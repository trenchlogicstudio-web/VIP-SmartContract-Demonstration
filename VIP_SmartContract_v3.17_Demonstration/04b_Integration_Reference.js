#!/usr/bin/env node
/**
 * VIP SmartContract — Integration Reference · v3.17 · registry slot 04b
 * Trench Logic Studio · AS-IS: a runnable reference for feasibility evaluation,
 * not a deployable production system.
 *
 * Serves all six routes declared in 04_API_Spec.yaml, with zero dependencies
 * on Node >= 18. State is in memory by design — this is a reference, so 04c
 * declares no database and none is needed.
 *
 * Middleware position: funds never go on chain, rules stay off chain, only the
 * audit proof is hash-anchored.
 *
 * Every value below resolves in 12_Canon.json. If this file and the canon
 * disagree, the canon is right.
 */

'use strict';
const http = require('http');
const crypto = require('crypto');

// ── configuration ─────────────────────────────────────────────────────────
// Every threshold is a per-jurisdiction configurable. Each one is validated at
// startup and the process REFUSES TO START on a bad value. Guarding the input
// alone is not enough: `x > NaN` is false in JavaScript, so a non-finite
// threshold silently turns an upper-bound test into a gate that admits
// everything. A threshold that is not a finite number in range must stop the
// process, not degrade it.
//
// Run directly, a refusal is one sentence and exit code 1. Loaded as a module
// (the MVP suite does), it is an exception the caller can assert on.
function refuse(msg) {
  if (require.main === module) {
    console.error('\n  VIP reference cannot start: ' + msg + '\n');
    process.exit(1);
  }
  throw new Error(msg);
}
function num(key, fallback, lo, hi) {
  const raw = process.env[key];
  const v = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(v) || v < lo || v > hi) {
    refuse(`${key} must be a finite number in [${lo}, ${hi}], got "${raw}". Refusing to start.`);
  }
  return v;
}
const MODES = ['hard_stop', 'advisory'];
const MODE = process.env.VIP_MODE || 'hard_stop';
if (!MODES.includes(MODE)) {
  refuse(`VIP_MODE must be one of ${MODES.join(' | ')}, got "${process.env.VIP_MODE}". Refusing to start.`);
}
const CFG = {
  mode: MODE,
  threshold: num('VIP_THRESHOLD', 0.50, 0.05, 0.95),   // canon thresholds.hard_stop_fraction
  nudge: num('VIP_NUDGE', 0.40, 0.05, 0.95),           // canon thresholds.advisory_nudge_fraction
  escalate: num('VIP_ESCALATE', 0.85, 0.05, 0.99),     // canon thresholds.advisory_escalate_fraction
  rollover: num('VIP_ROLLOVER', 0.20, 0, 1),           // canon thresholds.rollover_fraction
  // canon thresholds.redirect_split — per-jurisdiction configurable like every
  // threshold above, validated by the same rule.
  split: {
    spa: num('VIP_SPLIT_SPA', 0.30, 0, 1),
    fnb: num('VIP_SPLIT_FNB', 0.25, 0, 1),
    retail: num('VIP_SPLIT_RETAIL', 0.15, 0, 1)
  },
  port: num('PORT', 8080, 1, 65535)
};
if (!Number.isInteger(CFG.port)) {
  refuse(`PORT must be a whole number in [1, 65535], got "${process.env.PORT}". Refusing to start.`);
}
// ── money in integer cents ────────────────────────────────────────────────
// Every decision that involves money is taken on INTEGER CENTS, and every
// configured fraction is read as an integer number of millionths. Floating
// point displays a ratio; it never decides one. A share computed as
// cents x 0.25 / 0.7000000000000001 carries a rounding error that decides the
// ties the largest-remainder rule gives to position, and the same error let the
// published amount fall a cent below the stop line it named. With integers the
// split follows its rule to the cent and armed_at_eur is the first cent at
// which the policy fires. A fraction is read to six decimal places; no amount
// above MAX_EUR is accepted, so every product below is an exact integer.
const MICRO = 1000000;
const MAX_EUR = 10000000;
const cents = eur => Math.round(eur * 100);
const eur = c => Math.round(c) / 100;        // whole cents in: a stray fraction of a cent is rounded here, never carried
const micro = x => Math.round(x * MICRO);
const W = {
  threshold: micro(CFG.threshold), nudge: micro(CFG.nudge), escalate: micro(CFG.escalate),
  rollover: micro(CFG.rollover),
  spa: micro(CFG.split.spa), fnb: micro(CFG.split.fnb), retail: micro(CFG.split.retail)
};
W.redirect = W.spa + W.fnb + W.retail;
if (W.rollover + W.redirect > MICRO) {
  refuse('rollover + redirect split exceeds the preserved budget. Refusing to start.');
}
// The remainder is the guest's own money and is returned to them, not captured.
// It is reported as residual_to_guest_eur on every stop so the model closes:
// redirect + rollover + residual always equals the preserved budget.
W.residual = MICRO - W.rollover - W.redirect;
// A configured share as a plain ratio, for display only. No amount is decided
// on it: every amount is decided on the integer millionths in W.
const fraction = m => m / MICRO;
const REDIRECT_TOTAL = fraction(W.redirect);                              // 0.7
const RESIDUAL = fraction(W.residual);                                    // 0.1
// The first cent at or above `fraction` of a budget: the stop line, the nudge
// line and the escalation line, all one computation.
const lineCents = (budget_c, fraction_micro) => Math.ceil(budget_c * fraction_micro / MICRO);

