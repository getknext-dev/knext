# ADR-0056 Amendment 3 (DRAFT): a credential slot GitHub never ran

- **Status:** Proposed (2026-09-29, #1642). **The founder decides**; this draft recommends an
  option but changes nothing on its own. When accepted, fold it into
  `docs/adr/0056-credential-the-cell-matrix-against-a-frozen-rc-ref.md` as "Amendment 3" and add
  the Status line there.
- **Amends** ADR-0056 D1 and Amendment 2 (the missing-night calendar).
- **Relates to** #1640 (the read-only credential-slot watchdog), #1643 (the rc.2 harness batch
  that raises the grace).
- **Trigger-class:** ADR + CI + release process — flagged for the sprint-close design review.

## Context

Amendment 2 made the audit date every night by its cron slot and turn a slot with no run into a
`missing-night` that restarts the 14-night streak, once the slot's fire time plus
`MISSING_NIGHT_GRACE_HOURS` has passed. Two things happened in the week of 2026-09-22:

1. **Delay.** GitHub started scheduled credential runs up to 6h13m after their cron fire time
   (the bun credential slot, 05:47 UTC, ran at about 12:00). With a 6h grace, a night that was
   only queued read as missing. #1643 raises the grace to **10h**, which covers the measured worst
   case with about 4h of headroom and still resolves each slot long before the next one fires.
2. **Drop.** GitHub documents that scheduled workflows can be delayed, and under load dropped,
   by its scheduler. A delay is now absorbed by the grace; a drop is not. ADR-0056 has no remedy
   for a night GitHub itself never ran: the slot becomes a `missing-night`, and the cell's window
   resets.

The question is what the credential should do about a dropped slot.

## Options considered

| Option | What it means | For | Against |
|---|---|---|---|
| **A. Slot-stamped backfill** | When a slot has **no run at all** at grace expiry, one `workflow_dispatch` run is started for that lane, stamped with the missing slot. The audit counts it as that slot's night only if it is the first and only backfill for the slot, runs on the same RC commit with the same window fingerprint, is a first attempt, and was started before the next slot fires. | A GitHub scheduler fault no longer costs up to 14 nights per cell. | Changes D1 ("a credential night is a scheduled night; dispatches never count"). Adds a path that can mint a credential night, which needs its own authorization story (who or what may dispatch, how the audit tells a sanctioned backfill from any other dispatch) and its own guards. #1640's watchdog is read-only by design; this makes something dispatch. More harness code inside the frozen set. |
| **B. Accept the reset risk (recommended)** | A slot GitHub never ran stays a `missing-night` and restarts the streak. Delay is handled by the 10h grace; visibility by the #1640 watchdog, which alerts when a slot is late or missing. | Keeps D1's definition exact: every counted night was scheduled and ran unattended. No new write path into the credential. Nothing new to guard. | A true drop costs the cell its window (up to 14 more nights). The GA date absorbs that risk. |
| C. Excuse N missing nights per window | Allow, say, one missing slot per 14-night window without a reset. | Simple to implement. | Weakens "fourteen consecutive nights" for every cause of a missing night, not only GitHub drops. The audit cannot tell a scheduler drop from a broken lane. |

## Decision (recommended: B)

**Accept the reset risk.** A credential night stays a scheduled night; a slot GitHub never ran
is a `missing-night` and restarts the cell's streak, as Amendment 2 already specifies.

Why B over A: the credential is a public claim that a cell passed on fourteen consecutive
unattended nights on a frozen tag. Its value is that nobody chose which nights counted. A backfill
path keeps the tag and fingerprint fixed, but it reintroduces a dispatch that counts, and that
dispatch then has to be authorized, rate-limited, audited and guarded against cherry-picking.
All of that sits inside the frozen harness during a live window. The delay problem that actually
happened this week is fixed by the 10h grace. What remains is outright drops, which we have not
observed on these crons, only read about. If drops do start costing windows, this amendment should
be revisited with measured drop counts, and option A is the fallback design.

## Consequences

- No change to D1, the audit, or the harness beyond the grace bump that #1643 already carries.
- The #1640 watchdog is the operational answer. It alerts on a late or missing slot, so a drop is
  seen the same morning, not at the next audit.
- A dropped slot resets that cell's window. The rc.2 → GA plan should keep slack for one reset per
  cell.
- **Revisit trigger:** two or more `missing-night` resets in one release cycle that the watchdog
  attributes to GitHub (no run created at all for the slot), not to a lane failure.

## Action items

- [ ] Founder: accept B, or choose A or C.
- [ ] On acceptance: fold this text into ADR-0056 as Amendment 3, update its Status line, and
      update Amendment 2's "6h" grace figure to 10h (#1643).
- [ ] If A is chosen instead: file the design as its own issue (dispatcher, authorization, audit
      rule, guards). It lands through a frozen-file batch, never piecemeal during a window.
