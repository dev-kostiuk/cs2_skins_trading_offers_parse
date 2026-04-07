import Database from "better-sqlite3";
import { reloadEnvIfChanged, getBitskinsEnv } from "./env.js";

function nowUnix() { return Math.floor(Date.now() / 1000); }
function nowIso()  { return new Date().toISOString(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const API_URL = "https://api.bitskins.com/market/insell/730";

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
        CREATE TABLE IF NOT EXISTS offers_bitskins (
            name        TEXT NOT NULL,
            exterior    TEXT NOT NULL DEFAULT '',
            price_usd   REAL NOT NULL,
            quantity    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
            PRIMARY KEY (name, exterior)
        );
        CREATE INDEX IF NOT EXISTS idx_ob_name        ON offers_bitskins(name);
        CREATE INDEX IF NOT EXISTS idx_ob_price       ON offers_bitskins(price_usd);
        CREATE INDEX IF NOT EXISTS idx_ob_name_price  ON offers_bitskins(name, price_usd);
        CREATE INDEX IF NOT EXISTS idx_ob_updated_at  ON offers_bitskins(updated_at);

        CREATE TABLE IF NOT EXISTS offers_bitskins_history (
            id          INTEGER PRIMARY KEY,
            name        TEXT NOT NULL,
            exterior    TEXT NOT NULL DEFAULT '',
            price_usd   REAL NOT NULL,
            quantity    INTEGER NOT NULL DEFAULT 0,
            event       TEXT NOT NULL CHECK(event IN ('seen','price_changed','removed')),
            recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_obh_name        ON offers_bitskins_history(name);
        CREATE INDEX IF NOT EXISTS idx_obh_recorded_at ON offers_bitskins_history(recorded_at);
        CREATE INDEX IF NOT EXISTS idx_obh_name_event  ON offers_bitskins_history(name, event, recorded_at);
    `);
    return db;
}

/* ─── Fetch ───────────────────────────────────────────────── */

async function fetchBitskins() {
    const res = await fetch(API_URL, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; skin-tracker/1.0)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.list) throw new Error("Unexpected response format");
    return json.list;
}

/* ─── Upsert with history ─────────────────────────────────── */

function processBatch(db, freshItems) {
    const get     = db.prepare(`SELECT price_usd, quantity FROM offers_bitskins WHERE name = ? AND exterior = ?`);
    const upsert  = db.prepare(`
        INSERT INTO offers_bitskins (name, exterior, price_usd, quantity, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name, exterior) DO UPDATE SET
            price_usd  = excluded.price_usd,
            quantity   = excluded.quantity,
            updated_at = excluded.updated_at
    `);
    const history = db.prepare(`
        INSERT INTO offers_bitskins_history (name, exterior, price_usd, quantity, event, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const del    = db.prepare(`DELETE FROM offers_bitskins WHERE name = ? AND exterior = ?`);
    const getAll = db.prepare(`SELECT name, exterior, price_usd, quantity FROM offers_bitskins`);

    const freshSet = new Map(freshItems.map((r) => [`${r.name}\0${r.exterior}`, r]));
    const now = nowUnix();

    db.transaction(() => {
        for (const item of freshItems) {
            const existing = get.get(item.name, item.exterior);
            upsert.run(item.name, item.exterior, item.price_usd, item.quantity, now);
            if (!existing) {
                history.run(item.name, item.exterior, item.price_usd, item.quantity, "seen", now);
            } else if (Math.abs(existing.price_usd - item.price_usd) > 0.001) {
                history.run(item.name, item.exterior, item.price_usd, item.quantity, "price_changed", now);
            }
        }
        for (const row of getAll.all()) {
            if (!freshSet.has(`${row.name}\0${row.exterior}`)) {
                history.run(row.name, row.exterior, row.price_usd, row.quantity, "removed", now);
                del.run(row.name, row.exterior);
            }
        }
    })();
}

/* ─── Main loop ───────────────────────────────────────────── */

let shuttingDown = false;
process.on("SIGINT",  () => (shuttingDown = true));
process.on("SIGTERM", () => (shuttingDown = true));

async function main() {
    console.log("bitskins-offers daemon started", { at: nowIso() });

    let db = null;
    let lastPath = "";

    while (!shuttingDown) {
        reloadEnvIfChanged();
        const env = getBitskinsEnv();

        if (!db || env.DB_PATH !== lastPath) {
            try { db?.close(); } catch {}
            db = openDb(env.DB_PATH);
            lastPath = env.DB_PATH;
            console.log("[db] opened", env.DB_PATH);
        }

        try {
            console.log("[bitskins] fetching...");
            const raw = await fetchBitskins();

            const items = raw
                .map((item) => {
                    const { name, exterior } = parseNameExterior(item.name);
                    return { name, exterior, price_usd: item.price_min / 1000, quantity: item.quantity ?? 0 };
                })
                .filter((r) => r.price_usd > 0);

            processBatch(db, items);
            console.log(`[bitskins] processed ${items.length} items`, { at: nowIso() });
            db.pragma("incremental_vacuum(1000)");
        } catch (e) {
            console.error("[bitskins] error:", e?.message);
        }

        await sleep(env.LOOP_SLEEP_MS);
    }

    try { db?.close(); } catch {}
    console.log("bitskins-offers daemon stopped", { at: nowIso() });
}

main().catch((e) => {
    console.error("Fatal:", e?.stack || e);
    process.exitCode = 1;
});
