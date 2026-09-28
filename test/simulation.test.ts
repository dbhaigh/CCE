import assert from "node:assert/strict";
import test from "node:test";

import {
  CORE_RESOURCE_DEFINITIONS,
  DEFAULT_CORE_BALANCE_CONFIG,
  MAX_HOT_DEPLOY_REQUESTS,
  COMPILATION_SYSTEM_ID,
  AUTOMATION_SYSTEM_ID,
  CRISIS_SYSTEM_ID,
  ORGANIZATION_SYSTEM_ID,
  RESEARCH_SYSTEM_ID,
  RUNTIME_SYSTEM_ID,
  SOURCE_GENERATION_SYSTEM_ID,
  TESTING_SYSTEM_ID,
  TECHNICAL_DEBT_LAYER_ID,
  TECHNICAL_DEBT_SYSTEM_ID,
  Resources,
  SimulationPhase,
  Simulation,
  appendBoundedCohort,
  createFixedRateAnalyticalModel,
  createSimulationDiagnostics,
  createCoreSimulationModules,
  createCoreSimulationConfiguration,
  createVerticalSliceGame,
  decodeSave,
  encodeSave,
  getVerticalSliceStatus,
  hireAgents,
  loadVerticalSlice,
  migrateSnapshot,
  parseCoreBalanceConfig,
  saveVerticalSlice,
  setStrictPolicy,
  createKnowledgeResearchLayer,
  simTick,
  pipelineId,
  systemId,
  weightedPermille,
  parseSourceArtifact,
  payloadField,
  type CommandHandler,
  type EventHandler,
  type JsonObject,
  type SimulationConfiguration,
  type SimulationSystem,
} from "../src/index.js";

function configuration(seed = "test-seed"): SimulationConfiguration {
  const modules = createCoreSimulationModules();
  return {
    seed,
    gameVersion: "test",
    contentHash: "core-test",
    tickDurationMs: 1_000,
    maximumOfflineTicks: 100,
    resources: CORE_RESOURCE_DEFINITIONS,
    initialResources: {
      [Resources.Compute]: 0,
      [Resources.Money]: 1_000,
    },
    systems: modules.systems,
    pipelines: modules.pipelines,
    commandHandlers: modules.commandHandlers,
    eventHandlers: modules.eventHandlers,
  };
}

test("a tick processes the production dependency graph in order", () => {
  const simulation = new Simulation(configuration());

  simulation.runTick();

  assert.equal(simulation.tick, 1);
  assert.ok(simulation.resources.get(Resources.Source) > 0);
  assert.ok(simulation.resources.get(Resources.Binaries) >= 0);
  assert.ok(simulation.resources.get(Resources.Money) > 0);
  assert.ok(
    simulation.events.some((event) => event.type === "source.batch-generated"),
  );
  assert.ok(
    simulation.events.some((event) => /^build\./.test(event.type)),
  );
  assert.equal(simulation.plan.stages.length, 11);
});

test("the same seed and elapsed time produce identical state", () => {
  const first = new Simulation(configuration("repeatable"));
  const second = new Simulation(configuration("repeatable"));

  first.advanceTicks(50);
  second.advanceRealTime(10_000, 5_000);

  assert.deepEqual(first.serialize(100_000), second.serialize(100_000));
});

test("serialization restores a simulation without changing future results", () => {
  const uninterrupted = new Simulation(configuration("save-test"));
  uninterrupted.advanceTicks(12);
  const snapshot = uninterrupted.serialize(50_000);
  const restored = Simulation.restore(configuration("save-test"), snapshot);

  uninterrupted.advanceTicks(20);
  restored.advanceTicks(20);

  assert.deepEqual(
    uninterrupted.serialize(70_000),
    restored.serialize(70_000),
  );
  assert.deepEqual(
    uninterrupted.getState(COMPILATION_SYSTEM_ID),
    restored.getState(COMPILATION_SYSTEM_ID),
  );
});

