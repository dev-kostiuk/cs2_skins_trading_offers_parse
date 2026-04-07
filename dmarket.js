import Database from "better-sqlite3";
import nacl from "tweetnacl";
import { reloadEnvIfChanged, getDmarketOffersEnv, assertDmarketOffersEnv } from "./env.js";

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

/* ─── HTTP ────────────────────────────────────────────────── */

function hexToU8(hex) {
    const clean = hex.toLowerCase().replace(/^0x/, "");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function signedHeaders(env, method, pathWithQuery, body = "") {
    if (!env.PUBLIC_KEY || !env.SECRET_KEY) return {};
    const ts = nowUnix();
    const secretU8 = hexToU8(env.SECRET_KEY);
    // Офіційний формат: method + path+query + body + timestamp
    const msg = new TextEncoder().encode(`${method}${pathWithQuery}${body}${ts}`);
    const sig = nacl.sign.detached(msg, secretU8);
    return {
        "X-Api-Key": env.PUBLIC_KEY,
        "X-Sign-Date": String(ts),
        // Офіційний префікс з документації DMarket
        "X-Request-Sign": "dmar ed25519 " + Buffer.from(sig).toString("hex"),
    };
}

async function fetchJsonWithRetry(env, url, attempt = 0) {
    if (env.REQUEST_DELAY_MS > 0) await sleep(env.REQUEST_DELAY_MS);

    try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), env.FETCH_TOTAL_TIMEOUT_MS);

        const u = new URL(url);
        const headers = {
            accept: "application/json",
            ...signedHeaders(env, "GET", u.pathname + u.search),
        };

        const res = await fetch(url, { headers, signal: ac.signal });
        clearTimeout(t);

        if (res.ok) return res.json();

        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < env.HTTP_MAX_RETRIES) {
            const ra = res.headers.get("retry-after");
            let waitMs = ra && /^\d+$/.test(ra)
                ? Number(ra) * 1000
                : 400 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
            waitMs = Math.min(waitMs, env.MAX_WAIT_MS);
            console.warn("[dmarket-offers] retry (status)", { status: res.status, attempt, waitMs });
            await sleep(waitMs);
            return fetchJsonWithRetry(env, url, attempt + 1);
        }

        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    } catch (err) {
        const code = err?.cause?.code || err?.code || "";
        const msg = String(err?.message || "");
        const retryableNet =
            code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT" ||
            code === "UND_ERR_SOCKET" || code === "ECONNRESET" || code === "ETIMEDOUT" ||
            code === "EAI_AGAIN" || msg.includes("fetch failed") || msg.includes("aborted");

        if (retryableNet && attempt < env.HTTP_MAX_RETRIES) {
            let waitMs = 400 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
            waitMs = Math.min(waitMs, env.MAX_WAIT_MS);
            console.warn("[dmarket-offers] retry (network)", { code, attempt, waitMs });
            await sleep(waitMs);
            return fetchJsonWithRetry(env, url, attempt + 1);
        }
        throw err;
    }
}

/* ─── Offer mapping ───────────────────────────────────────── */

function parseOffer(o) {
    const id = o?.extra?.offerId || o?.offerId || o?.id;
    if (!id) return null;

    const rawUsd = o?.price?.USD ?? o?.instantPrice?.USD ?? o?.price;
    const price_usd = Number(rawUsd) / 100;
    if (!Number.isFinite(price_usd) || price_usd <= 0) return null;

    const extra = o?.extra || {};
    return {
        id: String(id),
        price_usd,
        float_val: extra.floatValue != null ? Number(extra.floatValue) : null,
        paint_seed: extra.paintSeed != null ? Number(extra.paintSeed) : null,
        paint_index: extra.paintIndex != null ? Number(extra.paintIndex) : null,
        inspect_url: typeof extra.inspectInGame === "string" ? extra.inspectInGame.trim() : null,
    };
}

/* ─── Fetch all pages for one item ───────────────────────── */

async function fetchOffersForItem(env, name) {
    const offers = [];
    let cursor = null;

    for (let page = 0; page < env.MAX_PAGES_PER_ITEM; page++) {
        const u = new URL(env.API_BASE + env.OFFERS_PATH);
        u.searchParams.set("Title", name);
        u.searchParams.set("GameId", env.GAME_ID);
        u.searchParams.set("Limit", String(env.OFFERS_LIMIT));
        if (cursor) u.searchParams.set("Cursor", cursor);

        const json = await fetchJsonWithRetry(env, u.toString());

        const arr = Array.isArray(json?.objects) ? json.objects
            : Array.isArray(json?.Offers) ? json.Offers
            : Array.isArray(json?.offers) ? json.offers : [];

        for (const o of arr) {
            const mapped = parseOffer(o);
            if (mapped) offers.push(mapped);
        }

        const next = (json?.cursor || json?.Cursor || "").trim();
        if (!arr.length || !next || next === cursor) break;
        cursor = next;
    }

    return offers;
}

/* ─── DB ──────────────────────────────────────────────────── */

