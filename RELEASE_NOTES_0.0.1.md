# Code Compiler Empire 0.0.1 — draft release notes

Initial desktop preview for Windows, macOS, and Linux. The same authoritative
TypeScript simulation runs in a Web Worker in the desktop UI and browser
preview; Tauri handles native save storage, not gameplay rules.

- Manage funded teams and agent swarms across Source, compilation, testing,
  deployment, research, technical debt, policies, and crisis response.
- Follow bounded market demand from requests through delivered Releases and
  reputation-driven referrals. Queue manual build jobs for any Source or
  specific producing teams; automatic compilation uses spare capacity.
- Purchase optional research upgrades after completing the corresponding
  projects. Use real resource flows, bottleneck indicators, and a bounded
  important-event log to diagnose outcomes.
- Save to three manual slots plus an independent autosave, with explicit
  backup recovery and exact uncapped offline progression.
- Read the [player manual](https://github.com/dbhaigh/CCE/blob/main/GAME_MANUAL.md)
  for gameplay and [README](https://github.com/dbhaigh/CCE/blob/main/README.md)
  for platform build and installation requirements.

**Preview limitations:** Offline replay simulates every active tick; on one
Windows development host, a saved week took about 34–37 seconds to catch up
and later worker commands waited for completion. Windows WebView2, macOS
WebKit, and Linux WebKitGTK are system prerequisites. The draft artifacts are
unsigned; macOS notarization, code signing, and an authenticated signed
auto-updater are not configured. Native Windows packaging is verified
locally; macOS and Linux bundles require verification by their hosted CI
runners and a human release check before publication.
