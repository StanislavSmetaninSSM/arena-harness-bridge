using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Security;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ArenaHarnessSetup
{
    /// <summary>
    /// Guides the current Windows user through installing the Desktop plugin and pairing a Chrome conversation.
    /// </summary>
    internal sealed class SetupWindow : Form
    {
        private readonly Panel scroller = new Panel();
        private readonly Label heading = new Label();
        private readonly Button language = new Button();
        private readonly Button primary = new Button();
        private readonly Font headingFont;
        private TableLayoutPanel page;
        private string desktopPath = "";
        private string profilePath = "";
        private string defaultProfile = "";
        private string error = "";
        private bool russian = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "ru";
        private bool showSettings;
        private bool installing;
        private bool installed;

        /// <summary>
        /// Opens the graphical installer on a Windows single-threaded apartment.
        /// </summary>
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (SetupWindow window = new SetupWindow())
                Application.Run(window);
        }

        /// <summary>
        /// Creates the native window and looks for an installed Harness Desktop.
        /// </summary>
        private SetupWindow()
        {
            Font = SystemFonts.MessageBoxFont;
            AutoScaleDimensions = new SizeF(96, 96);
            AutoScaleMode = AutoScaleMode.Dpi;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(670, 420);
            MinimumSize = new Size(495, 380);
            Padding = new Padding(18);
            SizeGripStyle = SizeGripStyle.Show;

            TableLayoutPanel frame = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 3 };
            frame.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            frame.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            frame.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            frame.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            frame.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Controls.Add(frame);

            headingFont = new Font(Font.FontFamily, Font.SizeInPoints + 6, FontStyle.Bold);
            heading.Font = headingFont;
            heading.Dock = DockStyle.Fill;
            heading.AutoSize = true;
            heading.Margin = new Padding(0, 0, 8, 10);
            frame.Controls.Add(heading, 0, 0);
            language.Name = "languageButton";
            language.AutoSize = true;
            language.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            language.Click += delegate
            {
                russian = !russian;
                Thread.CurrentThread.CurrentUICulture = new CultureInfo(russian ? "ru-RU" : "en-US");
                Render();
            };
            frame.Controls.Add(language, 1, 0);

            scroller.Dock = DockStyle.Fill;
            scroller.AutoScroll = true;
            scroller.Margin = Padding.Empty;
            frame.Controls.Add(scroller, 0, 1);
            frame.SetColumnSpan(scroller, 2);

            primary.AutoSize = true;
            primary.Anchor = AnchorStyles.Right;
            primary.Padding = new Padding(12, 3, 12, 3);
            primary.Margin = new Padding(0, 10, 0, 0);
            primary.Click += async delegate
            {
                if (installed) Close();
                else if (!installing) await InstallAsync();
            };
            frame.Controls.Add(primary, 0, 2);
            frame.SetColumnSpan(primary, 2);
            AcceptButton = primary;
            DetectDesktop();
        }

        /// <inheritdoc/>
        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing && headingFont != null) headingFont.Dispose();
        }

        /// <inheritdoc/>
        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            base.OnFormClosing(e);
            if (installing && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                MessageBox.Show(this, L("Wait for installation to finish before closing this window.",
                    "Дождитесь завершения установки, затем закройте окно."), Text,
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        /// <summary>
        /// Selects the text for the current installer language.
        /// </summary>
        /// <param name="english">
        /// English wording.
        /// </param>
        /// <param name="ru">
        /// Russian wording.
        /// </param>
        /// <returns>
        /// The selected translation.
        /// </returns>
        private string L(string english, string ru)
        {
            return russian ? ru : english;
        }

        /// <summary>
        /// Looks for Desktop again after the user installs it or changes its location.
        /// </summary>
        private void DetectDesktop()
        {
            try
            {
                SelectDesktop(SetupEngine.FindDesktop());
            }
            catch (Exception ex)
            {
                error = ex.Message;
                Render();
            }
        }

        /// <summary>
        /// Selects a Desktop executable and suggests that installation's profile, preserving a user override.
        /// </summary>
        /// <param name="path">
        /// The selected executable, or a null or empty string if Desktop was not found.
        /// </param>
        private void SelectDesktop(string path)
        {
            desktopPath = path ?? "";
            bool useDefault = String.IsNullOrWhiteSpace(profilePath) ||
                String.Equals(profilePath, defaultProfile, StringComparison.OrdinalIgnoreCase);
            defaultProfile = SetupEngine.IsDesktop(desktopPath) ? SetupEngine.FindHome(desktopPath) : "";
            if (useDefault) profilePath = defaultProfile;
            error = "";
            Render();
        }

        /// <summary>
        /// Rebuilds the scrollable page using the current paths, installation state and language.
        /// </summary>
        private void Render()
        {
            scroller.SuspendLayout();
            try
            {
                if (page != null) page.Dispose();
                page = new TableLayoutPanel {
                    Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
                    ColumnCount = 1, Margin = Padding.Empty, Padding = new Padding(0, 0, 3, 0)
                };
                page.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
                scroller.Controls.Add(page);
                Text = L("Arena Harness Bridge Setup", "Установка Arena Harness Bridge");
                language.Text = russian ? "English" : "Русский";
                language.Enabled = !installing;
                primary.Name = installed ? "doneButton" : "installButton";
                bool found = SetupEngine.IsDesktop(desktopPath);
                primary.Enabled = !installing && (installed || (found && !String.IsNullOrWhiteSpace(profilePath)));
                if (installed)
                {
                    heading.Text = L("Desktop plugin installed", "Плагин Desktop установлен");
                    primary.Text = L("Finish", "Готово");
                    RenderNextSteps();
                }
                else if (installing)
                {
                    heading.Text = L("Installing the bridge", "Установка моста");
                    primary.Text = L("Installing…", "Установка…");
                    AddRow(Note(L("Installing the Desktop plugin…", "Устанавливаем плагин Desktop…"), "progressText"));
                    AddRow(new ProgressBar { Dock = DockStyle.Top, Height = 18, Style = ProgressBarStyle.Marquee });
                }
                else
                {
                    heading.Text = L("Install Arena Harness Bridge", "Установка Arena Harness Bridge");
                    primary.Text = error.Length == 0 ? L("Install", "Установить") : L("Retry", "Повторить");
                    RenderSettings(found);
                }
            }
            finally
            {
                scroller.ResumeLayout(true);
            }
        }

        /// <summary>
        /// Shows Desktop discovery and the profile that will receive the plugin.
        /// </summary>
        /// <param name="found">
        /// Whether the selected executable belongs to an installed Harness Desktop.
        /// </param>
        private void RenderSettings(bool found)
        {
            if (found)
            {
                AddRow(Note(L("DeepSeek Harness Desktop found. The bridge lets you use your Arena chats from Desktop.",
                    "Найден DeepSeek Harness Desktop. С мостом вы сможете общаться в чатах Arena из Desktop.")));
                AddRow(Note(L("Before installing, open Desktop once and quit it completely using its menu or tray icon.",
                    "Перед установкой откройте Desktop хотя бы один раз и полностью закройте его через меню приложения или значок в области уведомлений.")));
                AddRow(Buttons(Command("changeSettings", showSettings
                    ? L("Hide settings", "Скрыть настройки")
                    : L("Change installation or profile…", "Изменить приложение или профиль…"), delegate
                {
                    showSettings = !showSettings;
                    Render();
                })));
            }
            else
            {
                AddRow(Note(desktopPath.Length == 0
                    ? L("DeepSeek Harness Desktop was not found. Install it from the official website and click Find again, or choose its executable below.",
                        "DeepSeek Harness Desktop не найден. Установите его с официального сайта и нажмите «Найти снова» или выберите файл приложения ниже.")
                    : L("Choose DeepSeek Harness.exe from the installed app folder. If you downloaded the Desktop installer, run it first and click Find again here.",
                        "Выберите DeepSeek Harness.exe из папки установленного приложения. Если вы скачали установщик Desktop, запустите его, затем нажмите здесь «Найти снова».")));
                Button download = Command("downloadButton", L("Download Harness Desktop", "Скачать Harness Desktop"), delegate
                {
                    OpenLocation("https://deepseek.com/harness/", L("Open https://deepseek.com/harness/ in your browser.",
                        "Откройте https://deepseek.com/harness/ в браузере."));
                });
                AddRow(Buttons(download, Command("detectButton", L("Find again", "Найти снова"), DetectDesktop)));
            }
            if (!found || showSettings)
            {
                string desktopLabel = L("Desktop application", "Приложение Desktop");
                AddRow(Note(desktopLabel));
                AddRow(PathRow(PathField("desktopPath", desktopLabel, desktopPath, true),
                    Command("browseDesktop", L("Choose file…", "Выбрать файл…"), BrowseDesktop)));
            }

            if (found && showSettings)
            {
                string profileLabel = L("Harness profile folder", "Папка профиля Harness");
                AddRow(Note(profileLabel));
                TextBox profile = PathField("profilePath", profileLabel, profilePath, false);
                profile.TextChanged += delegate
                {
                    profilePath = profile.Text;
                    primary.Enabled = SetupEngine.IsDesktop(desktopPath) && !String.IsNullOrWhiteSpace(profilePath);
                };
                AddRow(PathRow(profile, Command("browseProfile", L("Choose folder…", "Выбрать папку…"), BrowseProfile)));
                AddRow(Note(L("If you use a custom Desktop profile (DSH_HOME), select that folder.",
                    "Если вы запускаете Desktop с отдельным профилем (DSH_HOME), укажите его папку.")));
            }
            if (error.Length != 0)
            {
                AddRow(Note(L("Setup needs your attention", "Для продолжения установки")));
                AddRow(new TextBox {
                    Name = "errorText", AccessibleName = L("Installation details", "Подробности установки"),
                    Text = error, ReadOnly = true, Multiline = true, WordWrap = true, ScrollBars = ScrollBars.Vertical,
                    Dock = DockStyle.Top, Height = Font.Height * 5, Margin = new Padding(0, 0, 0, 5)
                });
            }
        }

        /// <summary>
        /// Displays the installed folder and the remaining steps in Chrome and Desktop.
        /// </summary>
        private void RenderNextSteps()
        {
            AddRow(Note(L("Chrome extension folder", "Папка расширения Chrome")));
            string folder = SetupEngine.ExtensionPath;
            TextBox path = PathField("extensionPath", L("Chrome extension folder", "Папка расширения Chrome"), folder, true);
            AddRow(path);
            Button copy = null;
            copy = Command("copyButton", L("Copy path", "Скопировать путь"), delegate
            {
                try
                {
                    Clipboard.SetText(folder);
                    copy.Text = L("Path copied", "Путь скопирован");
                }
                catch (System.Runtime.InteropServices.ExternalException)
                {
                    path.Focus();
                    path.SelectAll();
                    MessageBox.Show(this, L("Press Ctrl+C to copy the selected path.", "Нажмите Ctrl+C, чтобы скопировать выделенный путь."), Text);
                }
            });
            FlowLayoutPanel actions = Buttons(copy, Command("openButton", L("Open folder", "Открыть папку"), delegate
            {
                OpenLocation(folder, L("Copy the path and paste it into File Explorer.", "Скопируйте путь и вставьте его в адресную строку Проводника."));
            }));
            string chrome = FindChrome();
            if (chrome != null)
            {
                actions.Controls.Add(Command("chromeButton", L("Open Chrome extensions", "Открыть расширения Chrome"), delegate
                {
                    Launch(new ProcessStartInfo(chrome, "chrome://extensions/") { UseShellExecute = false },
                        L("Enter chrome://extensions in Chrome.", "Введите chrome://extensions в адресную строку Chrome."));
                }));
            }
            AddRow(actions);
            AddRow(Note(L(
                "1. Open chrome://extensions. Turn on Developer mode. Click Load unpacked and select the folder above. If Chrome already uses it, click Reload.\r\n\r\n" +
                "2. Open an Arena Agent Mode chat. For a new chat, send a message and wait for a reply. After an update, return to the original Arena tab. Refresh the tab.\r\n\r\n" +
                "3. Open a Harness Desktop conversation. After an update, use the original Desktop conversation. Select Arena Agent Mode, run /arena-pair and click Copy pairing token.\r\n\r\n" +
                "4. In the Arena tab, open Arena Harness Bridge. Select the same chat, paste the token and click Bind conversation. Send a message in Desktop.",
                "1. Откройте chrome://extensions. Включите «Режим разработчика». Нажмите «Загрузить распакованное расширение» и выберите папку выше. Если Chrome уже использует её, нажмите значок «Перезагрузить».\r\n\r\n" +
                "2. Откройте чат Arena в Agent Mode. В новом чате отправьте сообщение и дождитесь ответа. После обновления откройте прежнюю вкладку Arena. Обновите вкладку.\r\n\r\n" +
                "3. Откройте разговор в Harness Desktop. После обновления вернитесь в прежний разговор. Выберите Arena Agent Mode, введите /arena-pair и нажмите Copy pairing token.\r\n\r\n" +
                "4. Во вкладке Arena откройте Arena Harness Bridge. Выберите тот же чат, вставьте токен и нажмите Bind conversation. Отправьте сообщение в Desktop."), "instructions"));
        }

        /// <summary>
        /// Prompts for a Desktop application and refreshes the suggested profile.
        /// </summary>
        private void BrowseDesktop()
        {
            using (OpenFileDialog dialog = new OpenFileDialog())
            {
                dialog.Title = L("Choose DeepSeek Harness Desktop", "Выберите DeepSeek Harness Desktop");
                dialog.Filter = L("Applications (*.exe)|*.exe", "Приложения (*.exe)|*.exe");
                dialog.RestoreDirectory = true;
                if (File.Exists(desktopPath))
                {
                    dialog.InitialDirectory = Path.GetDirectoryName(desktopPath);
                    dialog.FileName = Path.GetFileName(desktopPath);
                }
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                try { SelectDesktop(dialog.FileName); }
                catch (Exception ex) { error = ex.Message; Render(); }
            }
        }

        /// <summary>
        /// Prompts for the folder used by a custom Desktop profile.
        /// </summary>
        private void BrowseProfile()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = L("Choose your Harness profile folder (DSH_HOME).", "Выберите папку профиля Harness (DSH_HOME).");
                if (Directory.Exists(profilePath)) dialog.SelectedPath = profilePath;
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                profilePath = dialog.SelectedPath;
                error = "";
                Render();
            }
        }

        /// <summary>
        /// Runs the installation off the UI thread and presents its result on the original window.
        /// </summary>
        /// <returns>
        /// A task that completes when the page reflects success or a retryable error.
        /// </returns>
        private async Task InstallAsync()
        {
            if (!SetupEngine.IsDesktop(desktopPath))
            {
                Render();
                return;
            }
            string desktop = desktopPath;
            string home = profilePath.Trim();
            CultureInfo culture = new CultureInfo(russian ? "ru-RU" : "en-US");
            installing = true;
            error = "";
            Render();
            Control status = page.Controls["progressText"];
            IProgress<string> progress = new Progress<string>(delegate(string message)
            {
                if (!status.IsDisposed) status.Text = message;
            });
            try
            {
                await Task.Run(delegate
                {
                    Thread.CurrentThread.CurrentUICulture = culture;
                    SetupEngine.Install(desktop, home, progress.Report);
                });
                installed = true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                showSettings = true;
            }
            finally
            {
                installing = false;
                if (!IsDisposed) Render();
            }
        }

        /// <summary>
        /// Opens a selected site or folder using its Windows association and handles a missing association.
        /// </summary>
        /// <param name="location">
        /// The fixed download URL or the installed extension folder.
        /// </param>
        /// <param name="fallback">
        /// An alternative way for the user to open the same location.
        /// </param>
        private void OpenLocation(string location, string fallback)
        {
            Launch(new ProcessStartInfo(location) { UseShellExecute = true }, fallback);
        }

        /// <summary>
        /// Finds Chrome in standard installation folders or its registered Windows application path.
        /// </summary>
        /// <returns>
        /// The Chrome executable, or <see langword="null"/> when its location cannot be determined.
        /// </returns>
        private static string FindChrome()
        {
            foreach (string variable in new[] { "LOCALAPPDATA", "ProgramW6432", "ProgramFiles", "ProgramFiles(x86)" })
            {
                string root = Environment.GetEnvironmentVariable(variable);
                if (String.IsNullOrEmpty(root) || root.IndexOfAny(Path.GetInvalidPathChars()) >= 0 || !Path.IsPathRooted(root)) continue;
                string path = Path.Combine(root, @"Google\Chrome\Application\chrome.exe");
                if (File.Exists(path)) return path;
            }
            foreach (string hive in new[] { "HKEY_CURRENT_USER", "HKEY_LOCAL_MACHINE" })
            {
                try
                {
                    string value = Registry.GetValue(hive + @"\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe", "", null) as string;
                    if (String.IsNullOrEmpty(value)) continue;
                    string path = value.Trim().Trim('"');
                    if (File.Exists(path) && Path.IsPathRooted(path) &&
                        String.Equals(Path.GetFileName(path), "chrome.exe", StringComparison.OrdinalIgnoreCase)) return path;
                }
                catch (SecurityException) { }
                catch (UnauthorizedAccessException) { }
                catch (IOException) { }
            }
            return null;
        }

        /// <summary>
        /// Starts a user-selected action and shows manual instructions if Windows cannot open it.
        /// </summary>
        /// <param name="start">
        /// The configured process or shell association.
        /// </param>
        /// <param name="fallback">
        /// Manual instructions for the same action.
        /// </param>
        private void Launch(ProcessStartInfo start, string fallback)
        {
            try
            {
                using (Process process = Process.Start(start)) { }
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, fallback + Environment.NewLine + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        /// <summary>
        /// Appends one automatically sized row to the current page.
        /// </summary>
        /// <param name="control">
        /// The native control to place in the row.
        /// </param>
        private void AddRow(Control control)
        {
            int row = page.RowCount++;
            page.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            page.Controls.Add(control, 0, row);
        }

        /// <summary>
        /// Creates a wrapping label for a field or instruction.
        /// </summary>
        /// <param name="text">
        /// The text shown to the user.
        /// </param>
        /// <param name="name">
        /// An optional identifier for this label. An empty string leaves it unnamed.
        /// </param>
        /// <returns>
        /// A label that takes the width of the containing row.
        /// </returns>
        private static Label Note(string text, string name = "")
        {
            return new Label {
                Name = name, Text = text, AutoSize = true, Dock = DockStyle.Fill,
                UseMnemonic = false, Margin = new Padding(0, 5, 0, 5)
            };
        }

        /// <summary>
        /// Creates a single-line path field with a screen-reader label.
        /// </summary>
        /// <param name="name">
        /// Identifier for the field.
        /// </param>
        /// <param name="label">
        /// The localized accessible name.
        /// </param>
        /// <param name="path">
        /// The selected path, or an empty string when no path is selected.
        /// </param>
        /// <param name="readOnly">
        /// Whether the path can only be selected and copied by the user.
        /// </param>
        /// <returns>
        /// A text box displaying the selected path.
        /// </returns>
        private static TextBox PathField(string name, string label, string path, bool readOnly)
        {
            return new TextBox {
                Name = name, Text = path, AccessibleName = label, ReadOnly = readOnly,
                Anchor = AnchorStyles.Left | AnchorStyles.Right, Margin = new Padding(0, 3, 5, 3)
            };
        }

        /// <summary>
        /// Creates a row containing a path field and its browse button.
        /// </summary>
        /// <param name="field">
        /// The field that shows the selected path.
        /// </param>
        /// <param name="browse">
        /// The button that opens the appropriate picker.
        /// </param>
        /// <returns>
        /// A two-column row that lets the field occupy the space beside the button.
        /// </returns>
        private static TableLayoutPanel PathRow(TextBox field, Button browse)
        {
            TableLayoutPanel row = new TableLayoutPanel {
                AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Dock = DockStyle.Top,
                ColumnCount = 2, RowCount = 1, Margin = new Padding(0, 0, 0, 5)
            };
            row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            row.Controls.Add(field, 0, 0);
            row.Controls.Add(browse, 1, 0);
            return row;
        }

        /// <summary>
        /// Creates a native button for a user-initiated action.
        /// </summary>
        /// <param name="name">
        /// The control identifier.
        /// </param>
        /// <param name="text">
        /// The localized button caption.
        /// </param>
        /// <param name="action">
        /// The action to invoke on click.
        /// </param>
        /// <returns>
        /// An automatically sized button.
        /// </returns>
        private static Button Command(string name, string text, Action action)
        {
            Button button = new Button {
                Name = name, Text = text, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Padding = new Padding(5, 2, 5, 2), Margin = new Padding(0, 0, 5, 0)
            };
            button.Click += delegate { action(); };
            return button;
        }

        /// <summary>
        /// Groups related buttons and allows them to wrap at narrow window widths.
        /// </summary>
        /// <param name="buttons">
        /// The buttons in keyboard navigation order.
        /// </param>
        /// <returns>
        /// A row containing the supplied buttons.
        /// </returns>
        private static FlowLayoutPanel Buttons(params Button[] buttons)
        {
            FlowLayoutPanel group = new FlowLayoutPanel {
                AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Dock = DockStyle.Top,
                Margin = new Padding(0, 2, 0, 5), WrapContents = true
            };
            group.Controls.AddRange(buttons);
            return group;
        }
    }
}
