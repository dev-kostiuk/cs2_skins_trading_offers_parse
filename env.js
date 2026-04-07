import fs from "node:fs";
import dotenv from "dotenv";

let lastEnvMtime = 0;

export function reloadEnvIfChanged(envPath = ".env") {
    try {
        const stat = fs.statSync(envPath);
        if (stat.mtimeMs !== lastEnvMtime) {
            dotenv.config({ path: envPath, override: true });
            lastEnvMtime = stat.mtimeMs;
            console.log(`[env] reloaded ${envPath}`);
        }
    } catch {}
}

function num(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
}
function str(v, d = "") {
    return (typeof v === "string" ? v : String(v ?? "")).trim() || d;
}

/* ─── DMarket offers ──────────────────────────────────────── */

export function getDmarketOffersEnv() {
    return {
        ENV_PATH: str(process.env.DMARKET_OFFERS_ENV_PATH, ".env"),

        API_BASE: str(process.env.DMARKET_API_BASE, "https://api.dmarket.com"),
        OFFERS_PATH: str(process.env.DMARKET_OFFERS_PATH, "/exchange/v1/offers-by-title"),
        GAME_ID: str(process.env.DMARKET_GAME_ID, "a8db"),

        PUBLIC_KEY: str(process.env.DMARKET_PUBLIC_KEY),
        SECRET_KEY: str(process.env.DMARKET_SECRET_KEY),

        BATCH_SIZE: num(process.env.DMARKET_OFFERS_BATCH_SIZE, 50),
        OFFERS_LIMIT: num(process.env.DMARKET_OFFERS_LIMIT, 100),
        MAX_PAGES_PER_ITEM: num(process.env.DMARKET_OFFERS_MAX_PAGES, 50),

        REQUEST_DELAY_MS: num(process.env.DMARKET_OFFERS_REQUEST_DELAY_MS, 200),
        HTTP_MAX_RETRIES: num(process.env.DMARKET_OFFERS_HTTP_MAX_RETRIES, 8),
        FETCH_TOTAL_TIMEOUT_MS: num(process.env.DMARKET_OFFERS_FETCH_TIMEOUT_MS, 30000),
        MAX_WAIT_MS: num(process.env.DMARKET_OFFERS_MAX_WAIT_MS, 15000),

        LOOP_SLEEP_MS: num(process.env.DMARKET_OFFERS_LOOP_SLEEP_MS, 5000),
        RESET_SLEEP_MS: num(process.env.DMARKET_OFFERS_RESET_SLEEP_MS, 60000),

        ITEMS_DMARKET_DB_PATH: str(process.env.DMARKET_ITEMS_DMARKET_DB_PATH, "../database/items_dmarket.db"),
        OFFERS_DMARKET_DB_PATH: str(process.env.DMARKET_OFFERS_DMARKET_DB_PATH, "../database/offers_dmarket.db"),

        BUSY_TIMEOUT_MS: num(process.env.DMARKET_BUSY_TIMEOUT_MS, 5000),
    };
}

export function assertDmarketOffersEnv(env) {
    if (!env.API_BASE) throw new Error("DMARKET_API_BASE is missing");
    if (!env.ITEMS_DMARKET_DB_PATH) throw new Error("DMARKET_ITEMS_DMARKET_DB_PATH is missing");
    if (!env.OFFERS_DMARKET_DB_PATH) throw new Error("DMARKET_OFFERS_DMARKET_DB_PATH is missing");
}

/* ─── Whitemarket offers ──────────────────────────────────── */

export function getWhitemarketOffersEnv() {
    return {
        ENV_PATH: str(process.env.WHITEMARKET_OFFERS_ENV_PATH, ".env"),

        ENDPOINT: str(process.env.WHITE_ENDPOINT, "https://api.white.market/graphql/partner"),
        PARTNER_TOKEN: str(process.env.WHITE_PARTNER_TOKEN),
        APP_ID: str(process.env.WHITE_APP_ID, "CSGO"),

        BATCH_SIZE: num(process.env.WHITE_OFFERS_BATCH_SIZE, 200),
        PAGE_SIZE: num(process.env.WHITE_OFFERS_PAGE_SIZE, 100),
        MAX_OFFERS_PER_ITEM: num(process.env.WHITE_OFFERS_MAX_PER_ITEM, 500),

        CONCURRENCY: num(process.env.WHITE_OFFERS_CONCURRENCY, 5),
        REQUEST_DELAY_MS: num(process.env.WHITE_OFFERS_REQUEST_DELAY_MS, 100),
        HTTP_MAX_RETRIES: num(process.env.WHITE_OFFERS_HTTP_MAX_RETRIES, 6),
        FETCH_TOTAL_TIMEOUT_MS: num(process.env.WHITE_OFFERS_FETCH_TIMEOUT_MS, 30000),
        MAX_WAIT_MS: num(process.env.WHITE_OFFERS_MAX_WAIT_MS, 15000),

        LOOP_SLEEP_MS: num(process.env.WHITE_OFFERS_LOOP_SLEEP_MS, 5000),
        RESET_SLEEP_MS: num(process.env.WHITE_OFFERS_RESET_SLEEP_MS, 60000),

        ITEMS_WHITEMARKET_DB_PATH: str(process.env.WHITEMARKET_ITEMS_WHITEMARKET_DB_PATH, "../database/items_whitemarket.db"),
        OFFERS_WHITEMARKET_DB_PATH: str(process.env.WHITE_OFFERS_WHITEMARKET_DB_PATH, "../database/offers_whitemarket.db"),

        BUSY_TIMEOUT_MS: num(process.env.WHITE_BUSY_TIMEOUT_MS, 5000),
    };
}

export function assertWhitemarketOffersEnv(env) {
    if (!env.ENDPOINT) throw new Error("WHITE_ENDPOINT is missing");
    if (!env.PARTNER_TOKEN) throw new Error("WHITE_PARTNER_TOKEN is missing");
    if (!env.ITEMS_WHITEMARKET_DB_PATH) throw new Error("WHITEMARKET_ITEMS_WHITEMARKET_DB_PATH is missing");
    if (!env.OFFERS_WHITEMARKET_DB_PATH) throw new Error("WHITE_OFFERS_WHITEMARKET_DB_PATH is missing");
}

/* ─── Waxpeer offers ──────────────────────────────────────── */

export function getWaxpeerEnv() {
    return {
        DB_PATH:       str(process.env.WAXPEER_DB_PATH, "../database/offers_waxpeer.db"),
        LOOP_SLEEP_MS: num(process.env.WAXPEER_LOOP_SLEEP_MS, 300_000),
    };
}

/* ─── BitSkins offers ─────────────────────────────────────── */

export function getBitskinsEnv() {
    return {
        DB_PATH:       str(process.env.BITSKINS_DB_PATH, "../database/offers_bitskins.db"),
        LOOP_SLEEP_MS: num(process.env.BITSKINS_LOOP_SLEEP_MS, 300_000),
    };
}

/* ─── Loot.Farm offers ────────────────────────────────────── */

export function getLootfarmEnv() {
    return {
        DB_PATH:       str(process.env.LOOTFARM_DB_PATH, "../database/offers_lootfarm.db"),
        LOOP_SLEEP_MS: num(process.env.LOOTFARM_LOOP_SLEEP_MS, 300_000),
    };
}
