# Windows release build

Use 64-bit Windows, Python, npm and the .NET Framework C# compiler. Node.js 24.22.3 can run both supported Harness versions. The build needs access to the npm registry and the pinned Python embeddable distribution. The headless tests use private loopback ports and exercise the automatic fallback with a separate listener. To use a cached official Python ZIP, pass its path with `--python-embed`; the builder checks the same SHA-256 as for a download.

```powershell
$bridgeVersion = Read-Host 'Bridge version to build (without v)'
python scripts/build_windows_release.py --version $bridgeVersion
```

The builder packs the plugin, Python companion, private Python runtime, Chrome extension and both installation guides. It tests the actual plugin package with the Harness CLI for every version declared in the plugin’s peer dependencies. The tests use scripted Arena replies. Each scenario must run successfully. Distribute the installer and manual ZIP together from `dist/`.

For the development test suites, first install the pinned Harness checkout and dependencies described in the [adapter guide](harness-adapter/README.md) and [plugin guide](desktop-plugin/README.md).

```powershell
python -m unittest discover
python -m unittest discover -s windows-setup/tests
node --test browser-extension/tests/*.test.cjs desktop-plugin/test/*.test.mjs harness-adapter/test/*.test.mjs
```
