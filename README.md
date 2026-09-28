# Code Compiler Empire

A deep systems-management idle game about building an interlocking software
empire.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the high-level game and software
architecture.

## Simulation core

The headless TypeScript engine in `src/` provides:

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
it before applying sequential snapshot migrations. Raw version 1 through version 3 snapshots remain loadable. `gameVersion`,
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
  gameVersion: "0.1.0",
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

- `src/examples/vertical-slice.ts` — four systems, two player commands, status
  projection, offline advancement, and save/load helpers.
- `src/examples/run-vertical-slice.ts` — executable scenario that hires three
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