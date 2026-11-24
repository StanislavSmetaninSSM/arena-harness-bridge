# Install Arena Harness Bridge on Windows

[Инструкция на русском](INSTALL.md)

You’ll need **DeepSeek Harness Desktop**, Google Chrome, and Python. The supported Desktop versions are **0.2.2-rc.5** and **0.2.3-alpha.2**. This bundle contains Desktop plugin 0.1.17 with its Python companion and Chrome extension 0.1.43. [DeepSeek Harness Desktop](https://deepseek.com/harness/) · [Bridge releases](https://github.com/StanislavSmetaninSSM/arena-harness-bridge/releases)

## 1. Download and extract the ZIP

1. Under **Assets** on the release page, find `arena-harness-bridge-v<version>-windows.zip` for your bridge version. Extract it to a folder you plan to keep, such as `C:\Tools\Arena Bridge`. Desktop stores the path to the plugin archive, and Chrome loads the extension from the extracted folder.
2. Install Python and run `python --version` in PowerShell to check that it is on your PATH. The plugin installer also needs access to the npm registry to install dependencies.

## 2. Install the Desktop plugin

1. Start DeepSeek Harness Desktop once so it creates its profile. On the welcome screen, you can choose **Add API key → Set up later**. Then quit Desktop completely from its application menu or system tray icon.
2. Open PowerShell in the extracted folder. Replace the example path with the actual path to `DeepSeek Harness.exe` to use the CLI bundled with that installation.

   ```powershell
   $desktop = 'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
   $dsh = Join-Path (Split-Path -Parent $desktop) 'resources\runtime\cli\bin\dsh.cmd'
   ```

   If the `dsh` command on your PATH belongs to that Desktop installation, you can set `$dsh = 'dsh'`.

   If you launch Desktop with a custom `DSH_HOME`, set `$env:DSH_HOME` to that same directory in this PowerShell window before installation. This installs the plugin into the profile your app uses.

3. Print the exact Harness version and install the plugin. Set `$pluginVersion` to the version in the extracted `.tgz` filename.

   ```powershell
   & $dsh --version
   $pluginVersion = '0.1.17'
   $package = (Resolve-Path -LiteralPath ".\dsh-arena-desktop-$pluginVersion.tgz").Path
   & $dsh plugin --profile desktop add $package
   ```

4. Restart Desktop. Create or open a session for your workspace and select **Arena Agent Mode** in the model picker.

### If Harness rejects the plugin version

If the CLI reports a compatibility error and you want to try the plugin with that version, enter the full version from `& $dsh --version` in the same PowerShell window, including any suffix such as `-rc.5`. The exemption lifts the version check for that exact pair of Harness and plugin versions. You’ll still need to test the plugin on that version. [DeepSeek Harness version compatibility](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md#version-compatibility-and-exemptions)

```powershell
$harnessVersion = Read-Host 'Exact DeepSeek Harness version from --version'
& $dsh plugin --profile desktop allow-version "dsh-arena-desktop@$pluginVersion" --dsh-version $harnessVersion --accept-risk
if ($LASTEXITCODE -eq 0) {
    & $dsh plugin --profile desktop add $package
}
```

## 3. Load the extension and pair the chat

1. In Chrome, open `chrome://extensions`. Turn on **Developer mode**, click **Load unpacked**, and select the `browser-extension` folder from the ZIP.
2. Sign in to Arena and open **Agent Mode**. For a new chat, send the first message in Chrome and wait for a reply. Once the URL looks like `https://arena.ai/agent/<id>`, refresh the tab.
3. In your Desktop session, run `/arena-pair` and click **Copy pairing token**.
4. In the Arena tab, open the **Arena Harness Bridge** extension. Select your Arena conversation, paste the token, and click **Bind conversation**. Use the token only for local pairing.

## 4. Send your first message

In Desktop, type “Reply on one line: THE BRIDGE IS WORKING.” The message should appear in the Arena tab, and the reply should appear in Desktop. For file tasks, choose the workspace and permissions in Desktop. Messages you send, selected attachments, and tool results from the session are sent to Arena.

At the start of a paired conversation Arena receives a short explanation of Desktop and a help example for this profile. Ordinary conversation uses plain text. When Arena requests documentation for a tool, Desktop returns its reference from the current profile. This includes the Computer Use guide, which can contain a local library path.

## Upgrade from a previous release

1. Let the current turn finish. Extract the new Windows ZIP to a separate folder you plan to keep.
2. Quit Desktop completely, open PowerShell in the new folder, and install `dsh-arena-desktop-0.1.17.tgz` using the [plugin installation steps](#2-install-the-desktop-plugin). Restart Desktop with the same profile.
3. Check **Arena Harness Bridge** in `chrome://extensions`. Extension **0.1.43** from v0.1.6 already works with this release. If your version is older, copy the contents of the new `browser-extension` folder into the folder Chrome loads, click **Reload** on the extension card, and refresh the Arena tab.
4. Continue your existing Desktop conversation. The bridge includes the new introduction with the first message after the upgrade. To check local file access, ask Arena to read a short text file in your workspace and compare its reply with the file. If the conversation has lost its pairing, run `/arena-pair` there and bind the original Arena chat using the [pairing instructions](#3-load-the-extension-and-pair-the-chat).

If an unsent request in the old format was still queued during the upgrade, Desktop shows `Resubmit this request in Desktop`. Send that request again.

## Troubleshooting

- **Arena Agent Mode or `/arena-pair` is missing.** Check that you installed the plugin with the CLI bundled with your Desktop into the `desktop` profile, then restart the app. The installer may warn about the `@deepseek-ai/dsh-llm` peer dependency on the tested Desktop build, which resolves it from its own runtime.
- **The companion does not start.** Check that Python is on your PATH. If needed, set `ARENA_PYTHON` to the full path to `python.exe` in the environment used to launch Desktop. If another bridge instance is using `127.0.0.1:8766`, close that instance.
- **The original Desktop session was deleted, or you need to change the pairing.** Run `/arena-reset` in any Desktop session in the same profile. This clears the pairing and stops pending deliveries. A send already handed to Chrome may finish in the old chat. Run `/arena-pair` in the intended session and bind the Arena tab.
- **Arena asks for verification.** Complete it in the Chrome tab.
- **The extension asks you to reload the Arena tab.** Open the saved chat at `/agent/<id>` and refresh the Chrome tab itself. Then reopen the extension, paste the token, and click **Bind conversation**. Refreshing the tab after installing or updating the extension starts the bridge script on that page.

To uninstall the plugin, quit Desktop and run `dsh plugin --profile desktop remove dsh-arena-desktop` with the same CLI. Remove the extension from `chrome://extensions`.
