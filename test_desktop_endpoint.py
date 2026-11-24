import errno
import hmac
import io
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import closing, contextmanager, redirect_stdout
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch

from arena_terminal import __main__ as cli, desktop_provider
from arena_terminal.journal import Problem


class DesktopEndpointTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        self.blocker = socket.socket()
        self.addCleanup(self.blocker.close)
        self.blocker.bind(("127.0.0.1", 0))
        self.blocker.listen()
        self.default_port = self.blocker.getsockname()[1]
        # Substitute a private preferred port so the suite can run alongside a live Desktop.
        self.command = [sys.executable, "-u", "-c",
                        f"from arena_terminal import desktop_provider as d; d.DEFAULT_DESKTOP_PORT={self.default_port}; d.serve()"]
        self.environment = dict(os.environ, ARENA_DESKTOP_STATE=str(self.state))
        self.setup_line = json.dumps({"id": 1, "method": "setup", "params": {"sessionId": "desktop-test"}}) + "\n"

    @contextmanager
    def companion(self):
        with subprocess.Popen(self.command, env=self.environment, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as process:
            timeout = threading.Timer(15, process.kill)
            timeout.start()
            try:
                process.stdin.write(self.setup_line)
                process.stdin.flush()
                reply = process.stdout.readline()
                if not reply:
                    self.fail(process.stderr.read() or "Companion exited before reporting setup")
                yield process, json.loads(reply)["result"]
            finally:
                process.stdin.close()
                process.wait(timeout=10)
                timeout.cancel()

    def post(self, port, path, body, **headers):
        connection = HTTPConnection("127.0.0.1", port, timeout=3)
        try:
            connection.request("POST", "/v1/" + path, json.dumps(body),
                               {"Content-Type": "application/json", **headers})
            response = connection.getresponse()
            return response.status, json.load(response)
        finally:
            connection.close()

    def verified_bearer(self, port, token):
        nonce = "0123456789abcdef" * 2
        status, identity = self.post(port, "identity", {"nonce": nonce})
        self.assertEqual(status, 200)
        instance = identity["instance"]
        self.assertRegex(instance, r"^[a-f0-9]{32}$")
        proof = hmac.digest(token.encode(), f"arena-proof-v1|{port}|{instance}|{nonce}".encode(), "sha256").hex()
        self.assertEqual(identity, {"instance": instance, "proof": proof})
        bearer = hmac.digest(token.encode(), f"arena-auth-v1|{port}|{instance}".encode(), "sha256").hex()
        return "Bearer " + bearer

    def assert_default_authentication(self, port, token):
        address = {"chat": "https://arena.ai/agent/abc", "tab": 1}
        self.assertEqual(self.post(port, "bind", address, Authorization="Bearer " + token)[0], 200)
        bearer = self.verified_bearer(port, token)
        self.assertEqual(self.post(port, "bind", address, Authorization=bearer)[0], 200)

    def test_free_default_supports_both_legacy_and_verified_connections(self):
        self.blocker.close()
        with self.companion() as (_, setup):
            self.assertEqual(setup["port"], self.default_port)
            token = (self.state / "extension.token").read_text().strip()
            self.assertEqual(setup["pairToken"], token)
            self.assert_default_authentication(self.default_port, token)

    def test_terminal_default_supports_both_legacy_and_verified_connections(self):
        project = self.state / "project"
        project.mkdir()
        with cli.Endpoint(("127.0.0.1", 0), cli.ExtensionHandler) as server:
            def interact(_prompt):
                token = (self.state / "extension.token").read_text().strip()
                self.assert_default_authentication(server.server_port, token)
                return "/quit"

            with (patch.object(cli, "Endpoint", return_value=server),
                  patch.object(cli, "state_path", return_value=self.state),
                  patch.object(cli, "Harness", **{"return_value.instructions.return_value": ""}),
                  patch.object(sys, "argv", ["arena_terminal", "--root", str(project)]),
                  patch("builtins.input", side_effect=interact), redirect_stdout(io.StringIO())):
                cli.main()

    def test_occupied_default_requires_verified_instance_credentials(self):
        with self.companion() as (_, setup):
            port = setup["port"]
            self.assertNotEqual(port, self.default_port)
            token = (self.state / "extension.token").read_text().strip()
            self.assertEqual(setup["pairToken"], f"AHB1:{port}→{token}")
            self.assertEqual(int((self.state / "desktop.port").read_text()), port)
            nonce = "0123456789abcdef" * 2
            status, identity = self.post(port, "identity", {"nonce": nonce})
            self.assertEqual(status, 200)
            instance = identity["instance"]
            self.assertRegex(instance, r"^[a-f0-9]{32}$")
            proof = hmac.digest(token.encode(), f"arena-proof-v1|{port}|{instance}|{nonce}".encode(), "sha256").hex()
            self.assertEqual(identity, {"instance": instance, "proof": proof})
            address = {"chat": "https://arena.ai/agent/abc", "tab": 1}
            for credential in ("", token, proof):
                with self.subTest(credential=bool(credential)):
                    self.assertEqual(self.post(port, "bind", address, Authorization="Bearer " + credential)[0], 401)
            bearer = hmac.digest(token.encode(), f"arena-auth-v1|{port}|{instance}".encode(), "sha256").hex()
            self.assertEqual(self.post(port, "bind", address, Authorization="Bearer " + bearer)[0], 200)
            for body in ({}, {"nonce": 1}, {"nonce": "F" * 32}, {"nonce": "a" * 33}, {"nonce": nonce, "extra": True}):
                with self.subTest(body=body):
                    self.assertEqual(self.post(port, "identity", body)[0], 400)
            for headers, expected in (({"Authorization": "Bearer " + bearer}, 401), ({"Host": "localhost"}, 403),
                                      ({"Origin": "https://arena.ai"}, 403), ({"Content-Type": "text/plain"}, 415),
                                      ({"Content-Length": "0"}, 413)):
                with self.subTest(headers=list(headers)):
                    self.assertEqual(self.post(port, "identity", {"nonce": nonce}, **headers)[0], expected)

    def test_owner_precedes_journal_recovery_and_crash_releases_the_saved_port(self):
        with self.companion() as (first, setup):
            port = setup["port"]
            self.assertNotEqual(port, self.default_port)
            token = (self.state / "extension.token").read_text().strip()
            bearer = self.verified_bearer(port, token)
            address = {"chat": "https://arena.ai/agent/abc", "tab": 1}
            address["binding"] = self.post(port, "bind", address, Authorization=bearer)[1]["binding"]
            request = {"sessionId": "desktop-test", "requestId": "pending", "text": "test", "tools": []}
            first.stdin.write(json.dumps({"id": 2, "method": "start", "params": request}) + "\n")
            first.stdin.flush()
            self.assertIn("result", json.loads(first.stdout.readline()))
            job = self.post(port, "poll", dict(address, ready=True), Authorization=bearer)[1]["job"]["id"]
            contender = subprocess.run(self.command, env=self.environment, input=self.setup_line,
                                       capture_output=True, text=True, timeout=5)
            self.assertNotEqual(contender.returncode, 0)
            self.assertIn("ARENA_DESKTOP_STATE_IN_USE", contender.stderr)
            first.stdin.write(self.setup_line)
            first.stdin.flush()
            deliveries = json.loads(first.stdout.readline())["result"]["deliveries"]
            self.assertIn((job, "offered"), [(d["id"], d["state"]) for d in deliveries])
            # An obsolete process started while the new owner serves must also be unable to recover deliveries.
            with closing(sqlite3.connect(self.state / "desktop.sqlite", timeout=0)) as older:
                with self.assertRaisesRegex(sqlite3.OperationalError, "database is locked"):
                    older.execute("UPDATE jobs SET state='uncertain' WHERE state='offered'")
            instance = self.post(port, "identity", {"nonce": "f" * 32})[1]["instance"]
            first.kill()
            first.wait(timeout=3)
        self.blocker.close()
        with self.companion() as (_, restarted):
            self.assertEqual(restarted["port"], port)
            self.assertEqual(restarted["pairToken"], setup["pairToken"])
            self.assertNotEqual(self.post(port, "identity", {"nonce": "f" * 32})[1]["instance"], instance)

    @unittest.skipUnless(os.name == "nt", "Windows journal sharing")
    def test_read_only_journal_handle_allows_startup(self):
        path = self.state / "desktop.sqlite"
        desktop_provider.DesktopJournal(path, self.state).close()
        with path.open("rb"), self.companion() as (_, setup):
            self.assertEqual(setup["mode"], "desktop")

    @unittest.skipUnless(os.name == "nt", "Windows journal sharing")
    def test_running_legacy_companion_blocks_recovery_with_idle_database_handle(self):
        legacy = desktop_provider.DesktopJournal(self.state / "desktop.sqlite", self.state)
        try:
            with legacy.sql:
                legacy.sql.execute("INSERT INTO jobs(id,state) VALUES('active','offered')")
            contender = subprocess.run(self.command, env=self.environment, input=self.setup_line,
                                       capture_output=True, text=True, timeout=5)
            self.assertNotEqual(contender.returncode, 0)
            self.assertIn("ARENA_DESKTOP_STATE_IN_USE", contender.stderr)
            self.assertEqual(legacy.state("active"), "offered")
        finally:
            legacy.close()
        with self.companion() as (_, setup):
            self.assertIn(("active", "uncertain"), [(d["id"], d["state"]) for d in setup["deliveries"]])

    def test_occupied_saved_port_is_replaced_even_when_default_is_now_free(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            self.blocker.close()
            saved = occupied.getsockname()[1]
            (self.state / "desktop.port").write_text(str(saved), encoding="ascii")
            with self.companion() as (_, setup):
                self.assertNotEqual(setup["port"], saved)
                self.assertEqual(int((self.state / "desktop.port").read_text()), setup["port"])
            with socket.create_connection(("127.0.0.1", saved), timeout=1) as client:
                client.sendall(b"ok")
                with occupied.accept()[0] as peer:
                    self.assertEqual(peer.recv(2), b"ok")

    def test_os_denial_retries_only_on_port_zero_and_reports_failed_loopback(self):
        denied = PermissionError(errno.EACCES, "port reserved")
        with patch.dict(os.environ, self.environment), patch.object(
                desktop_provider, "Endpoint", side_effect=[denied, OSError("bind refused")]) as bind:
            with self.assertRaisesRegex(Problem, "ARENA_LOOPBACK_UNAVAILABLE"):
                desktop_provider.serve()
            self.assertEqual([args.args[0] for args in bind.call_args_list], [("127.0.0.1", 8766), ("127.0.0.1", 0)])
