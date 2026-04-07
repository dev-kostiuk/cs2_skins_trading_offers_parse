import Database from "better-sqlite3";
import { reloadEnvIfChanged, getSkinportEnv } from "../prices_parse/env.js";

function nowUnix() { return Math.floor(Date.now() / 1000); }
function nowIso()  { return new Date().toISOString(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const API_URL = "https://api.skinport.com/v1/items?app_id=730&currency=USD";

/* ─── Wear parsing ────────────────────────────────────────── */

const WEAR_MAP = {
    "Factory New":    "factory new",
    "Minimal Wear":   "minimal wear",
    "Field-Tested":   "field-tested",
    "Well-Worn":      "well-worn",
    "Battle-Scarred": "battle-scarred",
};

function parseNameExterior(marketHashName) {
    const m = marketHashName.match(/^(.*?)\s*\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/);
    if (m) return { name: m[1].trim(), exterior: WEAR_MAP[m[2]] };
    return { name: marketHashName, exterior: "" };
}

/* ─── DB ──────────────────────────────────────────────────── */

function openDb(path) {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("auto_vacuum = INCREMENTAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("temp_store = MEMORY");
    db.pragma("busy_timeout = 5000");
    db.pragma("cache_size = -131072");
    db.pragma("mmap_size = 268435456");
    db.exec(`
        CREATE TABLE IF NOT EXISTS offers_skinport (
            name        TEXT NOT NULL,
            exterior    TEXT NOT NULL DEFAULT '',
            price_usd   REAL NOT NULL,
            quantity    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
            PRIMARY KEY (name, exterior)
        );
        CREATE INDEX IF NOT EXISTS idx_os_name       ON offers_skinport(name);
        CREATE INDEX IF NOT EXISTS idx_os_price      ON offers_skinport(price_usd);
        CREATE INDEX IF NOT EXISTS idx_os_name_price ON offers_skinport(name, price_usd);
        CREATE INDEX IF NOT EXISTS idx_os_updated_at ON offers_skinport(updated_at);

        CREATE TABLE IF NOT EXISTS offers_skinport_history (
            id          INTEGER PRIMARY KEY,
            name        TEXT NOT NULL,
            exterior    TEXT NOT NULL DEFAULT '',
            price_usd   REAL NOT NULL,
            quantity    INTEGER NOT NULL DEFAULT 0,
            event       TEXT NOT NULL CHECK(event IN ('seen','price_changed','removed')),
            recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_osh_name        ON offers_skinport_history(name);
        CREATE INDEX IF NOT EXISTS idx_osh_recorded_at ON offers_skinport_history(recorded_at);
        CREATE INDEX IF NOT EXISTS idx_osh_name_event  ON offers_skinport_history(name, event, recorded_at);
    `);
    return db;
}

/* ─── Fetch ───────────────────────────────────────────────── */

async function fetchSkinport() {
    const res = await fetch(API_URL, {
        headers: {
            "Accept-Encoding": "br, gzip, deflate",
            "User-Agent": "Mozilla/5.0 (compatible; skin-tracker/1.0)",
        },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/* ─── Upsert with history ─────────────────────────────────── */

const getExisting = (db) => db.prepare(`
    SELECT price_usd, quantity FROM offers_skinport WHERE name = ? AND exterior = ?
`);

const upsertStmt = (db) => db.prepare(`
    INSERT INTO offers_skinport (name, exterior, price_usd, quantity, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name, exterior) DO UPDATE SET
        price_usd  = excluded.price_usd,
        quantity   = excluded.quantity,
        updated_at = excluded.updated_at
`);

const insertHistory = (db) => db.prepare(`
    INSERT INTO offers_skinport_history (name, exterior, price_usd, quantity, event, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)
`);

const deleteStmt = (db) => db.prepare(`
    DELETE FROM offers_skinport WHERE name = ? AND exterior = ?
`);

const getAllActive = (db) => db.prepare(`
    SELECT name, exterior, price_usd, quantity FROM offers_skinport
`);

function processBatch(db, freshItems) {
    const get     = getExisting(db);
    const upsert  = upsertStmt(db);
    const history = insertHistory(db);
    const del     = deleteStmt(db);
    const getAll  = getAllActive(db);

    const freshSet = new Map(freshItems.map((r) => [`${r.name}\0${r.exterior}`, r]));
    const now = nowUnix();

    const run = db.transaction(() => {
        // upsert + history для нових/змінених
        for (const item of freshItems) {
            const existing = get.get(item.name, item.exterior);
            upsert.run(item.name, item.exterior, item.price_usd, item.quantity, now);

            if (!existing) {
                history.run(item.name, item.exterior, item.price_usd, item.quantity, "seen", now);
            } else if (Math.abs(existing.price_usd - item.price_usd) > 0.001) {
                history.run(item.name, item.exterior, item.price_usd, item.quantity, "price_changed", now);
            }
        }

        // removed — є в БД але немає у свіжих даних
        const active = getAll.all();
        for (const row of active) {
            if (!freshSet.has(`${row.name}\0${row.exterior}`)) {
                history.run(row.name, row.exterior, row.price_usd, row.quantity, "removed", now);
                del.run(row.name, row.exterior);
            }
        }
    });

    run();
}

/* ─── Main loop ───────────────────────────────────────────── */

let shuttingDown = false;
process.on("SIGINT",  () => (shuttingDown = true));
process.on("SIGTERM", () => (shuttingDown = true));

async function main() {
    console.log("skinport-offers daemon started", { at: nowIso() });

    let db = null;
    let lastPath = "";

    while (!shuttingDown) {
        reloadEnvIfChanged();
        const env = getSkinportEnv();

        if (!db || env.DB_PATH !== lastPath) {
            try { db?.close(); } catch {}
            db = openDb(env.DB_PATH);
            lastPath = env.DB_PATH;
            console.log("[db] opened", env.DB_PATH);
        }

        try {
            console.log("[skinport-offers] fetching...");
            const raw = await fetchSkinport();

            const items = raw.map((item) => {
                const { name, exterior } = parseNameExterior(item.market_hash_name);
                return { name, exterior, price_usd: item.min_price ?? null, quantity: item.quantity ?? 0 };
            }).filter((r) => r.price_usd != null);

            processBatch(db, items);
            console.log(`[skinport-offers] processed ${items.length} items`, { at: nowIso() });
            db.pragma("incremental_vacuum(1000)");
        } catch (e) {
            console.error("[skinport-offers] error:", e?.message);
        }

        await sleep(env.LOOP_SLEEP_MS);
    }

    try { db?.close(); } catch {}
    console.log("skinport-offers daemon stopped", { at: nowIso() });
}

main().catch((e) => {
    console.error("Fatal:", e?.stack || e);
    process.exitCode = 1;
});
