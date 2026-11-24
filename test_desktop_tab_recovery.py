import hashlib
import json
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from arena_terminal.desktop_provider import DesktopJournal
from arena_terminal.journal import Journal, Problem


class DesktopTabRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.clock = self.enterContext(patch("time.monotonic", return_value=1000.0))
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = self.root / "desktop.sqlite"
        self.db = DesktopJournal(self.path, self.root)
        self.addCleanup(lambda: self.db.close())
        self.db.pair_owner("A")
        self.chat = "https://arena.ai/agent/session-a"
        self.address = dict(chat=self.chat, tab=7, binding=self.db.bind(self.chat, 7))
        self.request = dict(sessionId="A", requestId="one", text="Hello")

    def test_explicit_same_chat_replacement_keeps_owner_and_fences_previous_tab(self):
        self.db.start(self.request)
        with self.assertRaises(Problem):
            self.db.bind("https://arena.ai/agent/other-chat", 11)
        with self.assertRaises(Problem):
            self.db.bind(self.chat, True)
        self.db.check(self.address)
        bound = self.db.bind(self.chat, 11)
        self.assertNotEqual(bound, self.address["binding"])
        new = dict(chat=self.chat, tab=11, binding=bound)
        with self.assertRaises(Problem):
            self.db.pair_owner("B")
        self.assertEqual("failed", self.db.status("one", "A")["state"])
        self.assertIsNone(self.db.poll(new, True))
        with self.assertRaises(Problem):
            self.db.poll(self.address, True)
        self.db.start(dict(self.request, requestId="two"))
        self.assertIsNotNone(self.db.poll(new, True))
        self.assertIsNone(self.db.poll(new, True))
        with closing(Journal(self.root / "cli.sqlite", self.root)) as cli:
            cli.bind(self.chat, 7)
            with self.assertRaises(Problem):
                cli.bind(self.chat, 11)

    def test_no_poll_expires_only_after_the_new_requests_own_grace(self):
        self.clock.return_value = 1500.0
        self.assertEqual(self.db.pair_status("A"), {"state":"offline"})
        self.db.start(self.request)
        self.clock.return_value = 1589.9
        self.assertEqual({"state":"queued"}, self.db.status("one", "A"))
        self.clock.return_value = 1590.0
        result = self.db.status("one", "A")
        self.assertEqual("failed", result["state"])
        self.assertIn("/arena-pair", result["error"])
        self.assertIn("Bind conversation", result["error"])
        self.assertNotIn("/arena-reset", result["error"])
        self.assertIsNone(self.db.poll(self.address, True))
        self.db.close()
        self.db = DesktopJournal(self.path, self.root)
        self.assertEqual(result, self.db.status("one", "A"))
        self.assertIsNone(self.db.poll(self.address, True))
        self.db.start(dict(self.request, requestId="two"))
        self.assertIsNotNone(self.db.poll(self.address, True))

    def test_replacing_tab_fences_the_previous_unclaimed_tool_reply(self):
        self.db.start(dict(self.request, tools=[{"name":"read"}]))
        sent = self.db.poll(self.address, True)["id"]
        self.db.event(dict(self.address, id="sent", kind="sent", job=sent))
        frame = json.dumps({"$harness":"tool_call", "turn_id":sent, "name":"read", "arguments":{}})
        self.db.event(dict(self.address, id="command", kind="assistant", replyTo=sent,
                           toolFrame=True, toolSource=frame, text="Reading."))
        self.db.bind(self.chat, 19)
        self.assertEqual("failed", self.db.status("one", "A")["state"])
        self.assertIsNotNone(self.db.lookup("one", "A")["reply"])
        with self.assertRaises(Problem):
            self.db.event(dict(self.address, id="command-2", kind="assistant", replyTo=sent,
                               toolFrame=True, toolSource=frame, text="Reading."))

    def test_saved_binding_is_unconfirmed_until_browser_contacts_this_companion(self):
        self.assertEqual({"state":"paired"}, self.db.pair_status("A"))
        self.db.poll(self.address, False)
        self.db.close()
        self.db = DesktopJournal(self.path, self.root)
        self.assertEqual({"state":"unconfirmed"}, self.db.pair_status("A"))
        self.clock.return_value += 90
        self.assertEqual({"state":"offline"}, self.db.pair_status("A"))
        with self.assertRaises(Problem):
            self.db.poll(dict(self.address, tab=8), False)
        self.assertEqual({"state":"offline"}, self.db.pair_status("A"))
        self.db.poll(self.address, False)
        self.assertEqual({"state":"paired"}, self.db.pair_status("A"))
        self.db.close()
        self.db = DesktopJournal(self.path, self.root)
        self.assertEqual({"state":"unconfirmed"}, self.db.pair_status("A"))
        self.db.bind(self.chat, 8)
        self.assertEqual({"state":"paired"}, self.db.pair_status("A"))

    def test_late_poll_during_quota_preserves_reason_and_resuming_grants_new_grace(self):
        self.db.start(self.request)
        self.db.event(dict(self.address, id="quota", kind="limited", text="Daily limit"))
        limited = {"state":"limited", "error":"Daily limit"}
        self.assertEqual(limited, self.db.status("one", "A"))
        self.clock.return_value += 95
        self.assertIsNone(self.db.poll(self.address, True))
        self.assertEqual(limited, self.db.status("one", "A"))
        self.clock.return_value += 95
        self.db.resume()
        self.clock.return_value += 89
        self.assertEqual({"state":"queued"}, self.db.status("one", "A"))
        self.assertIsNotNone(self.db.poll(self.address, True))

    def test_noop_resume_does_not_extend_unclaimed_request_grace(self):
        self.db.start(self.request)
        self.clock.return_value += 89
        self.db.resume()
        self.clock.return_value += 1
        self.assertEqual("failed", self.db.status("one", "A")["state"])

    def test_late_poll_cannot_pick_up_expired_delivery_even_before_next_status(self):
        self.db.start(self.request)
        self.clock.return_value += 80
        with self.assertRaises(Problem):
            self.db.poll(dict(self.address, tab=10), True)
        self.clock.return_value += 10
        self.assertIsNone(self.db.poll(self.address, True))
        self.assertEqual("failed", self.db.status("one", "A")["state"])

    def test_browser_background_polls_extend_grace_and_sent_turn_has_no_deadline(self):
        self.db.start(self.request)
        for _ in range(3):
            self.clock.return_value += 61
            self.assertIsNone(self.db.poll(self.address, False))
            self.assertEqual({"state":"queued"}, self.db.status("one", "A"))
        self.clock.return_value += 89
        delivered = self.db.poll(self.address, True)
        self.clock.return_value += 600
        self.assertEqual({"state":"waiting"}, self.db.status("one", "A"))
        self.db.event(dict(self.address, id="sent-1", kind="sent", job=delivered["id"]))
        self.clock.return_value += 7200
        self.assertEqual({"state":"waiting"}, self.db.status("one", "A"))
        self.db.event(dict(self.address, id="answer-1", kind="assistant", text="finished", replyTo=delivered["id"]))
        self.assertEqual("finished", self.db.status("one", "A")["reply"]["text"])

    def test_stale_file_delivery_is_not_available_to_a_late_browser(self):
        digest = hashlib.sha256(b"x").hexdigest()
        self.db.stage_file_chunk(dict(sessionId="A", requestId="one", sha256=digest, size=1, offset=0, data="eA=="))
        file = dict(sha256=digest, size=1, name="origin.txt", mediaType="text/plain")
        self.db.start(dict(self.request, files=[file]))
        self.clock.return_value += 91
        self.assertIsNone(self.db.poll(dict(self.address, supportsFiles=True), True))
        self.assertEqual("failed", self.db.status("one", "A")["state"])

    def queue_native_answer(self):
        self.db.start(dict(self.request, tools=[{"name":"ask_user_question"}]))
        sent = self.db.poll(self.address, True)["id"]
        self.db.event(dict(self.address, id="sent", kind="sent", job=sent))
        card = dict(id="choice", question="Which?", options=["A", "B"])
        self.db.event(dict(self.address, id="card", kind="assistant", nativeQuestion=card,
                           supportsNativeQuestions=True, replyTo=sent))
        result = json.dumps({"toolCallId":"arena_one", "failed":False, "text":json.dumps({"answers":[{"id":"choice","selected":["A"]}]})})
        self.db.start(dict(self.request, requestId="two", text="", toolResult=result))

    def test_stale_native_answer_is_never_clicked(self):
        self.queue_native_answer()
        self.clock.return_value += 91
        self.assertIsNone(self.db.poll(dict(self.address, supportsNativeQuestions=True, nativeQuestionId="choice"), False))
        self.assertEqual("failed", self.db.status("two", "A")["state"])

    def test_known_closed_card_reports_closure_at_delivery_deadline(self):
        self.queue_native_answer()
        self.clock.return_value += 90
        closed = dict(self.address, supportsNativeQuestions=True, nativeQuestionId="choice", ready=False)
        self.assertEqual("choice", self.db.close_site_question(closed))
        self.assertEqual({"state":"failed", "error":"The Arena question closed before the choice could be sent."},
                         self.db.status("two", "A"))
        self.assertIsNone(self.db.poll(closed, False))