// ── state and audit chain ─────────────────────────────────────────────────
const state = { sessions: new Map(), events: [], chain: '', suppressed: new Map() };
const money = n => Math.round(n * 100) / 100;

// ── RG eligibility gate ───────────────────────────────────────────────────
// The gate decides whether an incentive may be ISSUED. It never decides
// whether a guest is at risk: this engine performs no risk assessment and
// holds no harm model. The operator's responsible-gaming determination is an
// INPUT, supplied per session, and the engine's only job is to honour it and
// record that it did. A policy layer that classified harm would be a
// responsible-gaming system and would fall inside the certification perimeter
// of every jurisdiction that has one.
//
// The stricter of the configured default and the per-session input wins. A
// jurisdiction that forbids the incentive outright sets
// VIP_ELIGIBILITY_DEFAULT=suppressed and no session can re-enable it.
const ELIGIBILITY = ['permitted', 'suppressed'];
const ELIGIBILITY_DEFAULT = process.env.VIP_ELIGIBILITY_DEFAULT || 'permitted';
if (!ELIGIBILITY.includes(ELIGIBILITY_DEFAULT)) {
  refuse(`VIP_ELIGIBILITY_DEFAULT must be one of ${ELIGIBILITY.join(' | ')}, got "${process.env.VIP_ELIGIBILITY_DEFAULT}". Refusing to start.`);
}
function effectiveEligibility(requested, determined_at, now) {
  if (ELIGIBILITY_DEFAULT === 'suppressed') return 'suppressed';
  if (requested === 'suppressed') return 'suppressed';
  // A determination past its lifetime is not a permission.
  if (eligibilityExpired(determined_at, now)) return 'suppressed';
  return 'permitted';
}

// ── reward cap ────────────────────────────────────────────────────────────
// An absolute euro ceiling on the operator-funded part of a settlement —
// redirect plus rollover. Unset means uncapped, which is the reference
// configuration every canon figure was computed under.
//
// Without a ceiling the incentive grows with the pre-committed budget, so a
// larger declared budget earns a larger reward — an incentive to declare a
// larger budget, and the one attack on this design the mechanism does not
// answer by itself. When the cap binds the excess is not retained by the
// operator: it returns to the guest as residual.
function capEur(key) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    refuse(`${key} must be a finite number greater than 0 when set, got "${raw}". Refusing to start.`);
  }
  return v;
}
const REWARD_CAP_EUR = capEur('VIP_REWARD_CAP_EUR');

// ── eligibility lifetime ──────────────────────────────────────────────────
// How long the operator's responsible-gaming determination stays good for.
// Unset means it never expires, which is the reference configuration every
// figure in the canon was computed under.
//
// Why it exists: a determination taken once and never revisited is the weakest
// form of a control. Supervisory expectations in several regimes include
// periodic review of a high-value customer's account, and a policy layer that
// honours a two-year-old assessment as though it were today's is not honouring
// a control — it is honouring a memory of one. When the lifetime elapses the
// gate falls CLOSED rather than open: the incentive is withheld until the
// operator supplies a fresh determination. Failing safe is the only defensible
// direction here, because the alternative is issuing value on stale grounds.
function ttlDays(key) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    refuse(`${key} must be a finite number of days greater than 0 when set, got "${raw}". Refusing to start.`);
  }
  return v;
}
const ELIGIBILITY_TTL_DAYS = ttlDays('VIP_ELIGIBILITY_TTL_DAYS');

