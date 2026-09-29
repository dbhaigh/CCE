# Code Compiler Empire

A deep systems-management idle game about building an interlocking software
empire.

New to the game? Read the [player manual](GAME_MANUAL.md) for the current
mechanics, controls, and a first-session walkthrough.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the high-level game and software
architecture.

## Desktop and browser game

The React/TypeScript interface in `src/app/` uses a Web Worker to run the
**same** production simulation from `src/simulation/` in a browser or inside
Tauri 2's Windows WebView2, macOS WebKit, or Linux WebKitGTK window. Typed worker messages serialize commands,
ticks, saves, projections, and errors; long offline catch-ups run in chunks
with visible progress while the React thread remains responsive. Vite and
Tailwind CSS 4 power the UI. The Rust process does not run a second simulation:
its slot commands store exactly three manual saves and a separate autosave
in Tauri's app-data directory. The browser bridge uses `localStorage`.
Both bridges expose each slot's timestamp, an explicit corruption error and
the previous valid version as a separately loadable backup. Old single-file
`empire.json` (or the old browser key) remains a readable autosave until a
new autosave replaces it; deletion masks that legacy fallback without
destroying the original data. Saves retain independent slot revisions; the
frontend orders worker snapshots and coalesces only writes to the same slot.
Rust rejects stale revisions, syncs same-directory temporary files, atomically
replaces the old save with write-through on Windows or rename and directory
sync on macOS/Linux, and emits a slot-scoped `game:saved` event.
The browser keeps each slot's revision in a separate persistent key; failure
to write a backup or revision prevents replacing the prior primary.
The UI exposes engineering policies, swarm autonomy,
deployment strategies, build hardware, paid research upgrades, actual
producer-selective build jobs, bounded unmet-demand telemetry, resource/debt
dashboards, pipeline bottlenecks, and recent events. Demand counts outstanding
requests; existing in-flight work is not duplicated, deployment monetizes
only served requests, and successful releases/reputation bring bounded
referrals. A schema-6 migration seeds demand, starts older research with no
purchased upgrades, and defaults old manual jobs to Any Source.
While visible it autosaves to the dedicated AUTO slot at the configured interval
(30 seconds by default), flushing elapsed foreground time into the worker before stamping the
save. Hiding the window saves through the hide timestamp; hidden timer
autosaves are skipped so a crash/reload replays the unsaved interval instead
of losing it. A manual save while hidden catches up offline through its
timestamp, and returning to the window catches up only the remaining hidden
time. Snapshots enter the worker's ordered queue immediately at their
timestamp, before later commands or advances; only filesystem writes are
coalesced. Loading a slot replaces the authoritative worker simulation, catches
up through the slot's saved timestamp exactly once, and leaves other slots
untouched. A failed or corrupt load pauses play and exposes explicit backup,
other-slot, or confirmed new-game recovery instead of silently resetting or
overwriting the prior valid save. A rendering or worker failure suppresses
automatic writes and playback until explicit recovery, leaving existing slots
untouched.
Browser previews hosted inside another Tauri-based app are detected with a
CCE-specific command handshake before using native commands; a foreign host's
Tauri globals cannot hijack the browser save bridge. First-run guidance and
validated theme, UI-scale, default speed, and autosave-interval preferences
are stored separately from the canonical simulation; default speed applies
at the start of a new app session. There is intentionally no window tray:
hidden/minimized windows use the established save/offline catch-up path, not
a second unattended foreground timer.

