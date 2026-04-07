import Database from "better-sqlite3";
import { reloadEnvIfChanged, getWhitemarketOffersEnv, assertWhitemarketOffersEnv } from "./env.js";

function nowUnix() { return Math.floor(Date.now() / 1000); }
function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function applyPragmas(db, env) {
    db.pragma("journal_mode = WAL");
    db.pragma("auto_vacuum = INCREMENTAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("temp_store = MEMORY");
    db.pragma(`busy_timeout = ${env.BUSY_TIMEOUT_MS}`);
}

function parseNum(v) {
    if (v == null) return null;
    const n = Number(String(v).trim().replace(",", "."));
    return Number.isFinite(n) ? n : null;
}

/* ─── Auth token cache ────────────────────────────────────── */

let cachedToken = null;
let cachedTokenExpMs = 0;

async function getAccessToken(env) {
    if (cachedToken && Date.now() < cachedTokenExpMs) return cachedToken;

    const json = await postGraphql(env, { query: `mutation { auth_token { accessToken } }` }, {
        "X-partner-token": env.PARTNER_TOKEN,
    });

    const token = json?.data?.auth_token?.accessToken;
    if (!token) throw new Error("White.market: accessToken not found in response");

    cachedToken = token;
    cachedTokenExpMs = Date.now() + 23 * 60 * 60 * 1000; // 23h
    return token;
}

/* ─── HTTP ────────────────────────────────────────────────── */

async function postGraphql(env, body, extraHeaders = {}, attempt = 0) {
    if (env.REQUEST_DELAY_MS > 0) await sleep(env.REQUEST_DELAY_MS);

    try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), env.FETCH_TOTAL_TIMEOUT_MS);

        const res = await fetch(env.ENDPOINT, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json",
                ...extraHeaders,
            },
            body: JSON.stringify(body),
            signal: ac.signal,
        });

        clearTimeout(t);

        const text = await res.text();
        const json = (() => { try { return JSON.parse(text); } catch { return {}; } })();

        const retryable = res.status === 429 || res.status === 503 || (res.status >= 500 && res.status <= 504);
        if (retryable && attempt < env.HTTP_MAX_RETRIES) {
            const ra = res.headers.get("retry-after");
            let waitMs = ra && /^\d+$/.test(ra)
                ? Number(ra) * 1000
                : 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
            waitMs = Math.min(waitMs, env.MAX_WAIT_MS);
            console.warn("[white-offers] retry (status)", { status: res.status, attempt, waitMs });
            await sleep(waitMs);
            return postGraphql(env, body, extraHeaders, attempt + 1);
        }

        if (res.status < 200 || res.status >= 300) {
            throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        if (json?.errors?.length) {
            throw new Error(`GQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
        }

        return json;
    } catch (err) {
        const code = err?.cause?.code || err?.code || "";
        const msg = String(err?.message || "");
        const retryableNet =
            code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT" ||
            code === "UND_ERR_SOCKET" || code === "ECONNRESET" || code === "ETIMEDOUT" ||
            code === "EAI_AGAIN" || msg.includes("fetch failed") || msg.includes("aborted");

        if (retryableNet && attempt < env.HTTP_MAX_RETRIES) {
            let waitMs = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
            waitMs = Math.min(waitMs, env.MAX_WAIT_MS);
            console.warn("[white-offers] retry (network)", { code, attempt, waitMs });
            await sleep(waitMs);
            return postGraphql(env, body, extraHeaders, attempt + 1);
        }
        throw err;
    }
}

/* ─── Fetch offers for one item ───────────────────────────── */

function paramValue(params, key) {
    if (!Array.isArray(params)) return null;
    return params.find((x) => x?.param === key)?.value ?? null;
}

async function fetchOffersForItem(env, nameHash) {
    const token = await getAccessToken(env);
    const offers = [];
    let after = null;

    while (offers.length < env.MAX_OFFERS_PER_ITEM) {
        const body = {
            query: `
            query MarketList($search: MarketProductSearchInput!, $page: ForwardPaginationInput!) {
              market_list(search: $search, forwardPagination: $page) {
                edges {
                  node {
                    id
                    createdAt
                    price { value currency }
                    item {
                      assetId
                      order { nameHash params { param value } }
                      deal { seller { id steamId } }
                    }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }`,
            variables: {
                search: { appId: env.APP_ID, nameHash, nameStrict: true },
                page: { first: env.PAGE_SIZE, after },
            },
        };

        const json = await postGraphql(env, body, { Authorization: `Bearer ${token}` });
        const conn = json?.data?.market_list;
        const edges = conn?.edges || [];

        for (const e of edges) {
            const n = e?.node;
            if (!n?.id) continue;

            const price_usd = parseNum(n?.price?.value);
            if (price_usd === null) continue;

            const params = n?.item?.order?.params || null;
            const float_val = parseNum(paramValue(params, "CSGO_FLOAT"));
            const paint_seed = parseNum(paramValue(params, "PAINT_SEED"));
            const paint_index = parseNum(paramValue(params, "PAINT_INDEX"));
            const phase = paramValue(params, "PHASE") ?? paramValue(params, "CSGO_PHASE") ?? null;

            offers.push({
                id: String(n.id),
                price_usd,
                currency: n?.price?.currency ? String(n.price.currency) : "USD",
                float_val,
                paint_seed: paint_seed != null ? Math.round(paint_seed) : null,
                paint_index: paint_index != null ? Math.round(paint_index) : null,
                phase: (phase && String(phase).trim()) ? String(phase).trim() : null,
                asset_id: n?.item?.assetId ? String(n.item.assetId) : null,
                seller_id: n?.item?.deal?.seller?.id ? String(n.item.deal.seller.id) : null,
            });

            if (offers.length >= env.MAX_OFFERS_PER_ITEM) break;
        }

        const hasNext = !!conn?.pageInfo?.hasNextPage;
        after = conn?.pageInfo?.endCursor || null;
        if (!hasNext || !after) break;
    }

    return offers;
}

/* ─── DB ──────────────────────────────────────────────────── */

function openDbs(env) {
    const dbQueue = new Database(env.ITEMS_WHITEMARKET_DB_PATH);
    const dbOffers = new Database(env.OFFERS_WHITEMARKET_DB_PATH);
    applyPragmas(dbQueue, env);
    applyPragmas(dbOffers, env);

    const pickStmt = dbQueue.prepare(`
        SELECT name, category, exterior
        FROM items_whitemarket
        WHERE offers_parsed = 0
        LIMIT ?
    `);
    const lockStmt = dbQueue.prepare(`
        UPDATE items_whitemarket SET offers_parsed = 1
        WHERE name = ? AND exterior = ? AND offers_parsed = 0
    `);
    const rollbackStmt = dbQueue.prepare(`
        UPDATE items_whitemarket SET offers_parsed = 0 WHERE name = ? AND exterior = ?
    `);
    const resetStmt = dbQueue.prepare(`
        UPDATE items_whitemarket SET offers_parsed = 0 WHERE offers_parsed = 1
    `);

    const upsertOffer = dbOffers.prepare(`
        INSERT INTO offers_whitemarket
            (id, name, category, exterior, price_usd, currency, float_val, paint_seed, paint_index, phase, asset_id, seller_id, updated_at)
        VALUES
            (@id, @name, @category, @exterior, @price_usd, @currency, @float_val, @paint_seed, @paint_index, @phase, @asset_id, @seller_id, @now)
        ON CONFLICT(id) DO UPDATE SET
            price_usd   = excluded.price_usd,
            currency    = excluded.currency,
            float_val   = excluded.float_val,
            paint_seed  = excluded.paint_seed,
            paint_index = excluded.paint_index,
            phase       = excluded.phase,
            asset_id    = excluded.asset_id,
            seller_id   = excluded.seller_id,
            updated_at  = excluded.updated_at
    `);

    const getExistingOffer = dbOffers.prepare(`SELECT price_usd FROM offers_whitemarket WHERE id = ?`);
    const insertHistory = dbOffers.prepare(`
        INSERT INTO offers_whitemarket_history (offer_id, name, price_usd, event)
        VALUES (@offer_id, @name, @price_usd, @event)
    `);
    const getActiveOffers = dbOffers.prepare(`SELECT id, name, price_usd FROM offers_whitemarket WHERE name = ?`);
    const deleteOffer = dbOffers.prepare(`DELETE FROM offers_whitemarket WHERE id = ?`);

    const writeBatch = dbOffers.transaction((name, category, exterior, freshOffers) => {
        const now = nowUnix();
        const extLower = exterior ? exterior.toLowerCase() : exterior;
        const freshIds = new Set(freshOffers.map((o) => o.id));

        for (const o of freshOffers) {
            const existing = getExistingOffer.get(o.id);
            upsertOffer.run({ ...o, name, category, exterior: extLower, now });

            if (!existing) {
                insertHistory.run({ offer_id: o.id, name, price_usd: o.price_usd, event: "seen" });
            } else if (Math.abs(existing.price_usd - o.price_usd) > 0.001) {
                insertHistory.run({ offer_id: o.id, name, price_usd: o.price_usd, event: "price_changed" });
            }
        }

        // Видалені офери
        const active = getActiveOffers.all(name);
        for (const row of active) {
            if (!freshIds.has(row.id)) {
                insertHistory.run({ offer_id: row.id, name: row.name, price_usd: row.price_usd, event: "removed" });
                deleteOffer.run(row.id);
            }
        }
    });

    const pickAndLockTx = dbQueue.transaction((limit) => {
        const rows = pickStmt.all(limit);
        const locked = [];
        for (const r of rows) {
            const res = lockStmt.run(r.name, r.exterior);
            if (res.changes === 1) locked.push(r);
        }
        return locked;
    });

    return {
        dbQueue, dbOffers,
        pickAndLock(limit) { return pickAndLockTx(limit); },
        rollback(name, exterior) { rollbackStmt.run(name, exterior); },
        resetAll() { return resetStmt.run().changes; },
        writeBatch,
    };
}

/* ─── Main loop ───────────────────────────────────────────── */

// Будує повний market_hash_name для API запиту
function buildNameHash(name, exterior) {
    if (!exterior || exterior === "unknown") return name;
    // Конвертуємо lowercase exterior назад у Title Case для API
    const titleCase = exterior.replace(/\b\w/g, (c) => c.toUpperCase());
    return `${name} (${titleCase})`;
}

async function runBatch(env, db) {
    const items = db.pickAndLock(env.BATCH_SIZE);

    if (!items.length) {
        const reset = db.resetAll();
        console.log("[white-offers] queue empty, reset", { reset });
        return { empty: true };
    }

    let processed = 0, offersTotal = 0, errors = 0;
    const CONCURRENCY = env.CONCURRENCY || 5;

    // Паралельна обробка з обмеженням concurrency
    const semaphore = [];
    let idx = 0;

    async function processItem(item) {
        try {
            const nameHash = buildNameHash(item.name, item.exterior);
            const offers = await fetchOffersForItem(env, nameHash);
            db.writeBatch(item.name, item.category, item.exterior, offers);
            offersTotal += offers.length;
            processed++;
        } catch (e) {
            db.rollback(item.name, item.exterior);
            errors++;
            console.error("[white-offers] item failed:", item.name, item.exterior, e?.message);
        }
    }

    // Запускаємо CONCURRENCY воркерів паралельно
    async function worker() {
        while (idx < items.length) {
            const item = items[idx++];
            await processItem(item);
            await sleep(env.REQUEST_DELAY_MS);
        }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker());
    await Promise.all(workers);

    console.log("[white-offers] batch done", { processed, offersTotal, errors });
    return { empty: false };
}

let shuttingDown = false;
process.on("SIGINT", () => (shuttingDown = true));
process.on("SIGTERM", () => (shuttingDown = true));

async function main() {
    console.log("whitemarket-offers daemon started", { at: nowIso() });

    let db = null;
    let lastQ = "", lastO = "";

    while (!shuttingDown) {
        const e0 = getWhitemarketOffersEnv();
        reloadEnvIfChanged(e0.ENV_PATH);
        const env = getWhitemarketOffersEnv();
        assertWhitemarketOffersEnv(env);

        if (!db || env.ITEMS_WHITEMARKET_DB_PATH !== lastQ || env.OFFERS_WHITEMARKET_DB_PATH !== lastO) {
            try { db?.dbQueue?.close(); } catch {}
            try { db?.dbOffers?.close(); } catch {}
            db = openDbs(env);
            lastQ = env.ITEMS_WHITEMARKET_DB_PATH;
            lastO = env.OFFERS_WHITEMARKET_DB_PATH;
            console.log("[db] opened", { queue: lastQ, offers: lastO });
        }

        try {
            const { empty } = await runBatch(env, db);
            db.dbOffers.pragma("incremental_vacuum(1000)");
            await sleep(empty ? env.RESET_SLEEP_MS : env.LOOP_SLEEP_MS);
        } catch (e) {
            console.error("[white-offers] fatal:", e?.stack || e);
            await sleep(Math.min(env.MAX_WAIT_MS, 15000));
        }
    }

    try { db?.dbQueue?.close(); } catch {}
    try { db?.dbOffers?.close(); } catch {}
    console.log("whitemarket-offers daemon stopped", { at: nowIso() });
}

main().catch((e) => {
    console.error("Fatal:", e?.stack || e);
    process.exitCode = 1;
});
