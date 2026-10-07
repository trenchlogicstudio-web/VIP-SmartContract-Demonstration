# VIP SmartContract — Compliance-as-Revenue Layer

> **Try it in your browser, nothing to install:** [Demo B, the policy engine](https://trenchlogicstudio-web.github.io/VIP-SmartContract-Demonstration/VIP_SmartContract_v3.17_Demonstration/05b_Demo_B_Policy_Engine.html) · [All four demos](https://trenchlogicstudio-web.github.io/VIP-SmartContract-Demonstration/VIP_SmartContract_v3.17_Demonstration/05_Demo_Guide.html)

**A policy engine that turns a responsible-gambling limit into a revenue event.**
The guest pre-commits a budget. The engine watches the session. At the threshold it
stops gaming and converts the preserved budget into non-gaming spend, rollover
credit and a residual returned to the guest — every decision hash-chained.

Middleware: funds never go on chain, rules stay off chain, only proofs are anchored.

| Folder | What it is |
|---|---|
| `VIP_MVP_v0.2.11` | **The runnable build. Start here.** |
| `VIP_SmartContract_v3.17_Demonstration` | The package it belongs to — every document, demo and specification |

---

## Run it — 30 seconds, no dependencies

Node 22.13 or newer. No `npm install`, no build step, no network access.

```bash
cd VIP_MVP_v0.2.11
node server.js
```

Open **http://localhost:3400**.

### What to do on the screen

1. **Arm a policy.** Pick a guest, commit a budget. The console prints the euro
   amount at which the policy will fire — before the session, not at the stop.
2. **Run the session.** Press the tick buttons and watch the meter walk toward the
   line. The console shows what stopping right now would be worth at every point —
   redirect, rollover and the guest's own residual, priced on the budget still
   unspent. In Advisory mode the same crossing raises a nudge at 40% of the
   pre-committed budget and escalates to the host at 85%; Hard-Stop shows the
   preview and enforces.
3. **Cross the line.** In Hard-Stop mode the crossing returns **423 Locked** — a
   state, not an error — and the session settles at once: 70% of the preserved
   budget as resort credit (spa 30 · F&B 25 · retail 15), 20% as next-visit
   rollover, 10% back to the guest. The three legs close on the preserved budget
   to the cent, and the amount printed in step 1 is the first cent at which the
   engine fires.
4. **`/host`** — the host console: live sessions, distance to threshold, issued
   credit per guest, redemption.
5. **`/admin?token=evaluation-only`** — the quarter roll-up with its denominators,
   the canon figures kept visibly separate, chain verification from genesis to
   head, erasure, and the running configuration.

### Then break it

```bash
node test.js
```

283 checks here. Among them: the settlement is asserted to close **to the cent** on
every amount from €0.01 to €2,000.00 rather than on a sample, and the split is
recomputed independently on every one of those amounts to prove it follows its
stated rule; every stop, nudge and escalation line is checked on every budget in
the same range; the hash chain is deliberately corrupted and must break at exactly
the altered row; malformed and hostile input must be answered with its error
identifier, never a server error; an erased name must be gone from the database
file itself; fourteen bad configurations are fed to the build in child processes
and every one must refuse to start rather than degrade the gate.

One block is skipped here, and the suite prints the skip rather than passing it
silently: parity against the in-memory reference implementation,
`04b_Integration_Reference.js`, which sits beside the MVP inside the package. Run
the same command in `VIP_SmartContract_v3.17_Demonstration/13_VIP_MVP` and it runs
— 308 checks. Both builds must produce the same armed amount, fire on the same
tick and settle to the same cent, including the inputs both must **refuse**,
because two builds that agree on every valid call can still disagree on what they
reject.

### No Node on this machine?

Open `05a_Demo_A_Screens.html`, `05b_Demo_B_Policy_Engine.html`,
`05c_Demo_C_Synthetic_Case_Study.html` or `05d_Demo_D_Narrative_Proof.html` from
`VIP_SmartContract_v3.17_Demonstration` in a browser. They need nothing installed,
and `05b` runs the engine's rule in the page: consumption only goes up, the stop
fires at the line, and the preserved budget is settled in integer cents with the
same allocation as the reference implementation.

---

## What you are looking at

| | |
|---|---|
| **The problem** | A limit imposed is churn. A limit chosen is loyalty. Operators lose high-value guests at the moment protection kicks in, because the moment feels like punishment. |
| **The inversion** | The guest sets the budget and the host witnesses. At the stop the guest is *paid* for stopping — rollover toward the next visit, resort credit for tonight. |
| **The boundary** | The engine forms no view of risk and holds no harm model. It consumes the operator's responsible-gaming determination and records that it honoured it. |
| **The proof** | Every decision — including every refusal to reward — is a link in a SHA-256 chain. A regulator asking the system to prove itself needs the occasions it said no, and an absent row proves nothing. |

---

## What this is not

This is **not a responsible-gaming risk system**. It forms no view of any guest and
holds no harm model: it consumes a determination the operator has already made —
by its own analytics, a detection vendor, a host's judgement or a register feed —
and records that it honoured it.

It is **not a CRM, a bonus engine or a player-account platform**, and it does not
replace one. Limits, eligibility, promotional suppression, budget caps and audit
trails all exist in the market today, inside wallets, platform stacks, CRM suites
and detection products, and this layer is built to sit beside them rather than
in their place.

What it does is narrower, and it is the whole point: it governs the **handoff**
between a responsible-gaming decision and the settlement of the incentive
economics that decision touches. When the policy says stop, the preserved budget
does not become more play and does not quietly disappear — it settles,
deterministically, to the cent, into resort credit, a next-visit rollover and the
guest's own residual, with every refusal to reward recorded as carefully as every
reward.

---

## The package

`VIP_SmartContract_v3.17_Demonstration` holds the package in registry order, slots
00 to 15. Slot 13, `13_VIP_MVP`, is the build in `VIP_MVP_v0.2.11`, byte for byte.

| Slot | What it is |
|---|---|
| `00_INDEX.html` | The registry, with a reading path per role |
| `01_Executive_Brief.docx` | The 90-second frame |
| `03a` · `03b` | The two operating modes: Hard-Stop, Advisory |
| `04_API_Spec.yaml` · `04b_Integration_Reference.js` · `04c_docker-compose.yml` | The contract, the reference implementation, the compose stack |
| `05` → `05a`–`05d` | The demo guide and the four browser demos |
| `11_Competitive_Battlecard.html` | Named competitor classes, and the patent landscape stated first |
| `12_Canon.json` | Every fixed value, threshold, split and definition, with the formula beside each derived figure |
| `14_Regulatory_Parameter_Map.html` | Which lever answers which regulatory question |
| `15_Security_and_Boundaries.html` | What is implemented and verified, and what is deliberately the integrator's |

**The canon is the project.** Every document, every demo and both implementations
resolve in `12_Canon.json`. If a document and the canon disagree, the canon is
right. Every figure is labelled `ANCHORED` — a modelled assumption with its band —
or `DERIVED`, with the formula and the inputs it comes from. Exactly one figure in
the package is empirical, and the canon says which.

---

## AS-IS

Published strictly as-is: no warranties, no implementation services, no support, no
ongoing involvement. All performance figures are synthetic model outputs, declared
as such at the point of use — **no live deployment has occurred** and no pilot data
exists. `15_Security_and_Boundaries.html` states what is deliberately absent:
authentication, authorisation, transport security, event idempotency, durability
and scale are **not** in scope, and the admin token in the evaluation build is auth
for an evaluation, not for a property.

Whether any configuration is lawful in any jurisdiction, and whether a deployment
requires certification or regulatory approval, is the reader's determination to
make with their own counsel and regulator. Trench Logic Studio gives no legal
advice.

## The one exception

This is the public demonstration of VIP SmartContract v3.17; it carries no
commercial terms and no transaction figures, so the content of
`06b_Pricing_Model.docx`, `08_LOI_Template.docx`,
`08b_License_Agreement_Template.docx` and `08d_NDA_Template.docx`, and the pricing
section of `12_Canon.json`, are not included here. Every other file is the package
as it stands.

## Responsible gambling

This architecture exists because stopping should not cost a guest anything, and it
is built so that the reward can never attach to playing more. If gambling is
causing harm to you or someone close to you, the operator's own
responsible-gambling service and your national helpline are the right first call —
not a policy engine.

---

**Trench Logic Studio** — Miloš Petrović
milos@trench-logic.com · trenchlogicstudio.com
