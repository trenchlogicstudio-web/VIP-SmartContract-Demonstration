// VIP SmartContract · MVP v0.2.16 · engine (persistent session operations)
// Copyright (c) 2026 Miloš Petrović (Trench Logic Studio) · SPDX-License-Identifier: MIT
//
// This layer binds the pure policy core (policy.js) to storage and to the
// audit chain. The six /v3 routes answer with the response fields of registry
// slot 04b_Integration_Reference.js, except inside the events on the audit
// route, which are this build's own record (README, Documented divergences).
// Everything this file adds — voluntary stop, credit redemption, rollover
// application, the quarter roll-up — sits on the /vip surface and is not part
// of the specification.
'use strict';
const crypto = require('crypto');
const P = require('./policy');
const B = require('./boundary');
const { atomic, transaction, afterRollback } = require('./store');
const { validVip, determinationTime, addDecimal } = require('./values');

function fail(code, status, extra) { const e = new Error(code); e.status = status; if (extra) e.extra = extra; throw e; }

// The most recent session for a VIP, in any state. The reference keeps stopped
// sessions reachable in memory, so a second tick after a stop returns
// ALREADY_STOPPED rather than NO_LIVE_SESSION; looking up the latest session
// rather than only the live one reproduces that exactly.
function latest(db, vip_id) {
  // A vip_id that is not a non-empty string names no session. Handing it to
  // SQLite as a bind value raised a driver error that surfaced as a 500 with
  // the driver's message; the reference answers NO_LIVE_SESSION for the same
  // input, and so does this build now.
  if (!validVip(vip_id)) return undefined;
  return db.prepare(
    'SELECT * FROM sessions WHERE guest_id = ? ORDER BY rowid DESC LIMIT 1'
  ).get(vip_id);
}

function sessionForIssue(db, vip_id, session_id) {
  if (session_id === undefined) return latest(db, vip_id);
  if (!validVip(vip_id) || typeof session_id !== 'string') return undefined;
  return db.prepare('SELECT * FROM sessions WHERE id = ? AND guest_id = ?').get(session_id, vip_id);
}

function ensureGuest(db, vip_id) {
  const g = db.prepare('SELECT id FROM guests WHERE id = ?').get(vip_id);
  if (g) return;
  // The reference arms a policy for any vip_id string it is given. This build
  // does the same and creates the guest record with no name attached.
  db.prepare('INSERT INTO guests(id, display_name, tier, created_at) VALUES(?,NULL,?,?)')
    .run(vip_id, 'unclassified', new Date().toISOString());
}

// ── /v3 · GET /v3/terms ───────────────────────────────────────────────────
// The terms a guest is shown before agreeing, and their version. A client that
// sends the version back with the pre-commit has it checked: if the terms
// changed between the screen and the call, nothing is armed.
function terms() {
  return { terms_version: P.TERMS_VERSION, terms: P.TERMS };
}