The dark responsive dashboard uses Tailwind, Radix accessible tabs, and Lucide
icons. Seven sections are navigable: Resource overview and Source generation /
agents have complete live panels; Build & compilation, Testing & runtime,
Technical debt, Policy, and Research / insight expose their existing working
diagnostics and controls. Resource cards distinguish **net balance change**
between projections from measured **produced / consumed per exact tick**;
the latter comes from committed kernel mutations, excludes ephemeral tick
resets and failed transactions, and is unavailable across an analytical skip
rather than estimated. Debt pressure uses the debt system's pre-spend
maintenance capacity, actual retirement, knowledge-adjusted effective
potential, available funding, and observed net debt trend; zero *remaining*
capacity after a successful paydown is not mistaken for a stalled team.
The flow strip shows actual Source, Binary, and
Release backlog units. Teams and swarms can be hired/recruited or
fired/retired in single units (maximum 100 each cohort, never below zero).
Hiring costs five ticks of that cohort's salary/upkeep up front; operating
costs continue for each funded person or agent every tick. Team focus can be
set to generalist, source generation, verification, operations, or research:
the focused skill gains 20% while other skills lose 25%, changing actual
production and capacity. Teams can train each real skill for five credits per
point (maximum 2,000 per skill); team policy overrides can be cleared to
inherit later global changes again. Crisis response budget and trigger
thresholds are editable through the existing authoritative protocol command.
Swarm autonomy and alignment can be adjusted within their 0–1,000 bounds;
alignment changes actual funded agent capacity after instability.
Existing saves without a focus stay generalist;
rejected or unaffordable commands are reported in the status strip.
Build jobs are bounded requests for **existing or future generated Source**,
not reservations or free Source: at most 16 pending jobs, 256 units per job,
and 1,000 outstanding units. Each tick consumes the same Source cohorts,
Compute, hardware budget, binary buffer, and shared throughput as before;
jobs receive that work in visible queue order, then automatic compilation uses
any remaining capacity. Reorder, prioritize, and cancel change only pending
requests. Failed builds still consume their Source and Compute, with successful
and failed units recorded per job; cancellation refunds neither work already
processed nor spent resources. Research selection, hardware profiles, staffing,
role focus, global/team policy fields, and deployment strategy are all worker
commands. Manual category debt paydown takes priority over automatic
remediation **within the current tick's generated maintenance capacity**,
limited by category principal, knowledge/category efficiency, and available
Money. Unused capacity still serves automatic maintenance; an accepted request
may retire zero if resources are unavailable, and its observed result is shown
separately. Policies adjust future ticks; they do not grant resources outright.
The important-event log holds the most recent 64 selected engine facts in
canonical snapshots (including build jobs, hiring, research, debt and crisis
events); recurring incidents/debt/crisis notifications are throttled. UI
command/save notices are separate and are not persisted.

`src/app/simulation-store.ts` holds immutable, worker-projected UI state and
uses `useSyncExternalStore` selectors so a resource card only rerenders when
its displayed value changes. The dashboard shows **every** registered resource,
actual team and swarm cohorts, build-stage execution totals, and the real
Source/Binary/Release/Hot-deploy backlogs (resource units and cohort counts
where cohorts exist). `src/app/use-simulation-loop.ts` starts one controlled
250 ms loop; it never overlaps foreground advances and performs one ordered
offline catch-up when a hidden window returns. Playback supports Pause,
1x, 2x, 5x, and **Max = 10x**, a fixed safe cap rather than an unbounded
tick loop. The worker only sends a new view when a tick actually changes.
For a saved 86,400-exact-tick day on this Windows/Node 24 machine, the
worker's bounded 256-tick catch-up improved from 6.30 s to 4.73 s; two
days (172,800 exact ticks) improved from 12.16 s to 7.79 s using
`MessageChannel` task yields and cached, validated system/resource access.
These are example single-run measurements, not a performance guarantee.
With the current demand rules, three repeated restores of the same saved
game took 5.03–5.92 s for one day (86,400 exact ticks) and 34.20–36.68 s
for one week (604,800 exact ticks) on this Windows/Node 24 machine. A
100-engineer 10x workload advanced 600 ticks in
184 ms in the worker, yielding twice; foreground projections remain bounded
by the 250 ms loop. Busy machines can take substantially longer.
Progress remains periodic, but FIFO worker commands still wait for the
catch-up to finish; no rewards are capped or skipped.

```powershell
npm ci
npm run dev            # Browser at http://127.0.0.1:1420
npm run build          # TypeScript package and production web assets
npm test               # Headless engine and desktop integration tests
npm run desktop:dev    # Tauri/WebView2 desktop window
npm run desktop:build  # Desktop bundles configured for the current OS
```