// Returns true when a determination taken at determined_at is too old to rely
// on. An absent timestamp is treated as expired when a lifetime is configured:
// an unknown age is not a young age.
function eligibilityExpired(determined_at, now) {
  if (ELIGIBILITY_TTL_DAYS === null) return false;
  if (!determined_at) return true;
  const t = Date.parse(determined_at);
  if (!Number.isFinite(t)) return true;
  const age_days = ((now === undefined ? Date.now() : now) - t) / 86400000;
  return age_days > ELIGIBILITY_TTL_DAYS;
}


// settle: the single place a preserved budget is divided, gate and cap
// included. Both this file and the MVP run this same arithmetic; the suite
// asserts they agree rather than assuming it.

// ── exact allocation ──────────────────────────────────────────────────────
// Money is split in CENTS, as integers, and the split is guaranteed to close.
//
// The old arithmetic computed each leg independently — redirect, rollover and
// residual each as a rounded percentage of the preserved budget — and three
// independent roundings do not add up. Measured across every amount from €0.01
// to €2,000.00, the three legs failed to sum to the preserved budget in about
// 52,205 of the 200,000 cases, one in four, by a cent either way. One cent is small; money
// that appears or disappears in a settlement is not, because a buyer's
// reconciliation runs on exact equality and an operator's auditor tests it.
//
// allocate() uses the largest-remainder method on integers: every share is
// total x weight / sum-of-weights, floored; the leftover cents go one at a
// time to the largest remainders, ties broken by position. Remainders are
// compared as integers, so a tie is a tie and position decides it — exactly
// the rule, on every amount. The parts always sum to the whole, no part is
// ever negative, and a weight of zero receives nothing.
function allocate(total_c, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total_c <= 0 || sum === 0) return weights.map(() => 0);
  const raw = weights.map(w => total_c * w);
  const out = raw.map(r => Math.floor(r / sum));
  let left = total_c - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, rem: r - out[i] * sum }))
    .sort((a, b) => (b.rem - a.rem) || (a.i - b.i));
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length].i] += 1;
  return out;
}

function settle(preserved_eur, eligibility, determined_at, now) {
  const p = Math.max(0, cents(preserved_eur));
  const preserved = eur(p);
  const expired = eligibilityExpired(determined_at, now);
  const elig = effectiveEligibility(eligibility, determined_at, now);

  // Suppressed: the stop still happens and the budget is still preserved, but
  // nothing is issued. The whole preserved amount returns to the guest as
  // residual, so the model closes exactly as it does when an incentive runs.
  if (elig === 'suppressed') {
    return {
      preserved, eligibility: elig, capped: false, expired,
      credits: { spa: 0, fnb: 0, retail: 0 },
      redirect: 0, rollover: 0, residual: preserved
    };
  }

  // Two allocations, each exact. The first divides the preserved budget three
  // ways; the second divides the redirect leg across the three venues. Because
  // both use largest-remainder on integer cents, spa + fnb + retail === redirect
  // and redirect + rollover + residual === preserved, always.
  let [redirect, rollover, residual] = allocate(p, [W.redirect, W.rollover, W.residual]);
  let capped = false;

  if (REWARD_CAP_EUR !== null && redirect + rollover > cents(REWARD_CAP_EUR)) {
    capped = true;
    [redirect, rollover] = allocate(cents(REWARD_CAP_EUR), [W.redirect, W.rollover]);
    // The guest takes the whole difference, computed as the remainder so the
    // model still closes to the cent.
    residual = p - redirect - rollover;
  }

  const [spa, fnb, retail] = allocate(redirect, [W.spa, W.fnb, W.retail]);

  return {
    preserved, eligibility: elig, capped, expired,
    credits: { spa: eur(spa), fnb: eur(fnb), retail: eur(retail) },
    redirect: eur(redirect), rollover: eur(rollover), residual: eur(residual)
  };
}


function evt(type, payload) {
  const e = { seq: state.events.length + 1, type, at: new Date().toISOString(), ...payload };
  state.events.push(e);
  // Hash chain: each link folds the previous chain value with the new event, so
  // altering any earlier row breaks every fingerprint after it.
  state.chain = crypto.createHash('sha256').update(state.chain + JSON.stringify(e)).digest('hex');
  e.fingerprint = state.chain.slice(0, 16);
  return e;
}