// ── /v3 · POST /v3/precommit ──────────────────────────────────────────────
function precommit(db, { vip_id, budget_eur, mode, eligibility, eligibility_at, terms_version }) {
  if (!validVip(vip_id)) fail('INVALID_VIP', 400);
  // A budget is at least one cent and at most P.MAX_EUR: below a cent there is
  // no line to arm, and above the bound the cent arithmetic stops being exact.
  if (!Number.isFinite(budget_eur) || budget_eur < 0.01 || budget_eur > P.MAX_EUR) fail('INVALID_BUDGET', 400);
  // Money is counted in whole cents from the moment it arrives: a budget that
  // carries a fraction of a cent is taken to the nearest cent.
  budget_eur = P.eur(P.cents(budget_eur));
  const m = mode === undefined ? P.CFG.mode : mode;
  if (!P.MODES.includes(m)) fail('INVALID_MODE', 400);
  // The operator's responsible-gaming determination, supplied per session.
  // Absent means permitted; the engine forms no view of its own.
  const requested = eligibility === undefined ? 'permitted' : eligibility;
  if (!P.ELIGIBILITY.includes(requested)) fail('INVALID_ELIGIBILITY', 400);
  // When the operator states WHEN it made the determination, that timestamp is
  // carried for the life of the session. If no lifetime is configured it is
  // recorded and never acted on; if one is, an absent or unparseable timestamp
  // is treated as expired, because an unknown age is not a young age. An absent
  // date is recorded as absent: filling it in with the current time, as this
  // build once did, made an unknown age look fresh and the gate failed open.
  if (eligibility_at !== undefined) {
    const t = determinationTime(eligibility_at);
    if (!Number.isFinite(t) || t > Date.now()) {
      fail('INVALID_ELIGIBILITY_AT', 400);
    }
  }
  const elig_at = eligibility_at === undefined ? null : eligibility_at;
  // The terms the guest agreed to. A version the client sends is the version
  // it showed the guest; if it is not the version in force, the guest agreed to
  // something else and nothing is armed. Without one, the session records the
  // version in force, which is the version the guest was armed under.
  if (terms_version !== undefined && terms_version !== P.TERMS_VERSION) {
    fail('TERMS_CHANGED', 409, { terms_version: P.TERMS_VERSION });
  }

  ensureGuest(db, vip_id);
  // A guest withdrawn from the programme, excluded, or removed by the
  // operator's own assessment cannot be re-enrolled by opening a session.
  const sup = db.prepare('SELECT suppressed_at FROM guests WHERE id = ?').get(vip_id);
  const elig = sup && sup.suppressed_at ? 'suppressed' : P.effectiveEligibility(requested, elig_at);
  // A pre-commitment binds for the commitment period. While a session is live
  // and younger than that, a new pre-commit is refused and the answer says when
  // one will be accepted: before 0.2.14 it superseded the session at once, so a
  // larger budget sent in the middle of play moved the line. After the period a
  // live session is superseded as before; it is closed and stays in the record,
  // so the audit trail keeps both.
  // From 0.2.16 a stopped session holds the guest for the same period, counted
  // from the same moment: the session was armed, reached its line or was
  // settled, and a second budget inside the period would be a second limit on
  // top of the first. Until 0.2.15 that was left to the property's own rule.
  const last = latest(db, vip_id);
  if (last && last.state === 'stopped') {
    const after = new Date(last.opened_at).getTime() + P.COMMITMENT_HOURS * 3600000;
    if (!(Date.now() >= after)) {
      fail('COMMITMENT_ACTIVE', 409, { session_id: last.id, precommit_after: new Date(after).toISOString() });
    }
  }
  const live = db.prepare("SELECT id, opened_at FROM sessions WHERE guest_id = ? AND state = 'live'").get(vip_id);
  if (live) {
    const free_at = new Date(live.opened_at).getTime() + P.COMMITMENT_HOURS * 3600000;
    if (Date.now() < free_at) {
      fail('SESSION_LIVE', 409, { session_id: live.id, supersede_after: new Date(free_at).toISOString() });
    }
    db.prepare("UPDATE sessions SET state = 'closed', reserved_eur = 0 WHERE id = ?").run(live.id);
    // A stake checked under the superseded session cannot be reported against
    // the new one: its check closes with the session that granted it.
    db.prepare("UPDATE authorizations SET closed_at = ?, closed_by = 'superseded', consumed_eur = 0 WHERE session_id = ? AND closed_at IS NULL")
      .run(new Date().toISOString(), live.id);
  }

  const session_id = crypto.randomUUID();
  const armed = P.armedAt(budget_eur);
  db.prepare(`INSERT INTO sessions(id, guest_id, mode, eligibility, eligibility_at, terms_version, state, budget_eur, armed_at_eur, consumed_eur, opened_at)
              VALUES(?,?,?,?,?,?,'live',?,?,0,?)`)
    .run(session_id, vip_id, m, elig, elig_at, P.TERMS_VERSION, budget_eur, armed, new Date().toISOString());

  // The amount and the terms the guest agreed to are one link in the chain.
  const e = B.append(db, 'precommit', { vip_id, session_id, budget_eur, mode: m, armed_at_eur: armed, eligibility: elig, eligibility_at: elig_at, terms_version: P.TERMS_VERSION });
  return { session_id, armed_at_eur: armed, mode: m, eligibility: elig, eligibility_at: elig_at, terms_version: P.TERMS_VERSION, fingerprint: e.fingerprint };
}

// ── /v3 · GET /v3/policy/state ────────────────────────────────────────────
function view(s, db) {
  const consumed = s.consumed_exact ?? s.consumed_eur;
  const a = P.assess(consumed, s.budget_eur, s.mode, s.armed_at_eur);
  const now = Date.now();
  const eligibility = P.effectiveEligibility(s.eligibility, s.eligibility_at, now);
  const pv = s.state === 'stopped'
    ? settlementForIssue(db, s, now)
    : P.preview(consumed, s.budget_eur, s.eligibility, s.eligibility_at, now);
  return {
    vip_id: s.guest_id,
    session_id: s.id,
    mode: s.mode,
    stopped: s.state === 'stopped',
    budget_eur: s.budget_eur,
    // The terms this session was armed under; null for a session armed before 0.2.16.
    terms_version: s.terms_version ?? null,
    consumed_eur: P.money(consumed),
    consumed_fraction: Math.round(a.fraction * 1000) / 1000,
    distance_to_threshold_eur: P.distanceToThreshold(consumed, s.budget_eur, s.armed_at_eur),
    reserved_eur: P.money(s.reserved_eur || 0),
    // The largest stake the check would allow now; a stopped session allows none.
    headroom_eur: s.state === 'stopped' ? 0 : P.eur(P.headroomCents(s.armed_at_eur, consumed, s.reserved_eur)),
    nudge_active: a.nudge,
    escalate_active: a.escalate,
    eligibility, eligibility_expired: P.eligibilityExpired(s.eligibility_at, now),
    redirect_issued: Boolean(s.redirect_issued),
    incentive_preview: {
      redirect_eur: pv.redirect,
      rollover_eur: pv.rollover,
      residual_to_guest_eur: pv.residual,
      capped: pv.capped
    }
  };
}

function stateOf(db, vip_id) {
  const s = latest(db, vip_id);
  if (!s) fail('NO_LIVE_SESSION', 409);
  return view(s, db);
}