test("save envelopes verify integrity and migrate legacy snapshots", () => {
  const source = new Simulation(configuration("save-envelope"));
  source.advanceTicks(12);
  const encoded = encodeSave(source, 50_000);
  const restored = decodeSave(configuration("save-envelope"), encoded);

  assert.deepEqual(
    restored.serialize(50_000),
    source.serialize(50_000),
  );

  const corrupted = JSON.parse(encoded) as {
    snapshot: { tick: number };
  };
  corrupted.snapshot.tick += 1;
  assert.throws(
    () =>
      decodeSave(
        configuration("save-envelope"),
        JSON.stringify(corrupted),
      ),
    /checksum mismatch/,
  );

  const legacy = {
    ...source.serialize(50_000),
    schemaVersion: 2,
  } as Record<string, unknown>;
  delete legacy.durableEvents;
  const migrated = migrateSnapshot(legacy);
  assert.equal(migrated.schemaVersion, 4);
  assert.deepEqual(migrated.durableEvents, []);
  assert.deepEqual(
    decodeSave(
      configuration("save-envelope"),
      JSON.stringify(legacy),
    ).serialize(50_000),
    source.serialize(50_000),
  );
});

test("offline catch-up is deterministic and respects its cap", () => {
  const offline = new Simulation(configuration("offline"));
  const exact = new Simulation(configuration("offline"));

  const report = offline.advanceOffline(1_000, 151_000);
  exact.advanceTicks(150);

  assert.equal(report.ticksProcessed, 150);
  assert.equal(report.exactTicksProcessed, 150);
  assert.equal(report.requestedTicks, 150);
  assert.equal(report.discardedTicks, 0);
  assert.equal(report.capped, false);
  assert.deepEqual(offline.serialize(151_000), exact.serialize(151_000));
});

test("explicit offline truncation reports discarded ticks without replaying fractions", () => {
  const base = configuration("truncated-offline");
  const simulation = new Simulation({
    ...base,
    maximumOfflineTicks: 100,
    offlineProgressPolicy: "truncate",
  });

  const report = simulation.advanceOffline(1_000, 151_500);

  assert.equal(report.ticksProcessed, 100);
  assert.equal(report.requestedTicks, 150);
  assert.equal(report.discardedTicks, 50);
  assert.equal(report.capped, true);
  assert.equal(report.remainder, 500_000);
});

test("analytical offline models must cover every interlocking system", () => {
  const base = configuration("incomplete-analytical-model");
  assert.throws(
    () =>
      new Simulation({
        ...base,
        analyticalModels: [{
          id: "incomplete",
          coveredSystems: [ORGANIZATION_SYSTEM_ID],
          coveredResources: [],
          coveredEvents: [],
          invariant: () => true,
          tryAdvance: () => undefined,
        }],
      }),
    /must cover every configured system/,
  );
});

interface GrantMoneyPayload extends JsonObject {
  readonly amount: number;
}

test("commands and events communicate through validated resource deltas", () => {
  const grantMoney: CommandHandler<GrantMoneyPayload> = {
    id: systemId("test.grant-money"),
    type: "economy.grant-money",
    reads: [],
    writes: [Resources.Money],
    stateReads: [],
    eventReads: [],
    emits: ["money.granted"],
    handle: (command) => ({
      resources: [
        {
          resource: Resources.Money,
          amount: command.payload.amount,
          reason: "Accepted test grant",
        },
      ],
      events: [
        {
          type: "money.granted",
          payload: { amount: command.payload.amount },
        },
      ],
    }),
  };
  const compilationReward: EventHandler = {
    id: systemId("test.compilation-reward"),
    eventType: "build.completed",
    reads: [],
    writes: [Resources.Money],
    stateReads: [],
    emits: ["reward.recorded"],
    handle: () => ({
      resources: [
        {
          resource: Resources.Money,
          amount: 1,
          reason: "Compilation event reward",
        },
      ],
      events: [{ type: "reward.recorded", payload: { amount: 1 } }],
    }),
  };
  const base = configuration("messages");
  const control = new Simulation(base);
  control.runTick();
  const simulation = new Simulation({
    ...base,
    commandHandlers: [grantMoney],
    eventHandlers: [compilationReward],
  });
  simulation.dispatch({
    id: "grant-1",
    type: "economy.grant-money",
    issuedAt: simTick(1),
    payload: { amount: 75 },
  });

  const result = simulation.runTick();

  assert.deepEqual(result.commandResults, [
    { commandId: "grant-1", accepted: true },
  ]);
  assert.equal(
    simulation.resources.get(Resources.Money),
    control.resources.get(Resources.Money) + 76,
  );
  assert.ok(result.events.some((event) => event.type === "money.granted"));
  assert.ok(!result.events.some((event) => event.type === "reward.recorded"));
  assert.ok(
    simulation.runTick().events.some(
      (event) => event.type === "reward.recorded",
    ),
  );
});

