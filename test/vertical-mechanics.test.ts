import assert from "node:assert/strict";
import test from "node:test";
import { configuration, getGameView, issueCommand } from "../src/app/game.js";
import { SimulationWorkerRuntime } from "../src/app/worker-runtime.js";
import {
  COMPILATION_SYSTEM_ID, CRISIS_SYSTEM_ID, DEFAULT_CORE_BALANCE_CONFIG,
  ORGANIZATION_SYSTEM_ID, Resources, TECHNICAL_DEBT_SYSTEM_ID,
  Simulation, decodeSave, encodeSave, migrateSnapshot,
  createCoreSimulationConfiguration, simTick,
  type BuildState, type CrisisState, type OrganizationState, type TechnicalDebtState,
} from "../src/simulation/index.js";

function funded() {
  return new Simulation({ ...configuration, initialResources: { [Resources.Money]: 100_000, [Resources.Demand]: 40 } });
}

function unfunded() {
  return new Simulation({ ...configuration, initialResources: { [Resources.Money]: 0, [Resources.Demand]: 40 } });
}

test("manual jobs prioritize existing source, share hardware with automatic builds, and survive save/offline", () => {
  const game = funded();
  const automatic = funded();
  const queued = issueCommand(game, "build.start-job", { quantity: 1 });
  assert.equal(queued.accepted, true);
  automatic.runTick();
  const run = game.getState<BuildState>(COMPILATION_SYSTEM_ID).lastRun;
  assert.equal(run?.manualSource, 1);
  assert.ok((run?.automaticSource ?? 0) > 0, "unused build capacity must continue automatic flow");
  assert.equal(run!.manualSource + run!.automaticSource,
    game.getState<BuildState>(COMPILATION_SYSTEM_ID).compiled);
  assert.deepEqual(game.serialize(1_000).resources, automatic.serialize(1_000).resources,
    "a queued job labels actual source work; it must not spawn source or duplicate resources");
  assert.equal(game.getState<BuildState>(COMPILATION_SYSTEM_ID).jobs?.length, 0);
  assert.ok(game.getImportantEvents().some((event) => event.type === "build.job-completed"));
  assert.equal(issueCommand(game, "build.start-job", { quantity: 256 }).accepted, true);
  const snapshot = encodeSave(game, 5_000);
  const restored = decodeSave(configuration, snapshot);
  assert.deepEqual(restored.getState<BuildState>(COMPILATION_SYSTEM_ID).jobs,
    game.getState<BuildState>(COMPILATION_SYSTEM_ID).jobs);
  restored.advanceOffline(5_000, 10_000);
  game.advanceOffline(5_000, 10_000);
  assert.deepEqual(restored.serialize(10_000), game.serialize(10_000));
});

