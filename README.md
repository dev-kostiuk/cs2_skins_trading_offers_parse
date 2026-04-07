# Offers Parse — CS2 Skins Offers Parser

> 🇺🇦 [Українська версія](README.uk.md)

Six daemons that parse **real offers (listings)** from skin marketplaces — actual sell offers with prices, float values, paint seeds, etc. This is the core data source for arbitrage, order books, and price charts.

---

## Related repositories

| Repository | Description |
|------------|-------------|
| [cs2_skins_trading_database](https://github.com/dev-kostiuk/cs2_skins_trading_database) | Database schemas (required) |
| [cs2_skins_trading_items_parse](https://github.com/dev-kostiuk/cs2_skins_trading_items_parse) | Items catalog parser (required for DMarket/WM) |

---

## Installation

```bash
cd offers_parse
npm install
cp .env.example .env   # fill in API keys
```

## Quick start

```bash
# 1. Initialize databases first
cd ../database && npm i && node offers_dmarket.js && node offers_whitemarket.js && cd ../offers_parse

# 2. Make sure items catalog is populated
# (items_parse daemons should have run at least once)

# 3. Start offer parsers
pm2 start offers.config.cjs   # DMarket + WhiteMarket

# Or start individually
node dmarket.js
node whitemarket.js
node bitskins.js
node waxpeer.js
node lootfarm.js
node skinport.js
```

---

## API keys — where to get

### DMarket (required for dmarket.js)

1. Go to [dmarket.com/settings](https://dmarket.com/settings)
2. Navigate to **Trading API** section
3. Click **Generate Keys**
4. Copy **Public Key** (hex with `0x` prefix) and **Secret Key** (hex)
5. Paste into `.env` as `DMARKET_PUBLIC_KEY` and `DMARKET_SECRET_KEY`

Signing: ed25519 via `tweetnacl` library. Each request is signed with `method + path + body + timestamp`.

### WhiteMarket (required for whitemarket.js)

1. Go to [white.market/profile/api](https://white.market/profile/api)
2. Generate **Partner Token**
3. Paste into `.env` as `WHITE_PARTNER_TOKEN`

Auth flow: Partner Token → JWT access token (cached 23 hours).

### Other markets (no keys needed)

BitSkins, Waxpeer, Loot.Farm, Skinport — public APIs, no authentication required.

---

## Daemons

### `dmarket.js` — DMarket offers (auth required)

**API:** `https://api.dmarket.com/exchange/v1/offers-by-title`

**How it works:**
1. Takes a batch of items from `items_dmarket.db` queue (`offers_parsed=0`)
2. For each item, fetches all offers with pagination (up to MAX_PAGES × 100)
3. Stores each offer: `id`, `price_usd`, `float_val`, `paint_seed`, `paint_index`, `inspect_url`
4. Tracks changes via history table:
   - New offer → `seen` event
   - Price changed → `price_changed` event
   - Offer gone → `removed` event + DELETE
5. Marks item as `offers_parsed=1`
6. When queue empty → resets all to `offers_parsed=0`, starts over
7. Runs `incremental_vacuum(1000)` after each batch

**Speed:** 100 items/batch, 200ms delay. Full cycle ~12,600 items in ~8 hours.

### `whitemarket.js` — WhiteMarket offers (auth required)

**API:** `https://api.white.market/graphql/partner` (GraphQL)

**How it works:**
1. Takes batch of 500 items from `items_whitemarket.db` queue
2. For each item, fetches offers via GraphQL with pagination (up to 10,000 per item)
3. Extracts: `id`, `price_usd`, `float_val`, `paint_seed`, `paint_index`, `phase`, `asset_id`, `seller_id`
4. Upsert + history tracking (same as DMarket)
5. **Parallel:** 2 concurrent workers (configurable)

**Speed:** 500 items/batch, 2 parallel. Full cycle ~27,000 items in ~5 minutes.

### `bitskins.js` — BitSkins (public API)

**API:** `https://api.bitskins.com/market/insell/730`

Single request → all items with min price and quantity. Cycle every 5 minutes.

### `waxpeer.js` — Waxpeer (public API)

**API:** `https://api.waxpeer.com/v1/prices?game=csgo`

Single request → all items. Price in 1/1000 USD.

### `lootfarm.js` — Loot.Farm (public API)

**API:** `https://loot.farm/fullprice.json`

Single request → all items. Price in 1/1000 USD.

### `skinport.js` — Skinport (public API)

**API:** `https://api.skinport.com/v1/items?app_id=730`

Single request → all items with min price and quantity.

---

## .env parameters

### DMarket offers

| Parameter | Default | Description |
|-----------|---------|-------------|
| `DMARKET_API_BASE` | `https://api.dmarket.com` | API base URL |
| `DMARKET_OFFERS_PATH` | `/exchange/v1/offers-by-title` | Offers endpoint path |
| `DMARKET_GAME_ID` | `a8db` | CS2 game ID |
| `DMARKET_PUBLIC_KEY` | — | **Required.** Ed25519 public key (hex) |
| `DMARKET_SECRET_KEY` | — | **Required.** Ed25519 secret key (hex) |
| `DMARKET_OFFERS_BATCH_SIZE` | `50` | Items per batch from queue |
| `DMARKET_OFFERS_LIMIT` | `100` | Offers per page (max 100) |
| `DMARKET_OFFERS_MAX_PAGES` | `200` | Max pages per item. 200 × 100 = 20,000 offers max |
| `DMARKET_OFFERS_REQUEST_DELAY_MS` | `200` | Delay between API requests (ms) |
| `DMARKET_OFFERS_HTTP_MAX_RETRIES` | `8` | Max retries on 429/5xx |
| `DMARKET_OFFERS_FETCH_TIMEOUT_MS` | `30000` | Request timeout (ms) |
| `DMARKET_OFFERS_MAX_WAIT_MS` | `15000` | Max retry backoff (ms) |
| `DMARKET_OFFERS_LOOP_SLEEP_MS` | `5000` | Sleep between batches (ms) |
| `DMARKET_OFFERS_RESET_SLEEP_MS` | `60000` | Sleep after queue reset (ms) |
| `DMARKET_ITEMS_DMARKET_DB_PATH` | `../database/items_dmarket.db` | Items queue DB |
| `DMARKET_OFFERS_DMARKET_DB_PATH` | `../database/offers_dmarket.db` | Offers output DB |

### WhiteMarket offers

| Parameter | Default | Description |
|-----------|---------|-------------|
| `WHITE_ENDPOINT` | `https://api.white.market/graphql/partner` | GraphQL endpoint |
| `WHITE_PARTNER_TOKEN` | — | **Required.** Partner API token |
| `WHITE_APP_ID` | `CSGO` | Application ID |
| `WHITE_OFFERS_BATCH_SIZE` | `500` | Items per batch |
| `WHITE_OFFERS_PAGE_SIZE` | `100` | Offers per GraphQL page |
| `WHITE_OFFERS_MAX_PER_ITEM` | `10000` | Max offers per item |
| `WHITE_OFFERS_CONCURRENCY` | `2` | Parallel workers. Keep ≤3 to avoid 429 |
| `WHITE_OFFERS_REQUEST_DELAY_MS` | `300` | Delay between requests (ms) |
| `WHITE_OFFERS_HTTP_MAX_RETRIES` | `6` | Max retries |
| `WHITE_OFFERS_FETCH_TIMEOUT_MS` | `30000` | Request timeout (ms) |
| `WHITE_OFFERS_MAX_WAIT_MS` | `15000` | Max retry backoff (ms) |
| `WHITE_OFFERS_LOOP_SLEEP_MS` | `1000` | Sleep between batches (ms) |
| `WHITE_OFFERS_RESET_SLEEP_MS` | `60000` | Sleep after queue reset (ms) |
| `WHITEMARKET_ITEMS_WHITEMARKET_DB_PATH` | `../database/items_whitemarket.db` | Items queue DB |
| `WHITE_OFFERS_WHITEMARKET_DB_PATH` | `../database/offers_whitemarket.db` | Offers output DB |

### Other markets

| Parameter | Default | Description |
|-----------|---------|-------------|
| `WAXPEER_DB_PATH` | `../database/offers_waxpeer.db` | Waxpeer DB path |
| `WAXPEER_LOOP_SLEEP_MS` | `300000` | Cycle interval (5 min) |
| `BITSKINS_DB_PATH` | `../database/offers_bitskins.db` | BitSkins DB path |
| `BITSKINS_LOOP_SLEEP_MS` | `300000` | Cycle interval (5 min) |
| `LOOTFARM_DB_PATH` | `../database/offers_lootfarm.db` | Loot.Farm DB path |
| `LOOTFARM_LOOP_SLEEP_MS` | `300000` | Cycle interval (5 min) |

Skinport uses the same pattern via `prices_parse/` config.

---

## Key features

- **History tracking** — every price change or offer removal is recorded
- **auto_vacuum = INCREMENTAL** — prevents DB file bloat (was 66 GB before fix)
- **Hot-reload .env** — change parameters without restart
- **Retry with exponential backoff** — handles 429 and network errors
- **Queue-based parsing** — `offers_parsed` field ensures even coverage of all items

---

## Debugging

```bash
# Check daemon status
pm2 logs dmarket-offers-daemon --lines 20
pm2 logs whitemarket-offers-daemon --lines 20

# Check offers count
sqlite3 ../database/offers_dmarket.db "SELECT COUNT(DISTINCT name), COUNT(*) FROM offers_dmarket;"
sqlite3 ../database/offers_whitemarket.db "SELECT COUNT(DISTINCT name), COUNT(*) FROM offers_whitemarket;"

# Check parsing queue
sqlite3 ../database/items_dmarket.db "SELECT SUM(offers_parsed=0) as pending, SUM(offers_parsed=1) as done FROM items_dmarket;"

# Check DB size (should stay reasonable with auto_vacuum)
ls -lh ../database/offers_*.db

# Check 429 errors
pm2 logs whitemarket-offers-daemon --err --lines 50 | grep 429

# Force re-parse all items
sqlite3 ../database/items_dmarket.db "UPDATE items_dmarket SET offers_parsed=0;"
```

---

## File structure

```
offers_parse/
├── dmarket.js          # DMarket offers daemon (auth: ed25519)
├── whitemarket.js      # WhiteMarket offers daemon (auth: Partner Token)
├── bitskins.js         # BitSkins offers daemon (public API)
├── waxpeer.js          # Waxpeer offers daemon (public API)
├── lootfarm.js         # Loot.Farm offers daemon (public API)
├── skinport.js         # Skinport offers daemon (public API)
├── env.js              # Configuration with hot-reload
├── offers.config.cjs   # PM2 ecosystem config
├── .env.example        # Environment template
├── package.json
├── README.md           # English
└── README.uk.md        # Ukrainian
```

---

## Dependencies

- `better-sqlite3` — SQLite driver
- `dotenv` — Environment variables
- `tweetnacl` — Ed25519 signing for DMarket API
