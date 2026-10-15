# Dashboard composition

The approved brief calls for a room instrument beside laptop usage, with useful local time even when USB is absent. Keep the clock as the memorable element; other numbers and controls support it.

Palette: ink #191a18, panel #22231f, warm white #f2f0e8, stone #aaa99f, rule #45463e, amber #d5b97b. Functional green #a5c39c marks a connected link. No ornamental colour or font downloads.

System sans-serif throughout; tabular numerals for clock, room and quotas. Clock 80px landscape / 76px portrait; room and usage values at least32px. Labels and actions at least14px. Every primary action44px.

Landscape:
```
Laptop link   Controller link                           Settings
[ local clock/date | Claude, duration, usage, reset, age, View ]
[ room + history   | Codex, duration, usage, reset, age, View  ]
[                  | Recent alerts                         ]
Lighting   Power   brightness/colour/timer            Controls
```
Portrait deliberately places time/date above a horizontal room reading, then usage rows, recent alerts and the lighting strip. Detailed controls/history/windows/settings use the existing accessible dialog.

Review against brief: avoid repeating equal cards or large headings above every region. No decorative bulb, gradients, shadows, fetched fonts, fake content or animations. Borders separate different functions; usage rows remain unboxed. Source setup/error text must remain useful and honest. Layout may scroll vertically when text grows; controls must stay reachable with no horizontal overflow.