// ── the stop ──────────────────────────────────────────────────────────────
// trigger: 'threshold' when the engine fired it, 'voluntary' when the guest
// chose to stop in Advisory mode. The canon rule is that incentive mechanics
// are identical on a voluntary stop, so both paths run this one function.
function doStop(db, s, trigger) {
  const consumed = s.consumed_exact ?? s.consumed_eur;
  const st = P.preview(consumed, s.budget_eur, s.eligibility, s.eligibility_at);
  const at = new Date().toISOString();
  // How far consumption went past the line. Zero while the platform asks before
  // every stake and no wager consumes more than its check; above zero only when
  // one of those did not hold, and then the stop says so, in the chain, rather
  // than reading as a clean stop. Advisory mode enforces no line, so it records none.
  const overshoot = s.mode === 'hard_stop' ? P.eur(P.overshootCents(s.armed_at_eur, consumed)) : 0;
  // A stake checked but not yet reported when the session stops can no longer be
  // placed against it: the stop closes it, and the chain counts how many it closed.
  const voided = db.prepare('SELECT COUNT(*) n FROM authorizations WHERE session_id = ? AND closed_at IS NULL').get(s.id).n;
  if (voided) {
    db.prepare("UPDATE authorizations SET closed_at = ?, closed_by = 'stop', consumed_eur = 0 WHERE session_id = ? AND closed_at IS NULL")
      .run(at, s.id);
  }
  db.prepare(`UPDATE sessions SET state='stopped', preserved_eur=?, redirect_eur=?, rollover_eur=?,
              residual_eur=?, stopped_at=?, eligibility=?, settlement_json=?, reserved_eur=0 WHERE id=?`)
    .run(st.preserved, st.redirect, st.rollover, st.residual, at, st.eligibility, JSON.stringify(st), s.id);
  s.reserved_eur = 0;
  const e = B.append(db, 'policy.stop', {
    vip_id: s.guest_id, session_id: s.id, trigger,
    consumed_eur: P.money(consumed), preserved_eur: st.preserved,
    redirect_eur: st.redirect, rollover_eur: st.rollover, residual_to_guest_eur: st.residual,
    eligibility: st.eligibility, capped: st.capped, eligibility_expired: st.expired,
    overshoot_eur: overshoot, authorizations_voided: voided
  });
  // An expiry is recorded separately from a suppression, because the two are
  // different facts: one says the operator withheld eligibility, the other says
  // nobody refreshed it. A regulator reading the chain should be able to tell
  // a decision from a lapse.
  if (st.expired) {
    B.append(db, 'eligibility.expired', {
      vip_id: s.guest_id, session_id: s.id,
      determined_at: s.eligibility_at || null, ttl_days: P.ELIGIBILITY_TTL_DAYS
    });
  }
  // A refusal to issue is its own link in the chain. A regulator asking this
  // system to prove itself needs the occasions it did NOT reward, and an
  // absent row proves nothing.
  if (st.eligibility === 'suppressed') {
    B.append(db, 'incentive.suppressed', {
      vip_id: s.guest_id, session_id: s.id, scope: 'settlement',
      preserved_eur: st.preserved, returned_to_guest_eur: st.residual
    });
  }
  return {
    preserved: st.preserved,
    rollover: st.rollover,
    residual_to_guest_eur: st.residual,
    credits: st.credits,
    eligibility: st.eligibility,
    capped: st.capped,
    eligibility_expired: st.expired,
    overshoot_eur: overshoot,
    fingerprint: e.fingerprint
  };
}

// ── /v3 · POST /v3/session/authorize ──────────────────────────────────────
// The pre-stake check. A tick reports consumption AFTER it has happened, so a
// stop driven by ticks alone locks the session on the tick that crosses the
// line, and that tick counts in full: the line is where the engine notices,
// not where the guest's spend ends. The engine can hold the line only where it
// sees the stake first. With this call in the wager path it does: every stake
// the platform accepts is reserved against what is left to the line, as if it
// were lost, and a stake larger than that is refused before it is placed. Two
// stakes asked for at once cannot both take the last euros, because each check
// and its reservation are one transaction on one database.
// In Advisory mode nothing is enforced: the stake is reserved and reported the
// same way, and the answer says it was not enforced.
function authorize(db, { vip_id, stake_eur, session_id }) {
  const s = latest(db, vip_id);
  if (!s || s.state === 'closed' || (session_id !== undefined && session_id !== s.id)) fail('NO_LIVE_SESSION', 409);
  if (s.state === 'stopped') fail('ALREADY_STOPPED', 409);
  if (!Number.isFinite(stake_eur) || stake_eur < 0.01 || stake_eur > P.MAX_EUR) fail('INVALID_STAKE', 400);
  const stake_c = P.cents(stake_eur);
  const consumed = s.consumed_exact ?? s.consumed_eur;
  const headroom_c = P.headroomCents(s.armed_at_eur, consumed, s.reserved_eur);
  const enforced = s.mode === 'hard_stop';
  if (enforced && stake_c > headroom_c) {
    // A refused stake is the Hard-Stop working, and a regulator asking this
    // system to prove itself needs the refusals: it is its own link in the chain.
    // The refusal is kept although the request fails, so it is written after
    // the failing transaction has been rolled back.
    const refusal = { vip_id, session_id: s.id, stake_eur: P.eur(stake_c), headroom_eur: P.eur(headroom_c) };
    afterRollback(db, () => B.append(db, 'stake.refused', refusal));
    fail('STAKE_EXCEEDS_HEADROOM', 409, { headroom_eur: P.eur(headroom_c) });
  }
  const id = crypto.randomUUID();
  const reserved = P.eur(P.cents(s.reserved_eur || 0) + stake_c);
  db.prepare('INSERT INTO authorizations(id, session_id, stake_eur, created_at) VALUES(?,?,?,?)')
    .run(id, s.id, P.eur(stake_c), new Date().toISOString());
  db.prepare('UPDATE sessions SET reserved_eur = ? WHERE id = ?').run(reserved, s.id);
  return {
    authorized: true, authorization_id: id, session_id: s.id, stake_eur: P.eur(stake_c), enforced,
    reserved_eur: reserved, headroom_eur: P.eur(P.headroomCents(s.armed_at_eur, consumed, reserved))
  };
}

