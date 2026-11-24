"""Build the Windows release ZIP from the bridge source checkout."""

import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory
import zipfile


ROOT = Path(__file__).resolve().parents[1]
PLUGIN_FILES = (
    "companion.mjs", "cordis.patch.yml", "index.mjs", "outgoing-image.mjs",
    "package.json", "pairing.mjs", "pairing.ps1", "provider.mjs", "tool-help.mjs", "README.md",
)
EXTENSION_FILES = (
    "adapter.js", "content.js", "core.js", "generated-images.js", "manifest.json",
    "native-questions.js", "popup.html", "popup.js", "raw-reply.js",
    "THIRD_PARTY_NOTICES.txt", "worker.js",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="Release version without a leading v")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version):
        parser.error("Expected a version like 0.1.0")
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        parser.error("npm must be on PATH to pack the Desktop plugin")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    filename = f"arena-harness-bridge-v{args.version}-windows.zip"

    with TemporaryDirectory(dir=output) as scratch:
        stage = Path(scratch)
        plugin = stage / "desktop-plugin"
        plugin.mkdir()
        for name in PLUGIN_FILES:
            shutil.copyfile(ROOT / "desktop-plugin" / name, plugin / name)
        shutil.copyfile(ROOT / "LICENSE", plugin / "LICENSE")
        companion = plugin / "arena_terminal"
        companion.mkdir()
        for source in (ROOT / "arena_terminal").glob("*.py"):
            shutil.copyfile(source, companion / source.name)

        result = subprocess.run(
            [npm, "pack", ".", "--ignore-scripts", "--json", "--pack-destination", str(stage)],
            cwd=plugin, check=True, capture_output=True, text=True, encoding="utf-8",
        )
        package = stage / json.loads(result.stdout)[0]["filename"]
        sources = {name: ROOT / name for name in ("INSTALL.md", "INSTALL.en.md", "LICENSE")}
        sources[package.name] = package
        sources.update({
            "browser-extension/" + name: ROOT / "browser-extension" / name
            for name in EXTENSION_FILES
        })
        temporary_zip = stage / filename
        with zipfile.ZipFile(temporary_zip, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, source in sorted(sources.items()):
                entry = zipfile.ZipInfo(name)
                entry.external_attr = 0o100644 << 16
                archive.writestr(entry, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
        temporary_zip.replace(output / filename)
    print(output / filename)


if __name__ == "__main__":
    main()
