// VIP SmartContract · MVP v0.2.15 · policy core
// Copyright (c) 2026 Miloš Petrović (Trench Logic Studio) · SPDX-License-Identifier: MIT
//
// This file is the Body: the pre-commitment decision itself, with no database
// and no HTTP; it reads the clock only when a caller passes no time of its own.
// It does not reimplement the mechanism — it is the same
// arithmetic the shipped reference (registry slot 04b_Integration_Reference.js)
// performs, lifted into pure functions so it can be persisted, served and
// tested. test.js proves the two agree by running both on the same inputs
// whenever the reference file is reachable.
//
// Every value below resolves in CANON.json. If this file and the canon
// disagree, the canon is right.
'use strict';

// ── configuration ─────────────────────────────────────────────────────────
// Every threshold is a per-jurisdiction configurable. Each one is validated at
// startup and the process REFUSES TO START on a bad value. Guarding the input
// alone is not enough: `x > NaN` is false in JavaScript, so a non-finite
// threshold silently turns an upper-bound test into a gate that admits
// everything. A threshold that is not a finite number in range must stop the
// process, not degrade it.
function num(key, fallback, lo, hi) {
  const raw = process.env[key];
  const v = raw === undefined ? fallback : Number(raw);
  if ((raw !== undefined && raw.trim() === '') || !Number.isFinite(v) || v < lo || v > hi) {
    throw new Error(`${key} must be a finite number in [${lo}, ${hi}], got "${raw}". Refusing to start.`);
  }
  return v;
}

const MODES = ['hard_stop', 'advisory'];
const MODE = process.env.VIP_MODE ?? 'hard_stop';
if (!MODES.includes(MODE)) {
  throw new Error(`VIP_MODE must be one of ${MODES.join(' | ')}, got "${process.env.VIP_MODE}". Refusing to start.`);
}

const CFG = {
  mode: MODE,
  threshold: num('VIP_THRESHOLD', 0.50, 0.05, 0.95),   // canon thresholds.hard_stop_fraction
  nudge: num('VIP_NUDGE', 0.40, 0.05, 0.95),           // canon thresholds.advisory_nudge_fraction
  escalate: num('VIP_ESCALATE', 0.85, 0.05, 0.99),     // canon thresholds.advisory_escalate_fraction
  rollover: num('VIP_ROLLOVER', 0.20, 0, 1),           // canon thresholds.rollover_fraction
  // canon thresholds.redirect_split — per-jurisdiction configurable like every
  // other threshold above. A jurisdiction that caps F&B credit or bars retail
  // vouchers moves the split without touching the engine; each share is
  // validated by the same rule, so a non-finite share stops the process rather
  // than quietly redirecting nothing.
  split: {
    spa: num('VIP_SPLIT_SPA', 0.30, 0, 1),
    fnb: num('VIP_SPLIT_FNB', 0.25, 0, 1),
    retail: num('VIP_SPLIT_RETAIL', 0.15, 0, 1)
  }
};


// ── RG eligibility gate ───────────────────────────────────────────────────
// The gate decides whether an incentive may be ISSUED. It never decides
// whether a guest is at risk: this engine performs no risk assessment and
// holds no harm model. The operator's responsible-gaming determination is an
// INPUT, supplied per session, and the engine's only job is to honour it and
// record that it did. That separation is deliberate — a policy layer that
// classified harm would be a responsible-gaming system and would fall inside
// the certification perimeter of every jurisdiction that has one.
//
// Two values, and the stricter of the configured default and the per-session
// input always wins. A jurisdiction that forbids the incentive entirely sets
// VIP_ELIGIBILITY_DEFAULT=suppressed and no session can re-enable it.
const ELIGIBILITY = ['permitted', 'suppressed'];
const ELIGIBILITY_DEFAULT = process.env.VIP_ELIGIBILITY_DEFAULT ?? 'permitted';
if (!ELIGIBILITY.includes(ELIGIBILITY_DEFAULT)) {
  throw new Error(`VIP_ELIGIBILITY_DEFAULT must be one of ${ELIGIBILITY.join(' | ')}, got "${process.env.VIP_ELIGIBILITY_DEFAULT}". Refusing to start.`);
}
function effectiveEligibility(requested, determined_at, now) {
  if (ELIGIBILITY_DEFAULT === 'suppressed') return 'suppressed';
  if (requested === 'suppressed') return 'suppressed';
  // A determination past its lifetime is not a permission.
  if (eligibilityExpired(determined_at, now)) return 'suppressed';
  return 'permitted';
}

