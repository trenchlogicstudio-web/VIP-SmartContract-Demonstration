// VIP SmartContract · MVP v0.2.11 · boundary layer
// Boundary = everything that touches the outside world or survives it:
// the hash-chained audit log, the dormant downstream dispatch (Path 2),
// and guest erasure. The policy itself (policy.js) is the Body and never
// depends on anything in this file succeeding.
// AS-IS evaluation artifact — 09_AS_IS_Notice governs.
'use strict';
const crypto = require('crypto');
// The dispatch reads its source from package.json, the one place the code
// takes the version from. A literal here trailed the build twice.
const SOURCE = 'vip-mvp/' + require('../package.json').version;

// ---------- canonical serialization (stable key order) ----------
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// ---------- hash-chained audit log ----------
// Chain rule: hash = sha256(prev_hash | type | at | canonical(payload)).
// This is the audit trail the package sells: every policy decision, in order,
// each link folding the previous one, so altering any earlier row breaks every
// fingerprint after it. Payloads carry opaque guest ids and euro amounts only
// — never display names — so erasure never has to rewrite the chain.
function append(db, type, payload) {
  const last = db.prepare('SELECT hash FROM events ORDER BY seq DESC LIMIT 1').get();
  const prev = last ? last.hash : 'GENESIS';
  const at = new Date().toISOString();
  const hash = sha256(prev + '|' + type + '|' + at + '|' + canonical(payload));
  const r = db.prepare('INSERT INTO events(type, payload, at, prev_hash, hash) VALUES(?,?,?,?,?)')
    .run(type, JSON.stringify(payload), at, prev, hash);
  const evt = { seq: Number(r.lastInsertRowid), type, payload, at, hash, fingerprint: hash.slice(0, 16) };
  maybeDispatch(evt); // fire-and-forget; the Body never waits on the Boundary
  return evt;
}

// Full-chain verification. An EMPTY chain is a VALID chain of length 0 —
// stated explicitly because the failure mode of assuming at least one event
// is a crash on a fresh instance.
function verify(db) {
  const rows = db.prepare('SELECT seq, type, payload, at, prev_hash, hash FROM events ORDER BY seq ASC').all();
  if (rows.length === 0) return { valid: true, length: 0, head: 'GENESIS' };
  let prev = 'GENESIS';
  for (const r of rows) {
    if (r.prev_hash !== prev) return { valid: false, length: rows.length, broken_at_seq: r.seq, reason: 'PREV_MISMATCH' };
    const expect = sha256(prev + '|' + r.type + '|' + r.at + '|' + canonical(JSON.parse(r.payload)));
    if (expect !== r.hash) return { valid: false, length: rows.length, broken_at_seq: r.seq, reason: 'HASH_MISMATCH' };
    prev = r.hash;
  }
  return { valid: true, length: rows.length, head: prev };
}

function chainHead(db) {
  const last = db.prepare('SELECT hash FROM events ORDER BY seq DESC LIMIT 1').get();
  return last ? last.hash : 'GENESIS';
}

// ---------- Path 2 · dormant downstream ----------
// Dormant by default. Arms only when BOTH env vars are set:
//   VIP_DOWNSTREAM_URL  — the buyer's ingestion endpoint (host CRM, loyalty
//                         ledger, property management system, compliance store)
//   VIP_DOWNSTREAM_KEY  — bearer credential issued by that system
// Only revenue-bearing and obligation-bearing moments cross the boundary.
// guest.erase is dispatched too, because a downstream that received a stop
// must also receive the erasure.
const DISPATCH_TYPES = new Set(['policy.stop', 'redirect.issue', 'credit.redeem', 'guest.erase']);
const downstream = {
  url: process.env.VIP_DOWNSTREAM_URL || '',
  key: process.env.VIP_DOWNSTREAM_KEY || '',
  sent: 0, failed: 0,
  armed() { return Boolean(this.url && this.key); }
};

function maybeDispatch(evt) {
  if (!downstream.armed() || !DISPATCH_TYPES.has(evt.type)) return;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  fetch(downstream.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + downstream.key },
    body: JSON.stringify({ source: SOURCE, event: evt }),
    signal: ctl.signal
  }).then(res => { downstream.sent++; if (!res.ok) downstream.failed++; })
    .catch(() => { downstream.failed++; })
    .finally(() => clearTimeout(t));
}

// ---------- erasure ----------
// The audit trail is permanent; the PERSON is erasable. Those are different
// objects: the chain proves what the policy decided, erasure removes the
// guest's name. display_name is the only column that names a person, so
// nulling it satisfies the split without touching the chain. SQLite permits multiple
// NULLs, so no collision and no derived pseudo-name leaking part of the id.
// Issued credits and rollover keep opaque ids: whether a given jurisdiction
// requires those to go too is the buyer's legal call — flagged, not decided,
// here.
// v0.2.5: these two threw a bare Error, which carries no .status, and web.js
// answers `err.status || 500`. So GUEST_UNKNOWN came back as 500 and
// ALREADY_ERASED as 500, while CANON.json declares 404 and 409 — a server
// fault reported where "not found" and "already done" were meant, on the
// erasure route of all places, and a caller reads 500 as retryable. The engine
// has carried fail(code, status) all along; this file simply never used it.
function fail(code, status) { const e = new Error(code); e.status = status; throw e; }

function erase(db, guestId) {
  if (typeof guestId !== 'string' || !guestId) fail('GUEST_UNKNOWN', 404);
  const g = db.prepare('SELECT id, erased_at FROM guests WHERE id = ?').get(guestId);
  if (!g) fail('GUEST_UNKNOWN', 404);
  if (g.erased_at) fail('ALREADY_ERASED', 409);
  const at = new Date().toISOString();
  db.prepare('UPDATE guests SET display_name = NULL, erased_at = ? WHERE id = ?').run(at, guestId);
  append(db, 'guest.erase', { guest_id: guestId });
  // Erased means gone from the FILES, not only from the API. secure_delete
  // (set in store.open) zeroes the freed record; the checkpoint moves the new
  // page into the database file and truncates the write-ahead log, which still
  // held earlier copies of the page with the name in it.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  return { erased: true, guest_id: guestId };
}

module.exports = { append, verify, chainHead, erase, downstream, canonical, sha256 };
