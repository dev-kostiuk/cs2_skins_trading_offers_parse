# Offers Parse — Парсер офферів CS2 скінів

> 🇬🇧 [English version](README.md)

Шість демонів які парсять **реальні оффери (лістинги)** з маркетів скінів — конкретні пропозиції продажу з цінами, float value, paint seed тощо. Це основне джерело даних для арбітражу, стакану і графіків цін.

---

## Пов'язані репозиторії

| Репозиторій | Опис |
|-------------|------|
| [cs2_skins_trading_database](https://github.com/dev-kostiuk/cs2_skins_trading_database) | Схеми БД (обов'язково) |
| [cs2_skins_trading_items_parse](https://github.com/dev-kostiuk/cs2_skins_trading_items_parse) | Парсер каталогу айтемів (обов'язково для DM/WM) |

---

## Встановлення

```bash
cd offers_parse
npm install
cp .env.example .env   # заповни API ключі
```

## Швидкий старт

```bash
# 1. Спочатку ініціалізуй БД
cd ../database && npm i && node offers_dmarket.js && node offers_whitemarket.js && cd ../offers_parse

# 2. Переконайся що каталог айтемів заповнений
# (items_parse демони мали відпрацювати хоча б раз)

# 3. Запусти парсери офферів
pm2 start offers.config.cjs   # DMarket + WhiteMarket

# Або окремо
node dmarket.js
node whitemarket.js
node bitskins.js
```

---

## API ключі — де отримати

### DMarket (потрібен для dmarket.js)

1. Зайди на [dmarket.com/settings](https://dmarket.com/settings)
2. Перейди в розділ **Trading API**
3. Натисни **Generate Keys**
4. Скопіюй **Public Key** (hex з префіксом `0x`) та **Secret Key** (hex)
5. Встав в `.env` як `DMARKET_PUBLIC_KEY` і `DMARKET_SECRET_KEY`

Підпис: ed25519 через бібліотеку `tweetnacl`. Кожен запит підписується: `method + path + body + timestamp`.

### WhiteMarket (потрібен для whitemarket.js)

1. Зайди на [white.market/profile/api](https://white.market/profile/api)
2. Згенеруй **Partner Token**
3. Встав в `.env` як `WHITE_PARTNER_TOKEN`

Авторизація: Partner Token → JWT access token (кешується 23 години).

### Інші маркети (ключі не потрібні)

BitSkins, Waxpeer, Loot.Farm, Skinport — публічні API, авторизація не потрібна.

---

## Демони

### `dmarket.js` — Оффери DMarket (потрібна авторизація)

**API:** `https://api.dmarket.com/exchange/v1/offers-by-title`

**Як працює:**
1. Бере батч айтемів з черги `items_dmarket.db` (`offers_parsed=0`)
2. Для кожного айтема запитує всі оффери з пагінацією (до MAX_PAGES × 100)
3. Зберігає кожен оффер: `id`, `price_usd`, `float_val`, `paint_seed`, `paint_index`, `inspect_url`
4. Відстежує зміни через таблицю історії:
   - Новий оффер → подія `seen`
   - Ціна змінилась → подія `price_changed`
   - Оффер зник → подія `removed` + DELETE
5. Позначає айтем як `offers_parsed=1`
6. Коли черга порожня → скидає всі на `offers_parsed=0`, починає заново
7. `incremental_vacuum(1000)` після кожного батчу

**Швидкість:** 100 айтемів/батч, 200мс delay. Повний цикл ~12 600 айтемів за ~8 годин.

### `whitemarket.js` — Оффери WhiteMarket (потрібна авторизація)

**API:** `https://api.white.market/graphql/partner` (GraphQL)

**Як працює:**
1. Бере батч 500 айтемів з черги `items_whitemarket.db`
2. Для кожного запитує оффери через GraphQL з пагінацією (до 10 000 на айтем)
3. Витягує: `id`, `price_usd`, `float_val`, `paint_seed`, `paint_index`, `phase`, `asset_id`, `seller_id`
4. Upsert + відстеження історії (аналогічно DMarket)
5. **Паралельність:** 2 воркери одночасно (налаштовується)

**Швидкість:** 500 айтемів/батч, 2 паралельних. Повний цикл ~27 000 айтемів за ~5 хвилин.

### `bitskins.js` — BitSkins (публічний API)

**API:** `https://api.bitskins.com/market/insell/730` — один запит → всі айтеми. Цикл кожні 5 хвилин.

### `waxpeer.js` — Waxpeer (публічний API)

**API:** `https://api.waxpeer.com/v1/prices?game=csgo` — один запит → всі айтеми. Ціна в 1/1000 USD.

### `lootfarm.js` — Loot.Farm (публічний API)

**API:** `https://loot.farm/fullprice.json` — один запит → всі айтеми. Ціна в 1/1000 USD.

### `skinport.js` — Skinport (публічний API)

**API:** `https://api.skinport.com/v1/items?app_id=730` — один запит → всі айтеми з мін ціною.

---

## Параметри .env

### DMarket оффери

| Параметр | За замовч. | Опис |
|----------|-----------|------|
| `DMARKET_API_BASE` | `https://api.dmarket.com` | Базовий URL API |
| `DMARKET_OFFERS_PATH` | `/exchange/v1/offers-by-title` | Шлях ендпоінту офферів |
| `DMARKET_GAME_ID` | `a8db` | ID гри CS2 |
| `DMARKET_PUBLIC_KEY` | — | **Обов'язково.** Ed25519 публічний ключ (hex) |
| `DMARKET_SECRET_KEY` | — | **Обов'язково.** Ed25519 секретний ключ (hex) |
| `DMARKET_OFFERS_BATCH_SIZE` | `50` | Айтемів за батч з черги |
| `DMARKET_OFFERS_LIMIT` | `100` | Офферів на сторінку (макс 100) |
| `DMARKET_OFFERS_MAX_PAGES` | `200` | Макс сторінок на айтем. 200 × 100 = 20 000 офферів |
| `DMARKET_OFFERS_REQUEST_DELAY_MS` | `200` | Затримка між запитами (мс) |
| `DMARKET_OFFERS_HTTP_MAX_RETRIES` | `8` | Макс повторів при 429/5xx |
| `DMARKET_OFFERS_FETCH_TIMEOUT_MS` | `30000` | Таймаут запиту (мс) |
| `DMARKET_OFFERS_MAX_WAIT_MS` | `15000` | Макс час retry backoff (мс) |
| `DMARKET_OFFERS_LOOP_SLEEP_MS` | `5000` | Пауза між батчами (мс) |
| `DMARKET_OFFERS_RESET_SLEEP_MS` | `60000` | Пауза після скидання черги (мс) |
| `DMARKET_ITEMS_DMARKET_DB_PATH` | `../database/items_dmarket.db` | БД черги айтемів |
| `DMARKET_OFFERS_DMARKET_DB_PATH` | `../database/offers_dmarket.db` | БД офферів (вихід) |

### WhiteMarket оффери

| Параметр | За замовч. | Опис |
|----------|-----------|------|
| `WHITE_ENDPOINT` | `https://api.white.market/graphql/partner` | GraphQL ендпоінт |
| `WHITE_PARTNER_TOKEN` | — | **Обов'язково.** Partner API токен |
| `WHITE_APP_ID` | `CSGO` | ID додатку |
| `WHITE_OFFERS_BATCH_SIZE` | `500` | Айтемів за батч |
| `WHITE_OFFERS_PAGE_SIZE` | `100` | Офферів на GraphQL сторінку |
| `WHITE_OFFERS_MAX_PER_ITEM` | `10000` | Макс офферів на айтем |
| `WHITE_OFFERS_CONCURRENCY` | `2` | Паралельних воркерів. Тримай ≤3 щоб уникнути 429 |
| `WHITE_OFFERS_REQUEST_DELAY_MS` | `300` | Затримка між запитами (мс) |
| `WHITE_OFFERS_HTTP_MAX_RETRIES` | `6` | Макс повторів |
| `WHITE_OFFERS_LOOP_SLEEP_MS` | `1000` | Пауза між батчами (мс) |
| `WHITE_OFFERS_RESET_SLEEP_MS` | `60000` | Пауза після скидання черги (мс) |

### Інші маркети

| Параметр | За замовч. | Опис |
|----------|-----------|------|
| `WAXPEER_DB_PATH` | `../database/offers_waxpeer.db` | Шлях до БД Waxpeer |
| `WAXPEER_LOOP_SLEEP_MS` | `300000` | Інтервал циклу (5 хв) |
| `BITSKINS_DB_PATH` | `../database/offers_bitskins.db` | Шлях до БД BitSkins |
| `BITSKINS_LOOP_SLEEP_MS` | `300000` | Інтервал циклу (5 хв) |
| `LOOTFARM_DB_PATH` | `../database/offers_lootfarm.db` | Шлях до БД Loot.Farm |
| `LOOTFARM_LOOP_SLEEP_MS` | `300000` | Інтервал циклу (5 хв) |

---

## Ключові особливості

- **Відстеження історії** — кожна зміна ціни або зникнення оффера записується
- **auto_vacuum = INCREMENTAL** — запобігає роздуванню БД файлів (була проблема з 66 ГБ)
- **Hot-reload .env** — зміна параметрів без перезапуску
- **Retry з exponential backoff** — обробка 429 і мережевих помилок
- **Черга парсингу** — поле `offers_parsed` забезпечує рівномірне покриття всіх айтемів

---

## Дебаг

```bash
# Статус демонів
pm2 logs dmarket-offers-daemon --lines 20
pm2 logs whitemarket-offers-daemon --lines 20

# Кількість офферів
sqlite3 ../database/offers_dmarket.db "SELECT COUNT(DISTINCT name), COUNT(*) FROM offers_dmarket;"

# Черга парсингу
sqlite3 ../database/items_dmarket.db "SELECT SUM(offers_parsed=0) as pending, SUM(offers_parsed=1) as done FROM items_dmarket;"

# Розмір БД
ls -lh ../database/offers_*.db

# Перевірити 429 помилки
pm2 logs whitemarket-offers-daemon --err --lines 50 | grep 429

# Перепарсити все
sqlite3 ../database/items_dmarket.db "UPDATE items_dmarket SET offers_parsed=0;"
```

---

## Структура файлів

```
offers_parse/
├── dmarket.js          # Демон офферів DMarket (авторизація: ed25519)
├── whitemarket.js      # Демон офферів WhiteMarket (авторизація: Partner Token)
├── bitskins.js         # Демон офферів BitSkins (публічний API)
├── waxpeer.js          # Демон офферів Waxpeer (публічний API)
├── lootfarm.js         # Демон офферів Loot.Farm (публічний API)
├── skinport.js         # Демон офферів Skinport (публічний API)
├── env.js              # Конфігурація з hot-reload
├── offers.config.cjs   # PM2 ecosystem конфіг
├── .env.example        # Шаблон змінних оточення
├── package.json
├── README.md           # English
└── README.uk.md        # Українська
```

---

## Залежності

- `better-sqlite3` — SQLite драйвер
- `dotenv` — Змінні оточення
- `tweetnacl` — Ed25519 підпис для DMarket API
