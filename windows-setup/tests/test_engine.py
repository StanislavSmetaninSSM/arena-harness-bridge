"""Exercise setup through its normal entry points against a temporary Desktop and home."""

import json
import os
import ctypes
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
import zipfile


HERE = Path(__file__).resolve().parent
CSC = Path(os.environ.get("WINDIR", "C:/Windows")) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"


@unittest.skipUnless(CSC.is_file(), "Windows .NET Framework compiler required")
class SetupEngineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.build.cleanup)
        cls.tools = []
        for index, (version, body) in enumerate([("1.0.0", "first"), ("2.0.0", "second"), ("1.0.0", "other")]):
            directory = Path(cls.build.name) / str(index)
            directory.mkdir()
            payload = directory / "bridge.zip"
            with zipfile.ZipFile(payload, "w") as bundle:
                bundle.writestr(f"dsh-arena-desktop-{version}.tgz", body)
                bundle.writestr("browser-extension/manifest.json", '{"manifest_version":3}')
                bundle.writestr("browser-extension/worker.js", body)
            engine = HERE.parent / "SetupEngine.cs"
            driver = directory / "SetupTest.exe"
            subprocess.run([str(CSC), "/nologo", "/warnaserror", f"/doc:{directory / 'test.xml'}",
                            "/r:System.IO.Compression.dll", "/r:System.IO.Compression.FileSystem.dll",
                            "/r:System.Web.Extensions.dll", f"/resource:{payload},bridge.zip",
                            f"/out:{driver}", str(HERE / "EngineDriver.cs"), str(engine)], check=True)
            cls.tools.append(driver)

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="Arena Setup (Проверка) & ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.local = self.root / "Local"
        self.user = self.root / "User"
        self.profile = self.root / "custom home"
        self.install_root = self.local / "ArenaHarnessBridge/WindowsSetup"
        self.extension = self.install_root / "browser-extension/worker.js"
        self.desktop = self.local / "Programs/DeepSeek Harness/DeepSeek Harness.exe"
        self.desktop.parent.mkdir(parents=True)
        shutil.copyfile(self.tools[0], self.desktop)
        resources = self.desktop.parent / "resources"
        (resources / "runtime/cli/bin").mkdir(parents=True)
        (resources / "runtime/cli/bin/dsh.cmd").touch()
        (resources / "app.asar").touch()
        self.env = dict(os.environ, LOCALAPPDATA=str(self.local), USERPROFILE=str(self.user),
                        DSH_HOME="", ProgramFiles=str(self.root / "programs"), **{"ProgramFiles(x86)": str(self.root / "x86")})

    def driver(self, *args, build=0):
        return subprocess.run([self.tools[build], *args], capture_output=True, text=True, encoding="utf8",
                              cwd=self.root, env=self.env, timeout=15)

    def register(self, version, enabled=True):
        profile = self.profile / "profiles/desktop"
        plugin = profile / "node_modules/dsh-arena-desktop"
        plugin.mkdir(parents=True, exist_ok=True)
        (plugin / "package.json").write_text(json.dumps({"name": "dsh-arena-desktop", "version": version}))
        (profile / "package.json").write_text(json.dumps({
            "dependencies": {"dsh-arena-desktop": "file:fixture.tgz"},
            "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] +
                               (["dsh-arena-desktop"] if enabled else [])}}}))

    def test_desktop_discovery_and_profile_precedence(self):
        self.assertEqual(self.driver("desktop").stdout.strip(), str(self.desktop))
        self.assertEqual(self.driver("home", self.desktop).stdout.strip(), str(self.user / ".dsh"))
        custom = self.local / "ArenaHarnessBridge/Desktop"
        exe = custom / "app-0.2.3-alpha.2/DeepSeek Harness.exe"
        home = custom / "harness-home-0.2.3-alpha.2"
        home.mkdir(parents=True)
        self.assertEqual(self.driver("home", exe).stdout.strip(), str(home))
        self.env["DSH_HOME"] = str(self.profile)
        self.assertEqual(self.driver("home", exe).stdout.strip(), str(self.profile))

    def test_native_child_receives_exact_arguments_and_persistent_package(self):
        self.register("1.0.0")
        response = self.driver("install", self.desktop, self.profile)
        self.assertEqual(response.returncode, 0, response.stderr)
        args = (self.profile / "child.txt").read_text(encoding="utf-8-sig").splitlines()
        self.assertEqual(args[:6], ["--expose-internals", str(self.desktop.parent /
                         "resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"),
                         "plugin", "--profile", "desktop", "add"])
        self.assertEqual(len(args), 8)
        self.assertEqual(args[-1], "1")
        package = Path(args[-2])
        self.assertTrue(package.is_relative_to(self.install_root))
        self.assertEqual(package.read_text(), "first")
        self.assertEqual(self.extension.read_text(), "first")
        self.assertEqual(self.driver("install", self.desktop, self.profile).returncode, 0)
        self.assertEqual(self.driver("install", self.desktop, self.profile, build=2).returncode, 1)
        self.assertEqual(package.read_text(), "first")
        self.assertEqual(self.extension.read_text(), "first")

    def test_failed_upgrade_preserves_extension_and_profile(self):
        self.register("1.0.0")
        response = self.driver("install", self.desktop, self.profile)
        self.assertEqual(response.returncode, 0, response.stderr)
        token = self.profile / "pairing.json"
        token.write_text("existing token")
        (self.profile / "reject").touch()
        rejected = self.driver("install", self.desktop, self.profile, build=1)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("incompatible plugin version", rejected.stderr)
        self.assertEqual(self.extension.read_text(), "first")
        (self.profile / "reject").unlink()
        self.assertNotEqual(self.driver("install", self.desktop, self.profile, build=1).returncode, 0)
        self.register("2.0.0", enabled=False)
        self.assertNotEqual(self.driver("install", self.desktop, self.profile, build=1).returncode, 0)
        self.assertEqual(self.extension.read_text(), "first")
        self.register("2.0.0")
        self.assertEqual(self.driver("install", self.desktop, self.profile, build=1).returncode, 0)
        self.assertEqual(self.extension.read_text(), "second")
        self.assertEqual(token.read_text(), "existing token")

    def test_running_or_missing_desktop_is_rejected_before_install(self):
        self.assertNotEqual(self.driver("install", self.root / "absent.exe", self.profile).returncode, 0)
        with subprocess.Popen([self.desktop, "hold"], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as running:
            try:
                self.assertEqual(running.stdout.readline().strip(), b"ready")
                response = self.driver("install", self.desktop, self.profile)
                self.assertNotEqual(response.returncode, 0)
                self.assertIn("quit", response.stderr.lower())
                self.assertIsNone(running.poll())
            finally:
                running.communicate(b"\n", timeout=5)
        self.assertFalse((self.profile / "child.txt").exists())

    def test_new_home_needs_desktop_initialization_before_any_install(self):
        response = self.driver("install", self.desktop, self.profile)
        self.assertNotEqual(response.returncode, 0)
        self.assertIn("start desktop", response.stderr.lower())
        self.assertFalse(self.profile.exists())
        self.assertFalse(self.install_root.exists())

    def test_selected_profile_pid_lock_ignores_a_dead_owner(self):
        self.register("1.0.0")
        lock = self.profile / "profiles/desktop/lock"
        lock.write_text(str(os.getpid()))
        response = self.driver("install", self.desktop, self.profile)
        self.assertNotEqual(response.returncode, 0)
        self.assertIn("profile", response.stderr.lower())
        self.assertFalse((self.profile / "child.txt").exists())
        lock.write_text("2147483647")
        self.assertEqual(self.driver("install", self.desktop, self.profile).returncode, 0)
        self.assertEqual(lock.read_text(), "2147483647")

    def test_other_desktop_copy_with_same_home_is_rejected(self):
        self.register("1.0.0")
        other = self.root / "another copy" / self.desktop.name
        other.parent.mkdir()
        shutil.copyfile(self.desktop, other)
        with subprocess.Popen([other, "hold"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              env=dict(self.env, DSH_HOME=str(self.profile))) as running:
            try:
                self.assertEqual(running.stdout.readline().strip(), b"ready")
                response = self.driver("install", self.desktop, self.profile)
                self.assertNotEqual(response.returncode, 0)
                self.assertIn("quit", response.stderr.lower())
                self.assertFalse((self.profile / "child.txt").exists())
            finally:
                running.communicate(b"\n", timeout=5)

    def test_locked_extension_allows_identical_repeat_but_stops_upgrade_before_cli(self):
        self.register("1.0.0")
        self.assertEqual(self.driver("install", self.desktop, self.profile).returncode, 0)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.restype = ctypes.c_void_p
        handle = kernel.CreateFileW(str(self.extension.parent), 0x80000000, 3, None, 3, 0x02000000, None)
        self.assertNotEqual(handle, ctypes.c_void_p(-1).value)
        try:
            with self.assertRaises(PermissionError):
                self.extension.parent.rename(self.install_root / "rename-probe")
            repeated = self.driver("install", self.desktop, self.profile)
            self.assertEqual(repeated.returncode, 0, repeated.stderr)
            (self.profile / "child.txt").unlink()
            self.register("2.0.0")
            upgrade = self.driver("install", self.desktop, self.profile, build=1)
            self.assertNotEqual(upgrade.returncode, 0)
            self.assertFalse((self.profile / "child.txt").exists())
            self.assertEqual(self.extension.read_text(), "first")
        finally:
            kernel.CloseHandle(ctypes.c_void_p(handle))

    def test_interrupted_upgrade_recovers_on_retry(self):
        self.register("1.0.0")
        self.assertEqual(self.driver("install", self.desktop, self.profile).returncode, 0)
        child = self.profile / "child.txt"
        child.unlink()
        gate = self.profile / "pause"
        gate.touch()
        with subprocess.Popen([self.tools[1], "install", self.desktop, self.profile], cwd=self.root,
                              env=self.env, stdout=subprocess.DEVNULL) as setup:
            try:
                deadline = time.monotonic() + 10
                while not child.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(child.exists())
                self.assertEqual(self.extension.read_text(), "second")
            finally:
                setup.kill()
                setup.wait(5)
                gate.unlink()
        # The briefly surviving CLI must finish before setup can use this home.
        rejected = self.profile / "reject"
        rejected.touch()
        for _ in range(30):
            result = self.driver("install", self.desktop, self.profile, build=1)
            if "incompatible" in result.stderr:
                break
            time.sleep(0.05)
        self.assertIn("incompatible", result.stderr)
        self.assertEqual(self.extension.read_text(), "first")


if __name__ == "__main__":
    unittest.main()