// ── policy ────────────────────────────────────────────────────────────────
function precommit({ vip_id, budget_eur, mode, eligibility, eligibility_at }) {
  if (typeof vip_id !== 'string' || !vip_id) fail('INVALID_VIP', 400);
  // At least one cent and at most MAX_EUR: below a cent there is no line to
  // arm, and above the bound the cent arithmetic stops being exact.
  if (!Number.isFinite(budget_eur) || budget_eur < 0.01 || budget_eur > MAX_EUR) fail('INVALID_BUDGET', 400);
  // Money is counted in whole cents from the moment it arrives: a budget that
  // carries a fraction of a cent is taken to the nearest cent.
  budget_eur = eur(cents(budget_eur));
  const m = mode === undefined ? CFG.mode : mode;
  if (!MODES.includes(m)) fail('INVALID_MODE', 400);
  const requested = eligibility === undefined ? 'permitted' : eligibility;
  if (!ELIGIBILITY.includes(requested)) fail('INVALID_ELIGIBILITY', 400);
  if (eligibility_at !== undefined &&
      (typeof eligibility_at !== 'string' || !Number.isFinite(Date.parse(eligibility_at)))) {
    fail('INVALID_ELIGIBILITY_AT', 400);
  }
  // An absent determination date is recorded as absent, never filled in with the
  // current time: with a lifetime configured an unknown age counts as expired.
  const elig_at = eligibility_at === undefined ? null : eligibility_at;
  // A guest withdrawn from the programme cannot be re-enrolled by opening a
  // session; suppression outlives the session that carried it.
  const elig = state.suppressed.has(vip_id) ? 'suppressed' : effectiveEligibility(requested, elig_at);
  const s = {
    vip_id, budget: budget_eur, mode: m, consumed: 0, eligibility: elig, eligibility_at: elig_at,
    session_id: crypto.randomUUID(), stopped: false, redirect_issued: false
  };
  state.sessions.set(vip_id, s);
  const e = evt('precommit', { vip_id, budget_eur, mode: m, session_id: s.session_id, eligibility: elig, eligibility_at: elig_at });
  const armed = eur(lineCents(cents(budget_eur), W.threshold));
  return { session_id: s.session_id, armed_at_eur: armed, mode: m, eligibility: elig, eligibility_at: elig_at, fingerprint: e.fingerprint };
}

function tick({ vip_id, delta_eur }) {
  const s = typeof vip_id === 'string' ? state.sessions.get(vip_id) : undefined;
  if (!s) fail('NO_LIVE_SESSION', 409);
  if (s.stopped) fail('ALREADY_STOPPED', 409);
  // A tick REPORTS consumption, and consumption only goes up. A negative delta
  // was accepted here until v3.11 and silently reduced consumption, which lets a
  // caller walk a session back from its stop line and postpone the stop
  // indefinitely. The MVP has refused it since v0.2.4; this file did not, so the
  // two implementations disagreed on a control the canon declares. Corrections,
  // if an integration ever needs them, belong on their own route with their own
  // link in the chain, never hidden inside a tick.
  if (!Number.isFinite(delta_eur) || delta_eur < 0 || delta_eur > MAX_EUR) fail('INVALID_DELTA', 400);
  // The reported total is kept exactly, so ticks below a cent still add up; the
  // stop, the display and the settlement all read that total in whole cents.
  s.consumed = s.consumed + delta_eur;
  if (cents(s.consumed) >= lineCents(cents(s.budget), W.threshold)) {
    if (s.mode === 'hard_stop') return { locked: true, ...stop(s, 'threshold') };
    return { state: view(s), advisory: 'threshold reached — host escalation recommended' };
  }
  return { state: view(s) };
}