// ── reward cap ────────────────────────────────────────────────────────────
// An absolute ceiling in euro on the operator-funded part of a settlement —
// redirect plus rollover. Unset means uncapped, which is the reference
// configuration every figure in the canon was computed under.
//
// Why it exists: without a ceiling the incentive grows with the pre-committed
// budget, so a larger declared budget earns a larger reward. That is an
// incentive to declare a larger budget, and it is the one attack a regulator
// can make on this design that the mechanism itself does not answer. The cap
// answers it. When the cap binds, the excess is NOT retained by the operator —
// it goes to the guest as residual, so a capped settlement returns more of the
// guest's own money, never less.
function capEur(key) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`${key} must be a finite number greater than 0 when set, got "${raw}". Refusing to start.`);
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
    throw new Error(`${key} must be a finite number of days greater than 0 when set, got "${raw}". Refusing to start.`);
  }
  return v;
}
const ELIGIBILITY_TTL_DAYS = ttlDays('VIP_ELIGIBILITY_TTL_DAYS');

// ── the commitment period ────────────────────────────────────────────────
// A pre-commitment binds for at least this many hours. While a session is live
// and younger than this, a new pre-commit for the same guest is refused. Before
// 0.2.14 any pre-commit replaced a live session at once, so one call with a
// larger budget moved the line in the middle of play: the negotiation the
// Hard-Stop exists to rule out, available on the engine's own route. After the
// period a live session may be superseded as before, which is how the next
// day's budget is armed for a guest who never reached the previous line.
// 0 switches the lock off. That is an operator's setting, and it is stated as one.
function commitmentHours(key) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return 24;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 168) {
    throw new Error(`${key} must be a number of hours from 0 to 168, got "${raw}". Refusing to start.`);
  }
  return v;
}
const COMMITMENT_HOURS = commitmentHours('VIP_COMMITMENT_HOURS');

// Returns true when a determination taken at determined_at is too old to rely
// on. An absent timestamp is treated as expired when a lifetime is configured:
// an unknown age is not a young age.
function eligibilityExpired(determined_at, now) {
  if (determined_at == null) return ELIGIBILITY_TTL_DAYS !== null;
  const t = determinationTime(determined_at);
  const asOf = now === undefined ? Date.now() : now;
  if (!Number.isFinite(t) || t > asOf) return true;
  return ELIGIBILITY_TTL_DAYS !== null && (asOf - t) / 86400000 > ELIGIBILITY_TTL_DAYS;
}