// An open authorization of this guest's current session, or a refusal. An id
// that is not this guest's names nothing, and says so the same way an unknown
// one does.
function openAuthorization(db, authorization_id, s) {
  if (typeof authorization_id !== 'string' || !authorization_id) fail('AUTHORIZATION_UNKNOWN', 404);
  const a = db.prepare('SELECT * FROM authorizations WHERE id = ?').get(authorization_id);
  if (!a || a.session_id !== s.id) fail('AUTHORIZATION_UNKNOWN', 404);
  if (a.closed_at) fail('AUTHORIZATION_CLOSED', 409);
  return a;
}

function closeAuthorization(db, s, a, by, consumed_eur) {
  db.prepare('UPDATE authorizations SET closed_at = ?, closed_by = ?, consumed_eur = ? WHERE id = ?')
    .run(new Date().toISOString(), by, consumed_eur, a.id);
  const reserved = P.eur(Math.max(0, P.cents(s.reserved_eur || 0) - P.cents(a.stake_eur)));
  db.prepare('UPDATE sessions SET reserved_eur = ? WHERE id = ?').run(reserved, s.id);
  s.reserved_eur = reserved;
}

// ── /v3 · POST /v3/session/release ────────────────────────────────────────
// The stake was checked but never played: the wager was cancelled or voided.
// Its reservation is returned to the headroom and nothing is consumed.
function release(db, { vip_id, authorization_id, session_id }) {
  const s = latest(db, vip_id);
  if (!s || s.state === 'closed' || (session_id !== undefined && session_id !== s.id)) fail('NO_LIVE_SESSION', 409);
  if (s.state === 'stopped') fail('ALREADY_STOPPED', 409);
  const a = openAuthorization(db, authorization_id, s);
  closeAuthorization(db, s, a, 'release', 0);
  return {
    released: true, authorization_id: a.id, reserved_eur: P.money(s.reserved_eur),
    headroom_eur: P.eur(P.headroomCents(s.armed_at_eur, s.consumed_exact ?? s.consumed_eur, s.reserved_eur))
  };
}

// ── /v3 · POST /v3/session/tick ───────────────────────────────────────────
function tick(db, payload) {
  const { event_id, session_id, vip_id, delta_eur } = payload;
  if (event_id === undefined) return recordTick(db, payload);
  if (!validVip(event_id) || [...event_id].length > 128 || !validVip(session_id)) fail('INVALID_EVENT_ID', 400);
  if (!validVip(vip_id)) fail('NO_LIVE_SESSION', 409);
  const receipt = db.prepare(`SELECT t.delta_eur, t.response FROM tick_receipts t
    JOIN sessions s ON s.id=t.session_id WHERE t.session_id=? AND t.event_id=? AND s.guest_id=?`)
    .get(session_id, event_id, vip_id);
  if (receipt) {
    if (receipt.delta_eur !== delta_eur) fail('EVENT_CONFLICT', 409);
    return JSON.parse(receipt.response);
  }
  const result = recordTick(db, payload);
  db.prepare('INSERT INTO tick_receipts(session_id,event_id,delta_eur,response) VALUES(?,?,?,?)')
    .run(session_id, event_id, delta_eur, JSON.stringify(result));
  return result;
}

