import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parent


@unittest.skipUnless(shutil.which("npm.cmd") or shutil.which("npm"), "npm is required")
class WindowsReleaseTests(unittest.TestCase):
    def test_windows_zip_contains_a_self_contained_desktop_package(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            subprocess.run([
                sys.executable, str(ROOT / "scripts/build_windows_release.py"),
                "--version", "0.1.0", "--output", str(output),
            ], check=True, cwd=output, capture_output=True)
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
                        "package/outgoing-image.mjs", "package/pairing.mjs", "package/pairing.ps1",
                        "package/companion.mjs", "package/cordis.patch.yml", "package/README.md", "package/LICENSE",
                    })


if __name__ == "__main__":
    unittest.main()
