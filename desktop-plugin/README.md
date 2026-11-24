# Arena Agent Mode в DeepSeek Harness Desktop

Плагин добавляет модель **Arena Agent Mode** и команду **Connect Arena / Подключить Arena** (`/arena-pair`). Установите его с Python-компаньоном и расширением Chrome по [инструкции Windows](../INSTALL.md).

Пакет 0.1.21 устанавливается штатной командой `dsh plugin --profile desktop add` на DeepSeek Harness Desktop `0.2.2-rc.5` и `0.2.3-alpha.2` без допуска версии.

**English** — Plugin 0.1.21 supports installation with `dsh plugin --profile desktop add` on DeepSeek Harness Desktop `0.2.2-rc.5` and `0.2.3-alpha.2` without a version exemption.

Arena запрашивает справку через `arena_tool_help`. Пустой запрос показывает, какие инструменты на текущем шаге вызываются напрямую и какие доступны внутри `run_code`. Запрос `{"name":"read"}` возвращает способ вызова, параметры, сведения о результате и опубликованную Harness инструкцию. Ссылка на индивидуальную инструкцию `{"guide":"tool:read"}` открывает ту же справку. Запрос `{"sdk":true}` открывает штатный SDK. Если пришёл `nextCursor`, его передают как `cursor` с теми же аргументами. Справка о новом инструменте появляется, как только Harness допускает его к работе на этом шаге.

**English** — Call `arena_tool_help` with `{}` to see which tools can be called directly and which are available inside `run_code` on the current step. Use `{"name":"read"}` for its call route, arguments, return information and any instructions published by Harness. A link to an individual tool guide such as `{"guide":"tool:read"}` opens the same reference. Use `{"sdk":true}` for the native SDK. Pass a returned `nextCursor` as `cursor` with the same query to continue. New tools appear as soon as the active Harness step admits them.

Пустой запрос также показывает общие инструкции. Например, `{"guide":"tool:schedule"}` возвращает опубликованные правила планировщика. Для одного программного вызова запрос `{"name":"read_image","sdk":true}` показывает тип результата, который получает программа.

**English** — The index also lists shared guides. For example, `{"guide":"tool:schedule"}` returns the scheduler's published rules. Use `{"name":"read_image","sdk":true}` for a single program binding and its actual return type.

В начале диалога мост объясняет Arena, как общаться с Desktop, и показывает один пример запроса справки для текущего профиля. Для вызова инструмента Arena копирует в `turn_id` идентификатор из последней строки текущего сообщения `Bridge delivery <id>`, в том числе после возврата результата. Для обычного ответа достаточно текста. Руководство Computer Use доступно по запросу, когда инструмент разрешён. Доступ к приложениям подтверждается в Harness.

At the start of a conversation the bridge explains how to use Desktop and gives a help example for the current profile. For each tool call Arena copies the ID from the current message’s final `Bridge delivery <id>` line into `turn_id`, including after a tool result. Ordinary replies can be plain text. Arena can request the native Computer Use guide when the tool is available. Harness handles application permissions.

Начиная с плагина 0.1.11, команда `/arena-reset` очищает очередь моста и освобождает подключение из любого диалога этого профиля Desktop. Используйте её, если прежний диалог удалён или нужно привязать другой. После сброса выполните `/arena-pair` в нужном диалоге. Если Chrome уже получил задачу для отправки, она может дойти в прежний чат.

**English** — Run `/arena-reset` in any Desktop chat in the profile to clear the bridge queue and release the connection. Then run `/arena-pair` in the chat you want to use. A send already handed to Chrome may still reach the original chat.

## Использование

- В обычном режиме пишите задания в поле чата Desktop. Запросы инструментов проходят через штатный исполнитель и разрешения рабочего профиля.
- В режиме `/plan` Arena получает инструкцию текущего режима. Готовый план открывает штатную карточку согласования. После утверждения следующая доставка сообщает модели, что можно приступить к работе.
- `/goal` использует штатные раунды Harness. Число раундов, пауза и продолжение управляются в Desktop.
- В разговоре с моделью Arena Agent Mode нажмите **+ → Файл**, выберите файлы с диска и отправьте сообщение. Мост передаёт выбранные оригиналы в порядке прикрепления и сохраняет анимацию GIF. Проверку загрузки выполняет форма Arena. Введённый вручную путь остаётся текстом. Изображения, которые Arena сгенерировала в ответ, появляются в Desktop отдельными вложениями.
- На поддерживаемых карточках Arena варианты отображаются в Desktop через штатный `ask_user_question`. Управление подбором инструмента зависит от включённого набора инструментов сессии.

## Маршрутизация ответа

Идентификатор отправки в конце задания связывает ответ Arena с текущей доставкой. Локальный вызов передаётся одним JSON-объектом с первым ключом `"$harness":"tool_call"`, полем `turn_id`, именем `name` и объектом `arguments`. Обычный JSON остаётся видимым текстом. Принятый вызов передаётся штатному исполнителю Desktop. При подтверждённой правке исходного ответа мост останавливает затронутый ход, а новая пользовательская доставка открывает новый ход в том же документе браузера.

## Проверка из исходников

Сначала подготовьте чистый checkout upstream и зависимости по [инструкции адаптера](../harness-adapter/README.md). Затем в каталоге `desktop-plugin`:

```powershell
npm install --legacy-peer-deps --no-package-lock
npm test
```

Для интерактивной проверки окна сопряжения в Windows задайте `ARENA_TEST_NATIVE_WINDOW=1` перед запуском тестов. Эта проверка открывает диалог с синтетическим токеном.

В установленном архиве компаньон запускается из каталога самого пакета. Для разработки можно задать `ARENA_BRIDGE_ROOT` или свойство `bridgeRoot` в конфигурации плагина. Путь к Python настраивается через `ARENA_PYTHON` или свойство `python`.