function recordTick(db, { vip_id, delta_eur, session_id, authorization_id }) {
  const s = latest(db, vip_id);
  if (!s || s.state === 'closed' || (session_id !== undefined && session_id !== s.id)) fail('NO_LIVE_SESSION', 409);
  if (s.state === 'stopped') fail('ALREADY_STOPPED', 409);
  // A tick reports CONSUMPTION, which only ever goes up. A negative delta was
  // previously accepted and silently reduced consumption, which could disarm a
  // stop that had already been reached — a way around the gate rather than an
  // undefined edge. Corrections, if an integration ever needs them, belong on
  // their own route with their own link in the chain, not hidden inside a tick.
  if (!Number.isFinite(delta_eur) || delta_eur < 0 || delta_eur > P.MAX_EUR) fail('INVALID_DELTA', 400);
  // A tick that reports a checked stake names it, and the check closes with it.
  // Everything is validated before anything moves.
  const auth = authorization_id === undefined ? null : openAuthorization(db, authorization_id, s);

  // The reported total is kept exactly, so ticks below a cent still add up; every
  // decision reads that total in whole cents — the stop, the display and the
  // settlement alike — so while consumption is within the budget, consumed plus
  // preserved is the budget to the cent.
  const consumed = addDecimal(s.consumed_exact ?? s.consumed_eur, delta_eur);
  if (!Number.isSafeInteger(P.cents(consumed))) fail('INVALID_DELTA', 400);
  db.prepare('UPDATE sessions SET consumed_eur = ?, consumed_exact = ? WHERE id = ?').run(Number(consumed), consumed, s.id);
  db.prepare('INSERT INTO ticks(session_id, delta_eur, at, authorization_id) VALUES(?,?,?,?)')
    .run(s.id, delta_eur, new Date().toISOString(), auth ? auth.id : null);
  s.consumed_eur = Number(consumed);
  s.consumed_exact = consumed;
  if (auth) {
    closeAuthorization(db, s, auth, 'tick', delta_eur);
    // The platform defines consumption, stake or net loss, and the guarantee
    // holds only while a wager consumes no more than the stake it was checked
    // for. When it does consume more, that is a fact the engine records, not a
    // tick it refuses: consumption is reported truthfully and the chain shows
    // which check it exceeded.
    if (P.exceedsStake(delta_eur, auth.stake_eur)) {
      B.append(db, 'stake.exceeded', {
        vip_id, session_id: s.id, authorization_id: auth.id,
        stake_eur: auth.stake_eur, consumed_eur: delta_eur
      });
    }
  }

  const a = P.assess(consumed, s.budget_eur, s.mode, s.armed_at_eur);

  if (a.locks) return { locked: true, ...doStop(db, s, 'threshold') };

  if (s.mode === 'advisory') {
    // Each advisory crossing is announced ONCE per session, and a single large
    // tick can cross BOTH lines at once. The canon says each event fires when
    // its line is crossed, so both are emitted, in order. An earlier build
    // marked the nudge as sent while emitting only the escalation, and a
    // downstream reading the chain would have seen a session that escalated
    // without ever having been nudged.
    if (a.nudge && !s.nudged) {
      db.prepare('UPDATE sessions SET nudged = 1 WHERE id = ?').run(s.id);
      B.append(db, 'advisory.nudge', { vip_id, session_id: s.id, consumed_eur: P.money(consumed) });
      s.nudged = 1;
    }
    if (a.escalate && !s.escalated) {
      db.prepare('UPDATE sessions SET escalated = 1 WHERE id = ?').run(s.id);
      B.append(db, 'advisory.escalate', { vip_id, session_id: s.id, consumed_eur: P.money(consumed) });
    }
    if (a.fire) {
      return { state: view(s), advisory: 'threshold reached — host escalation recommended' };
    }
  }
  return { state: view(s) };
}

// ── /v3 · POST /v3/redirect/issue ─────────────────────────────────────────
// Version 0.2.12 stored the three leg totals but omitted the venue split
// from unissued stops. Recover issued instruments from the ledger. For an
// unissued legacy stop keep its leg totals and distribute only its existing
// redirect, using the available venue weights. A disabled redirect goes back
// to the guest. New stops carry their full quote and need no reconstruction.
function storedSettlement(db, s) {
  if (s.settlement_json) return JSON.parse(s.settlement_json);
  const { preserved_eur: preserved, rollover_eur: rollover } = s;
  let redirect = s.redirect_eur;
  let credits;
  if (s.redirect_issued && db) {
    credits = { spa: 0, fnb: 0, retail: 0 };
    for (const c of db.prepare('SELECT category, amount_eur FROM credits WHERE session_id = ?').all(s.id)) {
      credits[c.category] = P.money(credits[c.category] + c.amount_eur);
    }
  } else {
    if (!P.W.redirect && !s.redirect_issued) redirect = 0;
    const legs = P.allocate(P.cents(redirect), [P.W.spa, P.W.fnb, P.W.retail]).map(P.eur);
    credits = { spa: legs[0], fnb: legs[1], retail: legs[2] };
  }
  const stop = db && db.prepare("SELECT payload FROM events WHERE json_valid(payload) AND json_extract(payload,'$.session_id') = ? AND type='policy.stop' LIMIT 1").get(s.id);
  const capped = stop ? Boolean(JSON.parse(stop.payload).capped) : false;
  return { preserved, redirect, rollover, credits, capped,
           residual: P.eur(P.cents(preserved) - P.cents(redirect) - P.cents(rollover)) };
}

