import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

from scripts import build_windows_release
import test_headless_harness as harness_tests

ROOT = Path(__file__).resolve().parent


@unittest.skipUnless(shutil.which("npm.cmd") or shutil.which("npm"), "npm is required")
class WindowsReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.python_zip = Path(temporary.name) / "embed.zip"
        self.runtime_files = {
            "python.exe": b"test runtime", "_sqlite3.pyd": b"test extension", "sqlite3.dll": b"sqlite",
            "python314.zip": b"stdlib", "LICENSE.txt": b"Python license",
            "python314._pth": b"python314.zip\r\n.\r\n#import site\r\n",
        }
        with zipfile.ZipFile(self.python_zip, "w") as archive:
            for name, data in self.runtime_files.items():
                archive.writestr(name, data)
        digest = hashlib.sha256(self.python_zip.read_bytes()).hexdigest()
        self.enterContext(patch.object(build_windows_release, "PYTHON_SHA256", digest))

    def build(self, output):
        with patch.object(sys, "argv", ["build_windows_release.py", "--version", "0.1.0", "--output",
                                        str(output), "--python-embed", str(self.python_zip)]):
            build_windows_release.main()

    def test_modified_runtime_is_rejected_before_packing_or_publishing(self):
        with self.python_zip.open("ab") as runtime:
            runtime.write(b"modified")
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                self.build(temp)
            self.assertEqual(list(Path(temp).iterdir()), [])

    @unittest.skipUnless(os.name == "nt", "Windows release runtime")
    def test_release_harness_has_no_system_python_or_development_tree_override(self):
        directory = self.python_zip.parent
        system = directory / "python"
        node = directory / "node"
        system.mkdir()
        node.mkdir()
        (system / "python.exe").touch()
        with patch.dict(os.environ, {"PATH":os.pathsep.join(map(str, [node, system])),
                                     "ARENA_PYTHON":sys.executable, "ARENA_BRIDGE_ROOT":"dev"}):
            release = harness_tests.harness_environment(directory, directory, directory, True)
            dev = harness_tests.harness_environment(directory, directory, directory, False)
        self.assertEqual(release["PATH"], str(node))
        self.assertNotIn("ARENA_PYTHON", release)
        self.assertNotIn("ARENA_BRIDGE_ROOT", release)
        self.assertEqual(dev["ARENA_PYTHON"], sys.executable)
        self.assertEqual(dev["ARENA_BRIDGE_ROOT"], str(directory))

    def test_release_installs_cli_and_plugin_peers_at_the_same_version(self):
        manifest = json.loads((ROOT / "desktop-plugin/package.json").read_text(encoding="utf-8"))
        peers = [name for name in manifest["peerDependencies"] if name.startswith("@deepseek-ai/dsh-")]
        versions = [v.strip() for v in manifest["peerDependencies"]["@deepseek-ai/dsh-llm"].split("||")]
        pending = iter(versions)
        checked = []

        def simulate(command, *, cwd, check, env=None):
            self.assertTrue(check)
            if command[0] == "npm":
                version = next(pending)
                for name in ["@deepseek-ai/dsh", *peers]:
                    self.assertIn(f"{name}@{version}", command)
                    path = Path(cwd, "node_modules", name, "package.json")
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps({"version": version}), encoding="utf-8")
            else:
                self.assertIn("--release-check", command)
                self.assertEqual(Path(env["ARENA_DSH_PREFIX"]), Path(cwd))
                installed = Path(cwd, "node_modules/@deepseek-ai/dsh/package.json")
                checked.append(json.loads(installed.read_text(encoding="utf-8"))["version"])

        with patch.object(subprocess, "run", side_effect=simulate):
            build_windows_release.check_headless_release("npm", Path("candidate.tgz"), manifest)
        self.assertEqual(checked, versions)

    def test_windows_zip_contains_a_self_contained_desktop_package(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            with patch.object(build_windows_release, "check_headless_release") as check, \
                    patch.object(build_windows_release, "compile_setup", side_effect=lambda archive, exe: exe.write_bytes(archive.read_bytes())):
                self.build(output)
                check.assert_called_once()
            self.assertEqual((output / "Arena-Harness-Bridge-Setup.exe").read_bytes(),
                             (output / "arena-harness-bridge-v0.1.0-windows.zip").read_bytes())
            with zipfile.ZipFile(output / "arena-harness-bridge-v0.1.0-windows.zip") as bundle:
                manifest = json.loads(bundle.read("browser-extension/manifest.json"))
                expected = {
                    manifest["action"]["default_popup"],
                    manifest["background"]["service_worker"],
                    "popup.js", "THIRD_PARTY_NOTICES.txt",
                }
                expected.update(file for entry in manifest["content_scripts"] for file in entry["js"])
                packages = [name for name in bundle.namelist() if name.endswith(".tgz")]
                self.assertEqual(len(packages), 1)
                self.assertEqual(set(bundle.namelist()), {
                    "INSTALL.md", "INSTALL.en.md", "LICENSE", packages[0], "browser-extension/manifest.json",
                    *("browser-extension/" + name for name in expected),
                })
                for guide in ("INSTALL.md", "INSTALL.en.md"):
                    self.assertEqual(bundle.read(guide), (ROOT / guide).read_bytes())
                with tarfile.open(fileobj=io.BytesIO(bundle.read(packages[0])), mode="r:gz") as plugin:
                    installed = set(plugin.getnames())
                    python_files = {"package/arena_terminal/" + p.name for p in (ROOT / "arena_terminal").glob("*.py")}
                    self.assertTrue(python_files)
                    self.assertEqual({name for name in installed if "/arena_terminal/" in name}, python_files)
                    for name, data in self.runtime_files.items():
                        packed = plugin.extractfile("package/windows-python/" + name).read()
                        if name.endswith("._pth"):
                            entries = [s for s in packed.decode().splitlines() if s and not s.startswith("#")]
                            self.assertEqual(entries, ["python314.zip", ".", ".."])
                        else:
                            self.assertEqual(packed, data)
                    runtime = {"package/windows-python/" + name for name in self.runtime_files}
                    self.assertEqual(installed, python_files | runtime | {
                        "package/package.json", "package/index.mjs", "package/provider.mjs", "package/tool-help.mjs",
                        "package/outgoing-image.mjs", "package/original-files.mjs", "package/original-files.client.js",
                        "package/pairing.mjs", "package/pairing.ps1",
                        "package/companion.mjs", "package/cordis.patch.yml", "package/README.md", "package/LICENSE",
                    })

    def test_failed_release_check_preserves_previous_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / "arena-harness-bridge-v0.1.0-windows.zip"
            archive.write_bytes(b"previous archive")
            exe = Path(temp) / "Arena-Harness-Bridge-Setup.exe"
            exe.write_bytes(b"previous installer")
            with patch.object(build_windows_release, "check_headless_release", side_effect=RuntimeError("headless failed")):
                with self.assertRaisesRegex(RuntimeError, "headless failed"):
                    self.build(temp)
            self.assertEqual(archive.read_bytes(), b"previous archive")
            self.assertEqual(exe.read_bytes(), b"previous installer")

    def test_compiler_failure_does_not_replace_a_previous_release(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            zip_path = output / "arena-harness-bridge-v0.1.0-windows.zip"
            setup = output / "Arena-Harness-Bridge-Setup.exe"
            zip_path.write_bytes(b"previous archive")
            setup.write_bytes(b"previous setup")
            with patch.object(build_windows_release, "check_headless_release"), \
                    patch.object(build_windows_release, "compile_setup", side_effect=RuntimeError("compiler failed")):
                with self.assertRaisesRegex(RuntimeError, "compiler failed"):
                    self.build(output)
            self.assertEqual(zip_path.read_bytes(), b"previous archive")
            self.assertEqual(setup.read_bytes(), b"previous setup")

    def test_installer_replacement_failure_rolls_back_the_published_zip(self):
        for existing_zip in [False, True]:
            with self.subTest(existing_zip=existing_zip), tempfile.TemporaryDirectory() as temp:
                output = Path(temp)
                stage = output / "stage"
                stage.mkdir()
                archive = stage / "candidate.zip"
                exe = stage / "setup.exe"
                archive.write_bytes(b"new")
                exe.write_bytes(b"new")
                previous = output / archive.name
                if existing_zip:
                    previous.write_bytes(b"old")
                # A directory in place of the installer causes the second replacement to fail.
                (output / exe.name).mkdir()
                with self.assertRaises(OSError):
                    build_windows_release.publish_release(archive, exe, output)
                self.assertEqual(previous.read_bytes() if previous.exists() else None,
                                 b"old" if existing_zip else None)

    @unittest.skipUnless(os.name == "nt", "Requires the Windows Framework compiler")
    def test_windows_executable_embeds_the_exact_candidate_zip(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            payload = output / "release candidate.zip"
            payload.write_bytes(b"arbitrary candidate bytes")
            exe = output / "Bridge Setup.exe"
            build_windows_release.compile_setup(payload, exe)
            raw = exe.read_bytes()
            pe = int.from_bytes(raw[60:64], 'little')
            self.assertEqual(raw[pe:pe + 6], b"PE\x00\x00\x64\x86")  # AMD64
            self.assertEqual(int.from_bytes(raw[pe + 24 + 68:pe + 24 + 70], "little"), 2)  # Windows GUI
            start = raw.index(b"<assembly xmlns=")
            end = raw.index(b"</assembly>", start) + len(b"</assembly>")
            manifest = ET.fromstring(raw[start:end])
            privileges = manifest.find(".//{urn:schemas-microsoft-com:asm.v3}requestedExecutionLevel")
            self.assertEqual(privileges.attrib, {"level":"asInvoker", "uiAccess":"false"})
            probe = ("$assembly = [Reflection.Assembly]::LoadFile($env:TEST_SETUP_EXE); "
                     "$stream = $assembly.GetManifestResourceStream('bridge.zip'); "
                     "$memory = New-Object IO.MemoryStream; $stream.CopyTo($memory); "
                     "[Convert]::ToBase64String($memory.ToArray())")
            result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", probe],
                                    env={**os.environ, "TEST_SETUP_EXE":str(exe)}, capture_output=True,
                                    text=True, check=True)
            self.assertEqual(base64.b64decode(result.stdout.strip(), validate=True), payload.read_bytes())

    def test_skipped_headless_suite_blocks_release(self):
        environment = os.environ.copy()
        environment.pop("ARENA_DSH_PREFIX", None)
        result = subprocess.run([sys.executable, str(ROOT / "test_headless_harness.py"), "--release-check"],
                                env=environment, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("skipped=4", result.stderr)


if __name__ == "__main__":
    unittest.main()