// ── money in integer cents ────────────────────────────────────────────────
// Every decision that involves money is taken on INTEGER CENTS and every
// configured fraction is read as an integer number of millionths. Floating
// point is used only to display a ratio, never to decide one.
//
// The reason is concrete. A share computed as cents x 0.25 / 0.7000000000000001
// carries a rounding error, and in a largest-remainder split that error decides
// ties the rule says position must decide: measured on every amount from €0.01
// to €2,000.00, one settlement in thirty put a cent into a different venue than
// the rule. The same error let the published amount fall a cent below the stop
// line it named, so a guest could reach the published number and not be stopped.
// With integers both are exact: the split follows its stated rule to the cent,
// and armed_at_eur is the first cent at which the policy fires.
//
// Bounds: a configured fraction is read to six decimal places, and no amount
// above MAX_EUR is accepted, so every product below stays an exact integer.
const MICRO = 1000000;
const MAX_EUR = 10000000;                                 // €10,000,000 — see INVALID_BUDGET
const { cents, determinationTime } = require('./values');
const eur = c => Math.round(c) / 100;        // whole cents in: a stray fraction of a cent is rounded here, never carried
const micro = x => Math.round(x * MICRO);
const W = {
  threshold: micro(CFG.threshold), nudge: micro(CFG.nudge), escalate: micro(CFG.escalate),
  rollover: micro(CFG.rollover),
  spa: micro(CFG.split.spa), fnb: micro(CFG.split.fnb), retail: micro(CFG.split.retail)
};
if (W.nudge > W.escalate) {
  throw new Error('VIP_NUDGE must be at or below VIP_ESCALATE. Refusing to start.');
}
W.redirect = W.spa + W.fnb + W.retail;
if (W.rollover + W.redirect > MICRO) {
  throw new Error('rollover + redirect split exceeds the preserved budget. Refusing to start.');
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

// Display rounding for amounts that are sums of cents: two decimals.
const money = n => eur(cents(n));

// The first cent at or above `fraction` of a budget. The stop line, the nudge
// line and the escalation line are all this one computation, so the number the
// engine publishes and the number at which it acts cannot differ.
function lineCents(budget_c, fraction_micro) {
  return Math.ceil(budget_c * fraction_micro / MICRO);
}

// ── decisions ─────────────────────────────────────────────────────────────
// armedAt: the euro amount at which the policy fires. Published on the
// pre-commit response so the guest is told the number before the session, not
// at the moment it stops them.
function armedAt(budget_eur) { return eur(lineCents(cents(budget_eur), W.threshold)); }

// assess: what the engine thinks of a consumption level. Pure; no side effect.
// `fire` is mode-independent by design — the threshold is the same in both
// modes and only the ACTION differs (lock in hard_stop, host escalation in
// advisory). That is the canon rule "both modes run the same engine".
function assess(consumed_eur, budget_eur, mode, armed_at_eur = armedAt(budget_eur)) {
  const b = cents(budget_eur), c = cents(consumed_eur);
  const fire = c >= cents(armed_at_eur);
  return {
    fraction: budget_eur > 0 ? consumed_eur / budget_eur : 0,     // display only
    fire,
    nudge: mode === 'advisory' && c >= lineCents(b, W.nudge),
    escalate: mode === 'advisory' && c >= lineCents(b, W.escalate),
    locks: mode === 'hard_stop' && fire
  };
}

// settle: how a preserved budget is divided. The whole preserved amount is
// accounted for — redirect + rollover + residual — and the residual is the
// guest's own money, not operator capture.

// ── exact allocation ──────────────────────────────────────────────────────
// Money is split in CENTS, as integers, and the split is guaranteed to close.
//
// The old arithmetic computed each leg independently — redirect, rollover and
// residual each as a rounded percentage of the preserved budget — and three
// independent roundings do not add up. Measured across every amount from €0.01
// to €2,000.00, the three legs failed to sum to the preserved budget in about
// 52,205 of the 200,000 cases, one in four, by a cent either way. One cent is small; money
// that appears or disappears in a settlement is not, because an operator's
// reconciliation runs on exact equality and an operator's auditor tests it.
//
// allocate() uses the largest-remainder method on integers: every share is
// total x weight / sum-of-weights, floored; the leftover cents go one at a
// time to the largest remainders, ties broken by position. The weights are
// integer millionths and the remainders are compared as integers, so a tie is
// a tie and position decides it — exactly the rule, on every amount. The parts
// always sum to the whole, no part is ever negative, and a weight of zero
// receives nothing, so a jurisdiction that sets a share to zero gets zero there
// rather than an undefined amount.
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
  now ??= Date.now();
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

  if (REWARD_CAP_EUR !== null && eur(redirect + rollover) > REWARD_CAP_EUR) {
    capped = true;
    [redirect, rollover] = allocate(cents(REWARD_CAP_EUR, true), [W.redirect, W.rollover]);
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

// preview: what the guest is shown BEFORE stopping — the incentive that makes
// a chosen limit worth choosing. Same settle() maths on the currently
// unspent budget.
function preview(consumed_eur, budget_eur, eligibility, determined_at, now) {
  return settle(eur(Math.max(0, cents(budget_eur) - cents(consumed_eur))), eligibility, determined_at, now);
}

function distanceToThreshold(consumed_eur, budget_eur, armed_at_eur = armedAt(budget_eur)) {
  return eur(Math.max(0, cents(armed_at_eur) - cents(consumed_eur)));
}

// headroomCents: what is left to the stop line once every stake already checked
// is counted as if it were lost. A stake is accepted only if it fits inside
// this, so the line cannot be crossed while the platform asks before every
// stake. The line is the one armed at pre-commit and published to the guest;
// one computation serves the check, the state and the stop, so the number
// shown is the number enforced.
function headroomCents(armed_at_eur, consumed_eur, reserved_eur) {
  return Math.max(0, cents(armed_at_eur) - cents(consumed_eur) - cents(reserved_eur || 0));
}

// overshootCents: how far consumption went past the stop line. Zero while the
// platform asks before every stake and no wager consumes more than its check;
// above zero only when one of those did not hold, and then it is written into
// the stop, not hidden.
function overshootCents(armed_at_eur, consumed_eur) {
  return Math.max(0, cents(consumed_eur) - cents(armed_at_eur));
}

// exceedsStake: did a wager consume more than the stake it was checked for?
// Compared to the millionth of a euro, finer than any money this engine counts:
// an excess of a millionth or more is caught, while the binary noise of a
// client's own arithmetic (0.1 + 0.2 sent for a stake of 0.30) is not.
function exceedsStake(consumed_eur, stake_eur) {
  return Math.round(consumed_eur * MICRO) > Math.round(stake_eur * MICRO);
}

module.exports = {
  COMMITMENT_HOURS, headroomCents, overshootCents, exceedsStake,
  CFG, MODES, REDIRECT_TOTAL, RESIDUAL, num, MICRO, MAX_EUR, W, cents, eur, lineCents,
  ELIGIBILITY, ELIGIBILITY_DEFAULT, effectiveEligibility, REWARD_CAP_EUR, capEur,
  ELIGIBILITY_TTL_DAYS, ttlDays, eligibilityExpired, allocate,
  money, armedAt, assess, settle, preview, distanceToThreshold
};