test("offline catch-up preserves partial foreground tick progress", () => {
  const simulation = new Simulation(configuration("partial-offline"));

  simulation.advanceRealTime(500);
  const report = simulation.advanceOffline(1_000, 1_500);

  assert.equal(report.ticksProcessed, 1);
  assert.equal(simulation.tick, 1);
  assert.equal(report.remainder, 0);
});

test("compute is reset each tick instead of becoming stockpiled capacity", () => {
  const simulation = new Simulation(configuration("ephemeral-compute"));

  simulation.runTick();
  const firstRemainder = simulation.resources.get(Resources.Compute);
  simulation.runTick();

  assert.ok(firstRemainder >= 0);
  assert.equal(simulation.resources.get(Resources.Compute), firstRemainder);
});

test("offline reports aggregate events without retaining every event object", () => {
  const simulation = new Simulation(configuration("offline-events"));

  const report = simulation.advanceOffline(0, 10_000);

  assert.equal(report.events.length, 0);
  assert.equal(report.eventCounts["source.batch-generated"], 10);
  assert.ok((report.eventCounts["runtime.deployed"] ?? 0) > 0);
});

test("feedback systems consume outputs and feed revenue and debt retirement", () => {
  const simulation = new Simulation(configuration("feedback"));

  simulation.advanceTicks(100, false);

  const runtime = simulation.getState<{ deployed: number; revenue: number } & JsonObject>(
    RUNTIME_SYSTEM_ID,
  );
  const debt = simulation.getState<{ retired: number } & JsonObject>(
    TECHNICAL_DEBT_SYSTEM_ID,
  );
  assert.ok(runtime.deployed > 0);
  assert.ok(runtime.revenue > 0);
  assert.ok(debt.retired > 0);
  assert.ok(simulation.resources.get(Resources.Knowledge) > 0);
});

interface FailingState extends JsonObject {
  readonly attempts: number;
}

test("a failed tick rolls back all earlier stage mutations", () => {
  const failingSystem: SimulationSystem<FailingState> = {
    id: systemId("test.failure"),
    pipeline: TECHNICAL_DEBT_LAYER_ID,
    phase: SimulationPhase.Maintenance + 1,
    dependsOn: [TECHNICAL_DEBT_SYSTEM_ID],
    reads: [Resources.Money],
    writes: [Resources.Money],
    stateReads: [],
    eventReads: [],
    emits: [],
    initialState: () => ({ attempts: 0 }),
    run: () => ({
      resources: [
        {
          resource: Resources.Money,
          amount: -1_000_000,
          reason: "Force rollback",
        },
      ],
      state: { attempts: 1 },
    }),
  };
  const base = configuration("rollback");
  const simulation = new Simulation({
    ...base,
    systems: [...base.systems, failingSystem],
  });

  assert.throws(() => simulation.runTick(), /Insufficient Money/);
  assert.equal(simulation.tick, 0);
  assert.equal(simulation.resources.get(Resources.Money), 1_000);
  assert.equal(simulation.resources.get(Resources.Compute), 0);
  assert.equal(simulation.getState<FailingState>(failingSystem.id).attempts, 0);
});

test("cyclic event-handler graphs are rejected", () => {
  const first: EventHandler = {
    id: systemId("test.event-a"),
    eventType: "event.a",
    reads: [],
    writes: [],
    stateReads: [],
    emits: ["event.b"],
    handle: () => ({ events: [{ type: "event.b", payload: {} }] }),
  };
  const second: EventHandler = {
    id: systemId("test.event-b"),
    eventType: "event.b",
    reads: [],
    writes: [],
    stateReads: [],
    emits: ["event.a"],
    handle: () => ({ events: [{ type: "event.a", payload: {} }] }),
  };
  const base = configuration("event-cycle");

  assert.throws(
    () =>
      new Simulation({
        ...base,
        eventHandlers: [first, second],
      }),
    /Event handler graph contains a cycle/,
  );
});

test("research content cycles and invalid initial selections are rejected", () => {
  assert.throws(
    () =>
      createKnowledgeResearchLayer({
        projects: [
          {
            id: "a",
            requiredProgress: 1,
            insightPerProgress: 1,
            moneyPerProgress: 0,
            knowledgeReward: 1,
            dependencies: ["b"],
          },
          {
            id: "b",
            requiredProgress: 1,
            insightPerProgress: 1,
            moneyPerProgress: 0,
            knowledgeReward: 1,
            dependencies: ["a"],
          },
        ],
        initialProjectId: "a",
        progressPerTick: 1,
      }),
    /Research project graph contains a cycle/,
  );

  assert.throws(
    () =>
      createKnowledgeResearchLayer({
        projects: [],
        initialProjectId: "missing",
        progressPerTick: 1,
      }),
    /Unknown initial research project/,
  );
});