function openDbs(env) {
    const dbQueue = new Database(env.ITEMS_DMARKET_DB_PATH);
    const dbOffers = new Database(env.OFFERS_DMARKET_DB_PATH);
    applyPragmas(dbQueue, env);
    applyPragmas(dbOffers, env);

    // Черга: pick + lock
    const pickStmt = dbQueue.prepare(`
        SELECT name, category, exterior
        FROM items_dmarket
        WHERE offers_parsed = 0
        LIMIT ?
    `);
    const lockStmt = dbQueue.prepare(`
        UPDATE items_dmarket SET offers_parsed = 1
        WHERE name = ? AND exterior = ? AND offers_parsed = 0
    `);
    const rollbackStmt = dbQueue.prepare(`
        UPDATE items_dmarket SET offers_parsed = 0 WHERE name = ? AND exterior = ?
    `);
    const resetStmt = dbQueue.prepare(`
        UPDATE items_dmarket SET offers_parsed = 0 WHERE offers_parsed = 1
    `);

    // Офери: upsert + history
    const upsertOffer = dbOffers.prepare(`
        INSERT INTO offers_dmarket (id, name, category, exterior, price_usd, float_val, paint_seed, paint_index, inspect_url, updated_at)
        VALUES (@id, @name, @category, @exterior, @price_usd, @float_val, @paint_seed, @paint_index, @inspect_url, @now)
        ON CONFLICT(id) DO UPDATE SET
            price_usd   = excluded.price_usd,
            float_val   = excluded.float_val,
            paint_seed  = excluded.paint_seed,
            paint_index = excluded.paint_index,
            inspect_url = excluded.inspect_url,
            updated_at  = excluded.updated_at
    `);

    const getExistingOffer = dbOffers.prepare(`
        SELECT price_usd FROM offers_dmarket WHERE id = ?
    `);

    const insertHistory = dbOffers.prepare(`
        INSERT INTO offers_dmarket_history (offer_id, name, price_usd, event)
        VALUES (@offer_id, @name, @price_usd, @event)
    `);

    // Видалення офер яких більше немає (позначаємо як removed в history)
    const getActiveOffers = dbOffers.prepare(`
        SELECT id, name, price_usd FROM offers_dmarket WHERE name = ?
    `);
    const deleteOffer = dbOffers.prepare(`DELETE FROM offers_dmarket WHERE id = ?`);

    const writeBatch = dbOffers.transaction((name, category, exterior, freshOffers) => {
        const now = nowUnix();
        const freshIds = new Set(freshOffers.map((o) => o.id));

        // Upsert + history
        for (const o of freshOffers) {
            const existing = getExistingOffer.get(o.id);
            upsertOffer.run({ ...o, name, category, exterior, now });

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

async function runBatch(env, db) {
    const items = db.pickAndLock(env.BATCH_SIZE);

    if (!items.length) {
        const reset = db.resetAll();
        console.log("[dmarket-offers] queue empty, reset", { reset });
        return { empty: true };
    }

    let processed = 0, offersTotal = 0, errors = 0;

    for (const item of items) {
        try {
            const offers = await fetchOffersForItem(env, item.name);
            db.writeBatch(item.name, item.category, item.exterior, offers);
            offersTotal += offers.length;
            processed++;
        } catch (e) {
            db.rollback(item.name, item.exterior);
            errors++;
            console.error("[dmarket-offers] item failed:", item.name, e?.message);
        }
    }

    console.log("[dmarket-offers] batch done", { processed, offersTotal, errors });
    return { empty: false };
}

let shuttingDown = false;
process.on("SIGINT", () => (shuttingDown = true));
process.on("SIGTERM", () => (shuttingDown = true));

async function main() {
    console.log("dmarket-offers daemon started", { at: nowIso() });

    let db = null;
    let lastQ = "", lastO = "";

    while (!shuttingDown) {
        const e0 = getDmarketOffersEnv();
        reloadEnvIfChanged(e0.ENV_PATH);
        const env = getDmarketOffersEnv();
        assertDmarketOffersEnv(env);

        if (!db || env.ITEMS_DMARKET_DB_PATH !== lastQ || env.OFFERS_DMARKET_DB_PATH !== lastO) {
            try { db?.dbQueue?.close(); } catch {}
            try { db?.dbOffers?.close(); } catch {}
            db = openDbs(env);
            lastQ = env.ITEMS_DMARKET_DB_PATH;
            lastO = env.OFFERS_DMARKET_DB_PATH;
            console.log("[db] opened", { queue: lastQ, offers: lastO });
        }

        try {
            const { empty } = await runBatch(env, db);
            db.dbOffers.pragma("incremental_vacuum(1000)");
            await sleep(empty ? env.RESET_SLEEP_MS : env.LOOP_SLEEP_MS);
        } catch (e) {
            console.error("[dmarket-offers] fatal:", e?.stack || e);
            await sleep(Math.min(env.MAX_WAIT_MS, 15000));
        }
    }

    try { db?.dbQueue?.close(); } catch {}
    try { db?.dbOffers?.close(); } catch {}
    console.log("dmarket-offers daemon stopped", { at: nowIso() });
}

main().catch((e) => {
    console.error("Fatal:", e?.stack || e);
    process.exitCode = 1;
});
