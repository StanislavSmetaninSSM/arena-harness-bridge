import base64
import hashlib
import json
import sqlite3
import subprocess
import struct
import tempfile
import threading
import unittest
import zlib
from contextlib import contextmanager
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch

from arena_terminal.desktop_provider import DesktopJournal
from arena_terminal.journal import Problem
from arena_terminal.transport import Endpoint, ExtensionHandler


JS_HELP = "(typeof inspect === 'function' ? inspect : console.log)(JSON.stringify(await tools.arena_tool_help({})))"

RED = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
BLUE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC"

def tool_call(turn_id, name="read", arguments=None):
    return '```json\n' + json.dumps({"$harness":"tool_call", "turn_id":turn_id, "name":name,
                                      "arguments":{} if arguments is None else arguments}) + '\n```'

class DesktopProviderTests(unittest.TestCase):
    def test_pair_status_observes_only_the_requested_session_and_preserves_delivery(self):
        self.db.start(self.request)
        first = self.db.poll(self.addr, True)["id"]
        self.assertEqual(self.db.pair_status("desktop-session"), {"state":"paired"})
        self.assertEqual(self.db.pair_status("another"), {"state":"otherSession"})
        self.assertEqual(self.db.lease(), first)
        self.db.check(self.addr)
        self.db.event(dict(self.addr, id="pause-status", job=first, kind="limited", text="Daily usage limit reached"))
        self.assertEqual(self.db.pair_status("desktop-session"), {"state":"paused"})
        self.db.disconnect("desktop-session", reset=True)
        self.assertEqual(self.db.pair_status("another"), {"state":"unpaired"})
        self.assertIsNone(self.db.one("SELECT id FROM desktop_session"))

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
        self.assertNotIn('harness-text script', first["text"])
        self.db.start(dict(self.request, tools=[{"name":"pwsh"}], requestId="next", text="", toolResult=json.dumps(
            {"toolCallId":"arena_first", "failed":False, "text":"output"})))
        self.assertNotIn('harness-text script', self.db.poll(self.addr, True)["text"])

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
        self.assertNotIn('arena_read_batch', job['text'])
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
        # Replay a previously admitted delivery that filled the old combined budget.
        previous = {"id":"desktop-intro-v1/unavailable", "text":"DeepSeek Harness Desktop is connected."}
        legacy = dict(self.request, text="a" * (180000 - len(previous["text"]) - 2))
        with patch.object(self.db, "pending_intro", return_value=previous):
            old_request = self.db.start(legacy)
        upgraded = dict(legacy, supportsReadBatch=True)
        self.assertEqual(self.db.start(upgraded), old_request)
        with self.assertRaisesRegex(Problem, "reused with different content"):
            self.db.start(dict(upgraded, text="Different request"))
        delivery = self.db.poll(self.addr, True)
        self.assertEqual(delivery["text"], previous["text"] + "\n\n" + legacy["text"])
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
            self.assertIn("ordinary JSON", new["text"], "the replaced history may have lost its introduction")
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

    def test_known_program_tool_can_be_corrected_once_without_replaying_its_arguments(self):
        request = dict(self.request, tools=[{"name":"run_code"}], toolHelpViaCode=True,
                       programToolRoutes={"language":"typescript", "names":["read", "arena_tool_help"]})
        self.db.start(request)
        # Replaying an accepted request keeps its original admitted catalog, even across a restart.
        self.db.start(dict(request, programToolRoutes={"language":"python", "names":["different_tool"]}))
        self.db.close()
        self.db = DesktopJournal(self.root / "state.db", self.root)
        first = self.db.poll(self.addr, True)
        self.assertIn("Only run_code", first["text"])
        self.assertIn("TypeScript", first["text"])
        self.assertNotIn('"read"', first["text"])
        source = tool_call(first["id"], "read", {"file_path":"private-project-path"}).split("\n")[1]
        self.send_raw(first["id"], source)
        self.assertEqual(self.db.status("first", "desktop-session"), {"state":"queued"})
        self.assertIsNone(self.db.lookup("first","desktop-session")["reply"])
        retry = self.db.poll(self.addr, True)
        self.assertNotEqual(retry["id"], first["id"])
        for phrase in ('"read"', "run_code", "TypeScript", "fresh ID"):
            self.assertIn(phrase, retry["text"])
        self.assertNotIn("private-project-path", retry["text"])
        self.db.event(self.raw_reply(first["id"], source, event_id="late-original"))
        arguments = {"description":"Read the local file", "code":'await tools.read({file_path:"corrected-path"})'}
        self.send_raw(retry["id"], tool_call(retry["id"], "run_code", arguments).split("\n")[1], event_id="corrected")
        self.assertEqual(self.db.status("first","desktop-session")["reply"],
                         {"kind":"tool", "text":"Пояснение.", "name":"run_code", "arguments":arguments})
        self.assertIsNone(self.db.poll(self.addr, True))

    def test_misrouting_an_unfamiliar_tool_uses_current_dialect_and_shared_retry_budget(self):
        request = dict(self.request, tools=[{"name":"arena_tool_help"},{"name":"run_code"}],
                       programToolRoutes={"language":"python", "names":["new-capability"]})
        self.db.start(request)
        first = self.db.poll(self.addr, True)
        self.assertIn("Python", first["text"])
        self.assertNotIn("Only run_code", first["text"])
        self.assertNotIn("new-capability", first["text"])
        self.send_raw(first["id"], tool_call(first["id"], "new-capability", {}).split("\n")[1])
        second = self.db.poll(self.addr, True)
        self.assertIn("Python", second["text"])
        self.assertIn('"new-capability"', second["text"])
        self.send_raw(second["id"], self.malformed_source(second["id"], "run_code"), event_id="second-invalid")
        self.assertEqual(self.db.status("first","desktop-session")["state"], "failed")
        self.assertIsNone(self.db.poll(self.addr, True))

    def test_route_hints_expire_with_each_step_and_an_upgrade_announces_only_the_changed_contract(self):
        self.db.acknowledge_context("desktop-intro-v3/typescript")
        request = dict(self.request, tools=[{"name":"run_code"}], toolHelpViaCode=True,
                       programToolRoutes={"language":"typescript", "names":["read", "arena_tool_help"]})
        self.db.start(request)
        first = self.db.poll(self.addr, True)
        self.assertIn("Only run_code", first["text"])
        self.assertNotIn("ordinary JSON", first["text"])
        self.db.event(dict(self.addr, id="sent-1", kind="sent", job=first["id"]))
        self.db.event(dict(self.addr, id="finished", kind="assistant", replyTo=first["id"], text="OK"))
        self.db.start(dict(request, requestId="new-step", programToolRoutes={
            "language":"typescript", "names":["other", "arena_tool_help"]}))
        next_job = self.db.poll(self.addr, True)
        self.assertEqual(next_job["text"], self.request["text"])
        self.send_raw(next_job["id"], tool_call(next_job["id"], "read").split("\n")[1])
        self.assertEqual(self.db.status("new-step","desktop-session")["state"], "failed")
        self.assertIsNone(self.db.poll(self.addr, True))

    def test_repeated_wrong_route_stops_and_a_direct_tool_can_still_be_called_in_a_mixed_catalog(self):
        request = dict(self.request, tools=[{"name":"run_code"}, {"name":"read"}],
                       programToolRoutes={"language":"typescript", "names":["read", "custom"]})
        self.db.start(request)
        first = self.db.poll(self.addr, True)["id"]
        self.send_raw(first, tool_call(first, "custom").split("\n")[1])
        retry = self.db.poll(self.addr, True)["id"]
        self.send_raw(retry, tool_call(retry, "custom").split("\n")[1], event_id="wrong-again")
        self.assertEqual(self.db.status("first", "desktop-session")["state"], "failed")
        self.assertIsNone(self.db.poll(self.addr, True))
        self.db.start(dict(request, requestId="mixed"))
        job = self.db.poll(self.addr, True)["id"]
        self.send_raw(job, tool_call(job, "read", {"file_path":"fixture.txt"}).split("\n")[1], event_id="direct")
        self.assertEqual(self.db.status("mixed","desktop-session")["reply"]["name"], "read")

    def test_confirmed_bindings_determine_the_program_help_dialect_and_availability(self):
        request = dict(self.request, tools=[{"name":"run_code"}], toolHelpViaCode=True,
                       programToolRoutes={"language":"python", "names":["arena_tool_help"]})
        self.db.start(request)
        first = self.db.poll(self.addr, True)
        self.assertIn("print(await tools.arena_tool_help({}))", first["text"])
        self.db.event(dict(self.addr, id="old-sent", kind="sent", job=first["id"]))
        self.db.event(dict(self.addr, id="old-done", kind="assistant", replyTo=first["id"], text="OK"))
        for index, names in enumerate((["read"], [])):
            self.db.start(dict(request, requestId=f"changed-{index}", programToolRoutes={"language":"python", "names":names}))
            job = self.db.poll(self.addr, True)
            self.assertNotIn("tools.arena_tool_help", job["text"])
            self.db.event(dict(self.addr, id=f"change-sent-{index}", kind="sent", job=job["id"]))
            self.db.event(dict(self.addr, id=f"change-done-{index}", kind="assistant", replyTo=job["id"], text="OK"))

    def test_shadowed_help_names_do_not_advertise_a_bridge_help_route(self):
        for rid, direct, program, expected in (("both-shadowed", False, False, None),
                                               ("direct-shadowed", False, True, "run_code"),
                                               ("program-shadowed", True, False, "arena_tool_help")):
            with self.subTest(rid=rid):
                self.db.acknowledge_context("desktop-intro-v3/test")
                request = dict(self.request, requestId=rid, tools=[{"name":"arena_tool_help"},{"name":"run_code"}],
                               toolHelpDirect=direct, toolHelpViaCode=program,
                               programToolRoutes={"language":"python", "names":["arena_tool_help"]})
                self.db.start(request)
                self.db.start(dict(request, toolHelpDirect=not direct, toolHelpViaCode=not program))
                job = self.db.poll(self.addr, True)
                if expected:
                    example = json.loads(job["text"].split("```text\n")[1].split("\n```")[0])
                    self.assertEqual(example["name"], expected)
                else:
                    self.assertNotIn("arena_tool_help", job["text"])
                    self.assertIn("help is unavailable", job["text"])
                self.db.event(dict(self.addr, id=rid+"-sent", kind="sent", job=job["id"]))
                self.db.event(dict(self.addr, id=rid+"-done", kind="assistant", replyTo=job["id"], text="OK"))

    def test_program_tool_name_alone_is_not_a_help_capability(self):
        self.db.start(dict(self.request, tools=[{"name":"run_code"}],
                           programToolRoutes={"language":"typescript", "names":["arena_tool_help"]}))
        job = self.db.poll(self.addr, True)
        self.assertNotIn("tools.arena_tool_help", job["text"])
        self.assertIn("help is unavailable", job["text"])

    def test_program_route_recovery_requires_an_intact_current_source_and_admitted_name(self):
        request = dict(self.request, tools=[{"name":"run_code"}],
                       programToolRoutes={"language":"typescript", "names":["read"]})
        for scenario in ("unknown", "stale", "invalid-json", "text-reference", "extra-block", "missing-source", "no-run-code"):
            with self.subTest(scenario=scenario):
                params = dict(request, requestId=scenario)
                if scenario == "no-run-code":
                    params["tools"] = [{"name":"direct-tool"}]
                self.db.start(params)
                job = self.db.poll(self.addr, True)["id"]
                turn = "f"*32 if scenario == "stale" else job
                name = "unavailable" if scenario == "unknown" else "read"
                arguments = {"value":{"$text":"sample"}} if scenario == "text-reference" else {}
                source = tool_call(turn, name, arguments).split("\n")[1]
                if scenario == "invalid-json":
                    source = self.malformed_source(job, "read")
                if scenario == "extra-block":
                    source = "\x1e" + source + "\x1esample\nextra"
                if scenario == "missing-source":
                    self.db.event(dict(self.addr, id="sent-"+job, kind="sent", job=job))
                    self.db.event(dict(self.addr, id="plain-"+job, kind="assistant", replyTo=job,
                                       toolFrame=True, text=tool_call(job, name, arguments)))
                    self.assertEqual(self.db.status(scenario,"desktop-session")["reply"]["kind"], "text")
                else:
                    self.send_raw(job, source, event_id=scenario)
                    self.assertEqual(self.db.status(scenario,"desktop-session")["state"], "failed")
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
        replacement = self.addr["tab"]+1
        self.db.bind(self.addr["chat"], replacement, job)
        # A stamp seen on the replacement tab cannot settle an ambiguous send from the original.
        self.assertEqual(self.db.inspect(job)["state"], "uncertain")
        self.db.bind(self.addr["chat"], replacement, "0"*32)
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

    def browser_delivery(self):
        job = self.db.poll(self.addr, True)
        # Stamp the actual journal offer with the same formatter the extension submits.
        script = ("const job = JSON.parse(require('node:fs').readFileSync(0, 'utf8')); "
                  "process.stdout.write(require('./browser-extension/core.js').delivery(job.text, job.id).text)")
        out = subprocess.run(["node", "-e", script], cwd=Path(__file__).parent, check=True,
                             input=json.dumps(job).encode(), capture_output=True).stdout.decode()
        body, receipt = out.rsplit("\n\n", 1)
        self.assertRegex(receipt, r"^Bridge delivery [a-f0-9]{32}$")
        turn = receipt.removeprefix("Bridge delivery ")
        self.assertEqual(turn, job["id"])
        return body, turn

    def test_direct_help_example_executes_and_each_result_supplies_a_fresh_id(self):
        request = dict(self.request, text="Are you there?", planMode=False,
                       computerUseGuidance="old eager CUA guide", supportsReadBatch=True,
                       skills=[{"name":"hidden-skill", "description":"eager skill content"}],
                       tools=[{"name":"arena_tool_help"},{"name":"pwsh","description":"eager shell schema"},
                              {"name":"cua_run_code"},{"name":"read_image"},{"name":"ask_user_question"}])
        self.db.start(request)
        body, first = self.browser_delivery()
        intro, user = body.split("\n\n", 1)
        self.assertTrue(intro.startswith("DeepSeek Harness Desktop is connected."))
        self.assertEqual(user, "Are you there?")
        for phrase in ("cloud", "ordinary JSON", "32", "Bridge delivery", "first", "fenced json", "fenced text"):
            self.assertIn(phrase, intro)
        for unrelated in ("old eager CUA guide", "hidden-skill", "eager shell schema", "ask_user_question",
                          "read_image", "harness-text", "cua_run_code", "image generation", "run_code", "plan mode"):
            self.assertNotIn(unrelated, body)
        example = json.loads(intro.split("```text\n")[1].split("\n```")[0])
        self.assertEqual(list(example), ["$harness", "turn_id", "name", "arguments"])
        self.assertEqual(example, {"$harness":"tool_call", "turn_id":"CURRENT_DELIVERY_ID",
                                   "name":"arena_tool_help", "arguments":{}})
        self.send_raw(first, json.dumps(dict(example, turn_id=first)), text="")
        self.assertEqual(self.db.status("first", "desktop-session")["reply"],
                         {"kind":"tool","name":"arena_tool_help","arguments":{}})
        docs = "Requested tool names: read_image, pwsh"
        result = {"toolCallId":"arena_first","failed":False,"text":docs}
        self.db.start(dict(request, requestId="lookup", text="", toolResult=json.dumps(result), toolResultView={}))
        body, second = self.browser_delivery()
        self.assertEqual(body, "DeepSeek Harness tool result:\nTool arena_first (ok)\n" + docs)
        self.assertNotEqual(first, second)
        self.send_raw(second, json.dumps(dict(example, turn_id=second, arguments={"name":"pwsh"})),
                      event_id="lookup-answer", text="")
        self.assertEqual(self.db.status("lookup", "desktop-session")["reply"],
                         {"kind":"tool","name":"arena_tool_help","arguments":{"name":"pwsh"}})
        self.db.start(dict(request, requestId="last", text="", toolResult=json.dumps(
            {"toolCallId":"arena_lookup","failed":False,"text":"Specific docs"}), toolResultView={}))
        body, third = self.browser_delivery()
        self.assertEqual(body, "DeepSeek Harness tool result:\nTool arena_lookup (ok)\nSpecific docs")
        self.db.event(dict(self.addr, id="last-sent", kind="sent", job=third))
        self.db.event(dict(self.addr, id="final", kind="assistant", replyTo=third, text='{"finished":true}'))
        self.assertEqual(self.db.status("last", "desktop-session")["reply"], {"kind":"text","text":'{"finished":true}'})
        self.db.start(dict(request, requestId="human", text="My copy:\n" + docs,
                           computerUseGuidance="changed eager guide"))
        self.assertEqual(self.browser_delivery()[0], "My copy:\n" + docs)

    def test_nested_help_example_uses_only_the_admitted_program_tool(self):
        request = dict(self.request, tools=[{"name":"run_code"}], toolHelpViaCode=True)
        self.db.start(request)
        self.db.start(dict(request, toolHelpViaCode=False))
        self.db.close()
        self.db = DesktopJournal(self.root / "state.db", self.root)
        body, first = self.browser_delivery()
        intro, prompt = body.split("\n\n", 1)
        self.assertEqual(prompt, self.request["text"])
        example = json.loads(intro.split("```text\n")[1].split("\n```")[0])
        self.assertEqual(example["arguments"]["code"], JS_HELP)
        self.assertTrue(example["arguments"]["description"].strip())
        self.assertEqual(example["name"], "run_code")
        self.send_raw(first, json.dumps(dict(example, turn_id=first)), text="")
        self.assertEqual(self.db.status("first", "desktop-session")["reply"],
                         {"kind":"tool","name":"run_code","arguments":example["arguments"]})
        self.assertEqual(json.loads(self.db.lookup("first","desktop-session")["names"]), ["run_code"])

    def test_program_examples_change_with_the_current_runtime_and_replay_keeps_the_admitted_one(self):
        for dialect, code in (
                ("typescript", JS_HELP), ("python", "print(await tools.arena_tool_help({}))")):
            with self.subTest(dialect=dialect):
                request = dict(self.request, requestId=dialect, tools=[{"name":"run_code"}],
                               toolHelpViaCode=True, toolHelpProgram=dialect)
                self.db.start(request)
                self.db.start(dict(request, toolHelpProgram="python"))
                body, turn = self.browser_delivery()
                example = json.loads(body.split("```text\n")[1].split("\n```")[0])
                self.assertEqual(example["arguments"]["code"], code)
                self.assertEqual("ordinary JSON" in body, dialect == "typescript")
                self.db.event(dict(self.addr, id=dialect+"-sent", kind="sent", job=turn))
                self.db.event(dict(self.addr, id=dialect+"-answer", kind="assistant", text="Ready"))

    def test_unrequested_guides_and_catalog_revisions_do_not_consume_the_browser_budget(self):
        request = dict(self.request, computerUseGuidance="old guide", tools=[{"name":"read", "description":"x"*180000}])
        self.db.start(request)
        self.complete()
        result = json.dumps({"toolCallId":"arena_first","failed":False,"text":"My copy of old guide"})
        self.db.start(dict(self.request, requestId="continued", text="", computerUseGuidance="y"*180000, toolResult=result))
        self.assertEqual(self.db.poll(self.addr,True)["text"], "DeepSeek Harness tool result:\n" + result)

    def test_pending_context_can_be_acknowledged_after_a_companion_restart(self):
        self.db.start(dict(self.request, tools=[{"name":"arena_tool_help"}]))
        pending = self.db.context()
        self.assertIn('"name":"arena_tool_help"', pending["text"])
        self.db.close()
        self.db = DesktopJournal(self.root / "state.db", self.root)
        self.assertEqual(self.db.context(), pending)
        self.db.event(dict(self.addr, id="manual", kind="user", text="Earlier browser turn", contextId=pending["id"]))
        self.assertIsNone(self.db.context())
        self.db.event(dict(self.addr, id="manual-answer", kind="assistant", text="Ready"))
        self.assertEqual(self.browser_delivery()[0], self.request["text"])

    def test_only_an_acknowledged_intro_survives_restart_and_repair_of_the_same_chat(self):
        request = dict(self.request, tools=[{"name":"run_code"}], toolHelpViaCode=False)
        self.db.start(request)
        self.db.cancel("first","desktop-session")
        self.db.start(dict(request, requestId="offered"))
        body, turn = self.browser_delivery()
        self.assertIn("DeepSeek Harness Desktop is connected.", body)
        self.assertNotIn("arena_tool_help", body)
        self.assertNotIn("run_code", body)
        self.db.event(dict(self.addr, id="sent", kind="sent", job=turn))
        self.db.event(dict(self.addr, id="done", kind="assistant", text="Ready"))
        self.db.close()
        self.db = DesktopJournal(self.root / "state.db", self.root)
        self.addr["binding"] = self.db.bind(self.addr["chat"],self.addr["tab"])
        self.db.start(dict(request, requestId="reconnected", text="Next"))
        self.assertEqual(self.browser_delivery()[0], "Next")

    def test_previous_intro_receipt_delivers_the_visible_reply_contract_once(self):
        self.db.acknowledge_context("desktop-intro-v1/typescript")
        request = dict(self.request, tools=[{"name":"run_code"}], toolHelpViaCode=True,
                       text="!image Draw a sign")
        self.db.start(request)
        body, turn = self.browser_delivery()
        intro, separator, prompt = body.partition("\n\n")
        self.assertEqual((separator, prompt), ("\n\n", request["text"]))
        for phrase in ("You decide how to carry out the task", "your normal, visible reply",
                       "even when it does not appear", "subject to the user's permissions",
                       "Read the output or error", JS_HELP):
            self.assertIn(phrase, intro)
        self.db.event(dict(self.addr, id="role-sent", kind="sent", job=turn))
        self.db.event(dict(self.addr, id="role-answer", kind="assistant", replyTo=turn, text="OK"))
        self.db.close()
        self.db = DesktopJournal(self.root / "state.db", self.root)
        self.db.start(dict(request, requestId="next", text="Follow-up"))
        self.assertEqual(self.browser_delivery()[0], "Follow-up")

    def test_v2_chat_learns_automatic_image_delivery_once(self):
        self.db.acknowledge_context("desktop-intro-v2/typescript")
        request = dict(self.request, tools=[{"name":"run_code"}], toolHelpViaCode=True, text="Hello")
        self.db.start(request)
        body, turn = self.browser_delivery()
        intro, separator, prompt = body.partition("\n\n")
        self.assertEqual((separator, prompt), ("\n\n", "Hello"))
        self.assertIn("automatically delivers each generated image that Arena displays in your reply", intro)
        self.assertIn("Once Arena shows the finished images in your reply, finish your answer normally", intro)
        for topic in ("bridge:images", "read_image", "computer_use", "base64"):
            self.assertNotIn(topic, intro)
        self.db.event(dict(self.addr, id="image-role-sent", kind="sent", job=turn))
        self.db.event(dict(self.addr, id="image-role-answer", kind="assistant", replyTo=turn, text="OK"))
        self.db.close()
        self.db = DesktopJournal(self.root / "state.db", self.root)
        self.db.start(dict(request, requestId="next", text="Next"))
        self.assertEqual(self.browser_delivery()[0], "Next")

    def test_change_of_help_route_only_announces_the_new_entry_point(self):
        request = dict(self.request, tools=[{"name":"arena_tool_help"}])
        self.db.start(request)
        self.complete(name="arena_tool_help")
        self.db.start(dict(request, requestId="changed", tools=[{"name":"run_code"}], toolHelpViaCode=True,
                           text="",toolResult=json.dumps({"toolCallId":"arena_first","failed":False,"text":"names"})))
        body, _ = self.browser_delivery()
        self.assertIn(JS_HELP, body)
        self.assertNotIn("ordinary JSON", body)
        self.assertNotIn('"name":"arena_tool_help"', body)

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
        self.db.start(dict(self.request, text="!image Draw a lighthouse", planMode=True, tools=[{"name":"exit_plan_mode"}]))
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
        self.assertNotIn("Native tool catalog:", delivered)

    def test_program_only_plan_profile_uses_desktop_review_without_advertising_a_direct_exit_tool(self):
        self.db.start(dict(self.request, tools=[{"name":"run_code"}], toolHelpViaCode=True, planMode=True))
        body, _ = self.browser_delivery()
        mode = body.split("plan mode: ACTIVE.",1)[1]
        for term in ("read-only", "Desktop", "review", "approval"):
            self.assertIn(term, mode)
        self.assertNotIn("exit_plan_mode", body)

    def test_plan_instruction_follows_ordinary_tool_results_and_can_end(self):
        self.db.start(dict(self.request, planMode=True))
        self.complete()
        raw = json.dumps({"toolCallId":"arena_first","failed":False,"text":"Read-only result {fixture}"})
        self.db.start(dict(self.request, requestId="continuation", text="", toolResult=raw, planMode=True))
        continued = self.db.poll(self.addr, True)
        header, result_and_mode = continued["text"].split("\n", 1)
        result, _, mode = result_and_mode.partition("\n\n")
        self.assertEqual(header, "DeepSeek Harness tool result:")
        self.assertEqual(result, raw)
        self.assertIn("plan mode: ACTIVE", mode)
        self.assertNotIn("exit_plan_mode", mode)
        self.db.event(dict(self.addr, id="followup-sent", kind="sent", job=continued["id"]))
        self.db.event(dict(self.addr, id="followup-done", kind="assistant", text="Inspected"))
        self.db.start(dict(self.request, requestId="manual-off", text="Carry out the task", planMode=False))
        reset = self.db.poll(self.addr, True)["text"]
        self.assertIn("Carry out the task\n\n", reset)
        self.assertIn("plan mode: INACTIVE", reset)
        self.assertNotIn("plan mode: ACTIVE", reset)

    def test_plan_exit_requires_a_previously_delivered_active_mode_and_is_sent_only_once(self):
        self.db.start(dict(self.request, planMode=True))
        self.db.cancel("first", "desktop-session")
        self.db.start(dict(self.request, requestId="normal", planMode=False))
        body, turn = self.browser_delivery()
        self.assertNotIn("plan mode", body)
        self.db.event(dict(self.addr, id="normal-sent", kind="sent", job=turn))
        self.db.event(dict(self.addr, id="normal-answer", kind="assistant", text="Ready"))
        self.db.start(dict(self.request, requestId="active", planMode=True))
        body, turn = self.browser_delivery()
        self.assertIn("plan mode: ACTIVE", body)
        self.db.event(dict(self.addr, id="active-sent", kind="sent", job=turn))
        self.db.event(dict(self.addr, id="active-answer", kind="assistant", text="Ready"))
        self.db.close()
        self.db = DesktopJournal(self.root / "state.db", self.root)
        self.db.start(dict(self.request, requestId="off", planMode=False))
        body, turn = self.browser_delivery()
        self.assertIn("plan mode: INACTIVE", body)
        self.db.event(dict(self.addr, id="off-sent", kind="sent", job=turn))
        self.db.event(dict(self.addr, id="off-answer", kind="assistant", text="Ready"))
        self.db.start(dict(self.request, requestId="next", planMode=False))
        self.assertEqual(self.browser_delivery()[0], self.request["text"])

    def reopen_with_acknowledged_legacy_context(self):
        # The released companion recorded one SHA-256 acknowledgement for the paired
        # chat. Binding IDs could rotate between that send and the upgrade.
        with self.db.sql:
            self.db.sql.execute("DROP TABLE IF EXISTS desktop_prompts")
            digest = hashlib.sha256(b"Old tool catalog").hexdigest()
            self.db.sql.execute("UPDATE catalog SET digest=?", (digest,))
        self.db.close()
        self.db = DesktopJournal(self.root / "state.db", self.root)

    def test_legacy_ack_survives_repair_and_zero_tool_plan_until_a_known_mode_is_delivered(self):
        self.db.start(dict(self.request, tools=[], planMode=True))
        self.complete(block="Plan ready.")
        self.addr["binding"] = self.db.bind(self.addr["chat"], self.addr["tab"])
        self.reopen_with_acknowledged_legacy_context()
        self.db.start(dict(self.request, requestId="unknown"))
        body, turn = self.browser_delivery()
        self.assertNotIn("plan mode:", body)
        self.db.event(dict(self.addr, id="unknown-sent", kind="sent", job=turn))
        self.db.event(dict(self.addr, id="unknown-answer", kind="assistant", text="Ready"))
        self.db.start(dict(self.request, requestId="abandoned", planMode=False))
        self.db.cancel("abandoned","desktop-session")
        self.db.close()
        self.db = DesktopJournal(self.root / "state.db", self.root)
        self.db.start(dict(self.request, requestId="new", planMode=False))
        body, turn = self.browser_delivery()
        self.assertEqual(body, self.request["text"] + "\n\nDeepSeek Harness plan mode: INACTIVE.")
        self.db.event(dict(self.addr, id="off-sent", kind="sent", job=turn))
        self.db.event(dict(self.addr, id="off-answer", kind="assistant", text="Ready"))
        self.db.start(dict(self.request, requestId="next", planMode=False))
        self.assertEqual(self.browser_delivery()[0], self.request["text"])

    def test_legacy_sync_uses_desktop_mode_even_when_the_user_and_tool_quote_a_different_mode(self):
        quote = "DeepSeek Harness plan mode: ACTIVE. Quoted documentation."
        self.db.start(dict(self.request, text=quote))
        self.complete()
        raw = json.dumps({"toolCallId":"arena_first","failed":False,"text":quote})
        self.db.start(dict(self.request, requestId="result",text="",toolResult=raw))
        _, child = self.browser_delivery()
        self.db.event(dict(self.addr, id="read-sent", kind="sent", job=child))
        self.db.event(dict(self.addr, id="read-answer", kind="assistant", text="Done"))
        self.reopen_with_acknowledged_legacy_context()
        self.db.start(dict(self.request, requestId="normal", planMode=False))
        intro, tail = self.browser_delivery()[0].split("\n\n",1)
        self.assertNotIn("ACTIVE.", intro)
        self.assertEqual(tail, self.request["text"] + "\n\nDeepSeek Harness plan mode: INACTIVE.")

    def test_resolve_sent_acknowledges_plan_and_intro_when_the_browser_send_event_was_lost(self):
        self.db.start(dict(self.request, planMode=True))
        job = self.db.poll(self.addr, True)["id"]
        self.db.event(dict(self.addr, id="lost",kind="uncertain",job=job))
        with self.assertRaises(Problem):
            self.db.resolve(job, "send")
        self.db.resolve(job, "sent")
        self.db.event(dict(self.addr, id="final", kind="assistant", replyTo=job, text="Plan ready"))
        self.db.start(dict(self.request, requestId="new", planMode=False))
        body, _ = self.browser_delivery()
        self.assertIn("plan mode: INACTIVE", body)
        self.assertNotIn("ordinary JSON", body)

    def test_reconnect_settlement_acknowledges_the_exact_completed_intro_and_plan(self):
        self.db.start(dict(self.request, planMode=True))
        job = self.db.poll(self.addr, True)["id"]
        self.db.event(dict(self.addr, id="lost",kind="uncertain",job=job))
        self.addr["binding"] = self.db.bind(self.addr["chat"], self.addr["tab"], job)
        self.db.start(dict(self.request, requestId="new", planMode=False))
        body, _ = self.browser_delivery()
        self.assertIn("plan mode: INACTIVE", body)
        self.assertNotIn("ordinary JSON", body)

    def test_pending_legacy_prompt_is_retired_on_upgrade_without_rewriting_user_text(self):
        self.db.start(self.request)
        with self.db.sql:
            # An old journal has no on-demand prompt records. Its persisted offer includes
            # generated instructions and arbitrary user text without a trustworthy boundary.
            self.db.sql.execute("DROP TABLE IF EXISTS desktop_prompts")
            self.db.sql.execute("UPDATE outgoing_context SET text='Old private catalog'")
            self.db.sql.execute("UPDATE jobs SET text='user text plus legacy handoff'")
        self.db.close()
        self.db = DesktopJournal(self.root / "state.db", self.root)
        self.assertIsNone(self.db.poll(self.addr,True))
        self.assertIn("resubmit", self.db.status("first","desktop-session")["error"].lower())
        self.db.start(dict(self.request, requestId="new", text="New user text", planMode=False))
        body, _ = self.browser_delivery()
        self.assertNotIn("Old private catalog", body)
        self.assertEqual(body.split("\n\n",1)[1], "New user text")

    def test_uncertain_legacy_prompt_keeps_its_receipt_fence_until_explicit_resolution(self):
        self.db.start(self.request)
        job = self.db.poll(self.addr, True)
        with self.db.sql:
            self.db.sql.execute("DROP TABLE IF EXISTS desktop_prompts")
        self.db.close()
        self.db = DesktopJournal(self.root / "state.db", self.root)
        self.assertEqual(self.db.status("first", "desktop-session")["state"], "uncertain")
        self.assertIsNone(self.db.poll(self.addr, True))
        with self.assertRaisesRegex(Problem, "skip"):
            self.db.resolve(job["id"], "retry")
        self.db.resolve(job["id"], "skip")
        self.assertEqual(self.db.status("first", "desktop-session")["state"], "failed")
        self.db.start(dict(self.request, requestId="resubmitted"))
        self.assertIn("ordinary JSON", self.db.poll(self.addr,True)["text"])

    def test_plan_mode_is_optional_and_requires_an_actual_boolean(self):
        for invalid in (None, "true", 0, 1, [], {}):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(Problem, "plan mode"):
                self.db.start(dict(self.request, planMode=invalid))
        self.db.start(self.request)
        legacy = self.db.poll(self.addr, True)["text"]
        self.assertTrue(legacy.endswith("\n\nread file"))
        self.assertNotIn("plan mode", legacy)

    def test_plan_mode_preserves_image_only_and_checks_the_full_prompt_budget(self):
        with self.assertRaisesRegex(Problem, "text limit"):
            self.db.start(dict(self.request, text="x" * 179900, planMode=True))
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
        with self.assertRaisesRegex(Problem, "permission changed"):
            self.db.start(request)
        request["tools"] = [{"name":"ask_user_question"}]
        self.db.start(request)
        poller = dict(self.addr,supportsNativeQuestions=True,nativeQuestionId=card["id"])
        self.assertIsNone(self.db.poll(dict(poller,nativeQuestionId="different"),False))
        job = self.db.poll(poller,False)
        self.assertEqual(job["nativeAnswer"],dict(card,answer="Image 2"))
        self.assertIsNone(self.db.poll(poller,False))

    def program_gallery_exchange(self):
        start = dict(self.request, tools=[{"name":"run_code"}], galleryViaCode=True)
        self.db.start(start)
        origin = self.db.poll(self.addr,True)["id"]
        self.db.event(dict(self.addr,id="sent",kind="sent",job=origin))
        card = {"id":"gallery","question":"Choose an image","options":["Image 1","Image 2"]}
        previews = [{"mediaType":"image/png","data":data} for data in (RED,BLUE)]
        self.db.event(dict(self.addr,id="card",kind="assistant",replyTo=origin,supportsNativeQuestions=True,
                           nativeQuestion=card,choicePreviews=previews))
        def answer(label):
            return json.dumps({"answers":[{"id":card["id"],"selected":[label]}]})
        program = dict(start,requestId="result",text="",toolResult=json.dumps({
            "toolCallId":"arena_first","failed":False,"text":answer("Image 1")}))
        arguments = self.db.status("first","desktop-session")["reply"]["arguments"]
        native = dict(callId="arena_first",arguments=arguments,text=answer("Image 2"))
        return card, program, native

    def test_program_gallery_uses_the_settled_native_answer_and_requires_current_admission(self):
        card, program, native = self.program_gallery_exchange()
        with self.assertRaisesRegex(Problem,"no admitted native answer"):
            self.db.start(program)
        program["galleryAnswer"] = native
        with self.assertRaisesRegex(Problem,"no admitted native answer"):
            self.db.start(dict(program,galleryViaCode=False))
        self.db.start(program)
        job = self.db.poll(dict(self.addr,supportsNativeQuestions=True,nativeQuestionId=card["id"]),False)
        self.assertEqual(job["nativeAnswer"],dict(card,answer="Image 2"))

    def test_program_gallery_rejects_a_selection_from_a_different_prompt_with_the_same_id(self):
        _, program, native = self.program_gallery_exchange()
        question = native["arguments"]["questions"][0]
        for wrong in (dict(native,callId="arena_other"),dict(native,arguments={"questions":[dict(question,question="Other question")]})):
            with self.subTest(wrong=wrong), self.assertRaisesRegex(Problem,"no admitted native answer"):
                self.db.start(dict(program,galleryAnswer=wrong))

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
            self.assertEqual("Follow up", response["job"]["text"])
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

    def test_a_second_endpoint_on_the_same_port_is_refused(self):
        # Windows grants this bind when SO_REUSEADDR is set. The second companion then runs and receives nothing.
        with Endpoint(("127.0.0.1",0),ExtensionHandler) as first:
            with self.assertRaises(OSError):
                Endpoint(("127.0.0.1",first.server_port),ExtensionHandler).server_close()

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
        self.assertIn("DeepSeek Harness Desktop is connected.",job["text"])
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