test("artifact and debt cohorts remain bounded and preserve shared totals", () => {
  const simulation = new Simulation(configuration("cohorts"));

  simulation.advanceTicks(500, false);

  const build = simulation.getState<{
    readonly sourceCohorts: readonly JsonObject[];
    readonly binaryCohortsCreated: number;
  } & JsonObject>(COMPILATION_SYSTEM_ID);
  const testing = simulation.getState<{
    readonly binaryCohorts: readonly JsonObject[];
    readonly releaseCohortsCreated: number;
  } & JsonObject>(TESTING_SYSTEM_ID);
  const runtime = simulation.getState<{
    readonly releaseCohorts: readonly JsonObject[];
  } & JsonObject>(RUNTIME_SYSTEM_ID);
  const debt = simulation.getState<{
    readonly principalByCategory: Readonly<Record<string, number>>;
  } & JsonObject>(TECHNICAL_DEBT_SYSTEM_ID);

  assert.ok(build.binaryCohortsCreated > 0);
  assert.ok(testing.releaseCohortsCreated > 0);
  assert.ok(build.sourceCohorts.length <= 256);
  assert.ok(testing.binaryCohorts.length <= 256);
  assert.ok(runtime.releaseCohorts.length <= 256);
  const pendingSource = simulation
    .serialize(500_000)
    .pendingEvents.filter(
      (event) => event.type === "automation.source-generated",
    )
    .map((event) =>
      parseSourceArtifact(payloadField(event.payload, "artifact")),
    )
    .filter((artifact) => artifact !== undefined)
    .reduce((total, artifact) => total + artifact.quantity, 0);
  assert.equal(
    build.sourceCohorts.reduce(
      (total, cohort) => total + Number(cohort.quantity),
      0,
    ),
    simulation.resources.get(Resources.Source) - pendingSource,
  );
  assert.equal(
    testing.binaryCohorts.reduce(
      (total, cohort) => total + Number(cohort.quantity),
      0,
    ),
    simulation.resources.get(Resources.Binaries),
  );
  assert.equal(
    runtime.releaseCohorts.reduce(
      (total, cohort) => total + Number(cohort.quantity),
      0,
    ),
    simulation.resources.get(Resources.Releases),
  );
  assert.equal(
    Object.values(debt.principalByCategory).reduce(
      (total, principal) => total + principal,
      0,
    ),
    simulation.resources.get(Resources.TechnicalDebt),
  );
});

interface DeliveryState extends JsonObject {
  readonly observed: number;
}

test("next-tick and durable events survive snapshots and require acknowledgement", () => {
  const deliveryPipeline = pipelineId("test.delivery-pipeline");
  const deliverySystemId = systemId("test.delivery-reader");
  const reader: SimulationSystem<DeliveryState> = {
    id: deliverySystemId,
    pipeline: deliveryPipeline,
    phase: SimulationPhase.Source,
    dependsOn: [],
    reads: [],
    writes: [],
    stateReads: [],
    eventReads: ["test.next", "test.durable"],
    emits: [],
    initialState: () => ({ observed: 0 }),
    run: (view) => ({
      statePatch: {
        observed:
          view.getSystemState<DeliveryState>(deliverySystemId).observed +
          view.events.length,
      },
      acknowledgedEventSequences: view.events
        .filter((event) => event.delivery === "durable")
        .map((event) => event.sequence),
    }),
  };
  const emitter: CommandHandler = {
    id: systemId("test.delivery-emitter"),
    type: "test.emit-delayed",
    reads: [],
    writes: [],
    stateReads: [],
    eventReads: [],
    emits: ["test.next", "test.durable"],
    handle: () => ({
      events: [
        { type: "test.next", delivery: "nextTick", payload: {} },
        { type: "test.durable", delivery: "durable", payload: {} },
      ],
    }),
  };
  const deliveryConfiguration: SimulationConfiguration = {
    seed: "delivery",
    gameVersion: "test",
    contentHash: "delivery",
    resources: CORE_RESOURCE_DEFINITIONS,
    systems: [reader],
    pipelines: [
      {
        id: deliveryPipeline,
        displayName: "Delivery",
        inputs: [],
        outputs: [],
      },
    ],
    commandHandlers: [emitter],
  };
  const simulation = new Simulation(deliveryConfiguration);
  simulation.dispatch({
    id: "emit",
    type: "test.emit-delayed",
    issuedAt: simTick(1),
    payload: {},
  });

  assert.equal(simulation.runTick().events.length, 0);
  const restored = Simulation.restore(
    deliveryConfiguration,
    simulation.serialize(1_000),
  );
  const delivered = restored.runTick();

  assert.deepEqual(
    delivered.events.map((event) => event.type).sort(),
    ["test.durable", "test.next"],
  );
  assert.equal(
    restored.getState<DeliveryState>(deliverySystemId).observed,
    2,
  );
  assert.equal(restored.runTick().events.length, 0);
});