function stop(s, trigger) {
  s.stopped = true;
  const st = settle(eur(cents(s.budget) - cents(s.consumed)), s.eligibility, s.eligibility_at);
  s.pending = { preserved: st.preserved, credits: st.credits, rollover: st.rollover, residual: st.residual };
  const e = evt('policy.stop', {
    vip_id: s.vip_id, session_id: s.session_id, trigger: trigger || 'threshold',
    consumed: money(s.consumed), preserved: st.preserved, rollover: st.rollover,
    residual_to_guest_eur: st.residual, credits: st.credits,
    eligibility: st.eligibility, capped: st.capped, eligibility_expired: st.expired
  });
  if (st.expired) {
    evt('eligibility.expired', {
      vip_id: s.vip_id, session_id: s.session_id,
      determined_at: s.eligibility_at || null, ttl_days: ELIGIBILITY_TTL_DAYS
    });
  }
  // A refusal to issue is its own link in the chain. A regulator asking this
  // system to prove itself needs the occasions it did NOT reward, and an
  // absent row proves nothing.
  if (st.eligibility === 'suppressed') {
    evt('incentive.suppressed', {
      vip_id: s.vip_id, session_id: s.session_id, scope: 'settlement',
      preserved_eur: st.preserved, returned_to_guest_eur: st.residual
    });
  }
  return {
    preserved: st.preserved, rollover: st.rollover, residual_to_guest_eur: st.residual,
    credits: st.credits, eligibility: st.eligibility, capped: st.capped,
    eligibility_expired: st.expired, fingerprint: e.fingerprint
  };
}
// ── programme suppression ─────────────────────────────────────────────────
// One route, three reasons, one effect: stop issuing to this guest, now and
// from now on.
//   exclusion        the guest is on an exclusion or self-exclusion register
//   player_request   the guest asked to leave the programme
//   rg_determination the operator's responsible-gaming assessment withdrew it
// A live session stops on the spot. The stop is not cancelled and the budget
// is not forfeited: the guest keeps the whole preserved amount as residual.
// Suppression removes the incentive, never the protection.
const SUPPRESS_REASONS = ['exclusion', 'player_request', 'rg_determination'];

function programmeSuppress({ vip_id, reason }) {
  if (typeof vip_id !== 'string' || !vip_id) fail('INVALID_VIP', 400);
  if (!SUPPRESS_REASONS.includes(reason)) fail('INVALID_REASON', 400);
  if (state.suppressed.has(vip_id)) fail('ALREADY_SUPPRESSED', 409);
  state.suppressed.set(vip_id, { reason, at: new Date().toISOString() });
  const e = evt('incentive.suppressed', { vip_id, reason, scope: 'programme' });
  let stopped = null;
  const s = state.sessions.get(vip_id);
  // The guest's session is marked whether it is live or already stopped: an
  // incentive settled before the suppression arrived is not collected after it.
  if (s) {
    s.eligibility = 'suppressed';
    if (!s.stopped) stopped = stop(s, 'suppression');
    else if (!s.redirect_issued && s.pending.rollover + s.pending.credits.spa + s.pending.credits.fnb +
             s.pending.credits.retail > 0) {
      // A settlement computed before the suppression and not yet issued will now
      // never be: that refusal is written as its own link, as it is at a stop.
      evt('incentive.suppressed', { vip_id, session_id: s.session_id, scope: 'settlement',
        preserved_eur: s.pending.preserved, returned_to_guest_eur: s.pending.preserved });
    }
  }
  return { vip_id, suppressed: true, reason, session_stopped: stopped !== null, stopped, fingerprint: e.fingerprint };
}


function view(s) {
  const frac = s.consumed / s.budget;                     // display only
  const b = cents(s.budget), c = cents(s.consumed);
  const preserved = eur(Math.max(0, b - c));
  return {
    vip_id: s.vip_id, session_id: s.session_id, mode: s.mode, stopped: s.stopped,
    budget_eur: s.budget, consumed_eur: money(s.consumed),
    consumed_fraction: Math.round(frac * 1000) / 1000,
    distance_to_threshold_eur: eur(Math.max(0, lineCents(b, W.threshold) - c)),
    nudge_active: s.mode === 'advisory' && c >= lineCents(b, W.nudge),
    escalate_active: s.mode === 'advisory' && c >= lineCents(b, W.escalate),
    eligibility: effectiveEligibility(s.eligibility, s.eligibility_at),
    eligibility_expired: eligibilityExpired(s.eligibility_at),
    incentive_preview: (() => {
      const pv = settle(preserved, s.eligibility, s.eligibility_at);
      return { redirect_eur: pv.redirect, rollover_eur: pv.rollover,
               residual_to_guest_eur: pv.residual, capped: pv.capped };
    })()
  };
}

