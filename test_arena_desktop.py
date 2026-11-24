import base64
import hashlib
import json
import sqlite3
import struct
import tempfile
import threading
import unittest
import zlib
from contextlib import contextmanager
from http.client import HTTPConnection
from pathlib import Path

from arena_terminal.desktop_provider import DesktopJournal
from arena_terminal.journal import Problem
from arena_terminal.transport import Endpoint, ExtensionHandler


RED = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
BLUE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC"

def tool_call(turn_id, name="read", arguments=None):
    return '```json\n' + json.dumps({"$harness":"tool_call", "turn_id":turn_id, "name":name,
                                      "arguments":{} if arguments is None else arguments}) + '\n```'

class DesktopProviderTests(unittest.TestCase):
    def test_confirmed_text_argument_preserves_script_and_returns_only_explanation(self):
        self.db.start(dict(self.request, tools=[{"name":"pwsh"}]))
        first = self.db.poll(self.addr, True)
        delivery = first["id"]
        script = '  $p = "D:\\Games\\Arena"\r\n\r\n[Console]::WriteLine($p)  \r\n'
        source = tool_call(delivery, "pwsh", {"description":"Fixture", "command":{"$text":"script"}}).split("\n")[1]
        self.send_raw(delivery, "\x1e"+source+"\x1escript\n"+script, text="Before.\n\nAfter.")
        reply = self.db.status("first", "desktop-session")["reply"]
        self.assertEqual(reply, {"kind":"tool", "name":"pwsh", "arguments":{"description":"Fixture", "command":script},
                                 "text":"Before.\n\nAfter."})
        self.assertIn('harness-text script', first["text"])
        self.db.start(dict(self.request, tools=[{"name":"pwsh"}], requestId="next", text="", toolResult=json.dumps(
            {"toolCallId":"arena_first", "failed":False, "text":"output"})))
        self.assertIn('harness-text script', self.db.poll(self.addr, True)["text"])

    def test_text_argument_rejects_missing_ambiguous_nested_and_unproven_sources(self):
        valid = "\x1escript\nWrite-Output benign"
        invalid = [
            ("missing", "pwsh", {"command":{"$text":"script"}}, "", True),
            ("empty", "pwsh", {"command":{"$text":"script"}}, "\x1escript\n", True),
            ("wrong label", "pwsh", {"command":{"$text":"other"}}, valid, True),
            ("no label line", "pwsh", {"command":{"$text":"script"}}, "\x1escript", True),
            ("separator inside copied JSON fence", "pwsh", {"command":{"$text":"script"}}, valid, True),
            ("unreferenced body", "pwsh", {"command":"Write-Output benign"}, valid, True),
            ("wrong field", "pwsh", {"description":{"$text":"script"}, "command":"Write-Output benign"}, valid, True),
            ("several links", "pwsh", {"description":{"$text":"script"}, "command":{"$text":"script"}}, valid, True),
            ("nested link", "pwsh", {"description":[{"$text":"script"}], "command":{"$text":"script"}}, valid, True),
            ("different tool", "read", {"file_path":{"$text":"script"}}, valid, True),
            ("old turn", "pwsh", {"command":{"$text":"script"}}, valid, True),
            ("rendered only", "pwsh", {"command":{"$text":"script"}}, valid, False),
        ]
        for index, (case, name, args, body, exact) in enumerate(invalid):
            with self.subTest(case=case):
                request = dict(self.request, requestId=f"arg-{index}", tools=[{"name":name}])
                self.db.start(request)
                delivery = self.db.poll(self.addr, True)["id"]
                json_block = tool_call('a'*32 if case == "old turn" else delivery, name, args)
                event_id = f"reply-{index}"
                if exact:
                    prefix = "\x1e" if body and case != "separator inside copied JSON fence" else ""
                    self.send_raw(delivery, prefix+json_block.split("\n")[1]+body, event_id=event_id,
                                  text="```harness-text script\nWrite-Output display-only\n```")
                else:
                    self.db.event(dict(self.addr, id=f"sent-{index}", kind="sent", job=delivery))
                    self.db.event(dict(self.addr, id=event_id, kind="assistant", toolFrame=True, replyTo=delivery, text=json_block))
                status = self.db.status(request["requestId"], request["sessionId"])
                self.assertEqual(status["state"], "failed")
                self.assertIsNone(self.db.poll(self.addr, True))

    def test_unmarked_text_and_existing_inline_command_keep_their_meaning(self):
        self.db.start(self.request)
        first = self.db.poll(self.addr, True)
        self.assertNotIn('harness-text', first["text"])
        sample = '```harness-text script\nWrite-Output example\n```'
        self.db.event(dict(self.addr, id="sent-example", kind="sent", job=first["id"]))
        self.db.event(dict(self.addr, id="example", kind="assistant", text=sample, replyTo=first["id"]))
        self.assertEqual(self.db.status("first", "desktop-session")["reply"], {"kind":"text", "text":sample})
        self.db.start(dict(self.request, requestId="inline", tools=[{"name":"pwsh"}]))
        delivery = self.db.poll(self.addr, True)["id"]
        command = 'Write-Output "D:\\Games\\Arena"'
        self.send_raw(delivery, tool_call(delivery, "pwsh", {"command":command}).split("\n")[1])
        self.assertEqual(self.db.status("inline", "desktop-session")["reply"]["arguments"]["command"], command)

    def test_read_batch_returns_one_ordered_continuation_and_rejects_replay(self):
        self.db.start(dict(self.request, supportsReadBatch=True))
        job = self.db.poll(self.addr, True)
        self.assertIn('arena_read_batch', job['text'])
        calls = [{"name":"read", "arguments":{"file_path":f"file-{i}.txt"}} for i in range(5)]
        self.send_raw(job['id'], tool_call(job['id'], "arena_read_batch", {"calls":calls}).split("\n")[1])
        self.assertEqual(self.db.status("first", "desktop-session")["reply"],
                         {"kind":"tool-batch", "calls":calls, "text":"Пояснение."})
        results = [{"toolCallId":f"arena_first_{i}", "failed":i == 1, "text":value}
                   for i, value in enumerate(("content of one", "two was missing", "three", "four", "five"))]
        followup = dict(self.request, requestId="complete", text="")
        for invalid in ([results[0]], results[:-1], results[::-1], [results[0], *results[:-1]],
                        [results[0], dict(results[1], toolCallId="arena_unrelated_1"), *results[2:]]):
            with self.assertRaises(Problem):
                self.db.start(dict(followup, toolResult=json.dumps({"results":invalid})))
        with self.assertRaises(Problem):
            self.db.start(dict(followup, toolResult=json.dumps(dict(results[0], toolCallId="arena_first"))))
        self.assertIsNone(self.db.poll(self.addr, True))

        followup["toolResult"] = json.dumps({"results":results})
        self.assertEqual(self.db.start(followup), self.db.start(followup))
        self.assertEqual(self.db.status("first", "desktop-session")["state"], "failed")
        continued = self.db.poll(self.addr, True)
        self.assertIn(followup["toolResult"], continued["text"])
        with self.assertRaises(Problem):
            self.db.start(dict(followup, requestId="replay"))

    def test_read_batch_rejects_unavailable_call_as_a_unit(self):
        self.db.start(dict(self.request, supportsReadBatch=True))
        delivery = self.db.poll(self.addr, True)['id']
        calls = [{"name":"read", "arguments":{}}, {"name":"grep", "arguments":{}}]
        self.send_raw(delivery, tool_call(delivery, "arena_read_batch", {"calls":calls}).split("\n")[1])
        self.assertEqual(self.db.status("first", "desktop-session")["state"], "failed")
        self.assertEqual(self.db.pending_calls(), [])

    def test_readable_batch_preserves_result_order_ids_status_and_literal_text(self):
        self.db.start(dict(self.request, supportsReadBatch=True))
        delivery = self.db.poll(self.addr, True)['id']
        calls = [{"name":"read", "arguments":{"file_path":f"{i}.txt"}} for i in range(2)]
        self.send_raw(delivery, tool_call(delivery, "arena_read_batch", {"calls":calls}).split("\n")[1])
        body = "first line\r\n<path>literal</path> &lt;keep&gt;\\value\r\ud83d"
        results = [{"toolCallId":"arena_first_0", "failed":False, "text":body},
                   {"toolCallId":"arena_first_1", "failed":True, "text":"Missing file"}]
        self.db.start(dict(self.request, requestId="next", text="", toolResult=json.dumps({"results":results}),
                           toolResultView={}))
        text = self.db.poll(self.addr, True)["text"]
        expected = "first line\n<path>literal</path> &lt;keep&gt;\\value\\r\\ud83d"
        self.assertIn("Tool arena_first_0 (ok)\n" + expected, text)
        self.assertIn("Tool arena_first_1 (failed)\nMissing file", text)
        self.assertLess(text.index("arena_first_0"), text.index("arena_first_1"))
        self.assertNotIn('"results"', text)

    def test_readable_shell_reports_process_exit_separately_from_tool_status(self):
        self.db.start(dict(self.request, tools=[{"name":"pwsh"}]))
        delivery = self.db.poll(self.addr, True)['id']
        self.send_raw(delivery, tool_call(delivery, "pwsh").split("\n")[1])
        raw = json.dumps({"toolCallId":"arena_first", "failed":False,
                          "text":"out\r\n[stderr]\r\nerr\r\n[exit code: 3221226505]"})
        request = dict(self.request, requestId="next", text="", toolResult=raw)
        args = dict(request, toolResultView={"process":{"exitCode":3221226505, "signal":None, "timedOut":False}})
        self.assertEqual(self.db.start(args), self.db.start(request))
        text = self.db.poll(self.addr, True)["text"]
        self.assertIn("Tool arena_first (ok)\nProcess exit code: 3221226505\nout\n[stderr]\nerr", text)
        self.assertEqual(text.count("3221226505"), 1)
        # A prior companion accepted this exact request with the view still in its digest.
        legacy = {key:value for key,value in args.items() if key != "supportsReadBatch"}
        fingerprint = hashlib.sha256(json.dumps(legacy, sort_keys=True).encode()).hexdigest()
        with self.db.sql:
            self.db.sql.execute("UPDATE requests SET fingerprint=? WHERE id='next'", (fingerprint,))
        self.assertEqual(self.db.start(args), {"id":"next"})

    def test_read_batch_cannot_be_picked_up_after_reconnect_new_browser_turn_or_cancel(self):
        actions = {
            "reconnect": lambda db, addr: db.bind(addr['chat'], addr['tab']),
            "browser turn": lambda db, addr: db.event(dict(addr, id="new-turn", kind="user", text="New browser turn")),
            "cancel": lambda db, _addr: db.cancel("first", "desktop-session"),
        }
        for name, action in actions.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory(dir=self.root) as folder:
                db = DesktopJournal(Path(folder) / "isolated.db", Path(folder))
                try:
                    db.pair_owner("desktop-session")
                    addr = dict(self.addr, binding=db.bind(self.addr['chat'], self.addr['tab']))
                    db.start(dict(self.request, supportsReadBatch=True))
                    delivery = db.poll(addr, True)['id']
                    calls = [{"name":"read", "arguments":{"file_path":f"{i}.txt"}} for i in range(2)]
                    source = tool_call(delivery, "arena_read_batch", {"calls":calls}).split("\n")[1]
                    db.event(dict(addr, id="sent", kind="sent", job=delivery))
                    db.event(dict(self.raw_reply(delivery, source), **addr))
                    self.assertEqual(db.status("first", "desktop-session")["state"], "done")
                    action(db, addr)
                    self.assertEqual(db.status("first", "desktop-session")["state"], "failed")
                    self.assertEqual(json.loads(db.lookup("first", "desktop-session")["reply"])["calls"], calls)
                finally:
                    db.close()

    def test_enabling_read_batch_preserves_the_recorded_catalog_of_an_existing_request(self):
        # Leave room for the legacy catalog, with less than another catalog entry available.
        legacy = dict(self.request, text="a" * 178798)
        old_request = self.db.start(legacy)
        upgraded = dict(legacy, supportsReadBatch=True)
        self.assertEqual(self.db.start(upgraded), old_request)
        with self.assertRaisesRegex(Problem, "reused with different content"):
            self.db.start(dict(upgraded, text="Different request"))
        delivery = self.db.poll(self.addr, True)
        self.assertNotIn("arena_read_batch", delivery["text"])
        self.send_raw(delivery["id"], tool_call(delivery["id"]).split("\n")[1])
        self.assertEqual(self.db.status("first", "desktop-session")["reply"]["kind"], "tool")

    def test_changed_transcript_retires_a_browser_started_turn(self):
        self.db.event(dict(self.addr, id="browser-user", kind="user", text="Started in Chrome"))
        self.db.event(dict(self.addr, id="source-fault", kind="blocked", transcriptChanged=True, text="Source changed"))
        self.assertEqual(self.db.issues(), [])
        self.db.start(self.request)
        self.assertTrue(self.db.recover_transcript(dict(self.addr, ready=False, recoverTranscript="source-fault")))

    def test_changed_transcript_invalidates_a_tool_reply_pending_desktop_pickup(self):
        self.db.start(self.request)
        job = self.db.poll(self.addr, True)["id"]
        self.send_raw(job, tool_call(job).split("\n")[1])
        self.db.event(dict(self.addr, id="source-fault", kind="blocked", transcriptChanged=True, text="Source changed"))
        self.assertEqual(self.db.status("first", "desktop-session"), {"state":"failed", "error":"Source changed"})
        self.assertIsNotNone(self.db.lookup("first", "desktop-session")["reply"], "retain the original result in the journal")

    def test_changed_transcript_recovers_only_for_a_new_desktop_message(self):
        self.db.start(self.request)
        old_delivery = self.db.poll(self.addr, True)["id"]
        self.send_raw(old_delivery, tool_call(old_delivery).split("\n")[1])
        result = json.dumps({"toolCallId":"arena_first", "failed":False, "text":"old tool output"})
        old_request = dict(self.request, requestId="old-result", text="", toolResult=result)
        self.db.start(old_request)
        fault = dict(self.addr, id="changed-source", kind="blocked", transcriptChanged=True,
                     text="The transcript changed at row 3 (original source).")
        with self.extension_client() as post:
            self.assertEqual(post("event", fault)[0], 200)
            self.assertEqual(self.db.status("old-result", "desktop-session"),
                             {"state":"failed", "error":fault["text"]})
            probe = dict(self.addr, ready=False, recoverTranscript=fault["id"])
            self.assertFalse(post("poll", probe)[1]["recoverTranscript"])
            with self.assertRaises(Problem):
                self.db.start(dict(old_request, requestId="late-result"))
            with self.assertRaises(Problem):
                self.db.start(self.request)

            self.db.start(dict(self.request, requestId="new", text="A new human message"))
            self.assertEqual(post("event", fault)[0], 200, "a lost fault acknowledgement must be safe")
            self.assertIsNone(post("poll", dict(self.addr, ready=True))[1]["job"])
            self.assertEqual(post("poll", dict(probe, tab=3))[0], 400)
            self.assertFalse(post("poll", dict(probe, recoverTranscript="other"))[1]["recoverTranscript"])
            for _ in range(2):
                status, response = post("poll", probe)
                self.assertEqual(status, 200)
                self.assertTrue(response["recoverTranscript"])
                self.assertIsNone(response["job"])
            resumed = dict(self.addr, recoveredTranscript=fault["id"])
            new = post("poll", dict(resumed, ready=True))[1]["job"]
            self.assertNotEqual(new["id"], old_delivery)
            self.assertIn("A new human message", new["text"])
            self.assertNotIn("old tool output", new["text"])
            self.assertEqual(post("event", dict(resumed, id="new-sent", kind="sent", job=new["id"]))[0], 200)
            self.assertEqual(post("event", self.raw_reply(old_delivery, tool_call(old_delivery).split("\n")[1],
                                                          event_id="late-old-reply"))[0], 200)
            self.assertEqual(self.db.status("new", "desktop-session"), {"state":"waiting"})
            self.assertEqual(post("event", dict(resumed, id="new-reply", kind="assistant",
                                               replyTo=new["id"], text="New answer"))[0], 200)
            self.assertEqual(self.db.status("new", "desktop-session"),
                             {"state":"done", "reply":{"kind":"text", "text":"New answer"}})
            self.assertIsNone(post("poll", dict(resumed, ready=True))[1]["job"])

    def raw_reply(self, delivery, source, *, event_id="raw-answer", text="Пояснение."):
        return dict(self.addr, id=event_id, kind="assistant", replyTo=delivery, toolFrame=True,
                    toolSource=source, text=text)

    def send_raw(self, delivery, source, *, event_id="raw-answer", text="Пояснение."):
        self.db.event(dict(self.addr, id=f"sent-{delivery}", kind="sent", job=delivery))
        self.db.event(self.raw_reply(delivery, source, event_id=event_id, text=text))

    @staticmethod
    def malformed_source(delivery, name="read"):
        return tool_call(delivery, name, {"file_path":"INVALID_ESCAPE"}).split("\n")[1].replace(
            "INVALID_ESCAPE", r"C:\Users\Local.txt")

    def test_raw_command_preserves_its_arguments_and_displays_only_prose(self):
        self.db.start(self.request)
        delivery = self.db.poll(self.addr, True)["id"]
        args = {"file_path":r"C:\Users\file.txt"}
        source = tool_call(delivery, arguments=args).split("\n")[1]
        display = 'Пояснение.\n\n```json\n{"ordinary": true}\n```'
        self.db.event(dict(self.addr, id="sent", kind="sent", job=delivery))
        with self.extension_client() as post:
            event = self.raw_reply(delivery, source, text=display)
            self.assertEqual(post("event", event)[0], 200)
            self.assertEqual(post("event", event)[0], 200)
        self.assertEqual(self.db.status("first", "desktop-session"), {"state":"done", "reply":{
            "kind":"tool", "name":"read", "arguments":args, "text":display}})

        self.db.start(dict(self.request, requestId="next", text="", toolResult=json.dumps(
            {"toolCallId":"arena_first", "failed":False, "text":"File content"})))
        followup = self.db.poll(self.addr, True)
        self.assertIn('"text": "File content"', followup["text"])

    def test_malformed_raw_command_retries_once_and_deduplicates_across_restart(self):
        self.db.start(self.request)
        first = self.db.poll(self.addr, True)["id"]
        self.send_raw(first, self.malformed_source(first))
        self.assertEqual(self.db.status("first", "desktop-session"), {"state":"queued"})
        self.assertEqual(self.db.state(first), "done")
        self.assertEqual(self.db.pending_calls(), [])
        self.db.close()
        self.db = DesktopJournal(self.root / "state.db", self.root)
        self.db.event(self.raw_reply(first, self.malformed_source(first)))
        retry = self.db.poll(self.addr, True)
        self.assertNotEqual(first, retry["id"])
        self.assertNotIn(first, retry["text"])
        self.assertNotIn("Local.txt", retry["text"])
        self.assertIn("invalid JSON", retry["text"])
        self.assertIn("Bridge delivery", retry["text"])
        self.db.event(self.raw_reply(first, self.malformed_source(first), event_id="late-first"))
        source = tool_call(retry["id"], arguments={"file_path":"known.txt"}).split("\n")[1]
        self.send_raw(retry["id"], source, event_id="retry-answer")
        self.assertEqual(self.db.status("first", "desktop-session")["reply"]["arguments"], {"file_path":"known.txt"})
        self.assertIsNone(self.db.poll(self.addr, True))

    def test_second_malformed_raw_command_stops_and_keeps_technical_text_private(self):
        self.db.start(self.request)
        first = self.db.poll(self.addr, True)["id"]
        self.send_raw(first, self.malformed_source(first))
        second = self.db.poll(self.addr, True)["id"]
        self.send_raw(second, self.malformed_source(second), event_id="second-answer")
        status = self.db.status("first", "desktop-session")
        self.assertEqual(status["state"], "failed")
        self.assertIn("invalid JSON", status["error"])
        self.assertNotIn("Local.txt", status["error"])
        self.assertIsNone(self.db.poll(self.addr, True))

    def test_unproven_or_ambiguous_raw_commands_never_retry(self):
        for index, variant in enumerate(("stale", "duplicate", "extra-root-field", "unknown", "second-object")):
            with self.subTest(variant=variant):
                rid = f"bad-{index}"
                self.db.start(dict(self.request, requestId=rid))
                delivery = self.db.poll(self.addr, True)["id"]
                source = self.malformed_source(delivery)
                if variant == "stale":
                    source = self.malformed_source("f" * 32)
                elif variant == "duplicate":
                    source = tool_call(delivery).split("\n")[1].replace('"arguments": {}', '"arguments": {"x": 1, "x": 2}')
                elif variant == "extra-root-field":
                    source = source[:-1] + ', "turn_id": "' + "f" * 32 + '"}'
                elif variant == "unknown":
                    source = self.malformed_source(delivery, name="missing-tool")
                else:
                    source += '\n{"not": "a continuation"}'
                self.send_raw(delivery, source, event_id=f"bad-{index}")
                self.assertEqual(self.db.status(rid, "desktop-session")["state"], "failed")
                self.assertIsNone(self.db.poll(self.addr, True))

    def test_cancelled_desktop_request_does_not_send_its_pending_retry(self):
        self.db.start(self.request)
        first = self.db.poll(self.addr, True)["id"]
        self.send_raw(first, self.malformed_source(first))
        self.assertEqual(self.db.status("first", "desktop-session"), {"state":"queued"})
        self.db.cancel("first", "desktop-session")
        self.assertIsNone(self.db.poll(self.addr, True))
        self.assertEqual(self.db.status("first", "desktop-session")["state"], "failed")

    def test_newer_browser_turn_retires_a_queued_desktop_retry(self):
        self.db.start(self.request)
        first = self.db.poll(self.addr, True)["id"]
        self.send_raw(first, self.malformed_source(first))
        self.assertEqual(self.db.status("first", "desktop-session"), {"state":"queued"})

        self.db.event(dict(self.addr, id="manual", kind="user", text="A newer browser turn"))
        self.db.event(dict(self.addr, id="manual-reply", kind="assistant", text="Finished", replyTo="manual"))
        self.assertIsNone(self.db.poll(self.addr, True))
        self.assertEqual(self.db.status("first", "desktop-session")["state"], "failed")
        self.db.start(dict(self.request, requestId="newer"))
        self.assertIsNotNone(self.db.poll(self.addr, True))

    def test_newer_browser_turn_does_not_accept_a_reply_to_an_offered_retry(self):
        self.db.start(self.request)
        first = self.db.poll(self.addr, True)["id"]
        self.send_raw(first, self.malformed_source(first))
        retry = self.db.poll(self.addr, True)["id"]

        self.db.event(dict(self.addr, id="manual", kind="user", text="A newer browser turn"))
        self.db.event(dict(self.addr, id="late-send", kind="sent", job=retry))
        self.assertEqual(self.db.one("SELECT kind FROM events WHERE id='late-send'")["kind"], "discarded")
        self.db.event(self.raw_reply(retry, tool_call(retry).split("\n")[1], event_id="late-retry"))
        self.db.event(dict(self.addr, id="manual-reply", kind="assistant", text="Finished", replyTo="manual"))
        self.assertEqual(self.db.state(retry), "superseded")
        self.assertIsNone(self.db.lookup("first", "desktop-session")["reply"])
        self.assertEqual(self.db.status("first", "desktop-session")["state"], "failed")
        self.db.start(dict(self.request, requestId="newer"))
        self.assertIsNotNone(self.db.poll(self.addr, True))

    def test_retry_of_a_tool_result_preserves_native_continuation_route(self):
        self.db.start(self.request)
        root = self.db.poll(self.addr, True)["id"]
        self.send_raw(root, tool_call(root).split("\n")[1])
        self.db.start(dict(self.request, requestId="followup", text="", toolResult=json.dumps(
            {"toolCallId":"arena_first", "failed":False, "text":"Original tool result"})))
        previous = self.db.poll(self.addr, True)["id"]
        self.send_raw(previous, self.malformed_source(previous), event_id="broken-followup")
        retry = self.db.poll(self.addr, True)
        self.assertEqual(self.db.one("SELECT parent FROM jobs WHERE id=?", (retry["id"],))["parent"], root)
        self.assertNotIn("Original tool result", retry["text"])
        self.send_raw(retry["id"], tool_call(retry["id"]).split("\n")[1], event_id="corrected-followup")
        self.db.start(dict(self.request, requestId="final", text="", toolResult=json.dumps(
            {"toolCallId":"arena_followup", "failed":False, "text":"New result"})))
        self.assertIn("New result", self.db.poll(self.addr, True)["text"])

    def test_ordinary_json_is_unchanged_and_raw_transport_requires_its_authority(self):
        self.db.start(self.request)
        delivery = self.db.poll(self.addr, True)["id"]
        self.db.event(dict(self.addr, id="sent", kind="sent", job=delivery))
        text = '```json\n{"file_path":"C:/Users/file.txt","ordinary":true}\n```'
        raw = tool_call(delivery).split("\n")[1]
        no_authority = self.raw_reply(delivery, raw, text=text)
        no_authority.pop("toolFrame")
        with self.extension_client() as post:
            self.assertEqual(post("event", no_authority)[0], 400)
            ordinary = dict(self.addr, id="ordinary", kind="assistant", replyTo=delivery, text=text)
            self.assertEqual(post("event", ordinary)[0], 200)
        self.assertEqual(self.db.status("first", "desktop-session"), {"state":"done", "reply":{
            "kind":"text", "text":text}})

    def test_new_desktop_tool_result_delivery_rejects_exact_previous_command(self):
        self.db.start(self.request)
        first = self.db.poll(self.addr, True)["id"]
        frame = tool_call(first, arguments={"file_path":"local.txt"})
        self.db.event(dict(self.addr, id="first-send", kind="sent", job=first))
        self.db.event(dict(self.addr, id="first-answer", kind="assistant", replyTo=first, toolFrame=True, text=frame))
        self.assertEqual(self.db.status("first","desktop-session")["reply"]["kind"], "tool")

        self.db.start(dict(self.request, requestId="next", text="", toolResult=json.dumps(
            {"toolCallId":"arena_first","failed":False,"text":"File content"})))
        next_job = self.db.poll(self.addr, True)["id"]
        self.assertNotEqual(first, next_job)
        self.db.event(dict(self.addr, id="next-send", kind="sent", job=next_job))
        copied = dict(self.addr, id="next-answer", kind="assistant", replyTo=next_job, toolFrame=True, text=frame)
        with self.extension_client() as post:
            self.assertEqual(post("event",copied)[0], 200)
            self.assertEqual(post("event",copied)[0], 200)
        result = self.db.status("next","desktop-session")
        self.assertEqual(result["state"], "failed")
        self.assertIn("turn_id", result["error"])
        self.assertNotIn(first, result["error"])
        self.assertNotIn("$harness", result["error"])
        self.assertIsNone(self.db.lookup("next","desktop-session")["reply"])
        self.assertEqual(self.db.state(next_job), "done")

    def test_idle_credit_limit_reaches_a_queued_desktop_request_without_sending(self):
        self.db.start(self.request)
        reason = "Daily usage limit reached. Resets at 2:33 tomorrow."
        with self.extension_client() as post:
            status, _ = post("event", dict(self.addr, id="account-limit", kind="limited", text=reason))
            self.assertEqual(status, 200)
            status, body = post("poll", dict(self.addr, ready=True))
            self.assertEqual(status, 200)
            self.assertIsNone(body["job"])
        self.assertEqual(self.db.status("first", "desktop-session"), {"state":"limited", "error":reason})
        binding = self.db.bind(self.addr["chat"], self.addr["tab"])
        self.assertIsNone(self.db.poll(dict(self.addr, binding=binding), True))

    def test_desktop_displays_capture_failure_from_the_matched_job(self):
        self.db.start(self.request)
        job = self.db.poll(self.addr, True)["id"]
        self.db.event(dict(self.addr, id="sent", kind="sent", job=job))
        reason = "The generated Arena image could not be loaded."
        self.db.event(dict(self.addr, id="capture", kind="blocked", job=job, text=reason))
        self.assertEqual(self.db.status("first", "desktop-session"), {"state":"uncertain", "error":reason})

    def test_same_tab_reconnect_retires_only_the_observed_completed_delivery(self):
        self.db.start(self.request)
        job = self.db.poll(self.addr, True)["id"]
        self.db.event(dict(self.addr, id="sent-before-reconnect", kind="sent", job=job))
        self.db.event(dict(self.addr, id="lost-response", kind="blocked", job=job, text="Inspect Arena"))
        with self.extension_client() as post:
            status, result = post("bind", dict(chat=self.addr["chat"], tab=self.addr["tab"], settledDelivery=job))
        self.assertEqual(status, 200)
        binding = result["binding"]
        self.assertNotEqual(self.addr["binding"], binding)
        self.assertEqual(self.db.inspect(job)["state"], "done")
        self.assertEqual(self.db.pending_calls(), [])
        self.assertEqual(self.db.generated_images(job), [])
        self.db.start(dict(self.request, requestId="next"))
        self.assertIsNotNone(self.db.poll(dict(self.addr, binding=binding), True))

    def test_reconnect_keeps_uncertainty_for_a_missing_or_mismatched_receipt(self):
        self.db.start(self.request)
        job = self.db.poll(self.addr, True)["id"]
        self.db.event(dict(self.addr, id="uncertain-first", kind="uncertain", job=job, text="Inspect Arena"))
        with self.assertRaises(Problem):
            self.db.bind(self.addr["chat"], self.addr["tab"]+1, job)
        self.db.bind(self.addr["chat"], self.addr["tab"], "0"*32)
        self.assertEqual(self.db.inspect(job)["state"], "uncertain")
        with self.assertRaises(Problem):
            self.db.start(dict(self.request, requestId="next"))

    def test_generated_images_must_follow_the_matched_turn_and_survive_replay(self):
        item = {"mediaType":"image/png", "data":"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGPgEtHlEtFlgFAAB7YBLctR6mAAAAAASUVORK5CYII="}
        self.db.start(self.request)
        job = self.db.poll(self.addr, True)["id"]
        self.db.event(dict(self.addr, id="sent", kind="sent", job=job))
        event = dict(self.addr, id="art", kind="assistant", text="", images=[item], replyTo=job)
        for changes in ({"replyTo":"other"}, {"images":[dict(item, mediaType="image/jpeg")]},
                        {"images":[item] * 21}, {"toolFrame":True}):
            with self.subTest(changes=changes), self.assertRaises(Problem):
                self.db.event(dict(event, **changes))
        self.db.event(event)
        self.db.event(event)
        self.assertEqual(self.db.status("first", "desktop-session")["reply"],
                         {"kind":"text", "text":"", "images":[item]})
        self.assertEqual(len(self.db.generated_images(job)), 1)

    def test_generated_batch_survives_http_and_reply_replay_in_source_order(self):
        self.db.start(self.request)
        colors = [(value, 255-value, 61) for value in range(10)]
        items = []
        for color in colors:
            def chunk(kind, data):
                return (struct.pack(">I", len(data)) + kind + data
                        + struct.pack(">I", zlib.crc32(kind + data)))
            png = (b"\x89PNG\r\n\x1a\n"
                   + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
                   + chunk(b"IDAT", zlib.compress(bytes([0, *color])))
                   + chunk(b"IEND", b""))
            items.append({"mediaType": "image/png", "data": base64.b64encode(png).decode("ascii")})
        with self.extension_client() as post:
            status, response = post("poll", dict(self.addr, ready=True))
            self.assertEqual(status, 200)
            job = response["job"]["id"]
            status, _ = post("event", dict(self.addr, id="batch-sent", kind="sent", job=job))
            self.assertEqual(status, 200)
            event = dict(self.addr, id="batch-complete", kind="assistant", replyTo=job,
                         text="Готово.", images=items)
            for _ in range(2):
                status, response = post("event", event)
                self.assertEqual(status, 200, response)
        self.assertEqual(self.db.generated_images(job), items)
        self.assertEqual(self.db.status("first", "desktop-session")["reply"],
                         {"kind": "text", "text": "Готово.", "images": items})

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.db = DesktopJournal(self.root / "state.db", self.root)
        self.addCleanup(lambda: self.db.close())
        self.db.pair_owner("desktop-session")
        chat = "https://arena.ai/agent/desktop-demo"
        self.addr = {"tab":2,"chat":chat,"binding":self.db.bind(chat,2)}
        self.request = dict(sessionId="desktop-session",requestId="first",text="read file",
                            tools=[{"name":"read","description":"read file","inputSchema":{"type":"object"}}])

    def complete(self, block=None, *, name="read", arguments=None, explanation=""):
        job = self.db.poll(self.addr, True)["id"]
        self.db.event(dict(self.addr,id="sent",kind="sent",job=job))
        text = tool_call(job, name, arguments) if block is None else block
        if explanation:
            text = explanation + "\n\n" + text
        reply = dict(self.addr,id="answer",kind="assistant",text=text,toolFrame=True,replyTo=job)
        self.db.event(reply)
        self.db.event(reply)
        return self.db.status("first", "desktop-session")

    def test_identical_json_example_is_returned_intact_without_invoking_the_tool(self):
        self.db.start(self.request)
        block = '```json\n{"$harness":"tool_call","name":"read","arguments":{}}\n```'
        block = block.replace("```json","```text")
        result = self.complete(block, explanation="Пример команды.")
        self.assertEqual(result["reply"], {"kind":"text","text":"Пример команды.\n\n" + block})
        self.assertEqual(self.db.pending_calls(), [])

    def test_tool_continuation_delivers_reply_format_guidance_outside_the_original_result(self):
        self.db.start(self.request)
        first = self.db.poll(self.addr,True)
        _, catalog = first["text"].split("Native tool catalog: ",1)
        schema, end = json.JSONDecoder().raw_decode(catalog)
        self.assertEqual(schema,self.request["tools"])
        prefix, instructions = catalog[end:].rsplit("\n\n", 1)
        self.assertEqual(prefix, "\nAvailable skills: []\n\nread file")
        self.db.event(dict(self.addr,id="first-sent",kind="sent",job=first["id"]))
        frame = tool_call(first["id"])
        self.db.event(dict(self.addr,id="call",kind="assistant",text=frame,toolFrame=True,replyTo=first["id"]))
        raw = json.dumps({"toolCallId":"arena_first","failed":False,"text":"A result with \n, {braces}, and «quotes»."},
                         ensure_ascii=False)
        self.db.start(dict(self.request,requestId="result",text="",toolResult=raw))
        sent = self.db.poll(self.addr,True)["text"]
        header, body = sent.split("\n",1)
        self.assertTrue(header.startswith("DeepSeek Harness tool result:"))
        self.assertEqual(body,raw)
        for guidance in (header,instructions):
            self.assertIn('"$harness":"tool_call"',guidance)
            self.assertIn("first",guidance)
            self.assertIn("Bridge delivery",guidance)
            self.assertIn("turn_id",guidance)
            self.assertIn("fenced text",guidance)
            self.assertNotIn("arena.harness.v1",guidance)
            self.assertNotIn("Arena-Harness-Call",guidance)
            self.assertNotIn("WordPad",guidance)

    def test_computer_use_guidance_follows_the_acknowledged_catalog_and_tool_continuations(self):
        guide = "First line.\n\ninspect(await cua.getCapabilities())"
        request = dict(self.request, computerUseGuidance=guide)
        self.db.start(request)
        first = self.db.poll(self.addr, True)
        self.assertIn(json.dumps(guide, ensure_ascii=False), first["text"])
        self.assertEqual(first["text"].split("\n\n", 1)[1].split("\n", 1)[0], "read file")
        self.send_raw(first["id"], tool_call(first["id"]).split("\n")[1])
        continuation = dict(request, requestId="continued", text="", toolResult=json.dumps(
            {"toolCallId":"arena_first", "failed":False, "text":"read result"}))
        updated = guide + "\nUpdated rule."
        self.db.start(dict(continuation, computerUseGuidance=updated))
        self.db.start(dict(continuation, computerUseGuidance="another revision after admission"))
        # Drop all in-memory context, as on a companion restart.
        self.db.use_catalog(None)
        child = self.db.poll(self.addr, True)
        self.assertTrue(child["text"].startswith("DeepSeek Harness tool result:"))
        self.assertIn(json.dumps(updated, ensure_ascii=False), child["text"])
        self.assertNotIn("another revision", child["text"])
        self.assertNotIn(json.dumps(guide, ensure_ascii=False), child["text"])
        self.send_raw(child["id"], tool_call(child["id"]).split("\n")[1], event_id="second-answer")
        next_result = dict(continuation, requestId="retired", computerUseGuidance="", toolResult=json.dumps(
            {"toolCallId":"arena_continued", "failed":False, "text":"another read result"}))
        self.db.start(next_result)
        retired = self.db.poll(self.addr, True)
        self.assertIn("Computer Use guidance is unavailable", retired["text"])
        self.assertNotIn("Updated rule", retired["text"])
        self.db.event(dict(self.addr, id="retired-sent",kind="sent",job=retired["id"]))
        self.db.event(dict(self.addr, id="completed",kind="assistant",text="Ready"))
        self.db.start(dict(request,requestId="next",computerUseGuidance="",text="Follow up"))
        self.assertNotIn("Computer Use guidance", self.db.poll(self.addr,True)["text"])

    def test_changed_guidance_must_fit_before_a_continuation_is_queued(self):
        self.db.start(dict(self.request, computerUseGuidance="small section"))
        self.complete()
        request = dict(self.request, requestId="continued",text="",computerUseGuidance="x"*180000,
                       toolResult=json.dumps({"toolCallId":"arena_first","failed":False,"text":"read result"}))
        with self.assertRaisesRegex(Problem,"limit"):
            self.db.start(request)
        self.assertIsNone(self.db.poll(self.addr,True))

    def test_local_tool_handoff_is_available_after_the_catalog_is_acknowledged(self):
        self.db.start(self.request)
        first = self.db.poll(self.addr, True)
        self.db.event(dict(self.addr, id="first-sent", kind="sent", job=first["id"]))
        self.db.event(dict(self.addr, id="first-done", kind="assistant", text="Ready"))

        self.db.start(dict(self.request, requestId="local-follow-up", text="Read the local project file"))
        text = self.db.poll(self.addr, True)["text"]
        self.assertNotIn("Native tool catalog:", text)
        self.assertTrue(text.startswith("Read the local project file\n\n"))
        self.assertIn('"$harness":"tool_call"', text)
        self.assertIn("Bridge delivery", text)
        self.assertIn("visible reply", text)
        self.assertIn("End the reply", text)
        self.assertIn("next message", text)

    def test_tool_result_at_previous_combined_budget_is_delivered_intact(self):
        self.db.start(self.request)
        self.complete()
        # This profile's previous catalog occupied 837 characters. Its largest
        # admitted continuation included the header, its newline, and the result.
        raw_budget = 180000 - 837 - len("DeepSeek Harness tool result:\n")
        def result(text):
            return json.dumps({"toolCallId":"arena_first","failed":False,"text":text})
        raw = result("a" * (raw_budget-len(result(""))))
        self.db.start(dict(self.request,requestId="near-limit",text="",toolResult=raw))
        delivered = self.db.poll(self.addr,True)["text"]
        self.assertLessEqual(len(delivered),180000)
        self.assertEqual(delivered.split("\n",1)[1],raw)

    def test_plan_mode_reaches_the_browser_with_the_original_submission(self):
        self.db.start(dict(self.request, text="!image Draw a lighthouse", planMode=True))
        delivered = self.db.poll(self.addr, True)["text"]
        _, prompt = delivered.split("\n\n", 1)
        self.assertTrue(prompt.startswith("!image Draw a lighthouse\n\n"))
        instruction = prompt.split("\n\n", 1)[1]
        self.assertRegex(instruction, r"plan mode: ACTIVE")
        for phrase in ("read-only", "exit_plan_mode", "#", "approval"):
            self.assertIn(phrase, instruction)
        _, separator, template = instruction.partition("Use this object shape: ")
        self.assertTrue(separator, "The browser needs a concrete plan-review envelope")
        envelope = template.split(". Replace", 1)[0]
        self.assertEqual(json.loads(envelope), {
            "$harness": "tool_call", "turn_id":"CURRENT_DELIVERY_ID", "name": "exit_plan_mode",
            "arguments": {"plan": "# Plan"},
        })
        self.assertIn("one fenced json block", instruction)
        self.assertIn("Desktop opens its built-in plan review", instruction)
        self.assertIn("Native tool catalog:", delivered)

    def test_plan_instruction_follows_ordinary_tool_results_and_can_end(self):
        self.db.start(dict(self.request, planMode=True))
        self.complete()
        raw = json.dumps({"toolCallId":"arena_first","failed":False,"text":"Read-only result {fixture}"})
        self.db.start(dict(self.request, requestId="continuation", text="", toolResult=raw, planMode=True))
        continued = self.db.poll(self.addr, True)
        header, result_and_mode = continued["text"].split("\n", 1)
        result, _, mode = result_and_mode.partition("\n\n")
        self.assertIn('"$harness":"tool_call"', header)
        self.assertEqual(result, raw)
        self.assertIn("plan mode: ACTIVE", mode)
        self.assertIn('"name":"exit_plan_mode","arguments":{"plan":', mode)
        self.db.event(dict(self.addr, id="followup-sent", kind="sent", job=continued["id"]))
        self.db.event(dict(self.addr, id="followup-done", kind="assistant", text="Inspected"))
        self.db.start(dict(self.request, requestId="manual-off", text="Carry out the task", planMode=False))
        reset = self.db.poll(self.addr, True)["text"]
        self.assertIn("Carry out the task\n\n", reset)
        self.assertIn("plan mode: INACTIVE", reset)
        self.assertNotIn("plan mode: ACTIVE", reset)

    def test_plan_mode_is_optional_and_requires_an_actual_boolean(self):
        for invalid in (None, "true", 0, 1, [], {}):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(Problem, "plan mode"):
                self.db.start(dict(self.request, planMode=invalid))
        self.db.start(self.request)
        legacy = self.db.poll(self.addr, True)["text"]
        self.assertIn("\n\nread file\n\n", legacy)
        self.assertNotIn("plan mode", legacy)

    def test_plan_mode_preserves_image_only_and_checks_the_full_prompt_budget(self):
        with self.assertRaisesRegex(Problem, "text limit"):
            self.db.start(dict(self.request, text="x" * 179000, planMode=True))
        self.assertIsNone(self.db.poll(self.addr, True))
        self.db.start(dict(self.request, text="", png=BLUE, planMode=True))
        delivered = self.db.poll(self.addr, True)
        self.assertEqual(delivered["png"], BLUE)
        self.assertIn("\n\nReview the attached image.\n\n", delivered["text"])
        self.assertIn("plan mode: ACTIVE", delivered["text"])

    def site_question(self, advertised=True):
        tools = [{"name":"ask_user_question"}] if advertised else []
        self.db.start(dict(self.request,tools=tools))
        owner = self.db.poll(self.addr,True)["id"]
        self.db.event(dict(self.addr,id="sent",kind="sent",job=owner))
        card = {"id":"site-card","question":"Выберите вариант","options":["Первый","Второй"]}
        return dict(self.addr,id="card-event",kind="assistant",replyTo=owner,
                    supportsNativeQuestions=True,nativeQuestion=card)

    def test_image_choices_publish_previews_and_accept_only_the_linked_selection(self):
        event = self.site_question()
        previews = [{"mediaType":"image/png","data":data} for data in (RED,BLUE)]
        card = dict(event["nativeQuestion"],id="image-panel-1",options=["Image 1","Image 2","Skip"])
        event.update(nativeQuestion=card,choicePreviews=previews)
        with self.extension_client() as post:
            status, poll = post("poll",dict(self.addr,ready=False))
            self.assertEqual(status,200)
            self.assertTrue(poll["supportsImageChoices"])
            for bad in (previews[:1], list(reversed(previews)) + previews, [{"mediaType":"image/png","data":"AAAA"},previews[1]]):
                self.assertEqual(post("event",dict(event,choicePreviews=bad))[0],400)
            status, response = post("event",event)
            self.assertEqual(status,200)
            self.assertEqual(response["nativeQuestionHandled"],"interactive")
            self.assertEqual(post("event",event),(status,response))
            self.assertEqual(post("event",dict(event,choicePreviews=list(reversed(previews))))[0],400)
        reply = self.db.status("first","desktop-session")["reply"]
        self.assertEqual(reply["kind"],"image-choice")
        self.assertEqual(reply["previews"],previews)
        self.assertEqual(reply["arguments"]["questions"][0]["options"],[{"label":option} for option in card["options"]])
        answer = {"answers":[{"id":card["id"],"selected":["Image 2"]}]}
        request = dict(self.request,requestId="choice",text="",toolResult=json.dumps(
            {"toolCallId":"arena_first","failed":False,"text":json.dumps(answer)}))
        self.db.start(request)
        poller = dict(self.addr,supportsNativeQuestions=True,nativeQuestionId=card["id"])
        self.assertIsNone(self.db.poll(dict(poller,nativeQuestionId="different"),False))
        job = self.db.poll(poller,False)
        self.assertEqual(job["nativeAnswer"],dict(card,answer="Image 2"))
        self.assertIsNone(self.db.poll(poller,False))

    def test_site_card_admits_only_the_bound_question_and_matching_native_selection(self):
        event = self.site_question()
        card = event["nativeQuestion"]
        for changes in ({"replyTo":"wrong"}, {"supportsNativeQuestions":False}, {"toolFrame":True},
                        {"images":[]}, {"nativeQuestion":dict(card,name="read")}, {"kind":"user"},
                        {"nativeQuestion":dict(card,options=["Same","Same"])}):
            with self.subTest(changes=changes), self.assertRaises(Problem):
                self.db.event(dict(event,**changes))
        self.db.event(event)
        self.db.event(dict(event,id="same-card-replayed"))
        self.assertEqual(self.db.status("first","desktop-session")["reply"],{
            "kind":"tool","name":"ask_user_question","arguments":{"questions":[{
                "id":"site-card","question":"Выберите вариант","options":[{"label":"Первый"},{"label":"Второй"}],
            }]}})
        item = {"id":"site-card","selected":["Второй"]}
        def result(item, failed=False):
            output = json.dumps({"answers":[item]},ensure_ascii=False)
            return dict(self.request,requestId="second",text="",toolResult=json.dumps({
                "toolCallId":"arena_first","failed":failed,"text":output},ensure_ascii=False))
        for invalid in (dict(item,id="wrong"), dict(item,custom="free text"),dict(item,selected=[]),
                        dict(item,selected=["Unexpected"]),dict(item,selected=card["options"])):
            with self.subTest(invalid=invalid), self.assertRaises(Problem):
                self.db.start(result(invalid))
        with self.assertRaises(Problem):
            self.db.start(result(item,True))
        with self.assertRaises(Problem):
            self.db.start(dict(result(item),sessionId="different"))
        ack = self.db.start(result(item))
        self.assertEqual(ack,self.db.start(result(item)))
        # Pre-card companions recognize ordinary rows solely by this state. A
        # rollback must not expose the answer as a text message to that reader.
        self.assertIsNone(self.db.one("SELECT id FROM jobs WHERE state='queued'"))
        self.assertEqual(self.db.status("second","desktop-session")["state"],"queued")
        with self.assertRaisesRegex(Problem,"extension"):
            self.db.poll(self.addr,True)
        capable = dict(self.addr,supportsNativeQuestions=True)
        self.assertIsNone(self.db.poll(capable,True))
        self.assertIsNone(self.db.poll(dict(capable,nativeQuestionId="different"),True))
        self.assertIsNone(self.db.lease())
        job = self.db.poll(dict(capable,nativeQuestionId="site-card"),False)
        self.assertEqual(set(job),{"id","nativeAnswer"})
        self.assertEqual(job["nativeAnswer"],dict(card,answer="Второй"))
        self.assertIsNone(self.db.poll(dict(capable,nativeQuestionId="site-card"),False))
        with self.extension_client() as post:
            self.assertEqual(post("poll",dict(capable,nativeQuestionId="site-card",nativeQuestionClosed=True,ready=False))[0],400)
            self.assertEqual(self.db.lease(),job["id"])
        self.db.resolve(job["id"],"retry")
        self.assertIsNone(self.db.one("SELECT id FROM jobs WHERE state='queued'"))
        self.assertEqual(self.db.poll(dict(capable,nativeQuestionId="site-card"),False),job)
        self.db.event(dict(self.addr,id="answer-sent",kind="sent",job=job["id"]))
        self.db.event(dict(self.addr,id="after-answer",kind="assistant",text="Received"))
        self.assertEqual(self.db.status("second","desktop-session")["reply"],{"kind":"text","text":"Received"})

    def test_site_question_outside_the_profile_is_readable_and_inert(self):
        event = self.site_question(advertised=False)
        with self.extension_client() as post:
            for packet in (event,event,dict(event,id="same-card-new-event")):
                self.assertEqual(post("event",packet),(200,{"ok":True,"nativeQuestionHandled":"display-only",
                    "nativeQuestionId":"site-card","replyTo":event["replyTo"]}))
            self.assertEqual(post("event",dict(event,replyTo="wrong"))[0],400)
        reply = self.db.status("first","desktop-session")["reply"]
        self.assertEqual(reply["kind"],"text")
        for value in ("Выберите вариант","Первый","Второй","ask_user_question"):
            self.assertIn(value,reply["text"])

    def test_native_selection_followup_has_no_stamped_user_prompt_to_authorize_code(self):
        question = self.site_question()
        self.db.event(question)
        selection = json.dumps({"answers":[{"id":"site-card","selected":["Второй"]}]})
        self.db.start(dict(self.request,requestId="choice",text="",planMode=True,toolResult=json.dumps({
            "toolCallId":"arena_first","failed":False,"text":selection})))
        offered = self.db.poll(dict(self.addr,supportsNativeQuestions=True,nativeQuestionId="site-card"),False)
        self.assertEqual(set(offered), {"id", "nativeAnswer"})
        self.assertEqual(offered["nativeAnswer"], dict(question["nativeQuestion"], answer="Второй"))
        job = offered["id"]
        self.db.event(dict(self.addr,id="choice-sent",kind="sent",job=job))
        frame = tool_call(job)
        self.db.event(dict(self.addr,id="followup",kind="assistant",replyTo=job,text=frame,toolFrame=True))
        self.assertEqual(self.db.status("choice","desktop-session")["reply"], {"kind":"text","text":frame})
        self.db.start(dict(self.request,requestId="continue-planning",planMode=True))
        self.assertIn("plan mode: ACTIVE", self.db.poll(self.addr, True)["text"])

    def test_closed_unanswered_card_releases_the_next_ordinary_turn_and_rejects_a_late_choice(self):
        event = self.site_question()
        result = dict(self.request,requestId="second",text="",toolResult=json.dumps({
            "toolCallId":"arena_first","failed":False,"text":json.dumps({"answers":[{"id":"site-card","selected":[]}]})}))
        with self.extension_client() as post:
            for _ in range(2):
                self.assertEqual(post("event",event),(200,{"ok":True,"nativeQuestionHandled":"interactive",
                    "nativeQuestionId":"site-card","replyTo":event["replyTo"]}))
            with self.assertRaises(Problem):
                self.db.start(result)
            self.db.start(dict(self.request,requestId="normal",text="Follow up"))
            close = dict(self.addr,supportsNativeQuestions=True,nativeQuestionId="site-card",nativeQuestionClosed=True,ready=False)
            self.assertEqual(post("poll",dict(close,nativeQuestionId="wrong"))[0],400)
            for _ in range(2):
                status, response = post("poll",close)
                self.assertEqual(status,200)
                self.assertEqual(response.get("nativeQuestionClosed"),"site-card")
                self.assertIsNone(response["job"])
            status,response = post("poll",dict(self.addr,ready=True))
            self.assertEqual(status,200)
            self.assertIn("\n\nFollow up\n\n", response["job"]["text"])
            job = response["job"]["id"]
            self.db.event(dict(self.addr,id="sent-normal",kind="sent",job=job))
            self.db.event(dict(self.addr,id="done-normal",kind="assistant",text="Ok"))
        valid = {"answers":[{"id":"site-card","selected":["Первый"]}]}
        with self.assertRaisesRegex(Problem,"closed"):
            self.db.start(dict(result,toolResult=json.dumps({"toolCallId":"arena_first","failed":False,"text":json.dumps(valid)})))
        self.assertIsNone(self.db.lease())

    def test_close_before_browser_offer_fails_the_queued_answer_without_a_click(self):
        event = self.site_question()
        self.db.event(event)
        selection = {"answers":[{"id":"site-card","selected":["Первый"]}]}
        self.db.start(dict(self.request,requestId="reply",text="",toolResult=json.dumps({
            "toolCallId":"arena_first","failed":False,"text":json.dumps(selection)})))
        poll = dict(self.addr,supportsNativeQuestions=True,nativeQuestionId="site-card",ready=False)
        with self.extension_client() as post:
            status,response = post("poll",dict(poll,nativeQuestionClosed=True))
            self.assertEqual(status,200)
            self.assertIsNone(response["job"])
            self.assertEqual(response.get("nativeQuestionClosed"),"site-card")
            self.assertIsNone(post("poll",poll)[1]["job"])
        status = self.db.status("reply","desktop-session")
        self.assertEqual(status["state"],"failed")
        self.assertIn("closed",status["error"])

    def test_manually_superseded_card_cannot_be_sent_by_releasing_a_held_answer(self):
        event = self.site_question()
        self.db.event(event)
        selection = {"answers":[{"id":"site-card","selected":["Первый"]}]}
        self.db.start(dict(self.request,requestId="choice",text="",toolResult=json.dumps({
            "toolCallId":"arena_first","failed":False,"text":json.dumps(selection)})))
        self.db.event(dict(self.addr,id="different-turn",kind="user",text="Another task"))
        self.db.event(dict(self.addr,id="finished",kind="assistant",text="Done"))
        held, = self.db.held()
        self.db.resolve(held["id"],"send")
        with self.assertRaises(Problem):
            self.db.poll(dict(self.addr,supportsNativeQuestions=True,nativeQuestionId="site-card"),False)
        self.assertIsNone(self.db.lease())

    @contextmanager
    def extension_client(self):
        with Endpoint(("127.0.0.1",0),ExtensionHandler) as server:
            server.auth, server.journal = b"Bearer test", self.db
            listener = threading.Thread(target=server.serve_forever,kwargs={"poll_interval":0.01})
            listener.start()
            try:
                def post(path, body):
                    connection = HTTPConnection("127.0.0.1",server.server_port,timeout=2)
                    try:
                        payload = json.dumps(body).encode()
                        connection.request("POST","/v1/"+path,payload,{"Content-Type":"application/json","Authorization":"Bearer test"})
                        response = connection.getresponse()
                        return response.status, json.load(response)
                    finally:
                        connection.close()
                yield post
            finally:
                server.shutdown()
                listener.join()

    def test_only_explicitly_capable_http_peer_can_claim_the_complete_batch(self):
        self.db.start(dict(self.request,pngs=[BLUE,RED]))
        with self.extension_client() as post:
            for fields in ({"ready":True},{"ready":False},{"ready":True,"supportsPngBatch":"true"}):
                status, data = post("poll",dict(self.addr,**fields))
                self.assertEqual(status,400)
                self.assertRegex(data["error"],"extension")
                self.assertIsNone(self.db.lease())
            status, data = post("poll",dict(self.addr,ready=True,supportsPngBatch=True))
            self.assertEqual(status,200)
            self.assertEqual(data["job"]["pngs"],[BLUE,RED])
            self.assertNotIn("png",data["job"])
            self.assertEqual(data["lease"],data["job"]["id"])

    def test_batch_replay_before_and_after_offer_preserves_order_catalog_and_binding(self):
        request = dict(self.request,text="",pngs=[RED,BLUE])
        addr = dict(self.addr,supportsPngBatch=True)
        def restart():
            self.db.close()
            self.db = DesktopJournal(self.root / "state.db",self.root)
        self.db.start(request)
        restart()
        self.assertEqual(self.db.start(request),{"id":"first"})
        with self.assertRaisesRegex(Problem,"different content"):
            self.db.start(dict(request,pngs=[BLUE,RED]))
        with self.assertRaisesRegex(Problem,"Binding"):
            self.db.poll(dict(addr,tab=7),True)
        job = self.db.poll(addr,True)
        self.assertEqual(job["pngs"],[RED,BLUE])
        self.assertIn("attached images",job["text"])
        self.assertIn("Native tool catalog:",job["text"])
        self.assertTrue(self.db.inspect(job["id"])["has_image"])
        restart()
        self.assertEqual(self.db.status("first","desktop-session")["state"],"uncertain")
        self.assertIsNone(self.db.poll(addr,True))
        self.db.resolve(job["id"],"retry")
        self.assertEqual(self.db.poll(addr,True),job)
        self.db.cancel("first","desktop-session")
        self.assertEqual(self.db.status("first","desktop-session")["state"],"failed")
        self.assertIsNone(self.db.poll(addr,True))

    def test_malformed_or_oversize_batch_leaves_no_start_or_partial_delivery(self):
        raw = base64.b64decode(RED)
        # Ancillary data pads a syntactically framed PNG close to the per-image wire maximum.
        data = b"tEXt" + b"x\0" + bytes(4*1024**2-len(raw)-14)
        def padded_png(chunk):
            frame = struct.pack(">I",len(chunk)-4) + chunk + struct.pack(">I",zlib.crc32(chunk))
            return base64.b64encode(raw[:-12] + frame + raw[-12:]).decode()
        large = padded_png(data)
        cases = [{"pngs":value} for value in ([],[RED],None,RED,[RED,None],[RED,"???"],[RED,"YWJj"],
            [RED,base64.b64encode(b"\x89PNG\r\n\x1a\ntruncated").decode()],[RED]*21,[RED,padded_png(data+b"x")],[large]*9)]
        cases.extend(({"pngs":[RED,BLUE],"png":RED},{"pngs":[RED,BLUE],"png":None}))
        for index, fields in enumerate(cases):
            with self.subTest(case=index), self.assertRaises(ValueError):
                self.db.start(dict(self.request,**fields))
            self.assertEqual(self.db.issues(),[])
        self.db.start(dict(self.request,pngs=[RED,BLUE]))
        self.db.cancel("first","desktop-session")
        self.assertIsNone(self.db.poll(dict(self.addr,supportsPngBatch=True),True))

    def test_tool_result_batch_stays_bound_to_call_and_retains_the_upload_error(self):
        self.db.start(self.request)
        self.complete()
        continuation = dict(self.request,requestId="more",text="",pngs=[BLUE,RED],
                            toolResult='{"toolCallId":"arena_first","text":"window captures"}')
        self.db.start(continuation)
        addr = dict(self.addr,supportsPngBatch=True)
        job = self.db.poll(addr,True)
        self.assertEqual(job["pngs"],[BLUE,RED])
        self.assertIn("window captures",job["text"])
        reason = "Arena rejected the second upload"
        self.db.event(dict(self.addr,id="stopped",kind="blocked",job=job["id"],text=reason))
        self.assertEqual(self.db.status("more","desktop-session"),{"state":"uncertain","error":reason})
        self.assertIsNone(self.db.poll(addr,True))
        self.db.resolve(job["id"],"retry")
        self.assertEqual(self.db.poll(addr,True),job)
        with self.assertRaises(Problem):
            self.db.start(dict(continuation,requestId="duplicate"))

    def test_batch_page_limit_keeps_its_specific_reason_after_the_quota_pause_ends(self):
        self.db.start(dict(self.request,pngs=[RED,BLUE]))
        addr = dict(self.addr,supportsPngBatch=True)
        job = self.db.poll(addr,True)
        reason = "The selected Arena model allows only one file"
        self.db.event(dict(self.addr,id="limit",kind="limited",job=job["id"],text=reason))
        self.db.resume()
        self.assertEqual(self.db.status("first","desktop-session"),{"state":"limited","error":reason})
        self.assertIsNone(self.db.poll(addr,True))
        self.db.resolve(job["id"],"retry")
        self.assertEqual(self.db.poll(addr,True),job)

    def test_pre_batch_single_png_job_remains_deliverable_to_legacy_poller(self):
        path = self.root / "old.db"
        with sqlite3.connect(path) as old:
            old.execute("CREATE TABLE jobs(id TEXT PRIMARY KEY, text TEXT, png TEXT, state TEXT, parent TEXT)")
            old.execute("INSERT INTO jobs VALUES(?,?,?,'queued',NULL)",("legacy","picture",RED))
        old.close()
        reopened = DesktopJournal(path,self.root)
        self.addCleanup(reopened.close)
        reopened.pair_owner("original")
        addr = dict(self.addr,binding=reopened.bind(self.addr["chat"],2))
        self.assertEqual(reopened.poll(addr,True),{"id":"legacy","text":"picture","png":RED})

    def test_native_tool_has_exactly_one_owner_and_retries_are_idempotent(self):
        self.assertEqual(self.db.start(self.request), self.db.start(self.request))
        result = self.complete(arguments={"file_path":"x"}, explanation="I will read the file.")
        self.assertEqual(result["reply"], {"kind":"tool","name":"read","arguments":{"file_path":"x"},"text":"I will read the file."})
        self.assertEqual(self.db.pending_calls(), [])
        self.assertEqual(self.db.start(self.request)["id"], "first")
        self.assertIsNone(self.db.poll(self.addr, True))
        with self.assertRaises(Problem):
            self.db.start(dict(self.request, requestId="other",sessionId="wrong"))

    def test_unlisted_native_tool_and_cancellation(self):
        self.db.start(self.request)
        result = self.complete(name="different")
        self.assertEqual(result["reply"]["kind"],"text")
        self.assertIn('"name": "different"', result["reply"]["text"])
        self.db.start(dict(self.request,requestId="second"))
        self.db.cancel("second","desktop-session")
        self.assertIsNone(self.db.poll(self.addr,True))

    def test_cancelled_sent_turn_retires_on_its_exact_final_without_executing(self):
        self.db.start(self.request)
        job = self.db.poll(self.addr, True)["id"]
        self.db.event(dict(self.addr, id="sent", kind="sent", job=job))
        self.db.cancel("first", "desktop-session")
        with self.assertRaisesRegex(Problem, "previous turn is still active"):
            self.db.start(dict(self.request, requestId="next-round"))
        self.db.event(dict(self.addr, id="wrong", kind="assistant", text="Unrelated", replyTo="future"))
        self.db.event(dict(self.addr, id="unattributed", kind="assistant", text="Old extension"))
        self.assertEqual(self.db.inspect(job)["state"], "uncertain")
        self.db.close()
        self.db = DesktopJournal(self.root / "state.db", self.root)
        frame = tool_call(job)
        final = dict(self.addr, id="cancelled-final", kind="assistant", text=frame, toolFrame=True, replyTo=job)
        self.db.event(final)
        self.db.event(final)
        self.assertEqual(self.db.inspect(job)["state"], "done")
        self.assertEqual(self.db.status("first", "desktop-session"),
                         {"state":"failed", "error":"Desktop cancelled this request"})
        self.assertIsNone(self.db.lookup("first", "desktop-session")["reply"])
        self.assertEqual(self.db.pending_calls(), [])
        self.assertEqual(self.db.start(dict(self.request, requestId="next-round")), {"id":"next-round"})
        next_job = self.db.poll(self.addr, True)["id"]
        self.db.event(dict(self.addr, id="next-sent", kind="sent", job=next_job))
        self.db.event(dict(final, id="old-final-again"))
        self.assertEqual(self.db.status("next-round", "desktop-session"), {"state":"waiting"})

    def test_cancelled_offered_turn_requires_affirmative_sent_event_before_retiring(self):
        self.db.start(self.request)
        job = self.db.poll(self.addr, True)["id"]
        self.db.cancel("first", "desktop-session")
        response = dict(self.addr, id="early", kind="assistant", text="Unconfirmed", replyTo=job)
        self.db.event(response)
        self.assertEqual(self.db.inspect(job)["state"], "uncertain")
        self.db.event(dict(self.addr, id="sent-after-cancel", kind="sent", job=job))
        self.db.event(response)
        self.assertEqual(self.db.inspect(job)["state"], "waiting")
        self.db.event(dict(self.addr, id="plain-without-origin", kind="assistant", text="Unattributed"))
        self.assertEqual(self.db.inspect(job)["state"], "waiting")
        self.db.event(dict(response, id="confirmed-final", text="Completed"))
        self.assertEqual(self.db.inspect(job)["state"], "done")
        self.assertIsNone(self.db.lookup("first", "desktop-session")["reply"])

    def test_history_fault_keeps_a_cancelled_delivery_fenced(self):
        self.db.start(self.request)
        job = self.db.poll(self.addr, True)["id"]
        self.db.event(dict(self.addr, id="sent", kind="sent", job=job))
        self.db.cancel("first", "desktop-session")
        self.db.event(dict(self.addr, id="blocked", kind="blocked", job=job, text="The transcript changed"))
        self.db.event(dict(self.addr, id="late-sent", kind="sent", job=job))
        self.db.event(dict(self.addr, id="late-final", kind="assistant", text="Not verified", replyTo=job))
        self.assertIsNone(self.db.lookup("first", "desktop-session")["reply"])
        with self.assertRaisesRegex(Problem, "previous turn is still active"):
            self.db.start(dict(self.request, requestId="next-round"))

    def test_new_binding_cannot_retire_a_cancelled_delivery(self):
        self.db.start(self.request)
        job = self.db.poll(self.addr, True)["id"]
        self.db.event(dict(self.addr, id="sent", kind="sent", job=job))
        self.db.cancel("first", "desktop-session")
        rebound = self.db.bind(self.addr["chat"], self.addr["tab"])
        self.db.event(dict(self.addr, binding=rebound, id="late-final", kind="assistant", text="Late", replyTo=job))
        self.assertEqual(self.db.inspect(job)["state"], "uncertain")

    def test_cancelled_turn_native_card_is_passive_without_releasing_its_lease(self):
        event = self.site_question()
        self.db.cancel("first", "desktop-session")
        for packet in (event, event, dict(event, id="new-event-id")):
            self.assertEqual(self.db.event(packet), {"nativeQuestionHandled":"display-only",
                             "nativeQuestionId":"site-card", "replyTo":event["replyTo"]})
        with self.assertRaises(Problem):
            self.db.event(dict(event, nativeQuestion=dict(event["nativeQuestion"], question="Changed")))
        self.assertIsNone(self.db.lookup("first", "desktop-session")["reply"])
        self.db.event(dict(self.addr, id="unverified-final", kind="assistant", text="Late", replyTo=event["replyTo"]))
        self.assertEqual(self.db.inspect(event["replyTo"])["state"], "uncertain")
        with self.assertRaisesRegex(Problem, "previous turn is still active"):
            self.db.start(dict(self.request, requestId="next-round"))

    def test_cancelled_native_card_selection_cannot_retire_or_retain_a_generated_reply(self):
        question = self.site_question()
        self.db.event(question)
        selection = json.dumps({"answers":[{"id":"site-card","selected":["Второй"]}]})
        self.db.start(dict(self.request, requestId="choice", text="", toolResult=json.dumps({
            "toolCallId":"arena_first", "failed":False, "text":selection})))
        addr = dict(self.addr, supportsNativeQuestions=True, nativeQuestionId="site-card")
        job = self.db.poll(addr, False)["id"]
        self.db.cancel("choice", "desktop-session")
        self.db.event(dict(self.addr, id="choice-sent-after-cancel", kind="sent", job=job))
        self.db.event(dict(self.addr, id="late-image", kind="assistant", replyTo=job, text="Image attached",
                           images=[{"mediaType":"image/png", "data":BLUE}]))
        self.assertEqual(self.db.generated_images(job), [])
        self.assertEqual(self.db.inspect(job)["state"], "waiting")
        self.assertIsNone(self.db.lookup("choice", "desktop-session")["reply"])

    def test_manual_browser_turn_and_repair_invalidate_native_continuation(self):
        self.db.start(self.request)
        self.complete()
        continuation = dict(self.request,requestId="result",text="",
                            toolResult='{"toolCallId":"arena_first","text":"private file result"}')
        self.db.event(dict(self.addr,id="u",kind="user",text="different task"))
        self.db.event(dict(self.addr,id="a",kind="assistant",text="done"))
        with self.assertRaises(Problem):
            self.db.start(continuation)
        self.db.disconnect("desktop-session")
        self.db.pair_owner("desktop-session")
        self.db.bind("https://arena.ai/agent/second",3)
        with self.assertRaises(Problem):
            self.db.start(continuation)

    def test_explicit_disconnect_terminates_stranded_request(self):
        self.db.start(self.request)
        self.db.poll(self.addr,True)
        with self.assertRaises(Problem):
            self.db.disconnect("foreign")
        self.db.disconnect("desktop-session")
        self.assertEqual(self.db.status("first","desktop-session")["state"],"failed")

    def test_explicit_reset_from_another_session_releases_pairing(self):
        self.db.start(self.request)
        old_job = self.db.poll(self.addr, True)["id"]
        with self.assertRaisesRegex(Problem, "/arena-reset"):
            self.db.pair_owner("replacement")
        with self.assertRaises(Problem):
            self.db.disconnect("replacement")
        with self.assertRaises(Problem):
            self.db.disconnect("", reset=True)
        self.db.disconnect("replacement", reset=True)
        self.db.disconnect("replacement", reset=True)
        self.assertEqual(self.db.status("first", "desktop-session")["state"], "failed")
        self.assertEqual(self.db.state(old_job), "done")
        self.assertEqual(self.db.issues(), [])
        with self.assertRaisesRegex(Problem, "Binding mismatch"):
            self.db.event(dict(self.addr, id="late-send", kind="sent", job=old_job))

        self.db.pair_owner("replacement")
        chat = "https://arena.ai/agent/replacement"
        address = dict(tab=3, chat=chat, binding=self.db.bind(chat, 3))
        self.assertNotEqual(address["binding"], self.addr["binding"])
        self.db.start(dict(self.request, sessionId="replacement", requestId="new", text="New turn"))
        self.assertIn("New turn", self.db.poll(address, True)["text"])

    def test_explicit_reset_stops_a_cached_unclaimed_tool(self):
        self.db.start(self.request)
        delivery = self.db.poll(self.addr, True)["id"]
        self.send_raw(delivery, tool_call(delivery).split("\n")[1])
        self.db.disconnect("replacement", reset=True)
        self.assertEqual(self.db.status("first", "desktop-session")["state"], "failed")
        self.assertIsNotNone(self.db.lookup("first", "desktop-session")["reply"])

    def test_same_chat_rebind_invalidates_unobserved_or_queued_native_result(self):
        self.db.start(self.request)
        self.complete()
        continuation = dict(self.request,requestId="result",text="",
                            toolResult='{"toolCallId":"arena_first","text":"retained"}')
        self.db.start(continuation)
        new = self.db.bind(self.addr["chat"],self.addr["tab"])
        self.assertNotEqual(new,self.addr["binding"])
        self.assertIsNone(self.db.poll(dict(self.addr,binding=new),True))
        self.assertEqual(self.db.status("result","desktop-session")["state"],"failed")
        with self.assertRaises(Problem):
            self.db.start(dict(continuation,requestId="second-attempt"))