test("forced cohort compaction preserves weighted metadata", () => {
  const cohorts = appendBoundedCohort(
    [
      { id: "low", quantity: 3, riskPermille: 100 },
      { id: "high", quantity: 1, riskPermille: 900 },
    ],
    { id: "new", quantity: 1, riskPermille: 500 },
    2,
    (left, right) => left.riskPermille === right.riskPermille,
    (left, right) => ({
      ...left,
      quantity: left.quantity + right.quantity,
    }),
    (left, right) => ({
      id: "weighted",
      quantity: left.quantity + right.quantity,
      riskPermille: weightedPermille(
        left.riskPermille,
        left.quantity,
        right.riskPermille,
        right.quantity,
      ),
    }),
  );

  assert.equal(cohorts.length, 2);
  assert.deepEqual(cohorts[0], {
    id: "weighted",
    quantity: 4,
    riskPermille: 300,
  });
});

interface StableFlowState extends JsonObject {
  readonly produced: number;
}

test("offline analytical models exactly batch stable active flows", () => {
  const flowPipeline = pipelineId("test.stable-flow-pipeline");
  const flowSystemId = systemId("test.stable-flow");
  const flowSystem: SimulationSystem<StableFlowState> = {
    id: flowSystemId,
    pipeline: flowPipeline,
    phase: SimulationPhase.Source,
    dependsOn: [],
    reads: [],
    writes: [Resources.Money],
    stateReads: [],
    eventReads: [],
    emits: ["test.flow-produced"],
    initialState: () => ({ produced: 0 }),
    run: (view) => ({
      resources: [
        {
          resource: Resources.Money,
          amount: 2,
          reason: "Stable analytical flow",
        },
      ],
      statePatch: {
        produced:
          view.getSystemState<StableFlowState>(flowSystemId).produced + 1,
      },
      events: [{ type: "test.flow-produced", payload: { amount: 2 } }],
    }),
  };
  const model = createFixedRateAnalyticalModel({
    id: "test.stable-flow-model",
    coveredSystems: [flowSystemId],
    coveredResources: [Resources.Money],
    coveredEvents: ["test.flow-produced"],
    invariant: () => true,
    isApplicable: () => true,
    resourceRates: [
      {
        resource: Resources.Money,
        amount: 2,
        reason: "Analytical stable flow",
      },
    ],
    stateCounters: [
      {
        system: flowSystemId,
        field: "produced",
        amountPerTick: 1,
      },
    ],
    eventRates: { "test.flow-produced": 1 },
  });
  const base: SimulationConfiguration = {
    seed: "stable-flow",
    gameVersion: "test",
    contentHash: "stable-flow",
    tickDurationMs: 1_000,
    maximumOfflineTicks: 100,
    resources: CORE_RESOURCE_DEFINITIONS,
    systems: [flowSystem],
    pipelines: [
      {
        id: flowPipeline,
        displayName: "Stable Flow",
        inputs: [],
        outputs: [Resources.Money],
      },
    ],
  };
  const exact = new Simulation(base);
  const analytical = new Simulation({
    ...base,
    analyticalModels: [model],
  });

  exact.advanceTicks(100, false);
  const report = analytical.advanceOffline(0, 100_000);

  assert.equal(report.analyticalTicksSkipped, 99);
  assert.equal(report.exactTicksProcessed, 1);
  assert.equal(report.eventCounts["test.flow-produced"], 100);
  assert.deepEqual(
    analytical.serialize(100_000),
    exact.serialize(100_000),
  );

  const rejectedModel = createFixedRateAnalyticalModel({
    id: "test.rejected-stable-flow",
    coveredSystems: [flowSystemId],
    coveredResources: [Resources.Money],
    coveredEvents: ["test.flow-produced"],
    invariant: () => false,
    isApplicable: () => true,
    resourceRates: [{
      resource: Resources.Money,
      amount: 2,
      reason: "Rejected analytical flow",
    }],
    stateCounters: [{
      system: flowSystemId,
      field: "produced",
      amountPerTick: 1,
    }],
    eventRates: { "test.flow-produced": 1 },
  });
  const fallback = new Simulation({
    ...base,
    analyticalModels: [rejectedModel],
  });
  const fallbackReport = fallback.advanceOffline(0, 10_000);
  assert.equal(fallbackReport.analyticalTicksSkipped, 0);
  assert.equal(fallback.resources.get(Resources.Money), 20);
});

