# LumenDock phone dashboard revision

User request (2026-10-15): repair missing Claude usage and notifications; fully redesign horizontal and vertical dashboard; true fullscreen; useful clock/date and sensible glanceable content; compact lighting. User explicitly rejected generic AI visual styling, deep blue gradients, fashionable tech fonts, and em-dash copy. Notifications are limited to Claude, Codex and WhatsApp. Gemini retains desktop launcher/icons/tray work.

## Design and hierarchy

A quiet instrument display: flat ink and warm white, clear typography, sparing functional colour, no identical card grid or decorative light bulb panel. Landscape gives clock/date and room readings about36% width; the rest prioritizes usage and recent selected alerts. Portrait reorders this content for the tall screen. Lighting occupies a compact row with full controls in a sheet. Existing history, quota details, lighting modes/timer and settings remain accessible. Local time stays available offline; quota countdowns keep sampled laptop monotonic time.

True Activity fullscreen, safe camera-cutout padding, transient system-navigation swipe access, keyboard-safe sheets/native setup, normal sensor rotation. Preserve transport/security/lifecycle invariants.

## Diagnosed feed setup

Claude wrapper is not installed and has no cache; existing user status line must be preserved under verified shell/cancellation compatibility. Notification config is absent, so default-deny capture never starts. Actual installed busctl framing/collector passed an isolated synthetic private-bus check. Fix readiness and actual selected-source setup, not fabricated quota values or broad notification forwarding.

## Execution and evidence

Baseline87bd88d after Gemini launcher update. Parallel owned tracks: desktop collector backend, dashboard presentation, Android fullscreen. Shared protocol stays stable; startup scripts/desktop launcher are Gemini-owned. Coordinator handles live handoff, serialized commits, setup/device acceptance, packaging and private GitHub pushes. Fresh independent Astra-high final review remains required.

Targets:800x360 and740x320 landscape,360x800 portrait,>=44px primary targets,>=14px text,>=32px key values, reduced-motion and increased-text support, no horizontal overflow. JS/CSS<=750KiB, APK<=20MiB. Tests, actual browser screenshots and targeted phone acceptance must support completion claims.

## Latest UI-only scope (2026-10-15)

After Antigravity added a second Deck section, the user requested Astra to refine both screens while retaining the general direction. The user then confirmed backend and fullscreen work are complete and explicitly limited this task to UI.

Retain Monitor and Deck navigation, local12-hour clock with AM/PM, room/history, actual usage details and selected alerts. Retain Deck app-launcher/media/audio/lighting actions and lighting detail sheet. Retain bottom overlap dock, eight-second auto-hide, on-demand handle and connection/action feedback wake. Improve composition, typography, spacing, controls and visual consistency in landscape/portrait. Earlier proposals for a permanent lighting row or top bar are superseded by this existing two-screen interaction. Backend setup/routing/fullscreen behavior and Gemini launcher work are outside this task.

Astra-high owns the redesign, with a fresh independent Astra-high UI review afterward. Verify dashboard tests, production build, both screens and dock states in actual synthetic browser screenshots, accessibility/keyboard/text scale, and APK packaging. Do not run live host audio/application actions as tests. Earlier backend/device/final-project claims remain separately recorded and are not evidence for current UI completion.
