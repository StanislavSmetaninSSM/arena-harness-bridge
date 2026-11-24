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
import zipfile

from scripts import build_windows_release

ROOT = Path(__file__).resolve().parent


@unittest.skipUnless(shutil.which("npm.cmd") or shutil.which("npm"), "npm is required")
class WindowsReleaseTests(unittest.TestCase):
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
            with patch.object(sys, "argv", ["build_windows_release.py", "--version", "0.1.0", "--output", str(output)]), \
                    patch.object(build_windows_release, "check_headless_release") as check:
                build_windows_release.main()
                check.assert_called_once()
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
                    self.assertEqual(installed, python_files | {
                        "package/package.json", "package/index.mjs", "package/provider.mjs", "package/tool-help.mjs",
                        "package/outgoing-image.mjs", "package/original-files.mjs", "package/original-files.client.js",
                        "package/pairing.mjs", "package/pairing.ps1",
                        "package/companion.mjs", "package/cordis.patch.yml", "package/README.md", "package/LICENSE",
                    })

    def test_failed_release_check_preserves_previous_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / "arena-harness-bridge-v0.1.0-windows.zip"
            archive.write_bytes(b"previous archive")
            with patch.object(sys, "argv", ["build_windows_release.py", "--version", "0.1.0", "--output", temp]), \
                    patch.object(build_windows_release, "check_headless_release", side_effect=RuntimeError("headless failed")):
                with self.assertRaisesRegex(RuntimeError, "headless failed"):
                    build_windows_release.main()
            self.assertEqual(archive.read_bytes(), b"previous archive")

    def test_skipped_headless_suite_blocks_release(self):
        environment = os.environ.copy()
        environment.pop("ARENA_DSH_PREFIX", None)
        result = subprocess.run([sys.executable, str(ROOT / "test_headless_harness.py"), "--release-check"],
                                env=environment, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("skipped=3", result.stderr)


if __name__ == "__main__":
    unittest.main()
