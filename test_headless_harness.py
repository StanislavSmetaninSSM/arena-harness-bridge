"""Acceptance test with the real DeepSeek Harness, the real Desktop plugin and the real companion.

`dsh headless --json` runs the Harness without a window, loads desktop-plugin and
starts arena_terminal.desktop_provider from this checkout or the packaged release. Only the Arena page is
scripted: a thread speaks the extension's wire protocol on its selected loopback port and plays
prepared replies. browser-extension/ itself is covered by its own Node and Chrome tests.

The suite is skipped unless ARENA_DSH_PREFIX names an npm prefix holding both packages:

    npm install --prefix <dir> @deepseek-ai/dsh@0.2.2-rc.5
    npm install --prefix <dir> --install-links ./desktop-plugin
    ARENA_DSH_PREFIX=<dir> python -m unittest test_headless_harness

--install-links copies the plugin, so repeat the second command after editing desktop-plugin/.
Use a Node version supported by the Harness under test. Node 24.22.3 works for both release targets. Port 8766 must be free.
The release builder runs --release-check with the packaged plugin and treats skipped cases as failures.
"""
import hmac
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection
from pathlib import Path
from uuid import uuid4

from arena_terminal.__main__ import read_pairing
from arena_terminal.desktop_provider import DesktopJournal

REPOSITORY = Path(__file__).resolve().parent
PREFIX = os.environ.get("ARENA_DSH_PREFIX")
RELEASE_CHECK = __name__ == "__main__" and sys.argv[1:] == ["--release-check"]
PORT = 8766
CHAT, TAB = "https://arena.ai/agent/headless-test", 1
# browser-extension/adapter.js reports this instead of a tool source when a reply holds several marked objects.
SEVERAL_COMMANDS = "Arena returned more than one marked tool command. No command was run."


def port_is_free(port=PORT, patience=6):
    """Try the bind the companion will make. A companion outlives its Harness process by a moment."""
    deadline = time.monotonic() + patience
    while True:
        with socket.socket() as probe:
            if os.name != "nt":  # On Windows this option would let the probe share a busy port.
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
                return True
            except OSError:
                pass
        if time.monotonic() > deadline:
            return False
        time.sleep(0.1)


def marked(delivery, name, arguments):
    return json.dumps({"$harness":"tool_call", "turn_id":delivery, "name":name, "arguments":arguments})


def harness_environment(home, state, bridge_root, release):
    env = {**os.environ, "DSH_HOME":str(home), "ARENA_DESKTOP_STATE":str(state)}
    if release and os.name == "nt":
        env.pop("ARENA_BRIDGE_ROOT", None)
        env.pop("ARENA_PYTHON", None)
        env["PATH"] = os.pathsep.join(entry for entry in os.get_exec_path(env)
                                      if not (Path(entry.strip('"')) / "python.exe").exists())
    else:
        env.update(ARENA_BRIDGE_ROOT=str(bridge_root), ARENA_PYTHON=sys.executable)
    return env


class ScriptedPage(threading.Thread):
    """Poll the companion as the extension does and answer each delivery from a prepared list."""

    def __init__(self, token, port, binding, replies):
        super().__init__(daemon=True)
        self.token = token
        self.port = port
        self.address = {"chat":CHAT, "tab":TAB, "binding":binding}
        self.replies = list(replies)
        self.deliveries, self.refusals = [], []
        self.stop = threading.Event()

    def post(self, path, body):
        nonce = uuid4().hex
        identity = self.exchange("identity", {"nonce":nonce})
        instance = identity["instance"]
        key = self.token.encode("ascii")
        proof = f"arena-proof-v1|{self.port}|{instance}|{nonce}".encode("ascii")
        if not hmac.compare_digest(identity["proof"], hmac.digest(key, proof, "sha256").hex()):
            raise AssertionError("Scripted page could not verify its companion")
        context = f"arena-auth-v1|{self.port}|{instance}".encode("ascii")
        credential = hmac.digest(key, context, "sha256").hex()
        return self.exchange(path, body, credential)

    def exchange(self, path, body, credential=None):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=4)
        headers = {"Content-Type":"application/json", "Origin":"chrome-extension://" + "a" * 32}
        if credential is not None:
            headers["Authorization"] = "Bearer " + credential
        try:
            connection.request("POST", "/v1/" + path, json.dumps(body).encode(), headers)
            response = connection.getresponse()
            data = json.load(response)
            if response.status != 200:
                self.refusals.append((path, response.status, data))
            return data
        finally:
            connection.close()

    def event(self, kind, **fields):
        self.post("event", {**self.address, "id":uuid4().hex, "kind":kind, **fields})

    def run(self):
        while not self.stop.wait(0.1):
            try:
                job = self.post("poll", {**self.address, "ready":True, "supportsPngBatch":True,
                                         "supportsNativeQuestions":True}).get("job")
                if not job:
                    continue
                self.deliveries.append(job["text"])
                self.event("sent", job=job["id"])
                reply = self.replies.pop(0)(job["id"]) if self.replies else {"text":"The scripted page has no reply left."}
                self.event("assistant", replyTo=job["id"], **reply)
            except OSError:
                pass  # The companion lives only while a Harness process is running.


