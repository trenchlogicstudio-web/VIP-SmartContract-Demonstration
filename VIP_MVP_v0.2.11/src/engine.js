// VIP SmartContract · MVP v0.2.11 · engine (persistent session operations)
// AS-IS evaluation artifact — 09_AS_IS_Notice of the VIP SmartContract package governs.
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

function fail(code, status) { const e = new Error(code); e.status = status; throw e; }

// The most recent session for a VIP, in any state. The reference keeps stopped
// sessions reachable in memory, so a second tick after a stop returns
// ALREADY_STOPPED rather than NO_LIVE_SESSION; looking up the latest session
// rather than only the live one reproduces that exactly.
function latest(db, vip_id) {
  // A vip_id that is not a non-empty string names no session. Handing it to
  // SQLite as a bind value raised a driver error that surfaced as a 500 with
  // the driver's message; the reference answers NO_LIVE_SESSION for the same
  // input, and so does this build now.
  if (typeof vip_id !== 'string' || !vip_id) return undefined;
  return db.prepare(
    'SELECT * FROM sessions WHERE guest_id = ? ORDER BY opened_at DESC, rowid DESC LIMIT 1'
  ).get(vip_id);
}

// True once the operator has taken the guest out of the incentive programme.
function suppressed(db, vip_id) {
  const g = db.prepare('SELECT suppressed_at FROM guests WHERE id = ?').get(vip_id);
  return Boolean(g && g.suppressed_at);
}

function ensureGuest(db, vip_id) {
  const g = db.prepare('SELECT id FROM guests WHERE id = ?').get(vip_id);
  if (g) return;
  // The reference arms a policy for any vip_id string it is given. This build
  // does the same and creates the guest record with no name attached.
  db.prepare('INSERT INTO guests(id, display_name, tier, created_at) VALUES(?,NULL,?,?)')
    .run(vip_id, 'unclassified', new Date().toISOString());
}

// ── /v3 · POST /v3/precommit ──────────────────────────────────────────────
function precommit(db, { vip_id, budget_eur, mode, eligibility, eligibility_at }) {
  if (typeof vip_id !== 'string' || !vip_id) fail('INVALID_VIP', 400);
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
    if (typeof eligibility_at !== 'string' || !Number.isFinite(Date.parse(eligibility_at))) {
      fail('INVALID_ELIGIBILITY_AT', 400);
    }
  }
  const elig_at = eligibility_at === undefined ? null : eligibility_at;

  ensureGuest(db, vip_id);
  // A guest withdrawn from the programme, excluded, or removed by the
  // operator's own assessment cannot be re-enrolled by opening a session.
  const sup = db.prepare('SELECT suppressed_at FROM guests WHERE id = ?').get(vip_id);
  const elig = sup && sup.suppressed_at ? 'suppressed' : P.effectiveEligibility(requested, elig_at);
  // A pre-commit while a session is live supersedes it. The reference achieves
  // the same by replacing its map entry; here the superseded session is closed
  // and stays in the record, so the audit trail keeps both.
  const live = db.prepare("SELECT id FROM sessions WHERE guest_id = ? AND state = 'live'").get(vip_id);
  if (live) db.prepare("UPDATE sessions SET state = 'closed' WHERE id = ?").run(live.id);

  const session_id = crypto.randomUUID();
  const armed = P.armedAt(budget_eur);
  db.prepare(`INSERT INTO sessions(id, guest_id, mode, eligibility, eligibility_at, state, budget_eur, armed_at_eur, consumed_eur, opened_at)
              VALUES(?,?,?,?,?,'live',?,?,0,?)`)
    .run(session_id, vip_id, m, elig, elig_at, budget_eur, armed, new Date().toISOString());

  const e = B.append(db, 'precommit', { vip_id, session_id, budget_eur, mode: m, armed_at_eur: armed, eligibility: elig, eligibility_at: elig_at });
  return { session_id, armed_at_eur: armed, mode: m, eligibility: elig, eligibility_at: elig_at, fingerprint: e.fingerprint };
}