test("balance data can be tuned from JSON without code changes", () => {
  const editable = JSON.parse(
    JSON.stringify(DEFAULT_CORE_BALANCE_CONFIG),
  ) as {
    sourceGeneration: { humanProductivity: number };
  };
  editable.sourceGeneration.humanProductivity = 20;
  const balance = parseCoreBalanceConfig(JSON.stringify(editable));
  const tunedModules = createCoreSimulationModules(balance);
  const tuned = new Simulation({
    seed: "tuned-balance",
    gameVersion: "test",
    contentHash: "tuned",
    resources: CORE_RESOURCE_DEFINITIONS,
    initialResources: { [Resources.Money]: 1_000 },
    systems: tunedModules.systems,
    pipelines: tunedModules.pipelines,
    commandHandlers: tunedModules.commandHandlers,
    eventHandlers: tunedModules.eventHandlers,
  });

  tuned.runTick();

  assert.equal(balance.sourceGeneration.humanProductivity, 20);
  assert.throws(
    () => parseCoreBalanceConfig('{"balanceVersion":1}'),
    /section organization/,
  );
  assert.ok(
    tuned.getState<{ readonly humanAuthored: number } & JsonObject>(
      SOURCE_GENERATION_SYSTEM_ID,
    ).humanAuthored > 0,
  );

  const automatic = createCoreSimulationConfiguration(
    { seed: "automatic-hash", gameVersion: "test" },
    balance,
  );
  const baseline = createCoreSimulationConfiguration({
    seed: "automatic-hash",
    gameVersion: "test",
  });
  assert.notEqual(automatic.contentHash, baseline.contentHash);

  const invalid = JSON.parse(
    JSON.stringify(DEFAULT_CORE_BALANCE_CONFIG),
  ) as { testing: { suites: unknown[] } };
  invalid.testing.suites = [];
  assert.throws(
    () =>
      createCoreSimulationModules(
        invalid as unknown as typeof DEFAULT_CORE_BALANCE_CONFIG,
      ),
    /At least one test suite/,
  );
});

test("diagnostics expose debt, pipeline, and productivity projections", () => {
  const simulation = new Simulation(configuration("diagnostics"));
  simulation.advanceTicks(25, false);

  const diagnostics = createSimulationDiagnostics(simulation);
  const pipelineIds = new Set(
    diagnostics.pipeline.nodes.map((node) => node.id),
  );

  assert.equal(diagnostics.tick, simulation.tick);
  assert.equal(
    diagnostics.debt.total,
    simulation.resources.get(Resources.TechnicalDebt),
  );
  assert.ok(diagnostics.debt.heatmap.length > 0);
  assert.ok(diagnostics.pipeline.nodes.length >= 9);
  assert.ok(diagnostics.pipeline.systems.length >= 11);
  assert.ok(diagnostics.pipeline.rollingBottlenecks.length >= 11);
  const blockedBase = configuration("blocked-diagnostics");
  const blocked = new Simulation({
    ...blockedBase,
    initialResources: { [Resources.Money]: 0 },
    metricsSampleIntervalTicks: 1,
  });
  blocked.runTick();
  assert.ok(
    createSimulationDiagnostics(blocked).pipeline.rollingBottlenecks.some(
      (metric) => metric.blockedTicks > 0 && metric.lastBottleneck !== null,
    ),
  );
  assert.ok(
    diagnostics.pipeline.edges.every(
      (edge) => pipelineIds.has(edge.from) && pipelineIds.has(edge.to),
    ),
  );
  assert.ok(diagnostics.productivity.teams.length > 0);
  assert.ok(diagnostics.productivity.swarms.length > 0);
  assert.ok(diagnostics.productivity.sourceGenerated > 0);
});

