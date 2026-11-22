// Copyright (c) 2026 Miloš Petrović (Trench Logic Studio). SPDX-License-Identifier: MIT
// Used directly by the offline demos and by the SQLite service. Inputs are integer cents.
'use strict';
const VIPSettlement = (() => {
  const MICRO = 1000000;
  const defaultCap = 5000;
  const defaultSplit = Object.freeze({ spa: 0.30, fnb: 0.25, retail: 0.15 });
  const defaultRollover = 0.20;

  function weights(split, rollover) {
    const unit = value => Math.round(value * MICRO);
    const spa = unit(split.spa), fnb = unit(split.fnb), retail = unit(split.retail);
    const redirect = spa + fnb + retail, roll = unit(rollover);
    return { spa, fnb, retail, redirect, rollover: roll, residual: MICRO - redirect - roll };
  }

  // Largest remainders receive the spare cents. Input order settles exact ties.
  function allocate(total, parts) {
    const sum = parts.reduce((a, b) => a + b, 0);
    if (total <= 0 || sum === 0) return parts.map(() => 0);
    const raw = parts.map(weight => total * weight);
    const result = raw.map(n => Math.floor(n / sum));
    const order = raw.map((n, i) => ({ i, rem: n - result[i] * sum }))
      .sort((a, b) => b.rem - a.rem || a.i - b.i);
    const spare = total - result.reduce((a, b) => a + b, 0);
    for (let i = 0; i < spare; i++) result[order[i].i]++;
    return result;
  }

  function settleCents(total, w, cap, permitted) {
    let [redirect, rollover] = permitted ? allocate(total, [w.redirect, w.rollover, w.residual]) : [0, 0];
    const capped = cap !== null && redirect + rollover > cap;
    if (capped) [redirect, rollover] = allocate(cap, [w.redirect, w.rollover]);
    const [spa, fnb, retail] = allocate(redirect, [w.spa, w.fnb, w.retail]);
    return { preserved: total / 100, redirect: redirect / 100, rollover: rollover / 100,
      residual: (total - redirect - rollover) / 100, capped,
      credits: { spa: spa / 100, fnb: fnb / 100, retail: retail / 100 } };
  }

  // rollover: the future-play share; 0 when the operator switches future-play credit off,
  // in which case that share stays with the guest.
  function demoSettlement(preserved, resortPercent = 70, permitted = true, rollover = defaultRollover) {
    // Allocate the selected whole percentage across venues, preserving the exact total.
    const [spa, fnb, retail] = allocate(Math.round(resortPercent * MICRO / 100), [30, 25, 15]);
    const w = weights({ spa: spa / MICRO, fnb: fnb / MICRO, retail: retail / MICRO }, rollover);
    return settleCents(Math.round(preserved * 100), w, defaultCap * 100, permitted);
  }
  return { allocate, weights, settleCents, demoSettlement, defaultCap, defaultSplit, defaultRollover };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = VIPSettlement;