// ── /v3 · GET /v3/policy/state ────────────────────────────────────────────
function view(s) {
  const a = P.assess(s.consumed_eur, s.budget_eur, s.mode);
  const pv = P.preview(s.consumed_eur, s.budget_eur, s.eligibility, s.eligibility_at);
  return {
    vip_id: s.guest_id,
    session_id: s.id,
    mode: s.mode,
    stopped: s.state === 'stopped',
    budget_eur: s.budget_eur,
    consumed_eur: P.money(s.consumed_eur),
    consumed_fraction: Math.round(a.fraction * 1000) / 1000,
    distance_to_threshold_eur: P.distanceToThreshold(s.consumed_eur, s.budget_eur),
    nudge_active: a.nudge,
    escalate_active: a.escalate,
    eligibility: pv.eligibility,
    eligibility_expired: pv.expired,
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
  return view(s);
}

// ── the stop ──────────────────────────────────────────────────────────────
// trigger: 'threshold' when the engine fired it, 'voluntary' when the guest
// chose to stop in Advisory mode. The canon rule is that incentive mechanics
// are identical on a voluntary stop, so both paths run this one function.
function doStop(db, s, trigger) {
  const st = P.settle(P.eur(P.cents(s.budget_eur) - P.cents(s.consumed_eur)), s.eligibility, s.eligibility_at);
  const at = new Date().toISOString();
  db.prepare(`UPDATE sessions SET state='stopped', preserved_eur=?, redirect_eur=?, rollover_eur=?,
              residual_eur=?, stopped_at=? WHERE id=?`)
    .run(st.preserved, st.redirect, st.rollover, st.residual, at, s.id);
  const e = B.append(db, 'policy.stop', {
    vip_id: s.guest_id, session_id: s.id, trigger,
    consumed_eur: P.money(s.consumed_eur), preserved_eur: st.preserved,
    redirect_eur: st.redirect, rollover_eur: st.rollover, residual_to_guest_eur: st.residual,
    eligibility: st.eligibility, capped: st.capped, eligibility_expired: st.expired
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
    fingerprint: e.fingerprint
  };
}

// ── /v3 · POST /v3/session/tick ───────────────────────────────────────────
function tick(db, { vip_id, delta_eur }) {
  const s = latest(db, vip_id);
  if (!s || s.state === 'closed') fail('NO_LIVE_SESSION', 409);
  if (s.state === 'stopped') fail('ALREADY_STOPPED', 409);
  // A tick reports CONSUMPTION, which only ever goes up. A negative delta was
  // previously accepted and silently reduced consumption, which could disarm a
  // stop that had already been reached — a way around the gate rather than an
  // undefined edge. Corrections, if an integration ever needs them, belong on
  // their own route with their own link in the chain, not hidden inside a tick.
  if (!Number.isFinite(delta_eur) || delta_eur < 0 || delta_eur > P.MAX_EUR) fail('INVALID_DELTA', 400);

  // The reported total is kept exactly, so ticks below a cent still add up; every
  // decision reads that total in whole cents — the stop, the display and the
  // settlement alike — so while consumption is within the budget, consumed plus
  // preserved is the budget to the cent.
  const consumed = s.consumed_eur + delta_eur;
  db.prepare('UPDATE sessions SET consumed_eur = ? WHERE id = ?').run(consumed, s.id);
  db.prepare('INSERT INTO ticks(session_id, delta_eur, at) VALUES(?,?,?)')
    .run(s.id, delta_eur, new Date().toISOString());
  s.consumed_eur = consumed;

  const a = P.assess(consumed, s.budget_eur, s.mode);

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
      return { state: view(latest(db, vip_id)), advisory: 'threshold reached — host escalation recommended' };
    }
  }
  return { state: view(latest(db, vip_id)) };
}

// ── /v3 · POST /v3/redirect/issue ─────────────────────────────────────────
function redirectIssue(db, { vip_id }) {
  const s = latest(db, vip_id);
  if (!s || s.state === 'closed') fail('NO_LIVE_SESSION', 409);
  if (s.state !== 'stopped') fail('NOT_STOPPED', 409);
  if (s.redirect_issued) fail('ALREADY_ISSUED', 409);
  if (P.effectiveEligibility(s.eligibility, s.eligibility_at) === 'suppressed') {
    // Withheld at this call because the determination lapsed after the stop: the
    // settlement that will not issue is written once, as it is at a stop, so the
    // chain shows every occasion on which nothing was issued.
    const written = db.prepare("SELECT 1 FROM events WHERE type = 'incentive.suppressed' AND " +
                               "json_extract(payload, '$.session_id') = ?").get(s.id);
    if (!written) {
      if (P.eligibilityExpired(s.eligibility_at)) {
        B.append(db, 'eligibility.expired', {
          vip_id: s.guest_id, session_id: s.id,
          determined_at: s.eligibility_at || null, ttl_days: P.ELIGIBILITY_TTL_DAYS
        });
      }
      B.append(db, 'incentive.suppressed', {
        vip_id: s.guest_id, session_id: s.id, scope: 'settlement',
        preserved_eur: s.preserved_eur, returned_to_guest_eur: s.preserved_eur
      });
    }
    fail('INCENTIVE_SUPPRESSED', 409);
  }

  const st = P.settle(s.preserved_eur, s.eligibility, s.eligibility_at);
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
  db.prepare('UPDATE sessions SET redirect_issued = 1 WHERE id = ?').run(s.id);

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
// action and a buyer should not have to wire three integrations for it.
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
  if (typeof vip_id !== 'string' || !vip_id) fail('INVALID_VIP', 400);
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
  } else if (s && s.state === 'stopped' && !s.redirect_issued && s.redirect_eur + s.rollover_eur > 0) {
    // A settlement computed before the suppression and not yet issued will now
    // never be: that refusal is written as its own link, as it is at a stop.
    B.append(db, 'incentive.suppressed', {
      vip_id, session_id: s.id, scope: 'settlement',
      preserved_eur: s.preserved_eur, returned_to_guest_eur: s.preserved_eur
    });
  }
  return { vip_id, suppressed: true, reason, session_stopped: stopped !== null, stopped, fingerprint: e.fingerprint };
}

