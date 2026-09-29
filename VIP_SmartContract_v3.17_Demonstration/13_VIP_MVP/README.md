# VIP SmartContract · MVP v0.2.11

A runnable evaluation build of the pre-commitment policy engine: the guest
commits a budget, the engine watches the session, and at the threshold it
stops gaming and converts the preserved budget into non-gaming spend, rollover
credit and a residual returned to the guest — with every decision hash-chained.

AS-IS evaluation artifact. `09_AS_IS_Notice.txt` of the VIP SmartContract
package governs: no warranties, no implementation services, no support, no
ongoing involvement. Every guest, session and euro amount below is **synthetic
by declaration** and reproduces the reference preset recorded in the package
canon. It is not a measurement of any operator, and no live deployment has
occurred.

## Quick start

```
node --version        # must be 22.13.0 or newer
npm start             # http://localhost:3400
npm test              # the suite
npm run reset         # delete the database; it reseeds on the next start
```

No `npm install`. No dependencies, no build step, no compilation. Storage is
the built-in `node:sqlite`.

**Why 22.13.0 and not 22.5.0.** `node:sqlite` was added in 22.5.0 but sat
behind `--experimental-sqlite` until 22.13.0 (23.4.0 on the 23 line), so
22.13.0 is the true floor for an unflagged start. On 22.5–22.12 the build runs
with `node --experimental-sqlite server.js`. On anything older it stops with a
message naming what is needed and what is running, rather than a stack trace.
Node 22 prints an ExperimentalWarning about SQLite on startup; that warning is
expected and is not a fault of this build.

## Three screens

| | |
|---|---|
| `/` | **Guest.** Arm a policy, run session ticks, watch the meter, see what stopping now is worth, stop voluntarily. |
| `/host` | **Host console.** Live sessions with distance to threshold and the advisory signals; issued credit per guest, with redemption. |
| `/admin?token=…` | **Admin.** The quarter roll-up with denominators, the canon comparison figures kept visibly separate, chain verification, erasure, running configuration. |

The admin token defaults to `evaluation-only`. Change it with
`VIP_ADMIN_TOKEN` even for a demo.

## The loop, in one paragraph

`POST /v3/precommit` arms a budget and publishes the euro amount at which the
policy fires, so the guest knows the number before the session rather than at
the stop. `POST /v3/session/tick` moves consumption. In **Hard-Stop** mode the
crossing returns **423 Locked** — a state, not an error; the stop is the
product working — and the session settles at once. In **Advisory** mode the
same crossing nudges at four tenths of budget, escalates to the host at
eighty-five hundredths of it, and never locks; the guest can stop voluntarily, and
that stop settles through the identical code path. Settlement divides the
preserved budget: seven tenths as resort credit split spa / F&B / retail, one
fifth as rollover toward a future session, one tenth returned to the guest.
`POST /v3/redirect/issue` issues the credit instruments, and
`GET /v3/audit/{session_id}` returns the chain for that session.

## What to look at first

1. **The money closes, and follows its rule.** On any stop, redirect +
   rollover + residual equals preserved budget exactly. The residual is named
   and returned rather than quietly absorbed — a model that does not close
   invites the buyer to find the gap first. Every amount is decided in integer
   cents: the split goes by largest remainder with a tie to the earlier
   position, and the stop line the pre-commit publishes is the first cent at
   which the engine fires. Both are recomputed independently by the suite on
   every amount from €0.01 to €2,000.00.
2. **The quarter reproduces the canon.** `/admin` shows €306,000 preserved,
   €214,200 redirected, €61,200 rollover liability, €30,600 returned, capture
   0.70 of the preserved budget. Those figures are **computed from the seeded rows**, not read from a
   constant: the seed replays the real engine sixty times, once per limited VIP,
   on the canon's €5,100 preserved per VIP, so the console and the code cannot
   drift apart.
3. **Issuance is not revenue.** The console keeps credit *issued* and credit
   *redeemed* in separate columns. Redemption is where preserved gaming budget
   becomes non-gaming revenue; before that it is a liability.
4. **The chain notices.** `/admin` verifies from genesis to head. The suite
   mutates a row on purpose and asserts the chain breaks at exactly that row —
   without that check, "hash-chained" is decoration.
5. **Erasure does not damage the chain, and it reaches the disk.** The
   display name is the only field that names a person, and it never entered a
   payload: the chain carries the opaque `vip_id` your platform assigns.
   Erasure removes the name from the database file and its write-ahead log,
   not only from the API, and the suite reads both as bytes to prove it.
   Whether rows keyed to the `vip_id` must go too is your jurisdiction's call.
6. **A bad threshold stops the process, and a good one starts it.**
   `VIP_THRESHOLD=abc`, `-1`, `NaN`, or a rollover that would exceed the
   preserved budget: the build refuses to start, in one sentence and with exit
   code 1. `x > NaN` is false in JavaScript, so a non-finite threshold would
   otherwise turn the limit into a gate that admits everything. Every value the
   validation accepts — every redirect share at zero, a threshold at its
   bound, a jurisdiction-wide suppression, a determination lifetime — starts,
   seeds and serves.