function redirectIssue({ vip_id }) {
  const s = typeof vip_id === 'string' ? state.sessions.get(vip_id) : undefined;
  if (!s) fail('NO_LIVE_SESSION', 409);
  if (!s.stopped) fail('NOT_STOPPED', 409);
  if (s.redirect_issued) fail('ALREADY_ISSUED', 409);
  if (effectiveEligibility(s.eligibility, s.eligibility_at) === 'suppressed') {
    // Withheld at this call because the determination lapsed after the stop: the
    // settlement that will not issue is written once, as it is at a stop.
    if (!state.events.some(e => e.type === 'incentive.suppressed' && e.session_id === s.session_id)) {
      if (eligibilityExpired(s.eligibility_at)) {
        evt('eligibility.expired', { vip_id, session_id: s.session_id,
          determined_at: s.eligibility_at || null, ttl_days: ELIGIBILITY_TTL_DAYS });
      }
      evt('incentive.suppressed', { vip_id, session_id: s.session_id, scope: 'settlement',
        preserved_eur: s.pending.preserved, returned_to_guest_eur: s.pending.preserved });
    }
    fail('INCENTIVE_SUPPRESSED', 409);
  }
  s.redirect_issued = true;
  const e = evt('redirect.issue', { vip_id, session_id: s.session_id, ...s.pending });
  return { issued: true, ...s.pending, fingerprint: e.fingerprint };
}

function audit(session_id) {
  const rows = state.events.filter(e => e.session_id === session_id);
  if (!rows.length) fail('SESSION_UNKNOWN', 404);
  return { session_id, events: rows, chain: state.chain.slice(0, 16) };
}

function fail(code, status) { const e = new Error(code); e.status = status; throw e; }

// ── transport ─────────────────────────────────────────────────────────────
const ROUTES = ['POST /v3/precommit', 'POST /v3/session/tick', 'GET /v3/policy/state',
                'POST /v3/redirect/issue', 'GET /v3/audit/{session_id}',
                'POST /v3/programme/suppress'];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(400, { error: 'BAD_REQUEST' }); }
    const path = url.pathname;
    let payload = {};
    if (body) { try { payload = JSON.parse(body); } catch { return send(400, { error: 'BAD_JSON' }); } }
    // A body that parses but is not a JSON object — null, an array, a bare
    // string or number — is refused here, before any route reads it: a null
    // failed on destructuring and came back as a 500.
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(400, { error: 'BAD_JSON' });
    }
    try {
      if (req.method === 'POST' && path === '/v3/precommit') return send(201, precommit(payload));
      if (req.method === 'POST' && path === '/v3/session/tick') {
        const r = tick(payload);
        return send(r.locked ? 423 : 200, r);          // 423 Locked: the stop is the product working
      }
      if (req.method === 'GET' && path === '/v3/policy/state') {
        const s = state.sessions.get(url.searchParams.get('vip_id'));
        if (!s) return send(409, { error: 'NO_LIVE_SESSION' });
        return send(200, view(s));
      }
      if (req.method === 'POST' && path === '/v3/redirect/issue') return send(200, redirectIssue(payload));
      if (req.method === 'POST' && path === '/v3/programme/suppress') return send(200, programmeSuppress(payload));
      if (req.method === 'GET' && path.startsWith('/v3/audit/')) {
        let sid;
        try { sid = decodeURIComponent(path.slice('/v3/audit/'.length)); }
        catch { return send(400, { error: 'BAD_REQUEST' }); }   // not valid percent-encoding
        return send(200, audit(sid));
      }
      return send(404, { error: 'NO_ROUTE', routes: ROUTES });
    } catch (err) {
      return send(err.status || 500, { error: err.message });
    }
  });
});

if (require.main === module) {
  server.listen(CFG.port, () => {
    const pct = m => `${m / 10000}%`;
    console.log(`VIP SmartContract reference v3.17 · mode=${CFG.mode} · threshold=${pct(W.threshold)} · ` +
                `rollover=${pct(W.rollover)} · redirect=${pct(W.redirect)} · residual=${pct(W.residual)} · ` +
                `eligibility=${ELIGIBILITY_DEFAULT} · cap=${REWARD_CAP_EUR === null ? 'none' : REWARD_CAP_EUR} · ` +
                `:${CFG.port} · ${ROUTES.length}/6 spec routes live`);
  });
}

module.exports = { server, precommit, tick, stop, view, redirectIssue, audit, settle, MAX_EUR, W, lineCents, cents,
                   ELIGIBILITY_TTL_DAYS, eligibilityExpired, allocate,
                   programmeSuppress, SUPPRESS_REASONS, ELIGIBILITY, effectiveEligibility,
                   REWARD_CAP_EUR, CFG, _state: state };
