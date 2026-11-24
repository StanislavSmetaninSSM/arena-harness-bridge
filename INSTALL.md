# Установка на Windows

[English](INSTALL.en.md) · Windows x64 · Google Chrome

### 1. Установите мост

1. Скачайте и запустите [Arena-Harness-Bridge-Setup.exe](https://github.com/StanislavSmetaninSSM/arena-harness-bridge/releases/latest/download/Arena-Harness-Bridge-Setup.exe).
2. Если DeepSeek Harness Desktop ещё не установлен, нажмите в мастере кнопку скачивания Desktop. После установки один раз откройте Desktop. Перед установкой моста полностью выйдите из Desktop через меню приложения или значок в трее.
3. В мастере проверьте, что выбран ваш Desktop, и нажмите **Установить**. Дождитесь экрана с папкой расширения. Скопируйте из него путь.

### 2. Добавьте расширение в Chrome

Нажмите в мастере **Открыть расширения Chrome**. Если кнопки нет, введите в адресной строке Chrome `chrome://extensions`. Включите **Режим разработчика**, нажмите **Загрузить распакованное расширение**, вставьте путь в адресную строку окна выбора, нажмите Enter и затем **Выбор папки**. В списке появится **Arena Harness Bridge**.

### 3. Свяжите два чата

1. Войдите в [Arena](https://arena.ai/agent), откройте **Agent Mode** и отправьте «Привет». Дождитесь ответа и обновите вкладку.
2. Откройте разговор в Desktop, выберите модель **Arena Agent Mode**, введите `/arena-pair` и нажмите **Copy pairing token**. Если порт 8766 занят, Desktop сам выберет свободный и включит его в код.
3. Вернитесь во вкладку Arena. Через значок расширений Chrome откройте **Arena Harness Bridge**, вставьте токен и нажмите **Bind conversation**.
4. Напишите «Привет» уже в **Desktop**. Ответ Arena появится в том же разговоре.

**Обновление.** Полностью выйдите из Desktop и запустите новый установщик для того же профиля. Используйте расширение Chrome из того же комплекта. Если расширение загружено из папки мастера, нажмите **Перезагрузить** на его карточке в Chrome. При переходе с ZIP отключите прежнюю копию и добавьте расширение по шагу 2. Обновите прежнюю вкладку Arena. Выполните `/arena-pair` в **прежнем разговоре Desktop** и привяжите к нему тот же чат Arena по шагу 3.

<details>
<summary>Ручная установка из ZIP</summary>

Распакуйте Windows ZIP в постоянную папку. Полностью выйдите из Desktop. Откройте PowerShell в распакованной папке и выполните команды, указав путь к своему `DeepSeek Harness.exe`. Для отдельного профиля сначала задайте тот же `$env:DSH_HOME`, с которым запускаете Desktop.

```powershell
$desktop = Read-Host 'Полный путь к DeepSeek Harness.exe'
$dsh = Join-Path (Split-Path -Parent $desktop) 'resources\runtime\cli\bin\dsh.cmd'
$package = (Get-Item -Path '.\dsh-arena-desktop-*.tgz').FullName
& $dsh plugin --profile desktop add $package
```

В шаге 2 выберите папку `browser-extension` из ZIP. Команды требуют доступа к реестру пакетов npm.

</details>
