// VIP SmartContract · MVP v0.2.11 · seed
// AS-IS evaluation artifact — 09_AS_IS_Notice of the VIP SmartContract package governs.
//
// SYNTHETIC BY DECLARATION. Nothing here is a measurement of any operator.
//
// The seed reproduces the canon reference quarter — 60 limited VIPs, €5,100
// preserved each — and it does so by REPLAYING the real engine: every seeded
// row is written by the same precommit / tick / redirect path a buyer
// exercises from the API. There is no fixture table and no hard-coded total,
// so the quarter roll-up in the console is computed from rows the engine
// produced, not from a constant that could drift away from the code.
//
// Two figures below are stated rather than derived, and both are labelled:
//   limited_vips_per_quarter = 60      ANCHORED (canon model_figures)
//   preserved_per_vip_eur    = 5100    ANCHORED (canon model_figures)
// The session budget follows from them and from the canon threshold:
//   budget = preserved / (1 - hard_stop_fraction) = 5100 / 0.50 = 10200
// which is the smallest budget consistent with both. It is DERIVED, not chosen.
'use strict';
const P = require('./policy');
const E = require('./engine');

const LIMITED_VIPS = 60;          // ANCHORED — canon model_figures.limited_vips_per_quarter
const PRESERVED_PER_VIP = 5100;   // ANCHORED — canon model_figures.preserved_per_vip_eur

// Three live Advisory sessions so the host console has something to show
// before the evaluator types anything. They sit OUTSIDE the quarter roll-up:
// the quarter counts stopped sessions only, and its denominator says so.
const LIVE_DEMO = [
  { id: 'VIP-D01', budget: 8000, consumed: 2400 },  // below the nudge line
  { id: 'VIP-D02', budget: 8000, consumed: 3600 },  // past the nudge, below the threshold
  { id: 'VIP-D03', budget: 8000, consumed: 7000 }   // past the escalation line
];

function seed(db) {
  const already = db.prepare('SELECT COUNT(*) n FROM guests').get().n;
  if (already > 0) return false;

  // budget is DERIVED from the two anchored figures and the canon threshold.
  const budget = P.money(PRESERVED_PER_VIP / (1 - P.CFG.threshold));

  for (let i = 1; i <= LIMITED_VIPS; i++) {
    const vip_id = 'VIP-' + String(i).padStart(4, '0');
    db.prepare('INSERT INTO guests(id, display_name, tier, created_at) VALUES(?,?,?,?)')
      .run(vip_id, 'Synthetic Guest ' + String(i).padStart(3, '0'), 'unclassified', new Date().toISOString());
    E.precommit(db, { vip_id, budget_eur: budget, mode: 'hard_stop' });
    // One tick of exactly the published stop line, armed_at_eur, which is the
    // first cent at which the policy fires. At the canon threshold that is
    // budget x 0.50, so preserved = budget - consumed = PRESERVED_PER_VIP by
    // construction. Ticking a separately computed product instead could land a
    // cent short of the line under another configured threshold, and the seed
    // then failed at startup with NOT_STOPPED.
    const stop = E.tick(db, { vip_id, delta_eur: P.armedAt(budget) });
    // A settlement the gate withholds — a jurisdiction-wide suppression, or a
    // determination lifetime the seed's sessions do not carry a date for —
    // still stops and preserves; it issues nothing, so nothing is redirected.
    if (stop.eligibility !== 'suppressed') E.redirectIssue(db, { vip_id });
    db.prepare("UPDATE sessions SET quarter = 1 WHERE guest_id = ?").run(vip_id);
  }

  for (const d of LIVE_DEMO) {
    db.prepare('INSERT INTO guests(id, display_name, tier, created_at) VALUES(?,?,?,?)')
      .run(d.id, 'Synthetic Guest ' + d.id.slice(-3), 'unclassified', new Date().toISOString());
    E.precommit(db, { vip_id: d.id, budget_eur: d.budget, mode: 'advisory' });
    E.tick(db, { vip_id: d.id, delta_eur: d.consumed });
  }

  return true;
}

module.exports = { seed, LIMITED_VIPS, PRESERVED_PER_VIP, LIVE_DEMO };