test("manual queue is bounded, reorderable and cancelable without reserving or fabricating source", () => {
  const game = unfunded();
  const sourceBefore = game.resources.get(Resources.Source);
  assert.equal(issueCommand(game, "build.start-job", { quantity: 1 }).accepted, true);
  assert.equal(issueCommand(game, "build.start-job", { quantity: 4 }).accepted, true);
  assert.equal(issueCommand(game, "build.start-job", { quantity: 2 }).accepted, true);
  let jobs = game.getState<BuildState>(COMPILATION_SYSTEM_ID).jobs!;
  assert.deepEqual(jobs.map((job) => job.id), ["job:1", "job:2", "job:3"]);
  assert.equal(issueCommand(game, "build.prioritize-job", { jobId: "job:3" }).accepted, true);
  assert.deepEqual(game.getState<BuildState>(COMPILATION_SYSTEM_ID).jobs?.map((job) => job.id),
    ["job:3", "job:1", "job:2"]);
  assert.equal(issueCommand(game, "build.reorder-job", { jobId: "job:1", direction: 1 }).accepted, true);
  assert.deepEqual(game.getState<BuildState>(COMPILATION_SYSTEM_ID).jobs?.map((job) => job.id),
    ["job:3", "job:2", "job:1"]);
  for (const payload of [
    { jobId: "job:3", direction: -1 }, { jobId: "job:1", direction: 2 },
    { jobId: "missing", direction: 1 },
  ]) assert.equal(issueCommand(game, "build.reorder-job", payload).accepted, false);
  assert.equal(issueCommand(game, "build.cancel-job", { jobId: "job:2" }).accepted, true);
  assert.equal(issueCommand(game, "build.cancel-job", { jobId: "job:2" }).accepted, false);
  assert.equal(issueCommand(game, "build.start-job", { quantity: 257 }).accepted, false);
  assert.equal(game.resources.get(Resources.Source), sourceBefore);
  jobs = game.getState<BuildState>(COMPILATION_SYSTEM_ID).jobs!;
  assert.deepEqual(jobs.map((job) => job.id), ["job:3", "job:1"]);
  const saved = game.serialize(11_000);
  const refueled = Simulation.restore(configuration, {
    ...saved, resources: { ...saved.resources, [Resources.Money]: 100_000 },
  });
  refueled.runTick();
  assert.equal(refueled.getState<BuildState>(COMPILATION_SYSTEM_ID).jobs?.length, 0);
  assert.equal(refueled.getState<BuildState>(COMPILATION_SYSTEM_ID).lastRun?.manualSource, 3);
  assert.ok((refueled.getState<BuildState>(COMPILATION_SYSTEM_ID).lastRun?.automaticSource ?? 0) > 0);

  const full = unfunded();
  for (let i = 0; i < 16; i += 1) {
    assert.equal(issueCommand(full, "build.start-job", { quantity: 1 }).accepted, true);
  }
  assert.match(issueCommand(full, "build.start-job", { quantity: 1 }).reason ?? "", /queue is full/);
  const unitBound = unfunded();
  for (let i = 0; i < 4; i += 1) {
    assert.equal(issueCommand(unitBound, "build.start-job", { quantity: 250 }).accepted, true);
  }
  assert.match(issueCommand(unitBound, "build.start-job", { quantity: 1 }).reason ?? "", /queue is full/);
});

test("failed manual builds debit real source and record failed job units instead of awarding binaries", () => {
  const balance = {
    ...DEFAULT_CORE_BALANCE_CONFIG,
    build: {
      ...DEFAULT_CORE_BALANCE_CONFIG.build,
      stages: DEFAULT_CORE_BALANCE_CONFIG.build.stages.map((stage) =>
        ({ ...stage, failureChancePermille: 1_000 })),
    },
  };
  const game = new Simulation(createCoreSimulationConfiguration({
    seed: "forced-build-failure", gameVersion: "0.0.1",
    initialResources: { [Resources.Money]: 100_000 },
  }, balance));
  assert.equal(issueCommand(game, "build.start-job", { quantity: 4 }).accepted, true);
  const run = game.getState<BuildState>(COMPILATION_SYSTEM_ID).lastRun!;
  const event = game.getImportantEvents().find((entry) => entry.type === "build.job-completed");
  assert.equal(run.manualSource, 4);
  assert.equal(run.failed, true);
  assert.ok(event);
  assert.deepEqual(event?.payload, {
    jobId: "job:1", requested: 4, succeededUnits: 0, failedUnits: 4,
  });
  assert.ok(game.resources.get(Resources.Source) >= 0);
  assert.equal(game.getState<BuildState>(COMPILATION_SYSTEM_ID).jobs?.length, 0);
});