// ── /v3 · GET /v3/audit/{session_id} ──────────────────────────────────────
function audit(db, session_id) {
  const rows = db.prepare('SELECT seq, type, payload, at, hash FROM events ORDER BY seq ASC').all()
    .map(r => ({ seq: r.seq, type: r.type, at: r.at, ...JSON.parse(r.payload), fingerprint: r.hash.slice(0, 16) }))
    .filter(r => r.session_id === session_id);
  if (!rows.length) fail('SESSION_UNKNOWN', 404);
  return { session_id, events: rows, chain: B.chainHead(db).slice(0, 16) };
}

// ── /vip · product surface of this running system ─────────────────────────
// Not part of 04_API_Spec.yaml. These are the operations a resort actually
// performs around the policy, and they are what makes the money chain
// observable end to end rather than asserted.

// A voluntary stop in Advisory mode. Same settlement as an enforced stop —
// that identity is the canon rule, and here it is the same code path.
function voluntaryStop(db, { vip_id }) {
  const s = latest(db, vip_id);
  if (!s || s.state === 'closed') fail('NO_LIVE_SESSION', 409);
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
  const c = db.prepare('SELECT * FROM credits WHERE id = ?').get(credit_id);
  if (!c) fail('CREDIT_UNKNOWN', 404);
  if (c.redeemed_at) fail('CREDIT_REDEEMED', 409);
  // From the moment a guest is suppressed no incentive value reaches them: a
  // credit issued before the suppression arrived is not redeemed after it. An
  // excluded patron may not redeem comps, and the engine does not wait for the
  // next session to honour that.
  if (suppressed(db, c.guest_id)) fail('INCENTIVE_SUPPRESSED', 409);
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
  if (typeof vip_id !== 'string' || !vip_id) fail('NO_ROLLOVER', 404);
  const r = db.prepare('SELECT * FROM rollover WHERE guest_id = ? AND applied_at IS NULL ORDER BY id ASC LIMIT 1').get(vip_id);
  if (!r) fail('NO_ROLLOVER', 404);
  // Rollover is gaming value toward a future session; a suppressed guest does
  // not receive it, whatever the reason for the suppression.
  if (suppressed(db, vip_id)) fail('INCENTIVE_SUPPRESSED', 409);
  const at = new Date().toISOString();
  db.prepare('UPDATE rollover SET applied_at = ? WHERE id = ?').run(at, r.id);
  const e = B.append(db, 'rollover.apply', { vip_id, session_id: r.session_id, amount_eur: r.amount_eur });
  return { applied: true, amount_eur: r.amount_eur, fingerprint: e.fingerprint };
}

// The quarter roll-up. Every figure here is computed from this instance's own
// rows and published with its denominator; nothing is read from a constant.
function quarter(db) {
  const q = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(preserved_eur),0) preserved,
                        COALESCE(SUM(redirect_eur),0) redirect, COALESCE(SUM(rollover_eur),0) rollover,
                        COALESCE(SUM(residual_eur),0) residual
                        FROM sessions WHERE quarter = 1 AND state = 'stopped'`).get();
  const red = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount_eur),0) v FROM credits
                          WHERE redeemed_at IS NOT NULL`).get();
  const iss = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount_eur),0) v FROM credits').get();
  const liveN = db.prepare("SELECT COUNT(*) n FROM sessions WHERE state = 'live'").get().n;
  return {
    _basis: 'Computed from this instance. Seeded rows are a synthetic reproduction of the canon reference preset, not a measurement of any operator.',
    stopped_sessions_in_quarter: q.n,
    preserved_eur: P.money(q.preserved),
    redirected_eur: P.money(q.redirect),
    rollover_liability_eur: P.money(q.rollover),
    residual_to_guests_eur: P.money(q.residual),
    non_gaming_capture: q.preserved ? Math.round((q.redirect / q.preserved) * 1000) / 1000 : 0,
    _non_gaming_capture_denominator: 'preserved budget of the stopped sessions in the quarter — not the guests\' whole theoretical spend',
    credits_issued: { count: iss.n, eur: P.money(iss.v) },
    credits_redeemed: { count: red.n, eur: P.money(red.v) },
    _redeemed_denominator: 'issued credit; redemption is the point at which preserved budget becomes non-gaming revenue',
    live_sessions_outside_quarter: liveN
  };
}

function guests(db) {
  return db.prepare(`SELECT g.id, g.display_name, g.tier, g.erased_at,
                     (SELECT state FROM sessions s WHERE s.guest_id = g.id ORDER BY s.opened_at DESC, s.rowid DESC LIMIT 1) AS last_state
                     FROM guests g ORDER BY g.rowid ASC`).all();
}

module.exports = {
  precommit, tick, stateOf, redirectIssue, audit, view, latest,
  programmeSuppress, SUPPRESS_REASONS,
  voluntaryStop, redeem, applyRollover, quarter, guests, fail
};
