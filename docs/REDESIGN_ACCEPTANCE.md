# Current revision acceptance

Revision baseline: 87bd88d. Requirements: PRD current revision and REDESIGN.md. Results below apply only to this revision; historical device results remain in DEVICE_ACCEPTANCE.md. No real notification content, phone identifier or credentials belong here.

| Area | Required observation | Current result |
|---|---|---|
| Clock | Local time/date render with both links absent | Pending browser evidence |
| Layout | 800x360, 740x320 and 360x800; 130% text; keyboard/focus; primary actions reachable | Pending UI report and independent review |
| Lighting | Compact summary, full mode/colour/brightness/speed/timer controls accessible, pending states preserved | Pending UI evidence; actual strip acceptance separate |
| Fullscreen | On Redmi API29, no persistent status/navigation bars; system gestures still work | Pending new APK physical observation |
| Orientation | Deliberate portrait/landscape without restarting setup or dropping owned transports | Pending new APK physical observation |
| Insets and keyboard | Cutout-safe content and usable native setup/dialog input | Pending physical observation |
| Claude setup | Missing capture says setup required; installed quiet source says waiting; existing status line preserved | Pending backend tests/review and live compatibility evidence |
| Claude quotas | Real report shown after genuine normal provider activity; no inference created for testing | Pending real capture |
| Selected alerts | Only Claude, Codex and WhatsApp; synthetic selected event arrives; unrelated browser event rejected | Pending backend tests and controlled delivery |
| Link independence | USB and selected ESP Wi-Fi remain independent through loss/recovery | Historical success; current revision targeted check pending |
| Lifecycle | Home/return and native/OS setup flows remain operable | Pending current revision physical check |
| Build | Scoped/aggregate tests, typecheck, lint, packaged assets and APK budgets | Pending final integration |
| Final review | Fresh gpt-6-astra at high, whole project/PRD/evidence with findings resolved | Pending |

The user confirmed the previously installed app works on the phone. This does not prove acceptance of the redesigned UI or the repaired feed configuration. Software verification and physical acceptance stay separate in STATUS.json.
