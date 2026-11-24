using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace ArenaHarnessSetup
{
    /// <summary>
    /// Installs the embedded bridge into the selected Harness Desktop using its bundled plugin manager.
    /// </summary>
    internal static class SetupEngine
    {
        private const string Executable = "DeepSeek Harness.exe";
        private const string Plugin = "dsh-arena-desktop";
        private const string CliPath = @"resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js";

        /// <summary>
        /// Gets the directory Chrome can keep using across setup runs and bridge upgrades.
        /// </summary>
        internal static string ExtensionPath
        {
            get { return Path.Combine(InstallRoot, "browser-extension"); }
        }

        /// <summary>
        /// Gets the per-user directory containing persistent setup files.
        /// </summary>
        private static string InstallRoot
        {
            get { return Path.Combine(LocalData, "ArenaHarnessBridge", "WindowsSetup"); }
        }

        /// <summary>
        /// Gets the local application data directory of the current Windows environment.
        /// </summary>
        private static string LocalData
        {
            get { return Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); }
        }

        /// <summary>
        /// Selects the text matching the UI culture of the calling thread.
        /// </summary>
        /// <param name="english">
        /// The English message used by default.
        /// </param>
        /// <param name="russian">
        /// The message used for Russian UI cultures.
        /// </param>
        /// <returns>
        /// The localized message.
        /// </returns>
        private static string Message(string english, string russian)
        {
            return CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "ru" ? russian : english;
        }

        /// <summary>
        /// Finds an installed Desktop executable in common locations, Windows installation records or a known bridge installation.
        /// </summary>
        /// <returns>
        /// The full executable path, or an empty string when Desktop cannot be found.
        /// </returns>
        internal static string FindDesktop()
        {
            var candidates = new List<string>();
            foreach (string root in new[] { Path.Combine(LocalData, "Programs"), Environment.GetEnvironmentVariable("ProgramFiles"),
                Environment.GetEnvironmentVariable("ProgramW6432"), Environment.GetEnvironmentVariable("ProgramFiles(x86)") })
            {
                if (!string.IsNullOrEmpty(root))
                    foreach (string name in new[] { "DeepSeek Harness", "deepseek-harness-desktop", "@deepseek-ai" + Path.DirectorySeparatorChar + "dsh-desktop" })
                        candidates.Add(Path.Combine(root, name, Executable));
            }
            string common = candidates.FirstOrDefault(IsDesktop);
            if (common != null) return common;
            foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
                foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
                    AddRegisteredPaths(hive, view, candidates);
            string legacy = Path.Combine(LocalData, "ArenaHarnessBridge", "Desktop");
            if (Directory.Exists(legacy))
            {
                foreach (string dir in Directory.GetDirectories(legacy, "app-*").OrderByDescending(s => s, StringComparer.OrdinalIgnoreCase))
                    candidates.Add(Path.Combine(dir, Executable));
                candidates.Add(Path.Combine(legacy, "app", Executable));
            }
            return candidates.FirstOrDefault(IsDesktop) ?? "";
        }

        /// <summary>
        /// Collects executable paths from accessible DeepSeek Harness uninstall entries in a Windows registry view.
        /// </summary>
        /// <param name="hive">
        /// The user or machine hive to query.
        /// </param>
        /// <param name="view">
        /// The registry view used by the application installer.
        /// </param>
        /// <param name="paths">
        /// Candidate paths to extend with matching registrations.
        /// </param>
        private static void AddRegisteredPaths(RegistryHive hive, RegistryView view, List<string> paths)
        {
            try
            {
                using (var baseKey = RegistryKey.OpenBaseKey(hive, view))
                using (var uninstall = baseKey.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall"))
                {
                    if (uninstall == null) return;
                    foreach (string name in uninstall.GetSubKeyNames())
                        using (var key = uninstall.OpenSubKey(name))
                        {
                            if (key == null) continue;
                            string display = key.GetValue("DisplayName") as string ?? "";
                            if (!display.StartsWith("DeepSeek Harness", StringComparison.OrdinalIgnoreCase)) continue;
                            string location = key.GetValue("InstallLocation") as string;
                            if (!string.IsNullOrWhiteSpace(location))
                                paths.Add(Path.Combine(location.Trim('"'), Executable));
                            string icon = key.GetValue("DisplayIcon") as string;
                            if (!string.IsNullOrWhiteSpace(icon))
                                paths.Add(Regex.Replace(icon, @",\s*-?\d+$", "").Trim('"'));
                        }
                }
            }
            catch (SecurityException) { }
            catch (UnauthorizedAccessException) { }
            catch (IOException) { }
        }

        /// <summary>
        /// Checks the executable name and native resources in a candidate Desktop installation.
        /// </summary>
        /// <param name="path">
        /// The candidate executable path. An absent or empty path is rejected.
        /// </param>
        /// <returns>
        /// <see langword="true"/> when the Desktop executable, ASAR and CLI launcher exist together; otherwise, <see langword="false"/>.
        /// </returns>
        internal static bool IsDesktop(string path)
        {
            if (!File.Exists(path) || !string.Equals(Path.GetFileName(path), Executable, StringComparison.OrdinalIgnoreCase)) return false;
            string directory = Path.GetDirectoryName(path);
            return File.Exists(Path.Combine(directory, @"resources\app.asar")) &&
                File.Exists(Path.Combine(directory, @"resources\runtime\cli\bin\dsh.cmd"));
        }

        /// <summary>
        /// Resolves the current Harness home from its environment override, a known bridge launcher, or Desktop's per-user default.
        /// </summary>
        /// <param name="desktopExe">
        /// The selected Desktop executable, or an empty path to use the environment and default home.
        /// </param>
        /// <returns>
        /// The suggested absolute Harness home directory.
        /// </returns>
        internal static string FindHome(string desktopExe)
        {
            string user = Environment.GetEnvironmentVariable("USERPROFILE") ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string custom = Environment.GetEnvironmentVariable("DSH_HOME");
            if (!string.IsNullOrWhiteSpace(custom))
            {
                if (custom == "~") return user;
                if (custom.StartsWith("~/") || custom.StartsWith(@"~\")) custom = Path.Combine(user, custom.Substring(2));
                return Path.GetFullPath(custom);
            }
            if (!string.IsNullOrWhiteSpace(desktopExe))
            {
                var app = new FileInfo(desktopExe).Directory;
                string legacy = Path.Combine(LocalData, "ArenaHarnessBridge", "Desktop");
                if (app != null && app.Parent != null && string.Equals(app.Parent.FullName, legacy, StringComparison.OrdinalIgnoreCase) &&
                    (app.Name == "app" || app.Name.StartsWith("app-", StringComparison.OrdinalIgnoreCase)))
                {
                    string home = Path.Combine(legacy, "harness-home" + app.Name.Substring(3));
                    if (Directory.Exists(home)) return home;
                }
            }
            return Path.Combine(user, ".dsh");
        }

        /// <summary>
        /// Installs the embedded package with the selected Desktop, verifies registration and publishes the Chrome extension.
        /// </summary>
        /// <param name="desktopExe">
        /// The full path to an installed, closed DeepSeek Harness Desktop executable.
        /// </param>
        /// <param name="home">
        /// The absolute Harness home whose initialized desktop profile should receive the plugin.
        /// </param>
        /// <param name="progress">
        /// Receives localized status messages on the calling thread. A <see langword="null"/> callback suppresses progress.
        /// </param>
        internal static void Install(string desktopExe, string home, Action<string> progress)
        {
            if (!IsDesktop(desktopExe))
                throw new InvalidOperationException(Message("Choose DeepSeek Harness.exe in an installed copy of Desktop, or download Desktop and try again.",
                    "Выберите DeepSeek Harness.exe в папке установленного Desktop или скачайте Desktop и повторите попытку."));
            desktopExe = Path.GetFullPath(desktopExe);
            if (string.IsNullOrWhiteSpace(home) || !Path.IsPathRooted(home) || Path.GetPathRoot(home).Length < 3 || File.Exists(home))
                throw new InvalidOperationException(Message("Choose a full folder path for your Harness home.", "Выберите полный путь к папке профиля Harness."));
            home = Path.GetFullPath(home);
            if (IsRunning(desktopExe))
                throw new InvalidOperationException(Message("Quit each running copy of DeepSeek Harness Desktop from its menu or tray icon, then try again.",
                    "Завершите работу всех открытых экземпляров DeepSeek Harness Desktop через меню приложения или значок в области уведомлений и повторите попытку."));
            string profile = Path.Combine(home, "profiles", "desktop");
            if (HasActiveProfileLock(profile))
                throw new InvalidOperationException(Message("Another operation is using this Desktop profile. Wait for it to finish, quit Desktop and try again.",
                    "Другая операция использует этот профиль Desktop. Дождитесь её завершения, закройте Desktop и повторите попытку."));
            if (!File.Exists(Path.Combine(profile, "package.json")))
                throw new InvalidOperationException(Message("Start Desktop once with the selected Harness home, then quit it from the menu and retry. If you already use Desktop, choose its existing home folder.",
                    "Один раз запустите Desktop с выбранной папкой данных Harness, затем завершите его работу через меню и повторите попытку. Если вы уже пользуетесь Desktop, выберите его существующую папку данных."));
            Directory.CreateDirectory(InstallRoot);
            FileStream installationLock;
            try
            {
                installationLock = new FileStream(Path.Combine(InstallRoot, "setup.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            }
            catch (IOException error)
            {
                throw new IOException(Message("Check that another setup is not running and that you can write to the installation folder, then retry.",
                    "Убедитесь, что другой установщик не запущен и папка установки доступна для записи, затем повторите попытку."), error);
            }
            using (installationLock)
            {
                string staging = Path.Combine(InstallRoot, ".setup-" + Guid.NewGuid().ToString("N"));
                try
                {
                    Directory.CreateDirectory(staging);
                    FinishExtensionUpdate(staging, false);
                    if (progress != null) progress(Message("Preparing the bridge files…", "Подготовка файлов моста…"));
                    using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("bridge.zip"))
                    {
                        if (payload == null) throw new InvalidDataException(Message("Download a fresh copy of setup. Its payload is missing.", "Скачайте установщик заново. В нём отсутствуют файлы моста."));
                        using (var zip = new ZipArchive(payload, ZipArchiveMode.Read)) zip.ExtractToDirectory(staging);
                    }
                    string stagedExtension = Path.Combine(staging, "browser-extension");
                    var packages = Directory.GetFiles(staging, Plugin + "-*.tgz");
                    if (packages.Length != 1 || !File.Exists(Path.Combine(stagedExtension, "manifest.json")))
                        throw new InvalidDataException(Message("Download a fresh copy of setup. The bridge files are incomplete.", "Скачайте установщик заново. Комплект файлов моста неполон."));
                    string package = KeepPackage(packages[0]);
                    string version = Path.GetFileNameWithoutExtension(package).Substring(Plugin.Length + 1);
                    if (progress != null) progress(Message("Preparing the Chrome extension…", "Подготовка расширения Chrome…"));
                    try
                    {
                        if (!SameExtension(stagedExtension)) PrepareExtension(stagedExtension, home, version);
                        if (progress != null) progress(Message("Installing the Desktop plugin. This can take a few minutes…", "Установка плагина Desktop. Это может занять несколько минут…"));
                        RunPluginManager(desktopExe, home, package);
                        if (!IsRegistered(home, version))
                            throw new InvalidOperationException(Message("Desktop did not register the expected bridge version. Check the selected profile and retry.",
                                "Desktop не зарегистрировал ожидаемую версию моста. Проверьте выбранную папку профиля и повторите установку."));
                    }
                    catch
                    {
                        FinishExtensionUpdate(staging, true);
                        throw;
                    }
                    File.Delete(Path.Combine(InstallRoot, "extension.pending"));
                    TryRemoveDirectory(Path.Combine(InstallRoot, "previous-extension"));
                }
                finally { TryRemoveDirectory(staging); }
            }
        }

        /// <summary>
        /// Compares the installed and staged extension trees before attempting any directory rename.
        /// </summary>
        /// <param name="source">
        /// The newly extracted browser extension directory.
        /// </param>
        /// <returns>
        /// <see langword="true"/> if the persistent path holds the same files and bytes; otherwise, <see langword="false"/>.
        /// </returns>
        private static bool SameExtension(string source)
        {
            if (!Directory.Exists(ExtensionPath)) return false;
            string[] files = Directory.GetFiles(source, "*", SearchOption.AllDirectories);
            if (files.Length != Directory.GetFiles(ExtensionPath, "*", SearchOption.AllDirectories).Length) return false;
            foreach (string file in files)
            {
                string target = Path.Combine(ExtensionPath, file.Substring(source.Length + 1));
                if (!File.Exists(target) || !SameFile(file, target)) return false;
            }
            return true;
        }

        /// <summary>
        /// Stages the extension at Chrome's permanent path before the native plugin manager can change the profile.
        /// </summary>
        /// <param name="source">
        /// The extracted extension to move into place.
        /// </param>
        /// <param name="home">
        /// The selected Harness home to check after an interrupted install.
        /// </param>
        /// <param name="version">
        /// The expected plugin version corresponding to this update.
        /// </param>
        private static void PrepareExtension(string source, string home, string version)
        {
            string previous = Path.Combine(InstallRoot, "previous-extension");
            bool updating = Directory.Exists(ExtensionPath);
            try
            {
                if (Directory.Exists(previous)) Directory.Delete(previous, true);
                string journal = Path.Combine(Path.GetDirectoryName(source), "extension.pending");
                File.WriteAllLines(journal, new[] { updating ? "upgrade" : "new", home, version });
                File.Move(journal, Path.Combine(InstallRoot, "extension.pending"));
                if (updating) Directory.Move(ExtensionPath, previous);
                Directory.Move(source, ExtensionPath);
            }
            catch (IOException error)
            {
                throw new IOException(Message("Close any windows using the extension folder, including Explorer or Chrome, then retry.",
                    "Закройте окна, в которых открыта папка расширения, в том числе Проводник или Chrome, и повторите попытку."), error);
            }
        }

        /// <summary>
        /// Recovers an interrupted extension update, keeping the candidate only if Desktop registered its associated plugin.
        /// </summary>
        /// <param name="staging">
        /// The current temporary directory for retiring a rejected candidate.
        /// </param>
        /// <param name="rollback">
        /// Whether a known installation failure requires restoring the prior extension regardless of the installed version.
        /// </param>
        private static void FinishExtensionUpdate(string staging, bool rollback)
        {
            string journal = Path.Combine(InstallRoot, "extension.pending");
            if (!File.Exists(journal)) return;
            string previous = Path.Combine(InstallRoot, "previous-extension");
            string[] state = File.ReadAllLines(journal);
            bool moved = Directory.Exists(previous) || state[0] == "new";
            if (moved && (rollback || !Directory.Exists(ExtensionPath) || !IsRegistered(state[1], state[2])))
            {
                if (Directory.Exists(ExtensionPath)) Directory.Move(ExtensionPath, Path.Combine(staging, "rejected-extension-" + Guid.NewGuid().ToString("N")));
                if (Directory.Exists(previous)) Directory.Move(previous, ExtensionPath);
            }
            File.Delete(journal);
            TryRemoveDirectory(previous);
        }

        /// <summary>
        /// Checks for a running copy of Desktop that could be using this user's profile.
        /// </summary>
        /// <param name="executable">
        /// The normalized full path to the selected Desktop executable.
        /// </param>
        /// <returns>
        /// <see langword="true"/> for a running Desktop in this user's Windows session or when its ownership cannot be checked; otherwise, <see langword="false"/>.
        /// </returns>
        private static bool IsRunning(string executable)
        {
            bool running = false;
            using (var current = Process.GetCurrentProcess())
            using (var identity = WindowsIdentity.GetCurrent())
            {
                foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(executable)))
                    using (process)
                    {
                        try
                        {
                            if (process.SessionId != current.SessionId) continue;
                            using (var handle = OpenProcess(0x1000, false, process.Id))
                            {
                                SafeAccessTokenHandle token;
                                if (handle.IsInvalid || !OpenProcessToken(handle, 0x0008, out token)) running = true;
                                else using (token)
                                using (var owner = new WindowsIdentity(token.DangerousGetHandle()))
                                    running |= Equals(identity.User, owner.User);
                            }
                        }
                        catch (InvalidOperationException) { }
                        catch (Win32Exception) { running = true; }
                    }
            }
            return running;
        }

        /// <summary>
        /// Opens a process handle for a limited query of its owning user.
        /// </summary>
        /// <param name="access">
        /// The Windows process access mask.
        /// </param>
        /// <param name="inherit">
        /// Whether children can inherit the handle.
        /// </param>
        /// <param name="pid">
        /// The process identifier.
        /// </param>
        /// <returns>
        /// A disposable process handle that is invalid if Windows denied access or the process exited.
        /// </returns>
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);

        /// <summary>
        /// Opens a Windows process token to identify the account that owns the process.
        /// </summary>
        /// <param name="process">
        /// The process handle with query access.
        /// </param>
        /// <param name="access">
        /// The requested token access mask.
        /// </param>
        /// <param name="token">
        /// Receives the token handle on success.
        /// </param>
        /// <returns>
        /// <see langword="true"/> if Windows granted access; otherwise, <see langword="false"/>.
        /// </returns>
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out SafeAccessTokenHandle token);

        /// <summary>
        /// Checks whether Desktop has marked a profile operation as active.
        /// </summary>
        /// <param name="profile">
        /// The selected desktop profile directory containing the optional PID lock.
        /// </param>
        /// <returns>
        /// <see langword="true"/> for a live owner or an unidentifiable lock; otherwise, <see langword="false"/>.
        /// </returns>
        private static bool HasActiveProfileLock(string profile)
        {
            string path = Path.Combine(profile, "lock");
            if (Directory.Exists(path)) return true;
            try
            {
                int owner;
                if (!int.TryParse(File.ReadAllText(path).Trim(), out owner) || owner <= 0) return true;
                using (var process = Process.GetProcessById(owner)) return !process.HasExited;
            }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
            catch (ArgumentException) { return false; }
            catch (Win32Exception) { return true; }
            catch (UnauthorizedAccessException) { return true; }
            catch (IOException) { return true; }
        }

        /// <summary>
        /// Keeps the versioned archive at a permanent path that Harness can reference on subsequent installations.
        /// </summary>
        /// <param name="staged">
        /// The newly extracted package in the same filesystem.
        /// </param>
        /// <returns>
        /// The persistent path containing the verified package bytes.
        /// </returns>
        private static string KeepPackage(string staged)
        {
            string directory = Path.Combine(InstallRoot, "packages");
            Directory.CreateDirectory(directory);
            string target = Path.Combine(directory, Path.GetFileName(staged));
            if (!File.Exists(target)) File.Move(staged, target);
            else if (!SameFile(staged, target))
                throw new InvalidDataException(Message("A different archive already uses this plugin version. Download the matching setup or a newer release.",
                            "Для этой версии плагина уже сохранён другой архив. Скачайте соответствующий установщик или более новую версию."));
            return target;
        }

        /// <summary>
        /// Compares the content digests of two setup files.
        /// </summary>
        /// <param name="left">
        /// The first file path.
        /// </param>
        /// <param name="right">
        /// The other file path.
        /// </param>
        /// <returns>
        /// <see langword="true"/> for matching SHA-256 digests; otherwise, <see langword="false"/>.
        /// </returns>
        private static bool SameFile(string left, string right)
        {
            using (var hash = SHA256.Create())
            using (var first = File.OpenRead(left))
            using (var second = File.OpenRead(right))
                return first.Length == second.Length && hash.ComputeHash(first).SequenceEqual(hash.ComputeHash(second));
        }

        /// <summary>
        /// Starts the selected Desktop in its native CLI mode and collects its diagnostic output on failure.
        /// </summary>
        /// <param name="executable">
        /// The selected Desktop executable.
        /// </param>
        /// <param name="home">
        /// The full Harness home path passed to the child process.
        /// </param>
        /// <param name="package">
        /// The absolute path of the permanent plugin archive.
        /// </param>
        private static void RunPluginManager(string executable, string home, string package)
        {
            string directory = Path.GetDirectoryName(executable);
            var start = new ProcessStartInfo(executable, "--expose-internals \"" + Path.Combine(directory, CliPath) +
                "\" plugin --profile desktop add \"" + package + "\"");
            start.WorkingDirectory = InstallRoot;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.StandardOutputEncoding = Encoding.UTF8;
            start.StandardErrorEncoding = Encoding.UTF8;
            start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            start.EnvironmentVariables["DSH_HOME"] = home;
            using (var process = new Process { StartInfo = start })
            {
                var tail = new StringBuilder();
                DataReceivedEventHandler capture = delegate(object sender, DataReceivedEventArgs line) {
                    if (line.Data == null) return;
                    lock (tail)
                    {
                        tail.AppendLine(line.Data);
                        if (tail.Length > 4096) tail.Remove(0, tail.Length - 4096);
                    }
                };
                process.OutputDataReceived += capture;
                process.ErrorDataReceived += capture;
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                if (process.ExitCode != 0)
                    throw new InvalidOperationException(Message("Desktop could not install the plugin. Check the message below, your connection to the npm registry and Desktop compatibility, then retry.",
                        "Desktop не удалось установить плагин. Проверьте сообщение ниже, доступ к реестру npm и совместимость версии Desktop, затем повторите попытку.") +
                        Environment.NewLine + tail.ToString().Trim());
            }
        }

        /// <summary>
        /// Verifies the installed package identity, version and bundle registration in the selected desktop profile.
        /// </summary>
        /// <param name="home">
        /// The Harness home used in the completed plugin installation.
        /// </param>
        /// <param name="version">
        /// The package version identified by the embedded archive filename.
        /// </param>
        /// <returns>
        /// <see langword="true"/> for an installed plugin with the expected version and bundle registration; otherwise, <see langword="false"/>.
        /// </returns>
        private static bool IsRegistered(string home, string version)
        {
            string directory = Path.Combine(home, "profiles", "desktop");
            var json = new JavaScriptSerializer();
            try
            {
                var package = json.DeserializeObject(File.ReadAllText(Path.Combine(directory, "node_modules", Plugin, "package.json")));
                var profile = json.DeserializeObject(File.ReadAllText(Path.Combine(directory, "package.json")));
                var bundles = Field(profile, "dsh", "profile", "bundles") as object[];
                return Equals(Field(package, "name"), Plugin) && Equals(Field(package, "version"), version) &&
                    Field(profile, "dependencies", Plugin) is string && bundles != null && bundles.Contains(Plugin);
            }
            catch (IOException) { }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
            return false;
        }

        /// <summary>
        /// Reads a nested manifest field when each part of the path exists in a JSON object.
        /// </summary>
        /// <param name="value">
        /// The deserialized manifest to inspect. A missing object yields a missing field.
        /// </param>
        /// <param name="path">
        /// The successive property names in the manifest.
        /// </param>
        /// <returns>
        /// The field value or <see langword="null"/> if a property is missing or its parent is not an object.
        /// </returns>
        private static object Field(object value, params string[] path)
        {
            foreach (string key in path)
            {
                var properties = value as Dictionary<string, object>;
                if (properties == null || !properties.TryGetValue(key, out value)) return null;
            }
            return value;
        }

        /// <summary>
        /// Removes temporary setup material when it is accessible after installation.
        /// </summary>
        /// <param name="path">
        /// The temporary stage or retired extension directory owned by setup.
        /// </param>
        private static void TryRemoveDirectory(string path)
        {
            try { if (Directory.Exists(path)) Directory.Delete(path, true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
