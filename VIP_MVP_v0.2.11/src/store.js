// VIP SmartContract · MVP v0.2.11 · store (schema + open)
// AS-IS evaluation artifact. Not production infrastructure — 09_AS_IS_Notice governs.
// Design rule: a person's name lives ONLY in guests.display_name. Sessions, credits,
// rollover and the event chain carry opaque guest ids, so erasure
// (boundary.erase) never conflicts with hash-chain integrity.
'use strict';
// Runtime precondition, stated before it can fail cryptically.
// node:sqlite exists from Node 22.5.0 but needs --experimental-sqlite until
// 22.13.0. Without this guard a buyer on 20.x or on 22.5-22.12 gets a raw
// "No such built-in module" stack trace instead of being told what to do.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  const v = process.versions.node;
  console.error(
    '\n  VIP MVP cannot start.\n' +
    '  Needs Node >= 22.13.0 for the built-in node:sqlite module; this is ' + v + '.\n' +
    '  On 22.5-22.12 the module exists but requires:  node --experimental-sqlite server.js\n' +
    '  On anything older, install Node 22.13.0 or newer. No other dependency is needed.\n');
  process.exit(1);
}
const path = require('path');

const DB_PATH = process.env.VIP_DB || path.join(process.cwd(), 'vip-mvp.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(
  k TEXT PRIMARY KEY, v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guests(
  id TEXT PRIMARY KEY,
  display_name TEXT,                 -- the only column that names a person
  tier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  erased_at TEXT,
  -- Programme suppression. Set by POST /v3/programme/suppress and never
  -- cleared by this engine: an exclusion or a withdrawal is not something a
  -- policy layer may undo. No risk score, no harm model — only the fact that
  -- the operator told us to stop issuing, and why.
  suppressed_at TEXT,
  suppressed_reason TEXT
);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES guests(id),
  eligibility TEXT NOT NULL DEFAULT 'permitted',   -- operator RG determination at pre-commit
  eligibility_at TEXT,                             -- when the operator made that determination
  mode TEXT NOT NULL CHECK(mode IN ('hard_stop','advisory')),
  state TEXT NOT NULL CHECK(state IN ('live','stopped','closed')),
  budget_eur REAL NOT NULL,
  armed_at_eur REAL NOT NULL,        -- the euro amount at which the policy fires
  consumed_eur REAL NOT NULL DEFAULT 0,
  preserved_eur REAL,                -- written at the stop, NULL while live
  redirect_eur REAL,
  rollover_eur REAL,
  residual_eur REAL,                 -- the guest's own money, returned not captured
  nudged INTEGER NOT NULL DEFAULT 0,      -- advisory 40% crossing, emitted once
  escalated INTEGER NOT NULL DEFAULT 0,   -- advisory 85% crossing, emitted once
  redirect_issued INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL,
  stopped_at TEXT,
  quarter INTEGER NOT NULL DEFAULT 0      -- 1 = part of the seeded reference quarter
);
-- One live session per guest, enforced by the database rather than by a
-- convention in the handler. A superseding pre-commit closes the old one first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_live_session ON sessions(guest_id) WHERE state = 'live';
CREATE TABLE IF NOT EXISTS ticks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  delta_eur REAL NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credits(          -- resort credit issued from preserved budget
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  guest_id TEXT NOT NULL REFERENCES guests(id),
  category TEXT NOT NULL CHECK(category IN ('spa','fnb','retail')),
  amount_eur REAL NOT NULL,
  issued_at TEXT NOT NULL,
  redeemed_at TEXT                            -- the non-gaming revenue event landing
);
CREATE TABLE IF NOT EXISTS rollover(         -- credit toward a future session
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id TEXT NOT NULL REFERENCES guests(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  amount_eur REAL NOT NULL,
  issued_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE TABLE IF NOT EXISTS events(           -- append-only, hash-chained (boundary concern)
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_guest ON sessions(guest_id, state);
CREATE INDEX IF NOT EXISTS idx_credits_session ON credits(session_id);
`;

function open(dbPath = DB_PATH) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  // Deleted and overwritten content is zeroed, not merely unlinked: an erased
  // display name must not survive in a free region of a page.
  db.exec('PRAGMA secure_delete = ON;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

function getSetting(db, k, dflt = null) {
  const row = db.prepare('SELECT v FROM settings WHERE k = ?').get(k);
  return row ? row.v : dflt;
}
function setSetting(db, k, v) {
  db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
}


// ── migration ─────────────────────────────────────────────────────────────
// CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a
// database written by an earlier build would silently lack the suppression
// columns and every suppression check would read undefined. Add them if they
// are missing rather than requiring the evaluator to delete their database.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(guests)').all().map(c => c.name);
  if (!cols.includes('suppressed_at')) db.exec('ALTER TABLE guests ADD COLUMN suppressed_at TEXT');
  if (!cols.includes('suppressed_reason')) db.exec('ALTER TABLE guests ADD COLUMN suppressed_reason TEXT');
  const sc = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
  if (!sc.includes('eligibility')) db.exec("ALTER TABLE sessions ADD COLUMN eligibility TEXT NOT NULL DEFAULT 'permitted'");
  if (!sc.includes('eligibility_at')) db.exec('ALTER TABLE sessions ADD COLUMN eligibility_at TEXT');
}

module.exports = { open, getSetting, setSetting, DB_PATH, migrate };