function settlementForIssue(db, s, now) {
  if (!s.redirect_issued && P.effectiveEligibility(s.eligibility, s.eligibility_at, now) === 'suppressed') {
    return P.settle(s.preserved_eur, 'suppressed', s.eligibility_at, now);
  }
  const st = storedSettlement(db, s);
  if (s.redirect_issued) return st;
  // Each pending instrument must fit both the offer at stop and today's
  // policy. A disabled venue or smaller share returns the difference to the
  // guest; reallocating it to another venue could exceed the original offer.
  const current = P.settle(st.preserved, s.eligibility, s.eligibility_at, now);
  const credits = {};
  let redirectCents = 0;
  for (const category of ['spa', 'fnb', 'retail']) {
    credits[category] = Math.min(st.credits[category], current.credits[category]);
    redirectCents += P.cents(credits[category]);
  }
  const rollover = Math.min(st.rollover, current.rollover);
  const capBinds = P.REWARD_CAP_EUR !== null && P.money(st.redirect + st.rollover) > P.REWARD_CAP_EUR;
  return { ...st, credits, redirect: P.eur(redirectCents), rollover, capped: st.capped || capBinds,
           residual: P.eur(P.cents(st.preserved) - redirectCents - P.cents(rollover)) };
}

function withhold(db, s, now) {
  const st = P.settle(s.preserved_eur, 'suppressed', s.eligibility_at, now);
  db.prepare("UPDATE sessions SET eligibility='suppressed', redirect_eur=0, rollover_eur=0, residual_eur=preserved_eur, settlement_json=? WHERE id=?")
    .run(JSON.stringify(st), s.id);
  const written = db.prepare("SELECT 1 FROM events WHERE json_valid(payload) AND json_extract(payload,'$.session_id')=? AND type='incentive.suppressed' LIMIT 1").get(s.id);
  if (written) return;
  if (st.expired) {
    B.append(db, 'eligibility.expired', { vip_id: s.guest_id, session_id: s.id,
      determined_at: s.eligibility_at, ttl_days: P.ELIGIBILITY_TTL_DAYS });
  }
  B.append(db, 'incentive.suppressed', { vip_id: s.guest_id, session_id: s.id, scope: 'settlement',
    preserved_eur: st.preserved, returned_to_guest_eur: st.preserved });
}

function redirectIssue(db, payload) {
  // A policy refusal is a committed audit decision. Database errors roll back.
  const result = transaction(db, () => issue(db, payload));
  if (!result) fail('INCENTIVE_SUPPRESSED', 409);
  return result;
}

function issue(db, { vip_id, session_id }) {
  const s = sessionForIssue(db, vip_id, session_id);
  if (!s || s.state === 'closed') fail('NO_LIVE_SESSION', 409);
  if (s.state !== 'stopped') fail('NOT_STOPPED', 409);
  if (s.redirect_issued) fail('ALREADY_ISSUED', 409);
  const now = Date.now();
  if (P.effectiveEligibility(s.eligibility, s.eligibility_at, now) === 'suppressed') {
    withhold(db, s, now);
    return null;
  }
  const st = settlementForIssue(db, s, now);
  // An older build could leave uncommitted instruments on disk. A clean
  // retry replaces only unused rows from a stop with no issuance event.
  const priorCredits = db.prepare('SELECT redeemed_at FROM credits WHERE session_id=?').all(s.id);
  const priorRollover = db.prepare('SELECT applied_at FROM rollover WHERE session_id=?').all(s.id);
  if (priorCredits.length || priorRollover.length) {
    const issuedEvent = db.prepare("SELECT 1 FROM events WHERE json_valid(payload) AND json_extract(payload,'$.session_id')=? AND type='redirect.issue' LIMIT 1").get(s.id);
    if (issuedEvent || priorCredits.some(c => c.redeemed_at) || priorRollover.some(r => r.applied_at)) {
      fail('LEDGER_CONFLICT', 409);
    }
    db.prepare('DELETE FROM credits WHERE session_id=?').run(s.id);
    db.prepare('DELETE FROM rollover WHERE session_id=?').run(s.id);
  }
  const at = new Date().toISOString();
  // A share configured to zero issues nothing: no zero-euro instrument is
  // written, so nothing can later be "redeemed" for nothing.
  for (const cat of ['spa', 'fnb', 'retail']) {
    if (st.credits[cat] > 0) {
      db.prepare('INSERT INTO credits(session_id, guest_id, category, amount_eur, issued_at) VALUES(?,?,?,?,?)')
        .run(s.id, s.guest_id, cat, st.credits[cat], at);
    }
  }
  if (st.rollover > 0) {
    db.prepare('INSERT INTO rollover(guest_id, session_id, amount_eur, issued_at) VALUES(?,?,?,?)')
      .run(s.guest_id, s.id, st.rollover, at);
  }
  db.prepare('UPDATE sessions SET redirect_issued=1, redirect_eur=?, rollover_eur=?, residual_eur=?, settlement_json=? WHERE id=?')
    .run(st.redirect, st.rollover, st.residual, JSON.stringify(st), s.id);

  const e = B.append(db, 'redirect.issue', {
    vip_id, session_id: s.id, credits: st.credits,
    rollover_eur: st.rollover, residual_to_guest_eur: st.residual
  });
  return {
    issued: true,
    preserved: st.preserved,
    credits: st.credits,
    rollover: st.rollover,
    residual: st.residual,
    fingerprint: e.fingerprint
  };
}


