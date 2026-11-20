# VIP SmartContract — Compliance-as-Revenue Layer

**A policy engine that turns a responsible-gambling limit into a revenue event.**
The guest pre-commits a budget. The engine watches the session. At the threshold it
stops gaming and converts the preserved budget into non-gaming spend, rollover
credit and a residual returned to the guest — every decision hash-chained.

Middleware: funds never go on chain, rules stay off chain, only proofs are anchored.

Open source under the [MIT License](LICENSE). This is package **v3.21**; the runnable
build is **VIP MVP v0.2.15** in [`13_VIP_MVP`](13_VIP_MVP). Every figure in the
package is synthetic and labelled as such: no live deployment has occurred and no
pilot data exists.

---

## Run it — no dependencies

Node.js 22.13 or newer on the 22 line, or Node.js 24 or later. No `npm install`, no
build step, no network access.

```bash
npm start
```

Open **http://localhost:3400**. The server listens on the loopback interface only.
`cd 13_VIP_MVP && node server.js` does the same, and `npm run reference` starts the
in-memory reference service of slot 04b on port 8080.

### What to do on the screen

1. **Arm a policy.** Pick a guest and commit a budget. The console prints the euro
   amount at which the policy will fire — before the session, not at the stop.
2. **Run the session.** Press **Check, then report**: the wager path a platform
   should run. The engine is asked before each stake, reserves it against what is
   left to the line, and the console shows the largest stake allowed now. The
   **Report only** buttons report consumption after the fact instead.
3. **Reach the line.** A checked stake that would pass the line is refused with
   **409 STAKE_EXCEEDS_HEADROOM** and the amount that would still fit, so checked
   stakes lock the session exactly on the line. A reported tick that crosses it is
   counted in full, and the stop says how far past the line it went
   (`overshoot_eur`). In Hard-Stop mode the lock returns **423 Locked** — a state,
   not an error — and the session settles: 70% of the preserved budget as resort
   credit (spa 30 · F&B 25 · retail 15), 20% as next-visit rollover, 10% back to
   the guest, to the cent.
4. **Issue settled credits.** With a budget of €1,000 and one checked stake of
   €500, the guest receives €150 spa credit, €125 dining credit, €75 retail
   credit, €100 rollover and €50 residual.
5. **`/host`** — the host console: live sessions, distance to threshold, issued
   credit per guest, redemption.
6. **`/admin?token=evaluation-only`** — the quarter roll-up with its denominators,
   the canon figures kept visibly separate, chain verification from genesis to
   head, erasure and the running configuration. Set `VIP_ADMIN_TOKEN` for anything
   but a local evaluation.

A pre-commitment binds: while a session is live and younger than
`VIP_COMMITMENT_HOURS` (24 by default), a new pre-commit for the same guest is
refused with **409 SESSION_LIVE**. Every setting is listed in
[`13_VIP_MVP/.env.example`](13_VIP_MVP/.env.example).

### Then break it

```bash
npm test
```

308 checks and 41 regression scenarios, none skipped. Among them: the settlement
closes to the cent on every amount from €0.01 to €2,000.00, and the split is
recomputed independently on every one of them; every stop, nudge and escalation
line is checked on every budget in the same range; twelve stakes of €300 sent at
once against a €1,000 line let exactly three through; a seeded run of 2,000
sessions with every stake checked never once passes the line; the hash chain is
corrupted on purpose and must break at exactly the altered row; malformed and
hostile input must be answered with its error identifier, never a server error;
an erased name must be gone from the database file itself; bad configurations
are fed to the build in child processes and every one must refuse to start.

The parity block runs the MVP and the in-memory reference of slot 04b on the same
inputs: both must produce the same armed amount, fire on the same tick and settle
to the same cent, including the inputs both must **refuse**. Copied out of the
repository, `13_VIP_MVP` runs on its own and reports that block as skipped rather
than passing it silently.

### No Node on this machine?

Open [`05a_Demo_A_Screens.html`](05a_Demo_A_Screens.html),
[`05b_Demo_B_Policy_Engine.html`](05b_Demo_B_Policy_Engine.html),
[`05c_Demo_C_Synthetic_Case_Study.html`](05c_Demo_C_Synthetic_Case_Study.html) or
[`05d_Demo_D_Narrative_Proof.html`](05d_Demo_D_Narrative_Proof.html) in a browser.
They need nothing installed, and `05b` runs the engine's rule in the page: every
stake is checked before the hand is dealt, so the stop lands on the line, and the
preserved budget is settled in integer cents with the same allocation as the
reference implementation.

---

## What you are looking at