@unittest.skipUnless(PREFIX, "set ARENA_DSH_PREFIX to an npm prefix with @deepseek-ai/dsh and dsh-arena-desktop")
class HeadlessHarness(unittest.TestCase):
    def setUp(self):
        modules = Path(PREFIX).resolve() / "node_modules"
        self.dsh = modules / "@deepseek-ai" / "dsh" / "lib" / "bin.js"
        plugin = modules / "dsh-arena-desktop" / "index.mjs"
        self.bridge_root = plugin.parent if RELEASE_CHECK else REPOSITORY
        self.node = shutil.which("node")
        if not (self.node and self.dsh.is_file() and plugin.is_file()):
            self.skipTest("node, @deepseek-ai/dsh or dsh-arena-desktop is missing")
        if not port_is_free():
            self.skipTest(f"port {PORT} is in use")
        temporary = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name).resolve()
        self.state, self.home, self.work = directory / "state", directory / "home", directory / "work"
        for path in (self.state, self.home, self.work):
            path.mkdir()
        (self.work / "a.txt").write_text("alpha-" + uuid4().hex + "\n", encoding="utf-8")
        (self.work / "b.txt").write_text("beta-" + uuid4().hex + "\n", encoding="utf-8")
        self.patch = directory / "patch.yml"
        self.patch.write_text(
            "- id: agent-default-model\n  config:\n    provider: arena\n    model: agent-mode\n"
            f"- insert:\n    - id: arena-desktop\n      name: {plugin.as_uri()}\n", encoding="utf-8")
        self.page = None
        self.addCleanup(self.stop_page)

    def stop_page(self):
        if self.page:
            self.page.stop.set()
            self.page.join(timeout=6)
            self.assertFalse(self.page.is_alive())

    def harness(self, task, *options):
        environment = harness_environment(self.home, self.state, self.bridge_root, RELEASE_CHECK)
        port_file = self.state / "desktop.port"
        if port_file.is_file():
            previous = int(port_file.read_text(encoding="ascii").strip())
            self.assertTrue(port_is_free(previous), f"the previous test companion still holds port {previous}")
        run = subprocess.run([self.node, str(self.dsh), "headless", "--patch", str(self.patch), "--json",
                              "--approval-policy", "never", *options, task],
                             cwd=self.work, env=environment, capture_output=True, text=True, encoding="utf-8", timeout=90)
        events = [json.loads(line) for line in run.stdout.splitlines() if line.startswith("{")]
        self.assertTrue(events and events[-1]["type"] == "final", run.stderr[-2000:])
        expected_exit = 0 if events[-1]["reason"]["kind"] == "completed" else 1
        self.assertEqual(run.returncode, expected_exit, run.stderr[-2000:])
        return events

    def session(self, *replies):
        """Create a Harness session, then pair and bind it as /arena-pair and the extension would."""
        refused = self.harness("Create the session")
        self.assertEqual(refused[-1]["reason"]["kind"], "error")
        self.assertIn("Open Connect Arena", refused[-1]["reason"]["error"]["message"])
        self.assertFalse([event for event in refused if event["type"] == "tool_call"])
        session = refused[0]["sessionId"]
        token = read_pairing(self.state)
        journal = DesktopJournal(self.state / "desktop.sqlite", self.state)
        try:
            journal.pair_owner(session)
            binding = journal.bind(CHAT, TAB)
        finally:
            journal.close()
        port = int((self.state / "desktop.port").read_text(encoding="ascii").strip())
        self.page = ScriptedPage(token, port, binding, replies)
        self.page.start()
        return session

    def turn(self, task, *replies):
        events = self.harness(task, "--session-id", self.session(*replies))
        time.sleep(0.3)  # Let a delivery that should not exist reach the page before counting.
        self.assertEqual(self.page.refusals, [])
        return events, [event for event in events if event["type"] == "tool_call"]

    def test_one_marked_command_runs_and_its_result_returns_to_arena(self):
        content = (self.work / "a.txt").read_text(encoding="utf-8").strip()
        events, calls = self.turn(
            "Read a.txt",
            lambda delivery: {"text":"Reading.", "toolFrame":True,
                              "toolSource":marked(delivery, "read", {"file_path":"a.txt"})},
            lambda delivery: {"text":"The file was read."})
        self.assertEqual([(call["tool"], call["input"]) for call in calls], [("read", {"file_path":"a.txt"})])
        result, = [event for event in events if event["type"] == "tool_result"]
        self.assertEqual((result["callId"], result["status"]), (calls[0]["callId"], "completed"))
        self.assertIn(content, result["result"])
        self.assertEqual((events[-1]["reason"]["kind"], events[-1]["text"]), ("completed", "The file was read."))
        request, returned = self.page.deliveries
        self.assertIn("Read a.txt", request)
        self.assertIn(calls[0]["callId"], returned)
        self.assertIn(content, returned)

    def test_busy_preferred_port_still_delivers_a_complete_harness_turn(self):
        with socket.socket() as other:
            other.bind(("127.0.0.1", PORT))
            other.listen()
            events, calls = self.turn("Check the connection", lambda delivery: {"text":"Fallback reached Desktop."})
            self.assertNotEqual(self.page.port, PORT)
            self.assertEqual(calls, [])
            self.assertEqual(events[-1]["text"], "Fallback reached Desktop.")
            self.assertEqual(events[-1]["reason"]["kind"], "completed")
            other.setblocking(False)
            with self.assertRaises(BlockingIOError):
                other.accept()

    def test_two_marked_commands_in_one_reply_run_nothing_and_end_the_turn(self):
        # Current contract: one command per Arena reply. The page withholds the tool source,
        # the Harness receives prose, and the model is not asked to repeat the commands one at a time.
        events, calls = self.turn(
            "Read a.txt and b.txt",
            lambda delivery: {"text":"Reading both files.\n\n" + SEVERAL_COMMANDS})
        self.assertEqual(calls, [])
        self.assertEqual(events[-1]["reason"]["kind"], "completed")
        self.assertTrue(events[-1]["text"].endswith(SEVERAL_COMMANDS))
        self.assertEqual(len(self.page.deliveries), 1)

    def test_two_objects_in_one_tool_source_are_refused_by_the_companion(self):
        # Defence in depth: a page that handed over both objects must not get either of them run.
        events, calls = self.turn(
            "Read a.txt and b.txt",
            lambda delivery: {"text":"Reading both files.", "toolFrame":True,
                              "toolSource":marked(delivery, "read", {"file_path":"a.txt"}) + "\n"
                                           + marked(delivery, "read", {"file_path":"b.txt"})})
        self.assertEqual(calls, [])
        self.assertEqual(events[-1]["reason"]["kind"], "error")
        self.assertIn("invalid JSON for a local tool", events[-1]["reason"]["error"]["message"])
        self.assertEqual(len(self.page.deliveries), 1)


if __name__ == "__main__":
    if RELEASE_CHECK:
        result = unittest.main(argv=[sys.argv[0]], verbosity=2, exit=False).result
        if not result.wasSuccessful() or result.skipped or result.testsRun < 4:
            sys.exit("Release check requires all four headless scenarios to run and pass.")
    else:
        unittest.main()
