# Changelog

## v3.22 · MVP v0.2.16 — 21 November 2026

The corrections after an outside review of v3.21. No threshold, split, model figure or
metric changed value.

- **The terms a guest agrees to, and which ones.** `GET /v3/terms` publishes the stop
  line, the split of the preserved budget, the ceiling on the incentive, the lifetime of
  the operator's determination and the commitment period, with a version that is the
  fingerprint of exactly those values. Every pre-commit records the version beside the
  amount, in the session, the state and the chain; one that names another version is
  refused with `409 TERMS_CHANGED` and nothing is armed. Both services compute the same
  version. The guest screen shows the terms and sends their version; Demo A shows what
  is recorded at the consent.
- **A stop holds the guest.** A stopped session holds the guest until the commitment
  period, counted from when it was armed, ends: a second budget is refused with
  `409 COMMITMENT_ACTIVE`, `session_id` and `precommit_after`. Until v3.21 a stopped guest
  could arm a second budget at once. `VIP_COMMITMENT_HOURS=0` switches both holds off.
- **Stricter defaults.** The reward cap is on by default at €5,000 per stop and the
  determination lifetime at 90 days, so a pre-commit without a determination date issues
  nothing; `off` switches either off, and blank means the default. The reference stop
  earns €4,590 and the seed records a fresh determination, so the canon quarter is the
  same under the defaults.
- **Contract.** Nine `/v3` routes. `COMMITMENT_ACTIVE` and `TERMS_CHANGED` join the error
  identifiers, `terms_version` the pre-commit request and response, the state and the
  `precommit` event, and the specification validates as OpenAPI 3.0.3. A database written
  before 0.2.16 gains the `terms_version` column; its sessions keep `null` there.
- **Pages that lead somewhere.** The index opens with four direct entries and a button to
  Demo B, and the index and the demo guide link every demo, document and the runnable
  build; every page links back to the index.
- **Demo C.** Credit issued, redeemed and still owed sit side by side, with the redeemed
  share as a labelled assumption; retention can be set below the 61% hard-stop baseline,
  with a downside preset and a warning; the capture band is 40–80% in the canon as on the
  slider.
- **What the study shows.** The limit-setting study is cited as context in every page
  and in the canon: it compares players who set a limit with players who set none, and
  does not measure what the incentive adds, so the 84% vs 61% pair is labelled as not
  yet measured.
- **Keyboard and screen readers.** Demo D's weeks take focus and answer Enter and the
  arrow keys; the sliders in Demos A, B and C carry their labels and descriptions.
- **Phones.** On screens narrower than 860 px the control panel of Demos B and C stayed
  pinned to the top and covered the results; it now scrolls with the page, and on a
  desktop it scrolls inside itself when it is taller than the window. Demo C's
  settlement table becomes labelled rows on a phone, and no page is wider than a
  320 px screen.
- **Documents.** README files, the integration guide, the regulatory map (14), the
  security page (15), 03a, 10, both canons (1.17 and MVP 1.16) and
  [`docs/FIXES.md`](docs/FIXES.md), which records each change with its code and test.
- **Verified:** 314 checks and 54 regression scenarios pass, none skipped, on Node.js
  22.13.0, 22.23.4, 24 and 26; copied out of the repository, `13_VIP_MVP` passes with its
  stated skips. The four Word documents render on the same number of pages as before.

## v3.21 · MVP v0.2.15 — 20 November 2026

The open-source release. Nothing in the engine, the routes, the consoles or the
canon values changed.

- **Licence.** VIP SmartContract is released under the [MIT License](LICENSE), in
  the repository root and in [`13_VIP_MVP`](13_VIP_MVP/LICENSE). Every source file
  carries a copyright and `SPDX-License-Identifier: MIT` line, and both
  `package.json` files name the licence and the author.
- **Withdrawn from the repository:** the commercial and legal set — buyer briefs
  (02a, 02b), value justification (06), pricing model (06b), strategic value (07),
  letter of intent (08), licence agreement (08b), pitch deck (08c) and NDA (08d) —
  the AS-IS notice (09), the MVP licence note and the competitive battlecard (11).
  The remaining slots keep their numbers.
- **Documents and pages.** The confidentiality status and the proof-chain line are
  gone from every footer and title block; the status line states the licence.
  Wording that addressed a buyer addresses the operator or the integrator. The
  Word footers show the page number again, the title block no longer splits
  across two pages, and Demo A's step controls wrap on a phone screen instead of
  running past it.
- **Canon 1.16, MVP canon 1.15.** `terms` states the licence; the pricing, buyer
  segments, competitor classes and AS-IS scope blocks are removed;
  `licensed_ip` is kept, word for word, as `mechanism_scope`.
- **Documentation in English:** [`README.md`](README.md), this changelog, and
  [`docs/FIXES.md`](docs/FIXES.md), the record of the v3.19 and v3.20 corrections
  with links to the code and the regression tests.
- **CI:** GitHub Actions on `actions/checkout@v7` and `actions/setup-node@v7`,
  Node.js 22.13.0, 22.x, 24.x and 26.x.
- **Verified:** 308 checks and 41 regression scenarios pass, none skipped, on
  Node.js 22.13.0, 22.23.4, 24 and 26, with the workflow run locally; copied out of
  the repository, `13_VIP_MVP` passes with its stated skips. Every page and demo
  opens in Chrome without errors at desktop and phone widths, and a hard-stop
  settlement runs end to end in the guest screen. The compose stack starts both
  services, with a local Node.js 22.13.0 image standing in for the official one,
  which could not be downloaded here. The four Word documents render on the same
  number of pages as before.

## v3.20 · MVP v0.2.14 — 16 November 2026

- **The stop line is held before the stake.** `POST /v3/session/authorize` checks
  each stake before it is placed and refuses one that does not fit what is left to
  the line (`409 STAKE_EXCEEDS_HEADROOM`); `POST /v3/session/release` returns a
  stake that was never played. Every stop states `overshoot_eur`.
- **A pre-commitment binds.** A live session younger than `VIP_COMMITMENT_HOURS`
  (24 by default) refuses a new pre-commit with `409 SESSION_LIVE`.
- The v3.19 of 10 November was built without the pre-stake check that an October
  2026 release under the same numbers had introduced; v3.20 has both sets of
  changes. Details: [`docs/FIXES.md`](docs/FIXES.md).

## v3.19 · MVP v0.2.13 — 10 November 2026

Transactional issuance, exact sub-cent accumulation, idempotent tick receipts,
settlements kept at the terms quoted, eligibility checked again at issuance and
at use, an erasure that answers 503 while another reader holds the old log and
completes on the next call, byte-exact request bodies
with `413` above 1,000,000 bytes, loopback binding with same-origin writes, and
fixes to the consoles and the four demos. Details: [`docs/FIXES.md`](docs/FIXES.md).

## Earlier revisions

Every revision of the canon is recorded in [`12_Canon.json`](12_Canon.json), in its
`canon_change_log` entries, and every revision of the MVP in
[`13_VIP_MVP/CANON.json`](13_VIP_MVP/CANON.json).

---

Copyright (c) 2026 Miloš Petrović (Trench Logic Studio) · MIT License
