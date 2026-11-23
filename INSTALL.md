# Установка Arena Harness Bridge на Windows

[English version](INSTALL.en.md)

Для установки нужны **DeepSeek Harness Desktop**, Google Chrome и Python. Заявленные версии Desktop — **0.2.2-rc.5** и **0.2.3-alpha.2**. В ZIP v0.1.4 входят плагин 0.1.13 с Python-компаньоном и расширение Chrome 0.1.41. [DeepSeek Harness Desktop](https://deepseek.com/harness/) · [Релизы моста](https://github.com/StanislavSmetaninSSM/arena-harness-bridge/releases)

## 1. Скачайте и распакуйте ZIP

1. На странице релиза в разделе **Assets** найдите Windows ZIP нужной версии, например `arena-harness-bridge-v0.1.4-windows.zip`. Распакуйте его в постоянную папку, например `C:\Tools\Arena Bridge`. Desktop сохраняет путь к архиву плагина, а Chrome загружает расширение из распакованной папки.
2. Установите Python и проверьте в PowerShell, что команда `python --version` выводит версию. Для установки зависимостей плагина понадобится доступ к npm-реестру.

## 2. Установите плагин в Desktop

1. Запустите DeepSeek Harness Desktop один раз, чтобы он создал профиль. На экране приветствия можно выбрать **Добавить ключ API → Настроить позже**. Затем полностью выйдите из приложения через меню или значок в области уведомлений.
2. Откройте PowerShell в распакованной папке. Подставьте фактический путь к `DeepSeek Harness.exe`, чтобы использовать встроенный CLI именно этой установки.

   ```powershell
   $desktop = 'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
   $dsh = Join-Path (Split-Path -Parent $desktop) 'resources\runtime\cli\bin\dsh.cmd'
   ```

   Если `dsh` в PATH относится к этой установке Desktop, можно задать `$dsh = 'dsh'`.

3. Выведите точную версию Harness и установите плагин. В `$pluginVersion` укажите номер из имени распакованного `.tgz`. Для комплекта v0.1.4 это `0.1.13`.

   ```powershell
   & $dsh --version
   $pluginVersion = '0.1.13'
   $package = (Resolve-Path -LiteralPath ".\dsh-arena-desktop-$pluginVersion.tgz").Path
   & $dsh plugin --profile desktop add $package
   ```

4. Снова запустите Desktop. Создайте или откройте разговор в нужной рабочей папке и выберите **Arena Agent Mode** в селекторе моделей.

### Если Harness отклоняет установку из-за версии

Если CLI сообщает о несовместимости и вы хотите попробовать плагин на этой версии, в том же PowerShell введите полный номер из `& $dsh --version`, включая суффикс вроде `-rc.5`. Допуск снимает блокировку для этой пары версий Harness и плагина. Работу плагина с этой версией нужно проверить отдельно. [Управление совместимостью в DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md#version-compatibility-and-exemptions)

```powershell
$harnessVersion = Read-Host 'Точная версия DeepSeek Harness из --version'
& $dsh plugin --profile desktop allow-version "dsh-arena-desktop@$pluginVersion" --dsh-version $harnessVersion --accept-risk
if ($LASTEXITCODE -eq 0) {
    & $dsh plugin --profile desktop add $package
}
```

## 3. Загрузите расширение и привяжите чат

1. Откройте в Chrome `chrome://extensions`. Включите **Режим разработчика**, нажмите **Загрузить распакованное расширение** и выберите папку `browser-extension` из ZIP.
2. Войдите в Arena и откройте **Agent Mode**. Если чат новый, отправьте первое сообщение в Chrome и дождитесь ответа. После появления адреса вида `https://arena.ai/agent/<id>` обновите вкладку.
3. В выбранном разговоре Desktop выполните `/arena-pair` и нажмите **Copy pairing token**.
4. Во вкладке Arena откройте расширение **Arena Harness Bridge**, выберите ваш разговор Arena, вставьте токен и нажмите **Bind conversation**. Используйте токен только для локального сопряжения.

## 4. Отправьте первое сообщение

Введите в Desktop «Ответь одной строкой: СОЕДИНЕНИЕ РАБОТАЕТ». Сообщение должно появиться во вкладке Arena, а ответ — в Desktop. Для работы с файлами выберите нужную папку и уровень разрешений в Desktop. Отправленные сообщения, выбранные вложения и результаты инструментов этой сессии передаются в Arena.

## Обновление с предыдущей версии

1. Дождитесь завершения текущего запроса и распакуйте новый ZIP в отдельную папку.
2. Полностью закройте Desktop, установите новый `.tgz` из ZIP командой из [раздела установки плагина](#2-установите-плагин-в-desktop) и снова запустите Desktop.
3. Скопируйте файлы из новой папки `browser-extension` в ту, из которой Chrome уже загружает расширение, и подтвердите замену файлов. На странице `chrome://extensions` включите **Режим разработчика**, нажмите кнопку обновления на карточке **Arena Harness Bridge** и проверьте, что указана версия **0.1.41**.
4. Обновите вкладку Arena и выполните `/arena-pair` в прежнем диалоге Desktop. Скопируйте токен и привяжите вкладку по шагам 3–4 [раздела подключения](#3-загрузите-расширение-и-привяжите-чат).

## Если подключение не работает

- **Нет модели Arena Agent Mode или команды `/arena-pair`.** Проверьте, что плагин установлен встроенным CLI того же Desktop в профиль `desktop`, и перезапустите приложение. В проверенной сборке установщик может предупредить о peer-зависимости `@deepseek-ai/dsh-llm`. Эта сборка Desktop загружает её из своего окружения.
- **Компаньон не запускается.** Проверьте Python в PATH. Если нужно, задайте полный путь к `python.exe` в переменной `ARENA_PYTHON` в окружении запуска Desktop. Если порт `127.0.0.1:8766` занят другим экземпляром моста, завершите тот экземпляр.
- **Arena просит верификацию.** Пройдите её во вкладке Chrome.
- **Расширение просит перезагрузить вкладку Arena.** Откройте сохранённый чат с адресом `/agent/<id>` и обновите саму вкладку Chrome. Затем откройте расширение, вставьте токен и нажмите **Bind conversation**. После установки или обновления расширения перезагрузка вкладки запускает в ней скрипт моста.
- **Исходный разговор удалён или нужно сменить привязку.** Выполните `/arena-reset` в любом диалоге Desktop в том же профиле. Сброс освобождает привязку и останавливает ожидающие доставки. Отправка, уже переданная Chrome, может завершиться в старом чате. Затем выполните `/arena-pair` в нужном диалоге и привяжите вкладку Arena.

Чтобы удалить плагин, выйдите из Desktop и выполните `dsh plugin --profile desktop remove dsh-arena-desktop` тем же CLI. Удалите расширение на странице `chrome://extensions`.
