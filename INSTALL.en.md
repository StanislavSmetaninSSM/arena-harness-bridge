# Install on Windows

[Русский](INSTALL.md) · Windows x64 · Google Chrome

### 1. Install the bridge

1. Download and run [Arena-Harness-Bridge-Setup.exe](https://github.com/StanislavSmetaninSSM/arena-harness-bridge/releases/latest/download/Arena-Harness-Bridge-Setup.exe).
2. If you need DeepSeek Harness Desktop, use the wizard’s download button. Install Desktop and open it once. Before installing the bridge, quit Desktop completely from the app menu or system tray.
3. Check that the wizard has selected your Desktop installation and click **Install**. When the extension folder appears, copy its path.

### 2. Add the Chrome extension

Click **Open Chrome extensions** in the wizard. If that button is unavailable, enter `chrome://extensions` in Chrome’s address bar. Turn on **Developer mode**, click **Load unpacked**, paste the path into the folder picker’s address bar, press Enter, then click **Select Folder**. **Arena Harness Bridge** will appear in the extension list.

### 3. Connect your chats

1. Sign in to [Arena](https://arena.ai/agent), open **Agent Mode**, and send “Hello”. Wait for the reply and refresh the tab.
2. Open a conversation in Desktop, select the **Arena Agent Mode** model, type `/arena-pair`, and click **Copy pairing token**. If port 8766 is busy, Desktop chooses an available port and includes it in the code.
3. Return to the Arena tab. Open **Arena Harness Bridge** from Chrome’s extensions menu, paste the token, and click **Bind conversation**.
4. Send “Hello” in **Desktop**. Arena’s reply will appear in that conversation.

When you return to this conversation, use the normal message field. Switching conversations preserves the selected model and its Arena pairing.

If you open another Arena chat in the same Chrome tab between tasks, return to the paired chat. The bridge resumes when the original history has loaded and the message field is empty. If you leave during a send, check the original chat to see what was delivered.

If the extension asks for a token after Chrome restarts, open the same Arena chat. Run `/arena-pair` in the original Desktop conversation, copy the code, and click **Bind conversation** in the extension.

**Updating.** Quit Desktop completely and run the new installer for the same profile. Use the Chrome extension from the same release. If Chrome loads the extension from the wizard’s folder, click **Reload** on its extension card. If you originally installed from a ZIP, disable the old extension and add the new one as in step 2. Refresh the original Arena tab. Run `/arena-pair` in the **original Desktop conversation** and bind the same Arena chat as in step 3.

<details>
<summary>Manual installation from the ZIP</summary>

Extract the Windows ZIP to a folder you plan to keep. Quit Desktop completely. Open PowerShell in the extracted folder and enter the commands below, using the path to your own `DeepSeek Harness.exe`. If Desktop uses a custom profile, first set `$env:DSH_HOME` to the same directory you use to launch Desktop.

```powershell
$desktop = Read-Host 'Full path to DeepSeek Harness.exe'
$dsh = Join-Path (Split-Path -Parent $desktop) 'resources\runtime\cli\bin\dsh.cmd'
$package = (Get-Item -Path '.\dsh-arena-desktop-*.tgz').FullName
& $dsh plugin --profile desktop add $package
```

In step 2, select the ZIP’s `browser-extension` folder. Plugin installation requires access to the npm registry.

</details>
