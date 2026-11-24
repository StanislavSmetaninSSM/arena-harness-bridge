# Arena Harness Bridge

Мост подключает один веб-чат Arena Agent Mode к одному разговору в штатном DeepSeek Harness Desktop. Задания вводятся в обычном поле Desktop, ответы Arena приходят в тот же разговор. Штатные инструменты Harness выполняют локальные действия с разрешениями выбранного профиля.

Arena Harness Bridge connects an Arena Agent Mode browser chat to the standard DeepSeek Harness Desktop app. Type in Desktop and get Arena’s replies there.

**Проверено на Windows с Chrome и DeepSeek Harness Desktop 0.2.2-rc.5 и 0.2.3-alpha.2.** [Последний релиз и ZIP для Windows](https://github.com/StanislavSmetaninSSM/arena-harness-bridge/releases/latest) · [Инструкция на русском](INSTALL.md) · [English installation guide](INSTALL.en.md)

## Возможности

- Обычные сообщения, ответы и локальные вызовы инструментов с подтверждениями Desktop.
- Штатные цели, режим плана, карточки вопросов, вложения и скиллы текущего профиля.
- Передача PNG из Desktop в Arena и возврат сгенерированных изображений в Desktop.
- Команда `/arena-reset` освобождает привязку к Arena из любого диалога Desktop в том же профиле, даже если исходный диалог удалён.
- При подтверждённом изменении исходного ответа мост останавливает старый ход. Новое сообщение из Desktop восстанавливает работу в том же документе Arena. Старые доставки остаются закрытыми.

Ход цели, доступные инструменты и действия с файлами определяются профилем Desktop. Транспорт зависит от интерфейса Arena в браузере. Доступ к Agent Mode и условия текущей сессии определяются Arena.

## Данные и разрешения

Мост слушает `127.0.0.1:8766` и привязывает вкладку по локальному токену. В чат Arena передаются отправленные сообщения, выбранные вложения, результаты инструментов этой сессии и описания доступных инструментов и скиллов. Для локальной работы выберите нужную рабочую папку и профиль разрешений в Desktop.

## Дополнительный CLI

Терминальный режим использует отдельный профиль проекта и закреплённую ревизию upstream DeepSeek Harness. Установите зависимости по [инструкции терминального адаптера](harness-adapter/README.md), загрузите это же расширение в Chrome и запустите из корня репозитория:

```powershell
python -m arena_terminal --root 'C:\путь\к\проекту'
```

Откройте конкретный чат Arena Agent Mode, введите `/pair` в терминале и привяжите чат через расширение. Доступные команды показывает `/help`. Desktop и CLI используют один локальный порт и запускаются по очереди.

## Исходники и сборка

| Каталог | Назначение |
|---|---|
| `browser-extension/` | Расширение Chrome и тесты браузерной разметки |
| `desktop-plugin/` | Провайдер Arena и команда сопряжения Desktop |
| `arena_terminal/` | Python-компаньон, журнал доставки и терминальный клиент |
| `harness-adapter/` | Исполнитель для дополнительного терминального режима |

Для сборки нужны Python и npm. Архив появится в `dist/`.

```powershell
python scripts/build_windows_release.py --version 0.1.6
python -m unittest test_arena_desktop test_arena_terminal test_windows_release
node --test browser-extension/tests/*.test.cjs
```

Для полной проверки Python через `python -m unittest discover` сначала установите зависимости и закреплённые исходники DSH по [инструкции терминального адаптера](harness-adapter/README.md). Те же исходники используются в интеграционной [проверке плагина](desktop-plugin/README.md#проверка-из-исходников).

Лицензия проекта — [MIT](LICENSE). Часть селекторов Arena адаптирована из [Skainet Bridge](https://github.com/IvanSkainet/arena-agent). [Уведомление](browser-extension/THIRD_PARTY_NOTICES.txt)
