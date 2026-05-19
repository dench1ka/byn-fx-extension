# BYN → FX — Currency Converter for av.by & kufar.by

> Автоматически конвертирует цены в BYN в доллары, евро или рубли прямо на сайтах av.by и kufar.by по официальному курсу Нацбанка РБ.

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/EXTENSION_ID?label=Chrome%20Web%20Store&color=4285F4)](https://chrome.google.com/webstore/detail/EXTENSION_ID)
[![Chrome Web Store Users](https://img.shields.io/chrome-web-store/users/EXTENSION_ID?color=34A853)](https://chrome.google.com/webstore/detail/EXTENSION_ID)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Скриншоты

<!-- Замените на реальные скриншоты после публикации -->

| av.by с бейджами USD | Popup — конвертер и курсы |
|---|---|
| ![av.by screenshot](docs/screenshot-avby.png) | ![Popup screenshot](docs/screenshot-popup.png) |

---

## Что делает расширение

Открываете страницу с объявлением на av.by или kufar.by — рядом с каждой ценой в BYN автоматически появляется компактный синий бейдж с суммой в выбранной валюте. Никакой ручной работы.

**Поддерживаемые сайты:**
- [av.by](https://av.by) — авто, запчасти
- [kufar.by](https://kufar.by) — авто, недвижимость, товары

**Возможности:**
- Бейдж рядом с каждой ценой — USD, EUR или RUB на выбор
- Встроенный конвертер с 7 валютами (BYN, USD, EUR, RUB, PLN, CNY, GBP)
- Графики курсов: 7Д / 1М / 3М / 1Г
- Курсы обновляются каждый час с официального API Нацбанка РБ
- Тёмная / светлая / авто тема
- Работает при SPA-навигации и бесконечном скролле

---

## Установка

### Из Chrome Web Store (рекомендуется)

[![Установить из Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Установить-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://chrome.google.com/webstore/detail/EXTENSION_ID)

### Для разработчиков (Load unpacked)

```bash
git clone https://github.com/YOUR_USERNAME/byn-fx-extension.git
cd byn-fx-extension
```

1. Откройте Chrome → `chrome://extensions`
2. Включите **Developer mode** (переключатель справа вверху)
3. Нажмите **Load unpacked**
4. Выберите папку `extension/` внутри репозитория

---

## Структура репозитория

```
byn-fx-extension/
├── extension/          # Файлы расширения (загружаются в Chrome)
│   ├── manifest.json
│   ├── content.js      # Content script: поиск цен и вставка бейджей
│   ├── popup.html      # UI попапа
│   ├── popup.js        # Логика попапа: курсы, конвертер, графики
│   └── icons/
│       ├── icon16.png
│       ├── icon32.png
│       ├── icon48.png
│       └── icon128.png
├── tests/
│   └── run_v6.js       # 83 автотеста (jsdom + Node.js)
├── docs/               # Скриншоты для README
├── README.md
├── CHANGELOG.md
└── LICENSE
```

---

## Как это работает

Расширение ищет BYN-цены двумя способами:

1. **CSS-селекторы** — список из ~20 точных селекторов для известных блоков av.by и kufar.by.
2. **Leaf-scanner (TreeWalker)** — универсальный fallback: обходит DOM и находит маленькие элементы с числом + "р." даже когда CSS-классы изменились (kufar.by активно использует CSS-modules с хеш-суффиксами).

Курсы берутся с официального API: `api.nbrb.by/exrates/rates`. Один запрос возвращает все валюты, результат кешируется на 1 час в `chrome.storage.local`. При недоступности API (VPN, блокировки) расширение продолжает работать с кешированными данными.

---

## Запуск тестов

```bash
node tests/run_v6.js
```

Требования: Node.js 18+. Тесты используют jsdom, без дополнительных зависимостей.

Текущий статус: **83/83** ✅

---

## Правовой статус

Расширение законно. Предписания МАРТ (Министерства антимонопольного регулирования) адресованы владельцам сайтов, не пользователям. Расширение работает локально в браузере, не изменяет сайт и не занимается торговлей — аналогично переводчику страниц или тёмной теме.

**Конвертация носит справочный характер по курсу Нацбанка РБ. Официальные цены продавца — в BYN.**

---

## История изменений

См. [CHANGELOG.md](CHANGELOG.md)

---

## Лицензия

[MIT](LICENSE) © 2026