test("AI allocation policy controls funded agent capacity", () => {
  const simulation = new Simulation(configuration("ai-policy"));
  simulation.dispatch({
    id: "disable-ai",
    type: "organization.set-policy",
    issuedAt: simTick(1),
    payload: {
      policy: {
        aiAllocationPermille: 0,
        maintenanceAllocationPermille: 200,
        reviewStrengthPermille: 500,
        testStrengthPermille: 500,
        codingStandardsPermille: 600,
        riskTolerancePermille: 300,
        releaseCadencePermille: 500,
      },
    },
  });

  simulation.runTick();

  assert.equal(simulation.resources.get(Resources.AgentCapacity), 0);
  assert.equal(
    simulation.getState<{
      readonly policy: { readonly aiAllocationPermille: number } & JsonObject;
    } & JsonObject>(ORGANIZATION_SYSTEM_ID).policy.aiAllocationPermille,
    0,
  );
});

test("team policy is carried by source cohorts and morale persists", () => {
    const simulation = new Simulation(configuration("team-policy"));
    simulation.dispatch({
      id: "strict-team",
      type: "organization.set-team-policy",
      issuedAt: simTick(1),
      payload: {
        teamId: "platform-team",
        policy: {
          aiAllocationPermille: 500,
          maintenanceAllocationPermille: 200,
          reviewStrengthPermille: 900,
          testStrengthPermille: 900,
          codingStandardsPermille: 1_000,
          riskTolerancePermille: 0,
          releaseCadencePermille: 200,
        },
      },
    });

    const result = simulation.runTick();
    const sourceEvent = result.events.find(
      (event) => event.type === "source.batch-generated",
    );
    assert.ok(sourceEvent !== undefined);
    const artifacts = payloadField(sourceEvent.payload, "artifacts");
    assert.ok(Array.isArray(artifacts));
    const teamArtifact = artifacts
      .map(parseSourceArtifact)
      .find((artifact) => artifact?.teamId === "platform-team");
    assert.equal(teamArtifact?.codingStandardsPermille, 1_000);
    assert.equal(teamArtifact?.riskTolerancePermille, 0);
    assert.equal(teamArtifact?.releaseCadencePermille, 200);
    assert.equal(teamArtifact?.reviewStrengthPermille, 900);
    assert.equal(teamArtifact?.testStrengthPermille, 900);
    assert.notEqual(
      simulation.getState<{
        readonly teams: readonly { readonly moralePermille: number }[];
      } & JsonObject>(ORGANIZATION_SYSTEM_ID).teams[0]?.moralePermille,
      850,
    );
});

test("crisis episodes escalate and conserve scalar severity", () => {
  const base = configuration("crisis-conservation");
  const simulation = new Simulation({
    ...base,
    initialResources: {
      [Resources.Money]: 1_000,
      [Resources.AgentInstability]: 10_000,
    },
  });
  simulation.dispatch({
    id: "disable-crisis-response",
    type: "crisis.set-protocol",
    issuedAt: simTick(1),
    payload: {
      protocol: {
        automaticResponsePermille: 0,
        outageThreshold: 3,
        debtThreshold: 100,
        rebellionThreshold: 100,
        shutdownAutomationAtSeverity: 1_000_000_000,
      },
    },
  });

  const severities: number[] = [];
  for (let tick = 0; tick < 20; tick += 1) {
    simulation.runTick();
    const crisis = simulation.getState<{
      readonly episodes: readonly {
        readonly severity: number;
        readonly status: string;
      }[];
    } & JsonObject>(CRISIS_SYSTEM_ID);
    const episodeSeverity = crisis.episodes.reduce(
      (total, episode) =>
        total + (episode.status === "resolved" ? 0 : episode.severity),
      0,
    );
    assert.equal(
      episodeSeverity,
      simulation.resources.get(Resources.CrisisSeverity),
    );
    severities.push(episodeSeverity);
  }
  assert.ok(severities.at(-1)! > severities[0]!);
});

test("confidence is ephemeral and reputation remains bounded", () => {
  const simulation = new Simulation(configuration("bounded-feedback"));

  simulation.advanceTicks(2_000, false);

  assert.ok(simulation.resources.get(Resources.TestConfidence) <= 8);
  assert.ok(simulation.resources.get(Resources.Reputation) <= 1_000);
});

test("offline progression analytically skips proven quiescent ticks", () => {
  const simulation = new Simulation({
    seed: "quiescent",
    gameVersion: "test",
    contentHash: "empty",
    tickDurationMs: 1_000,
    maximumOfflineTicks: 10_000,
    resources: CORE_RESOURCE_DEFINITIONS,
    systems: [],
    pipelines: [],
  });

  const report = simulation.advanceOffline(0, 10_000_000);

  assert.equal(report.ticksProcessed, 10_000);
  assert.equal(report.analyticalTicksSkipped, 9_999);
  assert.equal(simulation.tick, 10_000);
});

