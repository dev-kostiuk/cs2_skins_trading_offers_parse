import Database from "better-sqlite3";
import { reloadEnvIfChanged, getLootfarmEnv } from "./env.js";

function nowUnix() { return Math.floor(Date.now() / 1000); }
function nowIso()  { return new Date().toISOString(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const API_URL = "https://loot.farm/fullprice.json";

/* ─── Wear parsing ────────────────────────────────────────── */

const WEAR_MAP = {
    "Factory New":    "factory new",
    "Minimal Wear":   "minimal wear",
    "Field-Tested":   "field-tested",
    "Well-Worn":      "well-worn",
    "Battle-Scarred": "battle-scarred",
};

function parseNameExterior(rawName) {
    const m = rawName.match(/^(.*?)\s*\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/);
    if (m) return { name: m[1].trim(), exterior: WEAR_MAP[m[2]] };
    return { name: rawName, exterior: "" };
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
        CREATE TABLE IF NOT EXISTS offers_lootfarm (
            name        TEXT NOT NULL,
            exterior    TEXT NOT NULL DEFAULT '',
            price_usd   REAL NOT NULL,
            quantity    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
            PRIMARY KEY (name, exterior)
        );
        CREATE INDEX IF NOT EXISTS idx_olf_name        ON offers_lootfarm(name);
        CREATE INDEX IF NOT EXISTS idx_olf_price       ON offers_lootfarm(price_usd);
        CREATE INDEX IF NOT EXISTS idx_olf_name_price  ON offers_lootfarm(name, price_usd);
        CREATE INDEX IF NOT EXISTS idx_olf_updated_at  ON offers_lootfarm(updated_at);

        CREATE TABLE IF NOT EXISTS offers_lootfarm_history (
            id          INTEGER PRIMARY KEY,
            name        TEXT NOT NULL,
            exterior    TEXT NOT NULL DEFAULT '',
            price_usd   REAL NOT NULL,
            quantity    INTEGER NOT NULL DEFAULT 0,
            event       TEXT NOT NULL CHECK(event IN ('seen','price_changed','removed')),
            recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_olfh_name        ON offers_lootfarm_history(name);
        CREATE INDEX IF NOT EXISTS idx_olfh_recorded_at ON offers_lootfarm_history(recorded_at);
        CREATE INDEX IF NOT EXISTS idx_olfh_name_event  ON offers_lootfarm_history(name, event, recorded_at);
    `);
    return db;
}

/* ─── Fetch ───────────────────────────────────────────────── */

async function fetchLootfarm() {
    const res = await fetch(API_URL, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; skin-tracker/1.0)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error("Unexpected response format");
    return json;
}

/* ─── Upsert with history ─────────────────────────────────── */

function processBatch(db, freshItems) {
    const get     = db.prepare(`SELECT price_usd, quantity FROM offers_lootfarm WHERE name = ? AND exterior = ?`);
    const upsert  = db.prepare(`
        INSERT INTO offers_lootfarm (name, exterior, price_usd, quantity, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name, exterior) DO UPDATE SET
            price_usd  = excluded.price_usd,
            quantity   = excluded.quantity,
            updated_at = excluded.updated_at
    `);
    const history = db.prepare(`
        INSERT INTO offers_lootfarm_history (name, exterior, price_usd, quantity, event, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const del    = db.prepare(`DELETE FROM offers_lootfarm WHERE name = ? AND exterior = ?`);
    const getAll = db.prepare(`SELECT name, exterior, price_usd, quantity FROM offers_lootfarm`);

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
        // Видаляємо items яких більше немає в API
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
    console.log("lootfarm-offers daemon started", { at: nowIso() });

    let db = null;
    let lastPath = "";

    while (!shuttingDown) {
        reloadEnvIfChanged();
        const env = getLootfarmEnv();

        if (!db || env.DB_PATH !== lastPath) {
            try { db?.close(); } catch {}
            db = openDb(env.DB_PATH);
            lastPath = env.DB_PATH;
            console.log("[db] opened", env.DB_PATH);
        }

        try {
            console.log("[lootfarm] fetching...");
            const raw = await fetchLootfarm();

            // price в loot.farm — 1/1000 долара
            const items = raw
                .map((item) => {
                    const { name, exterior } = parseNameExterior(item.name);
                    return {
                        name,
                        exterior,
                        price_usd: item.price / 1000,
                        // have = кількість в наявності; якщо 0 — є ціна але немає стоку
                        quantity: item.have ?? 0,
                    };
                })
                .filter((r) => r.price_usd > 0);

            processBatch(db, items);
            console.log(`[lootfarm] processed ${items.length} items`, { at: nowIso() });
            db.pragma("incremental_vacuum(1000)");
        } catch (e) {
            console.error("[lootfarm] error:", e?.message);
        }

        await sleep(env.LOOP_SLEEP_MS);
    }

    try { db?.close(); } catch {}
    console.log("lootfarm-offers daemon stopped", { at: nowIso() });
}

main().catch((e) => {
    console.error("Fatal:", e?.stack || e);
    process.exitCode = 1;
});
