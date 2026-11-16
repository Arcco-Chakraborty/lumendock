# Clock space and clipping repair — independent scoped review

Date: 2026-10-24. Verdict: approved for this bounded Clock UI repair; no actionable findings or open P1/P2 findings in the reviewed scope.

This is the independent scoped review requested for the current repair. It is not the required whole-project Astra-high finished-project review. The earlier Astra usage-limit error supplied no final verdict and is not approval. Physical device acceptance remains unobserved.

## Reviewed scope and identity

Canonical checkout: `/home/arcco-chakraborty/.codex/worktrees/phone-monitor-build/Phone_monitor`, detached baseline commit `8e8ddcc`, with pre-existing dirty work preserved. Compared the current task against `.superpowers/clock-space-2026-10-24/baseline`, not against HEAD. Read the current handoff, status, progress, PRD, system design, flip-clock brief and current clock-space brief.

Reviewed the six frozen files in `.superpowers/clock-space-2026-10-24/review-hashes.json`: `ClockView.tsx`, `clock.css`, the scoped removal from `styles.css`, `clock-space.spec.ts`, PRD and task brief. Independently verified all six SHA-256 values before and after browser probes. Also verified the five production files against `dist-hashes.json` before and after probing. The frozen comparison is recorded in `review.diff`.

Product changes remain bounded to Clock presentation and four obsolete global Clock CSS rules. Timer/alarm/stopwatch store, audio logic, FlipCard implementation, App, Monitor/Agenda, backend and native files are unchanged by this task. The reviewer made no product or test edits, builds, commits, device changes or checkpoint edits.

## Findings and resolution assessment

The initial independent investigation reproduced the actual causes: hidden header/footer tracks reserved 100px of landscape height and 220px on narrow portrait; viewport font/status clamps kept cards small; fixed timer side columns constrained the ring; the old global max-width649 timer rule overrode the landscape layout at 601px. The previous geometry tests omitted timer setup and overflow ancestors, while allowing arbitrary vertical scrolling.

The final code removes those conflicting global rules, places landscape controls in side rails, sizes the flaps and circular timer from their actual containers, and keeps reveal geometry stable. The documented Fit screen interpretation preserves the stored boolean values, presents horizontal cards in landscape and stacked cards in portrait, while explicitly saved stacked remains stacked. AM/PM and optional seconds retain their visibility through existing card corner support. Setup forms, timer controls and alarm forms fit the tested views.

The new tests measure the actual union of flap rectangles rather than a large empty wrapper. Their containment helper includes overflow ancestors, setup inputs/buttons and center hit-testing, closing the reproduced clipping blind spots. Circle tests measure countdown glyph corners against the inner circular radius.

## Independent browser evidence

Used only the local production preview at `127.0.0.1:4183`, installed Chrome, pinned Node24, synthetic bridge fixtures and frozen UTC time. Blocked requests outside the preview origin and disabled audio. No hub, real phone capture, account data, credentials or actual audio was used.

All 16 combinations of 740×320, 800×360, 320×800, 360×800, 600×360, 601×360, 649×360 and 650×360 at 100% and 130% text passed the independent checks. Each combination covered upcoming-alarm clock, revealed clock, explicitly stacked clock, timer setup, maximum-length synthetic label setup, 24-hour running/revealed/paused timer, and clock with long timer status.

- No viewport or overflow-ancestor clipping, undersized visible targets, inaccessible control centers or browser errors.
- Setup body `scrollHeight/clientHeight` and `scrollWidth/clientWidth` matched the viewport at all combinations; controls were visible without scrolling.
- Clock and ring bounds stayed exactly equal across control reveal.
- Long countdown glyph corners remained inside the circular stroke. Long labels intentionally ellipsize; the invisible full text range is not treated as painted text outside the ring.

Actual flap union with an upcoming alarm, 100% text:

| Viewport | Flap union | Viewport width / height used |
| --- | --- | --- |
| 740×320 | 532.3×226.7 | 71.9% / 70.8% |
| 800×360 | 590.5×251.9 | 73.8% / 70.0% |
| 320×800 | 289.1×504.1 | 90.4% / 63.0% |
| 360×800 | 324.1×564.6 | 90.0% / 70.6% |

The active circle is now 288px at 740×320 and 328px at 800×360, versus 204px and 244px in the initial audited production bundle. Independent results and screenshots are in `.superpowers/clock-space-2026-10-24/reviewer/probes.json` and that directory. Personally inspected landscape and portrait Clock, setup and paused-timer screenshots, including the 24-hour timer with an ellipsized maximum-length label. Quiet synthetic previews are `quiet-clock-800x360.png` and `quiet-clock-360x800.png`.

The final independent functional sweep passed changed-value fold stages and settling, reduced-motion direct updates, Appearance keyboard modality/Escape, optional seconds, Fit screen and saved stacked through rotation, halfway ring progress, pause, +1 minute, resume, reset, focus retention through the quiet timeout, and Close returning focus to Monitor. Results: `reviewer/functional.json`, zero browser errors, frozen hashes still matched.

Ad-hoc probe corrections are retained here for transparency: an initial assertion rejected Chrome's native Tab boundary where `activeElement` becomes BODY while `document.hasFocus()` is false; the next Tab returned inside Appearance and programmatic background focus remained inert, matching the previously recorded native-browser behavior. Another probe attempted a conditionally hidden +1 button after the intended idle timeout; it was corrected to reveal controls first. A frozen-clock focus assertion needed 20ms advancement for the existing scheduled animation frame. The corrected complete functional sweep exited 0; none of these harness assumptions established a product regression.

## Additional verification and remaining gates

Read coordinator evidence: final focused browser run 39/39, dashboard unit tests 209/209, dashboard source/E2E typecheck, production build and final full production browser suite 113/113 passed. These checks were run by the coordinator; the independent geometry and functional browser sweeps above were run by this reviewer. Earlier failures remain in the task logs and ledger rather than being discarded.

No signed APK/build/install claims are made by this review. The coordinator still owns signed build, exact packaged-asset/certificate checks and any authorized in-place installation. Software browser verification cannot establish actual phone interaction, audible chime behavior, USB/Wi-Fi routing or physical desk acceptance. The required final whole-project Astra-high review remains separate.