test("manual debt work spends actual category capacity and money before automatic remediation", () => {
  const game = funded();
  const noMaintenance = { ...getGameView(game).policy, maintenanceAllocationPermille: 0 };
  assert.equal(issueCommand(game, "organization.set-policy", { policy: noMaintenance }).accepted, true);
  game.advanceTicks(60);
  assert.ok(game.resources.get(Resources.TechnicalDebt) > 0);
  const maintenance = { ...noMaintenance, maintenanceAllocationPermille: 900 };
  assert.equal(issueCommand(game, "organization.set-policy", { policy: maintenance }).accepted, true);
  const principal = game.getState<TechnicalDebtState>(TECHNICAL_DEBT_SYSTEM_ID).principalByCategory;
  const categoryId = Object.entries(principal).sort((left, right) => right[1] - left[1])[0]![0];
  assert.equal(issueCommand(game, "debt.pay-down", { categoryId, amount: 5 }).accepted, true);
  const report = game.getState<TechnicalDebtState>(TECHNICAL_DEBT_SYSTEM_ID).lastManualPaydown!;
  assert.equal(report.categoryId, categoryId);
  assert.equal(report.requested, 5);
  assert.ok(report.retired > 0);
  assert.ok(report.capacitySpent > 0);
  assert.equal(report.moneySpent, report.retired * getGameView(game).debtTerms.moneyPerDebtRetired);
  assert.ok(game.getImportantEvents().some((event) =>
    event.type === "debt.manual-paydown" && event.payload !== null));
  assert.ok((game.getState<TechnicalDebtState>(TECHNICAL_DEBT_SYSTEM_ID).lastRemediation?.retired ?? 0) >= report.retired);
  assert.ok((game.getState<TechnicalDebtState>(TECHNICAL_DEBT_SYSTEM_ID).lastRemediation?.capacitySpent ?? 0) >= report.capacitySpent);
  assert.equal(issueCommand(game, "debt.pay-down", { categoryId: "unknown", amount: 1 }).accepted, false);
  assert.equal(issueCommand(game, "debt.pay-down", { categoryId, amount: 1_001 }).accepted, false);
  const resumed = decodeSave(configuration, encodeSave(game, 25_000));
  game.advanceOffline(25_000, 30_000);
  resumed.advanceOffline(25_000, 30_000);
  assert.deepEqual(resumed.serialize(30_000), game.serialize(30_000));
});

test("two debt commands in one tick reject the second instead of overwriting the first", () => {
  const game = funded();
  const policy = { ...getGameView(game).policy, maintenanceAllocationPermille: 0 };
  assert.equal(issueCommand(game, "organization.set-policy", { policy }).accepted, true);
  game.advanceTicks(10);
  const categoryId = game.getState<TechnicalDebtState>(TECHNICAL_DEBT_SYSTEM_ID).categories[0]!.id;
  game.dispatch({
    id: "first", type: "debt.pay-down", issuedAt: simTick(game.tick + 1),
    payload: { categoryId, amount: 1 },
  });
  game.dispatch({
    id: "second", type: "debt.pay-down", issuedAt: simTick(game.tick + 1),
    payload: { categoryId, amount: 2 },
  });
  const results = game.runTick().commandResults;
  assert.deepEqual(results.map((result) => result.accepted), [true, false]);
  assert.match(results[1]?.reason ?? "", /already scheduled/);
  assert.equal(game.getState<TechnicalDebtState>(TECHNICAL_DEBT_SYSTEM_ID).lastManualPaydown?.requested, 1);
});

test("global and team policy controls alter actual funded maintenance and delivery", () => {
  const baseline = funded();
  const local = funded();
  const policy = { ...getGameView(local).policy, maintenanceAllocationPermille: 850 };
  assert.equal(issueCommand(local, "organization.set-team-policy", {
    teamId: "platform-team", policy,
  }).accepted, true);
  baseline.runTick();
  assert.equal(getGameView(local).teamPolicies["platform-team"]?.maintenanceAllocationPermille, 850);
  assert.ok((local.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID).teamAllocations[0]?.capacity ?? 0) <
    (baseline.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID).teamAllocations[0]?.capacity ?? 0));
  assert.ok((local.getState<TechnicalDebtState>(TECHNICAL_DEBT_SYSTEM_ID).lastRemediation?.availableCapacity ?? 0) >
    (baseline.getState<TechnicalDebtState>(TECHNICAL_DEBT_SYSTEM_ID).lastRemediation?.availableCapacity ?? 0));
  assert.equal(issueCommand(local, "organization.clear-team-policy", { teamId: "platform-team" }).accepted, true);
  assert.equal(getGameView(local).teamPolicies["platform-team"], undefined);
  assert.equal(issueCommand(local, "organization.clear-team-policy", { teamId: "platform-team" }).accepted, false);
  assert.deepEqual(local.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID).teamAllocations[0]?.policy,
    local.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID).policy);
});

