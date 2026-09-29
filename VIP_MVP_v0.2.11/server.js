// VIP SmartContract · MVP v0.2.11 · entry
// AS-IS evaluation artifact — 09_AS_IS_Notice of the VIP SmartContract package governs.
'use strict';
// A configuration the build refuses is reported as one sentence and exit code
// 1 — what is wrong and what was found — not as a stack trace that buries the
// sentence under the modules that were loading when it was thrown.
let open, migrate, DB_PATH, seed, createServer, ADMIN_TOKEN, downstream, P, VERSION, p;
try {
  ({ open, migrate, DB_PATH } = require('./src/store'));
  ({ seed } = require('./src/seed'));
  ({ createServer, ADMIN_TOKEN } = require('./src/web'));
  ({ downstream } = require('./src/boundary'));
  P = require('./src/policy');
  VERSION = require('./package.json').version;
  // The port is validated by the same rule as every threshold, and before any
  // database is opened: a refused value leaves nothing behind on disk.
  p = P.num('PORT', 3400, 1, 65535);
  if (!Number.isInteger(p)) {
    throw new Error(`PORT must be a whole number in [1, 65535], got "${process.env.PORT}". Refusing to start.`);
  }
} catch (e) {
  console.error('\n  VIP MVP cannot start: ' + e.message + '\n');
  process.exit(1);
}

const db = open();
// A database written by an earlier build lacks columns this one reads. Running
// the migration at startup is what makes the documented upgrade path real
// rather than a claim: without it, an evaluator upgrading in place gets
// undefined where a suppression or a determination date should be.
migrate(db);
const fresh = seed(db);

createServer(db).listen(p, () => {
  console.log('──────────────────────────────────────────────────────');
  console.log(` VIP SMARTCONTRACT · MVP v${VERSION} · evaluation instance`);
  console.log(` db          ${DB_PATH}${fresh ? '  (freshly seeded)' : ''}`);
  // percentages printed from the integer millionths the engine decides on
  const pct = m => `${m / 10000}%`;
  console.log(` policy      mode ${P.CFG.mode} · stop ${pct(P.W.threshold)} · nudge ${pct(P.W.nudge)}` +
              ` · escalate ${pct(P.W.escalate)}`);
  console.log(` settlement  redirect ${pct(P.W.redirect)} · rollover ${pct(P.W.rollover)}` +
              ` · residual to guest ${pct(P.W.residual)}`);
  console.log(` downstream  ${downstream.armed() ? 'ARMED → ' + downstream.url : 'DORMANT (Path 2 off — set VIP_DOWNSTREAM_URL + VIP_DOWNSTREAM_KEY)'}`);
  console.log(` guest       http://localhost:${p}/`);
  console.log(` host        http://localhost:${p}/host`);
  console.log(` admin       http://localhost:${p}/admin?token=${ADMIN_TOKEN}`);
  if (ADMIN_TOKEN === 'evaluation-only') console.log('             default token — evaluation auth, never production');
  console.log(' SOLD AS-IS · SYNTHETIC BY DECLARATION · Trench Logic Studio');
  console.log('──────────────────────────────────────────────────────');
});