// ── /v3 · POST /v3/programme/suppress ─────────────────────────────────────
// One route, three reasons, one effect: stop issuing to this guest, now and
// from now on. It exists because three different obligations demand the same
// action and an integrator should not have to wire three integrations for it.
//
//   exclusion        the guest is on an exclusion or self-exclusion register.
//                    Several US states require that an excluded patron cannot
//                    redeem points, comps or freeplay, so this must be able to
//                    arrive from the operator's exclusion feed and take effect
//                    immediately, not overnight.
//   player_request   the guest asked to leave the programme. UK guidance
//                    expects a licensee to comply promptly and to stop
//                    personalised incentives immediately.
//   rg_determination the operator's responsible-gaming assessment withdrew
//                    eligibility. The assessment is theirs; the engine only
//                    records that it was applied.
//
// A live session is stopped on the spot. The stop is NOT cancelled and the
// budget is NOT forfeited — the guest keeps the whole preserved amount as
// residual. Suppression removes the incentive, never the protection.
const SUPPRESS_REASONS = ['exclusion', 'player_request', 'rg_determination'];

function programmeSuppress(db, { vip_id, reason }) {
  if (!validVip(vip_id)) fail('INVALID_VIP', 400);
  if (!SUPPRESS_REASONS.includes(reason)) fail('INVALID_REASON', 400);
  // The guest need not exist yet. An exclusion feed can reach this engine
  // before the guest has ever opened a session, and refusing it then would
  // leave a window in which the very person the register names could enrol.
  // The reference at slot 04b accepts an unknown vip_id for the same reason,
  // so accepting it here also keeps the two implementations identical on a
  // /v3 route, which the canon requires.
  ensureGuest(db, vip_id);
  const g = db.prepare('SELECT id, suppressed_at FROM guests WHERE id = ?').get(vip_id);
  if (g.suppressed_at) fail('ALREADY_SUPPRESSED', 409);

  const at = new Date().toISOString();
  db.prepare('UPDATE guests SET suppressed_at = ?, suppressed_reason = ? WHERE id = ?').run(at, reason, vip_id);
  db.prepare("UPDATE sessions SET eligibility = 'suppressed' WHERE guest_id = ?").run(vip_id);

  const e = B.append(db, 'incentive.suppressed', { vip_id, reason, scope: 'programme', at });

  // A live session is stopped immediately, under the suppressed settlement.
  let stopped = null;
  const s = latest(db, vip_id);
  if (s && s.state === 'live') {
    s.eligibility = 'suppressed';
    stopped = doStop(db, s, 'suppression');
  }
  const unissued = db.prepare("SELECT * FROM sessions WHERE guest_id=? AND state='stopped' AND redirect_issued=0").all(vip_id);
  for (const pending of unissued) withhold(db, pending, Date.parse(at));
  return { vip_id, suppressed: true, reason, session_stopped: stopped !== null, stopped, fingerprint: e.fingerprint };
}

// ── /v3 · GET /v3/audit/{session_id} ──────────────────────────────────────
function audit(db, session_id) {
  const rows = db.prepare("SELECT seq, type, payload, at, hash FROM events WHERE json_valid(payload) AND json_extract(payload, '$.session_id')=? ORDER BY seq").all(session_id)
    .map(r => ({ seq: r.seq, type: r.type, at: r.at, ...JSON.parse(r.payload), fingerprint: r.hash.slice(0, 16) }));
  if (!rows.length) fail('SESSION_UNKNOWN', 404);
  return { session_id, events: rows, chain: B.chainHead(db).slice(0, 16) };
}

// ── /vip · product surface of this running system ─────────────────────────
// Not part of 04_API_Spec.yaml. These are the operations a resort actually
// performs around the policy, and they are what makes the money chain
// observable end to end rather than asserted.

// A voluntary stop in Advisory mode. Same settlement as an enforced stop —
// that identity is the canon rule, and here it is the same code path.
function voluntaryStop(db, { vip_id, session_id }) {
  const s = latest(db, vip_id);
  if (!s || s.state === 'closed' || (session_id !== undefined && session_id !== s.id)) fail('NO_LIVE_SESSION', 409);
  if (s.state === 'stopped') fail('ALREADY_STOPPED', 409);
  return { stopped: true, trigger: 'voluntary', ...doStop(db, s, 'voluntary') };
}

// Redemption is where preserved gaming budget becomes non-gaming revenue.
// Until a credit is redeemed the redirect figure is an issuance, not a sale —
// the distinction the value documents depend on.
function redeem(db, { credit_id }) {
  // A credit is identified by the positive integer it was issued under, as a
  // JSON number. Anything else identifies no credit: coercing first would let
  // `true` or "1" redeem credit 1, and a boolean handed to SQLite as a bind
  // value is a driver error, not an answer.
  if (!Number.isInteger(credit_id) || credit_id < 1) fail('CREDIT_UNKNOWN', 404);
  const c = db.prepare(`SELECT c.*, s.eligibility, s.eligibility_at, g.suppressed_at FROM credits c
                        JOIN sessions s ON s.id=c.session_id JOIN guests g ON g.id=c.guest_id WHERE c.id=? AND s.redirect_issued=1`).get(credit_id);
  if (!c) fail('CREDIT_UNKNOWN', 404);
  if (c.redeemed_at) fail('CREDIT_REDEEMED', 409);
  // From the moment a guest is suppressed no incentive value reaches them: a
  // credit issued before the suppression arrived is not redeemed after it. An
  // excluded patron may not redeem comps, and the engine does not wait for the
  // next session to honour that.
  if (c.suppressed_at || P.effectiveEligibility(c.eligibility, c.eligibility_at) === 'suppressed') fail('INCENTIVE_SUPPRESSED', 409);
  const at = new Date().toISOString();
  db.prepare('UPDATE credits SET redeemed_at = ? WHERE id = ?').run(at, c.id);
  const e = B.append(db, 'credit.redeem', {
    vip_id: c.guest_id, session_id: c.session_id, category: c.category, amount_eur: c.amount_eur
  });
  return { redeemed: true, credit_id: c.id, category: c.category, amount_eur: c.amount_eur, fingerprint: e.fingerprint };
}