test("training raises a real team skill, charges credits, rejects malformed skills and caps", () => {
  const game = funded();
  const before = game.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID).teams[0]!.skillTree.research;
  assert.equal(issueCommand(game, "organization.train-team", {
    teamId: "platform-team", skill: "research", amount: 10,
  }).accepted, true);
  assert.equal(game.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID).teams[0]!.skillTree.research, before + 10);
  assert.equal(issueCommand(game, "organization.train-team", {
    teamId: "platform-team", skill: "unknown", amount: 10,
  }).accepted, false);
  assert.equal(issueCommand(game, "organization.train-team", {
    teamId: "platform-team", skill: "research", amount: 101,
  }).accepted, false);
  for (let i = 0; i < 14; i += 1) {
    assert.equal(issueCommand(game, "organization.train-team", {
      teamId: "platform-team", skill: "research", amount: 100,
    }).accepted, true);
  }
  assert.match(issueCommand(game, "organization.train-team", {
    teamId: "platform-team", skill: "research", amount: 100,
  }).reason ?? "", /skill cap/);
  const snapshot = encodeSave(game, 1_000);
  assert.equal(decodeSave(configuration, snapshot).getState<OrganizationState>(ORGANIZATION_SYSTEM_ID)
    .teams[0]?.skillTree.research, before + 1_410);
});

test("swarm alignment settings change funded agent output rather than only a label", () => {
  const baseline = funded();
  const changed = funded();
  baseline.runTick();
  assert.equal(issueCommand(changed, "organization.configure-swarm", {
    swarmId: "compiler-swarm", autonomyPermille: 400, alignmentPermille: 0,
  }).accepted, true);
  assert.ok((getGameView(baseline).diagnostics.productivity.swarms[0]?.effectiveCapacity ?? 0) >
    (getGameView(changed).diagnostics.productivity.swarms[0]?.effectiveCapacity ?? 0));
  assert.equal(changed.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID).agentSwarms[0]?.alignmentPermille, 0);
  assert.equal(issueCommand(changed, "organization.configure-swarm", {
    swarmId: "compiler-swarm", autonomyPermille: 400, alignmentPermille: 1_001,
  }).accepted, false);
});

test("crisis response controls affect budget and recorded containment under the same trigger", () => {
  const balance = {
    ...DEFAULT_CORE_BALANCE_CONFIG,
    crisis: {
      initialProtocol: { ...DEFAULT_CORE_BALANCE_CONFIG.crisis.initialProtocol, debtThreshold: 1 },
    },
  };
  const config = createCoreSimulationConfiguration({
    seed: "crisis-response-policy", gameVersion: "0.0.1",
    initialResources: { [Resources.Money]: 100_000, [Resources.TechnicalDebt]: 100 },
  }, balance);
  const automatic = new Simulation(config);
  const disabled = new Simulation(config);
  assert.equal(issueCommand(automatic, "crisis.set-protocol", { protocol: {
    ...balance.crisis.initialProtocol, automaticResponsePermille: 1_000,
  } }).accepted, true);
  assert.equal(issueCommand(disabled, "crisis.set-protocol", { protocol: {
    ...balance.crisis.initialProtocol, automaticResponsePermille: 0,
  } }).accepted, true);
  automatic.advanceTicks(5);
  disabled.advanceTicks(5);
  assert.ok(automatic.getState<CrisisState>(CRISIS_SYSTEM_ID).resolvedSeverity >
    disabled.getState<CrisisState>(CRISIS_SYSTEM_ID).resolvedSeverity);
  assert.ok(automatic.getImportantEvents().some((event) => event.type === "crisis.detected"));
});

