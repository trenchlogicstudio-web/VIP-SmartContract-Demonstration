// VIP SmartContract · MVP v0.2.15 · store (schema + open)
// Copyright (c) 2026 Miloš Petrović (Trench Logic Studio) · SPDX-License-Identifier: MIT · not production infrastructure.
// Design rule: a person's name lives ONLY in guests.display_name. Sessions, credits,
// rollover and the event chain carry opaque guest ids, so erasure
// (boundary.erase) never conflicts with hash-chain integrity.
'use strict';
// Runtime precondition, stated before it can fail cryptically.
// node:sqlite exists from Node 22.5.0 but needs --experimental-sqlite until
// 22.13.0. Without this guard an integrator on 20.x or on 22.5-22.12 gets a raw
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
  erase_pending INTEGER NOT NULL DEFAULT 0,
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
  consumed_exact TEXT,                -- exact decimal sum of the reported ticks
  reserved_eur REAL NOT NULL DEFAULT 0,   -- stakes checked and not yet reported: counted against the line as if lost
  settlement_json TEXT,               -- immutable venue amounts quoted at the stop
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
  at TEXT NOT NULL,
  authorization_id TEXT              -- the pre-stake check this tick reports, when it names one
);
-- A stake the platform asked about before it was placed. Open until the tick
-- that reports it, a release, the stop of its session, or a pre-commit that
-- supersedes the session.
CREATE TABLE IF NOT EXISTS authorizations(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  stake_eur REAL NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by TEXT CHECK(closed_by IN ('tick','release','stop','superseded')),
  consumed_eur REAL
);
CREATE INDEX IF NOT EXISTS idx_authorizations_session ON authorizations(session_id, closed_at);
CREATE TABLE IF NOT EXISTS tick_receipts(
  session_id TEXT NOT NULL REFERENCES sessions(id),
  event_id TEXT NOT NULL,
  delta_eur REAL NOT NULL,
  response TEXT NOT NULL,
  PRIMARY KEY(session_id, event_id)
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
CREATE INDEX IF NOT EXISTS idx_ticks_session ON ticks(session_id);
CREATE INDEX IF NOT EXISTS idx_event_session ON events(json_extract(payload, '$.session_id')) WHERE json_valid(payload);
`;

function open(dbPath = DB_PATH) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA journal_mode = WAL;');
  // Deleted and overwritten content is zeroed, not merely unlinked: an erased
  // display name must not survive in a free region of a page.
  db.exec('PRAGMA secure_delete = ON;');
  db.exec('PRAGMA foreign_keys = ON;');
  transaction(db, () => { db.exec(SCHEMA); migrate(db); });
  return db;
}

// The public engine functions are synchronous. Nested calls (including seed)
// share the same SQLite transaction and its after-commit callbacks.
const pending = new WeakMap();
// What must be recorded although the request fails: a refusal is evidence, and
// the transaction that produced it is rolled back. These run after the rollback,
// each in its own transaction.
const refused = new WeakMap();

function transaction(db, operation) {
  if (pending.has(db)) return operation();
  const callbacks = [];
  db.exec('BEGIN IMMEDIATE');
  pending.set(db, callbacks);
  let result;
  try {
    result = operation();
    db.exec('COMMIT');
  } catch (error) {
    // A SQLite trigger may already have rolled this transaction back.
    try { db.exec('ROLLBACK'); } catch { /* keep the original failure */ }
    pending.delete(db);
    const kept = refused.get(db) || [];
    refused.delete(db);
    for (const record of kept) transaction(db, record);
    throw error;
  } finally {
    pending.delete(db);
    refused.delete(db);
  }
  for (const callback of callbacks) callback();
  return result;
}

function atomic(operation) {
  return (db, ...args) => transaction(db, () => operation(db, ...args));
}

function afterCommit(db, callback) {
  const callbacks = pending.get(db);
  if (callbacks) callbacks.push(callback);
  else callback();
}

function afterRollback(db, record) {
  if (!pending.has(db)) return record();
  if (!refused.has(db)) refused.set(db, []);
  refused.get(db).push(record);
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
  if (!cols.includes('erase_pending')) db.exec('ALTER TABLE guests ADD COLUMN erase_pending INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('suppressed_at')) db.exec('ALTER TABLE guests ADD COLUMN suppressed_at TEXT');
  if (!cols.includes('suppressed_reason')) db.exec('ALTER TABLE guests ADD COLUMN suppressed_reason TEXT');
  const sc = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
  if (!sc.includes('eligibility')) db.exec("ALTER TABLE sessions ADD COLUMN eligibility TEXT NOT NULL DEFAULT 'permitted'");
  if (!sc.includes('consumed_exact')) {
    db.exec('ALTER TABLE sessions ADD COLUMN consumed_exact TEXT');
    // Reconstruct live totals from the old journal. Completed settlements
    // keep their published amounts, even across an upgrade.
    const { addDecimal } = require('./values');
    const ticks = db.prepare('SELECT delta_eur FROM ticks WHERE session_id = ? ORDER BY id');
    const save = db.prepare('UPDATE sessions SET consumed_exact = ?, consumed_eur = ? WHERE id = ?');
    for (const row of db.prepare("SELECT id, consumed_eur FROM sessions WHERE state='live'").all()) {
      const history = ticks.all(row.id);
      const total = history.length ? history.reduce((sum, t) => addDecimal(sum, t.delta_eur), '0') : String(row.consumed_eur);
      save.run(total, Number(total), row.id);
    }
  }
  if (!sc.includes('settlement_json')) db.exec('ALTER TABLE sessions ADD COLUMN settlement_json TEXT');
  if (!sc.includes('eligibility_at')) db.exec('ALTER TABLE sessions ADD COLUMN eligibility_at TEXT');
  // The pre-stake check arrived in 0.2.14: a database written by an earlier build
  // gains the reservation column and the link from a tick to its check.
  if (!sc.includes('reserved_eur')) db.exec('ALTER TABLE sessions ADD COLUMN reserved_eur REAL NOT NULL DEFAULT 0');
  const tc = db.prepare('PRAGMA table_info(ticks)').all().map(c => c.name);
  if (!tc.includes('authorization_id')) db.exec('ALTER TABLE ticks ADD COLUMN authorization_id TEXT');
}

module.exports = { open, getSetting, setSetting, DB_PATH, migrate, transaction, atomic, afterCommit, afterRollback };
