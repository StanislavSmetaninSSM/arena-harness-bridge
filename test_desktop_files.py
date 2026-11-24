import base64
import hashlib
import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path

from arena_terminal.desktop_provider import DesktopJournal
from arena_terminal.journal import Journal, Problem
from arena_terminal.transport import Endpoint, ExtensionHandler


class DesktopFilesTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.path = self.root / "journal.db"
        self.db = DesktopJournal(self.path, self.root)
        self.addCleanup(lambda: self.db.close())
        self.db.pair_owner("desktop")
        self.chat = "https://arena.ai/agent/files"
        self.addr = dict(chat=self.chat, tab=7, binding=self.db.bind(self.chat, 7))
        self.owner = dict(requestId="attach", sessionId="desktop")

    def reopen(self):
        self.db.close()
        self.db = DesktopJournal(self.path, self.root)

    def file(self, data, name, mime):
        return dict(sha256=hashlib.sha256(data).hexdigest(), size=len(data), name=name, mediaType=mime)

    def stage(self, file, offset, data, **changes):
        packet = dict(self.owner, sha256=file["sha256"], size=file["size"], offset=offset,
                      data=base64.b64encode(data).decode("ascii"))
        return self.db.stage_file_chunk({**packet, **changes})

    def test_order_duplicates_empty_binary_and_chunk_replay_across_restart(self):
        original = bytes(range(256)) * 1111
        file = self.file(original, "два слова", "")
        empty = self.file(b"", "archive.custom", "application/x-custom")
        manifest = [file, empty, dict(file, name="same.bin"), file]
        request = dict(self.owner, files=manifest, text="")
        cut = 256 * 1024
        self.assertEqual(self.stage(file, 0, original[:cut]), {"nextOffset":cut})
        self.reopen()
        self.assertEqual(self.stage(file, 0, original[:cut]), {"nextOffset":cut})
        with self.assertRaises(Problem):
            self.db.start(request)
        self.stage(file, cut, original[cut:])
        self.stage(empty, 0, b"")
        self.assertEqual(self.db.start(request), {"id":"attach"})
        self.reopen()
        self.assertEqual(self.db.start(request), {"id":"attach"})
        job = self.db.poll(dict(self.addr, supportsFiles=True), True)
        self.assertEqual(job["files"], manifest)
        for index, expected in enumerate([original, b"", original, original]):
            offset = 0
            got = bytearray()
            while True:
                part = self.db.file_chunk(dict(self.addr, job=job["id"], index=index, offset=offset))
                got.extend(base64.b64decode(part["data"], validate=True))
                self.assertEqual(part["nextOffset"], len(got))
                if len(got) == len(expected):
                    break
                self.assertGreater(part["nextOffset"], offset)
                offset = part["nextOffset"]
            self.assertEqual(got, expected)
        self.db.event(dict(self.addr, id="sent", job=job["id"], kind="sent"))
        with self.assertRaises(Problem):
            self.db.file_chunk(dict(self.addr, job=job["id"], index=0, offset=0))
        self.assertIsNone(self.db.poll(dict(self.addr, supportsFiles=True), True))

    def test_only_bound_request_and_offered_job_can_read_original(self):
        original = b"%PDF-sample"
        file = self.file(original, "scan.pdf", "application/pdf")
        with self.assertRaises(Problem):
            self.stage(file, 0, original, sessionId="other")
        self.stage(file, 0, original)
        with self.assertRaises(Problem):
            self.db.start(dict(self.owner, requestId="other", files=[file]))
        self.db.start(dict(self.owner, files=[file]))
        job = self.db.lookup("attach", "desktop")["job"]
        route = dict(self.addr, job=job, index=0, offset=0)
        with self.assertRaises(Problem):
            self.db.file_chunk(route)
        self.db.poll(dict(self.addr, supportsFiles=True), True)
        for change in [dict(binding="stale"), dict(tab=8), dict(job="another"), dict(index=-1),
                       dict(index=True), dict(offset=True), dict(offset=len(original)+1)]:
            with self.subTest(change=change), self.assertRaises(Problem):
                self.db.file_chunk({**route, **change})
        self.db.bind(self.chat, 7)
        with self.assertRaises(Problem):
            self.db.file_chunk(route)

    def test_legacy_extension_never_offers_text_only(self):
        file = self.file(b"original", "no-extension", "")
        self.stage(file, 0, b"original")
        self.db.start(dict(self.owner, text="send this", files=[file]))
        self.assertIsNone(self.db.poll(self.addr, True))
        status = self.db.status("attach", "desktop")
        self.assertEqual(status["state"], "failed")
        self.assertIn("extension", status["error"])
        self.assertIsNone(self.db.poll(dict(self.addr, supportsFiles=True), True))

    def test_old_companion_cannot_offer_a_file_turn_as_plain_text_including_on_retry(self):
        file = self.file(b"source", "README", "")
        self.stage(file, 0, b"source")
        self.db.start(dict(self.owner, files=[file]))
        job = self.db.lookup("attach", "desktop")["job"]
        # The shipping pre-files companion selects only queued and question_queued.
        legacy = "SELECT id FROM jobs WHERE state IN ('queued','question_queued')"
        self.assertIsNone(self.db.one(legacy))
        self.db.close()
        terminal = Journal(self.path, self.root)
        try:
            self.assertIsNone(terminal.poll(self.addr, True))
        finally:
            terminal.close()
            self.db = DesktopJournal(self.path, self.root)
        self.db.poll(dict(self.addr, supportsFiles=True), True)
        self.reopen()
        self.assertEqual(self.db.state(job), "uncertain")
        self.db.resolve(job, "retry")
        self.assertIsNone(self.db.one(legacy))
        self.assertEqual(self.db.poll(dict(self.addr, supportsFiles=True), True)["files"], [file])

    def test_original_exceeds_legacy_png_batch_size_without_inline_poll_payload(self):
        block = bytes(range(256)) * 1024
        pieces = 129  # Over 32 MiB, the previous whole-turn PNG limit.
        checksum = hashlib.sha256()
        for _ in range(pieces):
            checksum.update(block)
        file = dict(sha256=checksum.hexdigest(), size=len(block)*pieces, name="unknown.abc", mediaType="")
        for i in range(pieces):
            self.stage(file, i * len(block), block)
        self.db.start(dict(self.owner, text="attached", files=[file]))
        job = self.db.poll(dict(self.addr, supportsFiles=True), True)
        self.assertLess(len(json.dumps(job)), 10000)
        received = hashlib.sha256()
        offset = 0
        while offset < file["size"]:
            part = self.db.file_chunk(dict(self.addr, job=job["id"], index=0, offset=offset))
            received.update(base64.b64decode(part["data"]))
            offset = part["nextOffset"]
        self.assertEqual(received.hexdigest(), file["sha256"])

    def test_reject_integrity_mismatch_gaps_and_mismatched_chunk_replays(self):
        file = self.file(b"real data", "picture.gif", "image/gif")
        with self.assertRaises(Problem):
            self.stage(file, 3, b"l data")
        self.stage(file, 0, b"rea")
        with self.assertRaises(Problem):
            self.stage(file, 0, b"bad")
        with self.assertRaises(Problem):
            self.stage(file, 3, b"x data")
        with self.assertRaises(Problem):
            self.db.start(dict(self.owner, files=[file]))
        self.stage(file, 0, b"real data")
        for name in ("", "../outside", "C:\\windows\\test"):
            with self.subTest(name=name), self.assertRaises(Problem):
                self.db.start(dict(self.owner, files=[dict(file, name=name)]))
        self.db.start(dict(self.owner, files=[file]))

    def test_http_file_chunk_auth_and_offset(self):
        file = self.file(b"abc", "README", "")
        self.stage(file, 0, b"abc")
        self.db.start(dict(self.owner, files=[file]))
        job = self.db.poll(dict(self.addr, supportsFiles=True), True)
        server = Endpoint(("127.0.0.1", 0), ExtensionHandler)
        server.auth = b"Bearer fixture"
        server.journal = self.db
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        body = dict(self.addr, job=job["id"], index=0, offset=1)
        for token, status in (("wrong", 401), ("fixture", 200)):
            connection = HTTPConnection("127.0.0.1", server.server_port)
            try:
                connection.request("POST", "/v1/file-chunk", json.dumps(body),
                                   {"Content-Type":"application/json","Authorization":"Bearer "+token})
                response = connection.getresponse()
                self.assertEqual(response.status, status)
                reply = json.loads(response.read())
                if status == 200:
                    self.assertEqual(reply, {"nextOffset":3, "data":"YmM="})
            finally:
                connection.close()

    def test_completed_turn_releases_original_bytes_and_remains_idempotent(self):
        source = b"temporary original"
        file = self.file(source, "test.data", "")
        request = dict(self.owner, text="Read", files=[file])
        self.stage(file, 0, source)
        self.db.start(request)
        job = self.db.poll(dict(self.addr, supportsFiles=True), True)["id"]
        self.db.event(dict(self.addr, id="sent", job=job, kind="sent"))
        self.db.event(dict(self.addr, id="answer", replyTo=job, kind="assistant", text="done"))
        self.assertIsNone(self.db.one("SELECT 1 FROM desktop_upload_chunks WHERE data IS NOT NULL"))
        self.reopen()
        self.assertEqual(self.stage(file, 0, source), {"nextOffset":len(source)})
        with self.assertRaises(Problem):
            self.stage(file, 0, b"X" * len(source))
        self.assertEqual(self.db.start(request), {"id":"attach"})
        self.assertIsNone(self.db.poll(dict(self.addr, supportsFiles=True), True))
        self.assertIsNone(self.db.one("SELECT 1 FROM desktop_upload_chunks WHERE data IS NOT NULL"))

    def test_cancelled_or_abandoned_staging_and_rebind_release_private_copies(self):
        source = b"original!"
        file = self.file(source, "test.data", "")
        self.stage(file, 0, source[:3])
        self.db.cancel("attach", "desktop")
        self.assertIsNone(self.db.one("SELECT 1 FROM desktop_upload_chunks"))
        self.stage(file, 0, source[:3])
        with self.db.sql:
            self.db.sql.execute("UPDATE desktop_uploads SET touched=0")
        self.reopen()
        self.assertIsNone(self.db.one("SELECT 1 FROM desktop_upload_chunks"))
        self.stage(file, 0, source[:3])
        self.addr["binding"] = self.db.bind(self.chat, 7)
        self.assertIsNone(self.db.one("SELECT 1 FROM desktop_upload_chunks"))
        self.stage(file, 0, source)
        self.db.disconnect("desktop")
        self.assertIsNone(self.db.one("SELECT 1 FROM desktop_upload_chunks"))