## Configuration

Every threshold is a per-jurisdiction configurable, not a constant — including
each of the three redirect shares, which a regulator that caps F&B credit or
bars retail vouchers will move. See `.env.example`; every value resolves in
`CANON.json`.

## Documented divergences

Four places where this build is deliberately not identical to the shipped
reference `04b_Integration_Reference.js`. All four are recorded rather than
silent, and none of them changes an amount:

1. **A superseding pre-commit is kept, not dropped.** The reference replaces
   its in-memory entry when a second pre-commit arrives for a live session, so
   the earlier session becomes unreachable. Here the earlier session is closed
   and stays in the record, and the audit chain keeps both. Observable
   behaviour on `/v3` is the same.
2. **A guest record is created on first sight.** The reference arms a policy
   for any `vip_id` string. This build does the same and writes a guest row
   with no name attached, so the same call cannot fail on a foreign
   key that the specification never mentions.
3. **This build writes its own events.** The reference emits the five events
   the package canon fixes. This build emits those five and five more —
   `advisory.nudge`, `advisory.escalate`, `credit.redeem`, `rollover.apply`
   and `guest.erase` — which `CANON.json` scopes to this build alone. The
   difference is visible on `/v3/audit/{session_id}`: in Advisory mode the
   chain here carries the nudge and the escalation, and the reference's chain
   does not.
4. **The audit payloads are this build's own.** Beyond the events of the third
   divergence, `GET /v3/audit/{session_id}` returns the same event types in the
   same order in both, but the fields inside each event are each
   implementation's own record: here amounts carry an `_eur` suffix and
   `policy.stop` names the redirect leg, where the reference writes `consumed`,
   `preserved`, `rollover` and `credits` — so the chain value differs with them.
   A request outside `/v3` that matches nothing is answered `NO_ROUTE` here with
   `spec_routes`, where the reference names the same list `routes`. Read
   amounts from the tick and state responses, which are identical in both.

Amounts, status codes and error identifiers are identical in both.

The PARITY block of `test.js` covers the arithmetic the two share: armed
amount, the tick that fires, preserved, rollover, residual and every credit
line — on every amount from €0.01 to €2,000.00 — and what both must refuse: a
negative delta, a budget above €10,000,000, a `vip_id` that is not a string,
and an issue for a guest suppressed after the stop.
It runs when the reference sits beside this build — as it does inside
the package registry — and prints a declared skip when it does not, never a
silent pass.

## The suite

```
npm test
```

308 checks inside the package registry, 283 with one declared skip standalone — the parity
block needs the shipped reference beside it.
Contract routes, a negative case for every error identifier, both modes, every
line on its own cent, the bounds of the budget and the tick, malformed and
hostile input, the money chain end to end with the settlement rule recomputed
on every amount, chain tamper detection, erasure down to the bytes on disk, the
dormant and the armed downstream, fourteen configuration refusals and seven
accepted boundary values probed in child processes, the whole server started
under five configurations the validation accepts, and reference parity. The
suite is the checklist a buyer ports before porting the code.

## Files

```
server.js          entry and boot banner
src/policy.js      the decision itself — no storage; the clock only if no time is given
src/engine.js      persistent session operations over the policy core
src/store.js       schema and the guarded node:sqlite import
src/boundary.js    hash chain, dormant downstream, erasure
src/web.js         /v3 contract surface, /vip product surface, the console
src/seed.js        the reference quarter, replayed through the real engine
test.js            the suite
CANON.json         every fixed value in this build
INTEGRATION.md     Path 2 event contract and the specification mapping
```

## Changelog

**v0.2.11** — money is decided in integer cents and every configured fraction in
integer millionths, as in the shipped reference. The split follows its stated
rule on every amount — the previous build put a cent into a different venue on
6,553 of the 200,000 amounts from €0.01 to €2,000.00 — and the published stop
line is the enforced one; on 4,588 of the same 200,000 budgets the engine had
fired one cent later than the amount the pre-commit published. A budget runs
from €0.01 to €10,000,000, a tick up to €10,000,000. Malformed input that
answered 500 now answers its identifier: a `vip_id` that is not a string, a
body that parses to anything but an object, a `session_id` that is not valid
percent-encoding; a `credit_id` of `true` no longer redeems credit 1. A budget
is taken to the nearest cent on arrival and consumption is read in whole cents
from its exact total, so a tick carrying a fraction of a cent can no longer make
consumed and preserved add up to a cent more than the budget, and ticks below a
cent still add up. A suppressed guest can neither redeem a credit nor apply a
rollover, whatever the reason for the suppression; a suppression that lands on
a stopped, unissued settlement, and a determination that lapses between the
stop and the issue call, each write that refusal to the chain once. A pre-commit that sends no determination date is
recorded without one, so a configured lifetime treats it as expired. The host
console escapes every string it prints, so a `vip_id` armed as markup is shown
as text rather than run. Erasure reaches the database file and its write-ahead
log. Every configuration the validation accepts starts, including a
determination lifetime the seeded sessions carry no date for; a refused one — a
port that is not a whole number included — is reported in one sentence before
any database exists; and the
version in the pages, the banner and the downstream source is read from
`package.json` — the source had still said 0.2.9. The fourth documented
divergence names the audit payloads and the `NO_ROUTE` body outside `/v3`. The
suite grows from 139 checks to 308 and is measured by mutation: each comparison,
boolean, rounding call and error guard in `src/` outside the HTML page
templates is broken one at a time, and the suite fails on every one except a
single mutant that returns the same result as the original on every input. No
threshold, split or figure changed value. The parent pointer follows the
package to v3.17.