| | |
|---|---|
| **The problem** | A limit imposed is churn. A limit chosen is loyalty. Operators lose high-value guests at the moment protection kicks in, because the moment feels like punishment. |
| **The inversion** | The guest sets the budget and the host witnesses. At the stop the guest is *paid* for stopping — rollover toward the next visit, resort credit for tonight. |
| **The boundary** | The engine forms no view of risk and holds no harm model. It consumes the operator's responsible-gaming determination and records that it honoured it. |
| **The proof** | Every decision — including every refusal to reward — is a link in a SHA-256 chain. A regulator asking the system to prove itself needs the occasions it said no, and an absent row proves nothing. |

## What this is not

This is **not a responsible-gaming risk system**. It forms no view of any guest and
holds no harm model: it consumes a determination the operator has already made —
by its own analytics, a detection vendor, a host's judgement or a register feed —
and records that it honoured it.

It is **not a CRM, a bonus engine or a player-account platform**, and it does not
replace one. What it does is narrower: it governs the **handoff** between a
responsible-gaming decision and the settlement of the incentive economics that
decision touches. When the policy says stop, the preserved budget does not become
more play and does not quietly disappear — it settles, deterministically, to the
cent, into resort credit, a next-visit rollover and the guest's own residual, with
every refusal to reward recorded as carefully as every reward.

---

## The repository

The package keeps its registry order. Slots 02, 06–09 and 11 held the commercial
and legal set, which is not part of the open-source release; the other slots keep
their numbers so every reference to them stays valid.

| Slot | What it is |
|---|---|
| [`00_INDEX.html`](00_INDEX.html) | The registry, with a reading path per role |
| [`01_Executive_Brief.docx`](01_Executive_Brief.docx) | The 90-second frame, with the scope and patent note |
| [`03a`](03a_Mode_Hard_Stop.docx) · [`03b`](03b_Mode_Advisory.docx) | The two operating modes: Hard-Stop, Advisory |
| [`04_API_Spec.yaml`](04_API_Spec.yaml) · [`04b_Integration_Reference.js`](04b_Integration_Reference.js) · [`04c_docker-compose.yml`](04c_docker-compose.yml) | The contract, the in-memory reference implementation, the compose stack |
| [`05_Demo_Guide.html`](05_Demo_Guide.html) → `05a`–`05d` | The demo guide and the four browser demos |
| [`10_Design_Rationale.docx`](10_Design_Rationale.docx) | The variants considered, and why the shipped shape won |
| [`12_Canon.json`](12_Canon.json) | Every fixed value, threshold, split and definition, with the formula beside each derived figure |
| [`13_VIP_MVP/`](13_VIP_MVP) | The runnable build: SQLite ledger, guest, host and admin consoles, eight contract routes |
| [`14_Regulatory_Parameter_Map.html`](14_Regulatory_Parameter_Map.html) | Which lever answers which regulatory question |
| [`15_Security_and_Boundaries.html`](15_Security_and_Boundaries.html) | What is implemented and verified, and what is deliberately the integrator's |
| [`CHANGELOG.md`](CHANGELOG.md) · [`docs/FIXES.md`](docs/FIXES.md) | What changed in each release, and the record of the corrections with their regression tests |

**The canon is the project.** Every document, every demo and both implementations
resolve in `12_Canon.json`. If a document and the canon disagree, the canon is
right. Every figure is labelled `ANCHORED` — a modelled assumption with its band —
or `DERIVED`, with the formula and the inputs it comes from. Exactly one figure in
the package is empirical, and the canon says which.

---

## Status and limits

All performance figures are synthetic model outputs, declared as such at the point
of use. [`15_Security_and_Boundaries.html`](15_Security_and_Boundaries.html) states
what is deliberately absent: authentication, authorisation, transport security,
durability and scale are **not** in scope — and neither is your wager path: the
line holds where your platform checks each stake with the engine before accepting
it, and the admin token of the evaluation build is auth for an evaluation, not for
a property.

Whether any configuration is lawful in any jurisdiction, and whether a deployment
requires certification or regulatory approval, is the deployer's determination to
make with their own counsel and regulator. This is not legal advice.

On-chain management and enforcement of responsible-gaming limits is a
patent-encumbered space. This design stays out of it on purpose — funds and rules
off chain, only proofs anchored — and the reasoning is in `10_Design_Rationale.docx`.
The MIT License grants no rights under anyone else's patents: a freedom-to-operate
review is recommended before any deployment, as `01_Executive_Brief.docx` says.

## Responsible gambling

This architecture exists because stopping should not cost a guest anything, and it
is built so that the reward can never attach to playing more. If gambling is
causing harm to you or someone close to you, the operator's own
responsible-gambling service and your national helpline are the right first call —
not a policy engine.

## License

[MIT](LICENSE) — Copyright (c) 2026 Miloš Petrović (Trench Logic Studio). Provided as
is, without warranty, support or maintenance commitments.

**Trench Logic Studio** — Miloš Petrović · milos@trench-logic.com · trenchlogicstudio.com