// Rollover is a liability, not revenue: it is credit toward a future session
// and is only extinguished when the guest comes back and uses it.
function applyRollover(db, { vip_id }) {
  if (!validVip(vip_id)) fail('NO_ROLLOVER', 404);
  const held = db.prepare(`SELECT r.*, s.eligibility, s.eligibility_at, g.suppressed_at FROM rollover r
    JOIN sessions s ON s.id=r.session_id JOIN guests g ON g.id=r.guest_id
    WHERE r.guest_id=? AND r.applied_at IS NULL AND s.redirect_issued=1 ORDER BY r.id`).all(vip_id);
  if (!held.length) fail('NO_ROLLOVER', 404);
  const now = Date.now();
  const r = held.find(row => !row.suppressed_at && P.effectiveEligibility(row.eligibility, row.eligibility_at, now) === 'permitted');
  if (!r) fail('INCENTIVE_SUPPRESSED', 409);
  const at = new Date().toISOString();
  db.prepare('UPDATE rollover SET applied_at = ? WHERE id = ?').run(at, r.id);
  const e = B.append(db, 'rollover.apply', { vip_id, session_id: r.session_id, amount_eur: r.amount_eur });
  return { applied: true, amount_eur: r.amount_eur, fingerprint: e.fingerprint };
}

// The quarter roll-up. Every figure here is computed from this instance's own
// rows and published with its denominator; nothing is read from a constant.
function quarter(db) {
  const q = db.prepare(`WITH cohort AS (SELECT * FROM sessions WHERE quarter=1 AND state='stopped'),
       issued AS (SELECT c.* FROM credits c JOIN cohort s ON s.id=c.session_id WHERE s.redirect_issued=1)
       SELECT COUNT(*) n, COALESCE(SUM(preserved_eur),0) preserved, COALESCE(SUM(redirect_eur),0) redirect,
         COALESCE(SUM(rollover_eur),0) rollover, COALESCE(SUM(residual_eur),0) residual,
         (SELECT COUNT(*) FROM issued) issued_n, (SELECT COALESCE(SUM(amount_eur),0) FROM issued) issued_eur,
         (SELECT COUNT(*) FROM issued WHERE redeemed_at IS NOT NULL) redeemed_n,
         (SELECT COALESCE(SUM(amount_eur),0) FROM issued WHERE redeemed_at IS NOT NULL) redeemed_eur,
         (SELECT COALESCE(SUM(r.amount_eur),0) FROM rollover r JOIN cohort s ON s.id=r.session_id WHERE r.applied_at IS NULL AND s.redirect_issued=1) outstanding,
         (SELECT COUNT(*) FROM sessions WHERE state='live' AND quarter=0) live_n
       FROM cohort`).get();
  return {
    _basis: 'Computed from this instance. Seeded rows are a synthetic reproduction of the canon reference preset, not a measurement of any operator.',
    stopped_sessions_in_quarter: q.n,
    preserved_eur: P.money(q.preserved),
    redirected_eur: P.money(q.redirect),
    rollover_allocated_eur: P.money(q.rollover),
    rollover_liability_eur: P.money(q.outstanding),
    residual_to_guests_eur: P.money(q.residual),
    non_gaming_capture: q.preserved ? Math.round((q.redirect / q.preserved) * 1000) / 1000 : 0,
    _non_gaming_capture_denominator: 'preserved budget of the stopped sessions in the quarter — not the guests\' whole theoretical spend',
    credits_issued: { count: q.issued_n, eur: P.money(q.issued_eur) },
    credits_redeemed: { count: q.redeemed_n, eur: P.money(q.redeemed_eur) },
    _redeemed_denominator: 'issued credit; redemption is the point at which preserved budget becomes non-gaming revenue',
    live_sessions_outside_quarter: q.live_n
  };
}

function guests(db) {
  return db.prepare(`SELECT g.id, g.display_name, g.tier, g.erased_at,
                     (SELECT state FROM sessions s WHERE s.guest_id = g.id ORDER BY s.rowid DESC LIMIT 1) AS last_state
                     FROM guests g ORDER BY g.rowid ASC`).all();
}

module.exports = {
  terms, precommit: atomic(precommit), tick: atomic(tick), authorize: atomic(authorize), release: atomic(release), stateOf, redirectIssue, audit, view, latest,
  programmeSuppress: atomic(programmeSuppress), SUPPRESS_REASONS,
  voluntaryStop: atomic(voluntaryStop), redeem: atomic(redeem), applyRollover: atomic(applyRollover), quarter, guests, fail
};