Desktop commands require [Rust stable](https://rustup.rs/) plus platform
prerequisites: **MSVC C++ Build Tools with Windows SDK** and WebView2 on
Windows, Xcode command-line tools on macOS, or GTK3/WebKit2GTK 4.1 and
AppIndicator development packages on Linux. The Tauri CLI may download
packaging tools such as NSIS. Bundle types configured in
`src-tauri/tauri.conf.json` are NSIS, `.app`/`.dmg`, and `.deb`/AppImage,
respectively. To build just the release formats for this host:

```powershell
npm run desktop:build -- --bundles nsis            # Windows
npm run desktop:build -- --bundles app,dmg         # macOS
npm run desktop:build -- --bundles deb,appimage    # Linux
```

The Windows build writes `src-tauri/target/release/code-compiler-empire.exe`
and `src-tauri/target/release/bundle/nsis/*.exe`; the former can be copied
without installing but is **not** self-contained and still requires a
working WebView2 runtime. The macOS build writes an `.app` and `.dmg` under
`src-tauri/target/release/bundle/`; Linux outputs a `.deb` and AppImage
under that bundle directory. Linux builds require the distribution's
WebKitGTK 4.1 runtime and may need `libfuse2` to run an AppImage. Unsigned
Windows installers can trigger SmartScreen; unsigned/unnotarized macOS apps
may be blocked by Gatekeeper. No signing or notarization credentials are
configured in the repository: configure trusted keys and Apple's
notarization credentials before a trusted public distribution. CI builds
each OS on a hosted runner; building on Windows does not verify the macOS
or Linux packages locally.

`RELEASE_NOTES_0.0.1.md` is a **draft**, and `.github/workflows/draft-release.yml`
requires a manually supplied tag whose commit is already merged into `main`,
rebuilds all platforms, then creates a **draft** GitHub release for human
review. This PR does not create a tag or publish a release. There is no
active auto-updater; a future signed updater requires a trusted update
endpoint, signing keys kept outside the repository, and explicit client
verification before it can be enabled. Browser and desktop saves are
intentionally separate; compatible snapshots can be moved manually, but
there is no automatic transfer.

For a Windows smoke test, a release-mode executable with a temporary,
isolated app identifier and WebView2 profile loaded the same paused save as
the browser preview. Both UIs accepted the same deployment-strategy command
and wrote canonically identical tick-1 manual-slot snapshots (apart from
their wall-clock save timestamps); the native file was read back from its
isolated app-data directory. The smoke app data was removed afterward.
The production Windows executable and NSIS installer were built, but the
installer itself was not installed in this test. macOS/Linux bundles have
not been built or run on this Windows host; CI and release review must verify
them before publication.

## Simulation core

The framework-agnostic TypeScript engine in `src/simulation/` provides:

- deterministic fixed ticks and counter-based random values;
- variable-speed offline advancement with explicit complete/truncate policy;
- a validated central resource registry;
- typed commands, same-tick, next-tick, and acknowledged durable events;
- dependency-ordered pipelines with resource, state, and event conflict checks;
- neutral layer/system IDs and validated content dependency graphs;
- quantity-conserving source, binary, release, and debt cohorts carrying
  provenance and local policy;
- reversible tick mutation journals instead of full rollback snapshots;
- analytical skipping for quiescent intervals plus exact opt-in models for
  stable active flows;
- JSON-compatible snapshots and exact restoration; and
- nine composable domain modules for organization, source generation, build
  graphs, verification, runtime, research, and technical-debt maintenance.

Each module implements `SimulationLayer`: public pipeline metadata, systems,
command/event handlers, documented feedback loops, and high-entity-count
performance guidance. `createCoreSimulationModules()` composes the default
layers without exposing one layer's internal state to another.

The default composition also includes self-improving automation and crisis
response. Runtime evidence can recursively improve automation, generate source,
request hot deployments, and feed the resulting artifacts back through the
normal build and verification layers. Outages, debt explosions, and swarm
rebellions open bounded crisis episodes. Response consumes both reserves and
capacity, while hot-deploy backlogs are capped and overflow becomes debt.

Events declare `delivery: "sameTick" | "nextTick" | "durable"`. Durable events
remain in snapshots and views until a consumer returns their sequence IDs in
`acknowledgedEventSequences`. Offline models implement
`AnalyticalOfflineModel`; the kernel invokes them only across command-free,
event-free intervals and otherwise uses exact ticks. Deterministic linear
subsystems can use `createFixedRateAnalyticalModel()` instead of implementing
the contract directly.

### Persistence, balancing, and diagnostics

Use `encodeSave(simulation, Date.now())` and `decodeSave(configuration, data)`
for persisted saves. The envelope includes a canonical checksum; load verifies
it before applying sequential snapshot migrations. Raw version 1 through version 4 snapshots remain loadable; schema 5 adds bounded important events and preexisting build states without jobs remain valid. `gameVersion`,
`contentHash`, tick duration, system
state ownership, and resource definitions are checked during restoration.

All default tuning lives in `DEFAULT_CORE_BALANCE_CONFIG`. It contains only
JSON-safe data and can be exported, edited by designers, loaded with
`parseCoreBalanceConfig()`, and passed to `createCoreSimulationModules(balance)`.
`createCoreSimulationConfiguration()` validates the complete balance bundle
and derives its canonical `contentHash`, so saves cannot silently load against
incompatible economy curves.

`createSimulationDiagnostics(simulation)` returns immutable UI-ready data:

- debt principal, share, interest, and maintenance efficiency by category;
- pipeline and system nodes, dependency edges, phases, resources, and events;
- funded team and swarm capacity, morale, alignment, policy, and cumulative
  human/AI source output.
- sampled rolling throughput, resource flow, active/blocked ticks, and explicit
  Source/Build/Test/Runtime bottleneck reasons.

Offline reports include both `ticksProcessed` and `exactTicksProcessed`.
Quiescent skipping is proven by the mutation journal. An active analytical
model is accepted only when its system, resource, and event coverage exactly
matches the configured graph. Endpoint invariants are checked transactionally;
failure rolls back to exact ticks. Commands and queued events force exact
boundary ticks. Offline processing is complete by default. Explicit
`offlineProgressPolicy: "truncate"` reports `discardedTicks` and still consumes
the elapsed-time remainder correctly.

### Automation posture

Stable hyper-automation combines high coding standards, low risk tolerance,
canary or rolling deployments, maintenance allocation, aligned swarms, and an
automatic crisis-response budget. A singularity posture does the opposite:

```ts
import { simTick } from "code-compiler-empire";

simulation.dispatch({
  id: "singularity-policy",
  type: "organization.set-policy",
  issuedAt: simTick(1),
  payload: {
    policy: {
      aiAllocationPermille: 1000,
      maintenanceAllocationPermille: 0,
      reviewStrengthPermille: 0,
      testStrengthPermille: 0,
      codingStandardsPermille: 0,
      riskTolerancePermille: 1000,
      releaseCadencePermille: 1000,
    },
  },
});

simulation.dispatch({
  id: "singularity-swarm",
  type: "organization.configure-swarm",
  issuedAt: simTick(1),
  payload: {
    swarmId: "compiler-swarm",
    autonomyPermille: 1000,
    alignmentPermille: 700,
  },
});

simulation.dispatch({
  id: "hot-deploy-everything",
  type: "runtime.set-deployment-strategy",
  issuedAt: simTick(1),
  payload: { strategy: "hot" },
});
```

This raises recursive automation power, but also compounds debt, instability,
incident risk, and crisis severity. Crisis circuit breakers can spend reserves,
retire emergency debt, contain swarms, or shut down automation before the loop
escapes control.

```ts
import {
  Simulation,
  createCoreSimulationConfiguration,
} from "code-compiler-empire";

const configuration = createCoreSimulationConfiguration({
  seed: "empire-1",
  gameVersion: "0.0.1",
  initialResources: { "core.money": 1_000 },
});
const simulation = new Simulation(configuration);

simulation.advanceRealTime(1_000, 2_000); // One real second at 2x speed.
const save = simulation.serialize(Date.now());
```

Run `npm test` to build the package and execute determinism, save/restore, flow,
and offline-progress tests.

## Minimal vertical slice

The complete playable example consists of:

- `src/simulation/examples/vertical-slice.ts` — four systems, two player commands, status
  projection, offline advancement, and save/load helpers.
- `src/simulation/examples/run-vertical-slice.ts` — executable scenario that hires three
  agents, runs the fast policy until debt slows compilation, enables the strict
  policy, saves, restores, and advances ten seconds offline.

The slice uses the production simulation, resource, command, offline, and
versioned save APIs. Binaries persist between ticks and generate the next tick's
ephemeral Compute; the compiler starts with a small bootstrap Compute allowance.

### How to run

```powershell
npm install
npm run demo:vertical-slice
```

The output shows agent count, Source, Binaries, generated Compute, Technical
Debt, compile throughput/debt penalty, policy state, and restored offline
progress. To use it programmatically, import `createVerticalSliceGame`,
`hireAgents`, `setStrictPolicy`, `saveVerticalSlice`, `loadVerticalSlice`, and
`getVerticalSliceStatus` from the package root.