test("important events are cause-bearing, bounded, migrated and survive save/load", () => {
  const game = unfunded();
  for (let i = 0; i < 40; i += 1) {
    assert.equal(issueCommand(game, "build.start-job", { quantity: 1 }).accepted, true);
    const jobId = game.getState<BuildState>(COMPILATION_SYSTEM_ID).jobs![0]!.id;
    assert.equal(issueCommand(game, "build.cancel-job", { jobId }).accepted, true);
  }
  const log = game.getImportantEvents();
  assert.equal(log.length, 64);
  assert.equal(log.at(-1)?.type, "build.job-cancelled");
  assert.equal(typeof log.at(-1)?.payload, "object");
  const snapshot = game.serialize(1_000);
  assert.deepEqual(decodeSave(configuration, encodeSave(game, 1_000)).getImportantEvents(), log);
  const { importantEvents: _prior, ...oldSnapshot } = snapshot;
  const migrated = migrateSnapshot({ ...oldSnapshot, schemaVersion: 4 });
  assert.equal(migrated.schemaVersion, 6);
  assert.deepEqual(migrated.importantEvents, []);
  assert.equal(Simulation.restore(configuration, migrated).getImportantEvents().length, 0);
  const { jobs: _jobs, nextJobId: _sequence, lastRun: _run, ...legacyBuild } =
    game.getState<BuildState>(COMPILATION_SYSTEM_ID);
  const legacy = migrateSnapshot({
    ...oldSnapshot, schemaVersion: 4,
    systemStates: { ...oldSnapshot.systemStates, [COMPILATION_SYSTEM_ID]: legacyBuild },
  });
  const resumed = Simulation.restore(configuration, legacy);
  assert.equal(issueCommand(resumed, "build.start-job", { quantity: 1 }).accepted, true);
  assert.ok(resumed.getImportantEvents().some((event) => event.type === "build.job-queued"));
});

test("durable crisis detection is logged exactly once, not replayed from subsequent event views", () => {
  const balance = {
    ...DEFAULT_CORE_BALANCE_CONFIG,
    crisis: {
      initialProtocol: {
        ...DEFAULT_CORE_BALANCE_CONFIG.crisis.initialProtocol,
        debtThreshold: 1,
      },
    },
  };
  const game = new Simulation(createCoreSimulationConfiguration({
    seed: "crisis-log", gameVersion: "0.0.1",
    initialResources: { [Resources.Money]: 100_000, [Resources.TechnicalDebt]: 100 },
  }, balance));
  game.advanceTicks(6);
  const detected = game.getImportantEvents().filter((event) => event.type === "crisis.detected");
  assert.equal(detected.length, 1);
  assert.equal(new Set(game.getImportantEvents().map((event) => event.sequence)).size,
    game.getImportantEvents().length);
  assert.equal(decodeSave(createCoreSimulationConfiguration({
    seed: "crisis-log", gameVersion: "0.0.1",
    initialResources: { [Resources.Money]: 100_000, [Resources.TechnicalDebt]: 100 },
  }, balance), encodeSave(game, 7_000)).getImportantEvents().filter((event) =>
    event.type === "crisis.detected").length, 1);
});

test("worker commands project canonical queue and event history into ordered snapshots", async () => {
  const runtime = new SimulationWorkerRuntime();
  const initialized = await runtime.submit({ id: 1, kind: "initialize", save: null, now: 1_000 });
  assert.equal(initialized.kind, "result");
  const queued = await runtime.submit({
    id: 2, kind: "command", commandType: "build.start-job", payload: { quantity: 256 },
  });
  assert.equal(queued.kind, "result");
  if (queued.kind !== "result" || queued.result.kind !== "command") return;
  assert.equal(queued.result.commandResult.accepted, true);
  assert.equal(queued.result.view.buildJobs[0]?.id, "job:1");
  assert.ok(queued.result.view.importantEvents.some((event) => event.type === "build.job-queued"));
  const snapshot = await runtime.submit({ id: 3, kind: "snapshot", now: 2_000 });
  assert.equal(snapshot.kind, "result");
  if (snapshot.kind !== "result" || snapshot.result.kind !== "snapshot") return;
  const restored = decodeSave(configuration, snapshot.result.data);
  assert.deepEqual(restored.getState<BuildState>(COMPILATION_SYSTEM_ID).jobs,
    queued.result.view.buildJobs);
  assert.deepEqual(restored.getImportantEvents().map((event) => event.sequence),
    queued.result.view.importantEvents.map((event) => event.sequence));
});
