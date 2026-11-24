"""Build the Windows release ZIP from the bridge source checkout."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
import zipfile


ROOT = Path(__file__).resolve().parents[1]
PLUGIN_FILES = (
    "companion.mjs", "cordis.patch.yml", "index.mjs", "outgoing-image.mjs",
    "original-files.mjs", "original-files.client.js",
    "package.json", "pairing.mjs", "pairing.ps1", "provider.mjs", "tool-help.mjs", "README.md",
)
EXTENSION_FILES = (
    "adapter.js", "content.js", "core.js", "generated-images.js", "manifest.json",
    "native-questions.js", "popup.html", "popup.js", "raw-reply.js",
    "THIRD_PARTY_NOTICES.txt", "worker.js",
)


def check_headless_release(npm, package, plugin_manifest):
    """Exercise the candidate tarball using every supported Harness CLI before publishing the ZIP."""
    peers = plugin_manifest["peerDependencies"]
    harness_packages = ["@deepseek-ai/dsh", *(name for name in peers if name.startswith("@deepseek-ai/dsh-"))]
    peer_spec = peers["@deepseek-ai/dsh-llm"]
    for entry in peer_spec.split("||"):
        version = entry.strip()
        if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[\w.-]+)?", version):
            raise ValueError(f"Expected an exact Harness version in the release matrix, got {version!r}")
        print(f"Running the headless release check with DeepSeek Harness {version}", flush=True)
        with TemporaryDirectory(prefix="arena-headless-") as prefix:
            Path(prefix, "package.json").write_text('{"private":true}\n', encoding="utf-8")
            # npm may otherwise resolve the plugin's peer range to a newer Harness than the CLI.
            pins = [f"{name}@{version}" for name in harness_packages]
            subprocess.run([npm, "install", "--no-audit", "--no-fund", "--prefer-offline",
                            *pins, str(package)], cwd=prefix, check=True)
            for name in harness_packages:
                installed = Path(prefix, "node_modules", name, "package.json")
                actual = json.loads(installed.read_text(encoding="utf-8"))["version"]
                if actual != version:
                    raise ValueError(f"Expected {name} {version} for headless tests, found {actual}")
            subprocess.run([sys.executable, str(ROOT / "test_headless_harness.py"), "--release-check"],
                           cwd=prefix, env={**os.environ, "ARENA_DSH_PREFIX": prefix}, check=True)


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
        check_headless_release(npm, package, json.loads((plugin / "package.json").read_text(encoding="utf-8")))
        temporary_zip.replace(output / filename)
    print(output / filename)


if __name__ == "__main__":
    main()