test("player policies produce stable automation or a runaway singularity", () => {
  const stable = new Simulation(configuration("stable-automation"));
  const runaway = new Simulation(configuration("runaway-automation"));

  runaway.dispatch({
    id: "runaway-policy",
    type: "organization.set-policy",
    issuedAt: simTick(1),
    payload: {
      policy: {
        aiAllocationPermille: 1_000,
        maintenanceAllocationPermille: 0,
        reviewStrengthPermille: 0,
        testStrengthPermille: 0,
        codingStandardsPermille: 0,
        riskTolerancePermille: 1_000,
        releaseCadencePermille: 1_000,
      },
    },
  });

  runaway.dispatch({
    id: "runaway-swarm",
    type: "organization.configure-swarm",
    issuedAt: simTick(1),
    payload: {
      swarmId: "compiler-swarm",
      autonomyPermille: 1_000,
      alignmentPermille: 700,
    },
  });
  runaway.dispatch({
    id: "runaway-deployments",
    type: "runtime.set-deployment-strategy",
    issuedAt: simTick(1),
    payload: { strategy: "hot" },
  });
  runaway.dispatch({
    id: "disable-circuit-breaker",
    type: "crisis.set-protocol",
    issuedAt: simTick(1),
    payload: {
      protocol: {
        automaticResponsePermille: 0,
        outageThreshold: 1,
        debtThreshold: 20,
        rebellionThreshold: 100,
        shutdownAutomationAtSeverity: 1_000_000_000,
      },
    },
  });

  stable.advanceTicks(300, false);
  runaway.advanceTicks(300, false);

  assert.ok(
    runaway.resources.get(Resources.AutomationPower) >
      stable.resources.get(Resources.AutomationPower) * 10,
  );
  assert.ok(
    runaway.resources.get(Resources.HotDeployRequests) <=
      MAX_HOT_DEPLOY_REQUESTS,
  );
  assert.equal(
    runaway.getState<{
      readonly episodes: readonly {
        readonly kind: string;
        readonly status: string;
      }[];
    } & JsonObject>(CRISIS_SYSTEM_ID).episodes.filter(
      (episode) =>
        episode.kind === "rebellion" && episode.status !== "resolved",
    ).length,
    1,
  );
  assert.ok(
    runaway.resources.get(Resources.AgentInstability) >
      stable.resources.get(Resources.AgentInstability),
  );
  assert.ok(
    runaway.resources.get(Resources.CrisisSeverity) >
      stable.resources.get(Resources.CrisisSeverity),
  );
  assert.ok(
    runaway.getState<{ readonly peakPower: number } & JsonObject>(
      AUTOMATION_SYSTEM_ID,
    ).peakPower >
      stable.getState<{ readonly peakPower: number } & JsonObject>(
        AUTOMATION_SYSTEM_ID,
      ).peakPower,
  );
  assert.ok(
    runaway.getState<{ readonly rebellions: number } & JsonObject>(
      CRISIS_SYSTEM_ID,
    ).rebellions > 0,
  );
});

test("vertical slice demonstrates the complete playable loop", () => {
  const game = createVerticalSliceGame("vertical-slice-test");
  hireAgents(game, 3);
  game.advanceTicks(12, false);
  const fast = getVerticalSliceStatus(game);

  assert.equal(fast.agents, 3);
  assert.ok(fast.binaries > 0);
  assert.ok(fast.totalComputeGenerated > 12 * 4);
  assert.ok(fast.technicalDebt > 0);
  assert.ok(fast.debtPenalty > 0);
  assert.ok(fast.compileThroughput < 8);

  setStrictPolicy(game, true);
  game.advanceTicks(5, false);
  const strict = getVerticalSliceStatus(game);
  assert.equal(strict.strictPolicy, true);
  assert.equal(strict.technicalDebt, fast.technicalDebt);

  const savedAt = 5_000;
  const saved = saveVerticalSlice(game, savedAt);
  const restored = loadVerticalSlice(saved, "vertical-slice-test");
  assert.deepEqual(
    getVerticalSliceStatus(restored),
    getVerticalSliceStatus(game),
  );

  const offline = restored.advanceOffline(savedAt, savedAt + 10_000);
  assert.equal(offline.ticksProcessed, 10);
  assert.ok(
    getVerticalSliceStatus(restored).compiledTotal > strict.compiledTotal,
  );
});