**v0.2.10** — the release note names the third place where this build differs
from the shipped reference: it writes its own five events beside the five the
package canon fixes, and the audit chain shows them in Advisory mode. The note
on the seeded quarter states the preserved budget per VIP that the seed
replays. No behaviour, threshold, split or figure changed. The parent pointer
follows the package to v3.16.


**v0.2.9** — no change to this build's behaviour. The files that count the
contract surface — `INTEGRATION.md`, the comments in `src/web.js` and
`src/engine.js`, and the contract section of the suite — say six `/v3` routes,
which is what this build serves and what `04_API_Spec.yaml` declares. The
number of configuration refusals above is the number the suite runs. The parent
pointer follows the package to v3.15.


**v0.2.8** — no change to this build's behaviour. The release notes above state
what each edition defines, which is what a note that ships to a buyer is for. The
parent pointer follows the package to v3.14.


**v0.2.7** — the guest screen no longer offers a "-500 (win)" button. It sent a
negative delta, which the engine refuses, so pressing it answered 400
INVALID_DELTA. The suite now reads every page this build serves and fails on any
control that would send a negative tick. The parent pointer follows the package
to v3.13. Two comments in this build that record when a fix landed had
been rewritten to name a later version by the bump to v0.2.6; both name v0.2.5
again, which is when the fixes were made.


**v0.2.6** — no change to this build's behaviour. The parent pointer follows the
package to v3.12, whose legal set states the mechanism it transfers: the
eligibility gate, programme suppression, the determination lifetime and the reward
cap, and every slot in the registry the buyer receives. The number moves because
the contents moved; two archives must never share a name.


**v0.2.5** — `GUEST_UNKNOWN` and `ALREADY_ERASED` return the 404 and 409 the canon
declares; they were raised as bare errors and surfaced as 500. The downstream
envelope announces the build it actually is. The parity block now sends a
negative delta to both implementations and requires both to refuse it — the
check whose absence let v0.2.4 carry the guard while the shipped reference did
not. Every HTTP code in the canon is an integer again. No figure changed value.


**v0.2.3** — internal build, superseded the same day and never shipped on its
own. Recorded here because its version string outlived it in two files.


**v0.2.4** — the settlement is allocated in integer cents and closes exactly:
three legs to the preserved budget, three credits to the redirect leg, asserted
across every amount from 0.01 to 2000.00. A consumption delta must be
non-negative. The schema migration runs at startup. Adversarial ordering checks
across cap, suppression, lifetime and issue. No figure changed value.


**v0.2.2** — the eligibility determination now carries the timestamp of when it was
made, plus a configurable lifetime after which the gate fails CLOSED. Ships unset,
so no threshold, split or model figure changed value. One event and one error
identifier added.


**v0.2.1** — the responsible-gaming eligibility gate, the reward cap and
`POST /v3/programme/suppress`. Both the gate and the cap ship at the reference
setting, so no threshold, split or model figure changed value. Four error
identifiers and one event were added.


**v0.2.0** — the redirect split becomes a per-jurisdiction configurable in fact
and not only in prose: `VIP_SPLIT_SPA`, `VIP_SPLIT_FNB`, `VIP_SPLIT_RETAIL`,
each validated by the same rule as every other threshold, and the process still
refuses to start if the shares plus rollover would exceed the preserved budget.
The advisory nudge is now emitted when one tick crosses both advisory lines at
once — the previous build marked it as sent while emitting only the escalation,
so a downstream reading the chain saw a session that escalated without ever
having been nudged. Both are covered by new checks. No threshold, split, model
figure or event changed value.


**v0.1.0** — first runnable build of the VIP SmartContract line. The package
already shipped a five-route in-memory reference at registry slot 04b; this
adds persistence, the guest and host surfaces, credit and rollover as
first-class objects, the audit chain, erasure, the dormant downstream and the
suite — without reimplementing the policy: `src/policy.js` is the reference's
arithmetic in pure form, and parity is asserted rather than assumed.

Trench Logic Studio — Miloš Petrović · milos@trench-logic.com ·
trenchlogicstudio.com
