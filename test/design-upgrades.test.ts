import assert from "node:assert/strict";
import test from "node:test";
import { configuration, getGameView, issueCommand, newGame } from "../src/app/game.js";
import {
  COMPILATION_SYSTEM_ID, DEFAULT_CORE_BALANCE_CONFIG, INITIAL_DEMAND_BACKLOG,
  MAX_DEMAND_BACKLOG, ORGANIZATION_SYSTEM_ID, RESEARCH_SYSTEM_ID, Resources,
  RUNTIME_SYSTEM_ID, SOURCE_GENERATION_SYSTEM_ID, Simulation, createCoreSimulationConfiguration,
  decodeSave, encodeSave, migrateSnapshot, simTick,
  type BuildState, type OrganizationState, type ResearchState, type RuntimeState,
  type SourceGenerationState,
  type SourceArtifactCohort,
} from "../src/simulation/index.js";

test("bounded real demand gates unassigned Source and monetized deployments without an empty-market deadlock", () => {
  const game = newGame();
  assert.equal(game.resources.get(Resources.Demand), INITIAL_DEMAND_BACKLOG);
  game.advanceTicks(6);
  const snapshot = game.serialize(1_000);
  const scarce = Simulation.restore(configuration, {
    ...snapshot, resources: { ...snapshot.resources, [Resources.Demand]: 0 },
  });
  const funded = Simulation.restore(configuration, snapshot);
  const first = scarce.runTick();
  funded.runTick();
  const scarceRevenue = scarce.getState<RuntimeState>(RUNTIME_SYSTEM_ID).revenue -
    game.getState<RuntimeState>(RUNTIME_SYSTEM_ID).revenue;
  const fundedRevenue = funded.getState<RuntimeState>(RUNTIME_SYSTEM_ID).revenue -
    game.getState<RuntimeState>(RUNTIME_SYSTEM_ID).revenue;
  assert.ok(first.events.some((event) => event.type === "runtime.deployed"));
  assert.equal(scarce.getState<RuntimeState>(RUNTIME_SYSTEM_ID).lastDemandServed, 1,
    "one organic request can be sold; other Releases are not monetized");
  assert.ok(scarceRevenue < fundedRevenue);
  assert.ok(scarce.getState<RuntimeState>(RUNTIME_SYSTEM_ID).lastDemandCreated! <= 1);

  const restarted = new Simulation({ ...configuration, initialResources: {
    [Resources.Money]: 100_000, [Resources.Demand]: 0,
  } });
  restarted.runTick();
  assert.ok(restarted.resources.get(Resources.Demand) > 0, "organic requests restart a dry pipeline");
  const ongoing = new Simulation({ ...configuration, initialResources: {
    [Resources.Money]: 1_000_000, [Resources.Demand]: MAX_DEMAND_BACKLOG,
  } });
  ongoing.advanceTicks(120);
  assert.ok(ongoing.resources.get(Resources.Demand) <= MAX_DEMAND_BACKLOG);
  assert.ok(getGameView(ongoing).market.unassigned >= 0);
  assert.ok(ongoing.getState<RuntimeState>(RUNTIME_SYSTEM_ID).revenue > 0);
  assert.equal(decodeSave(configuration, encodeSave(ongoing, 150_000)).resources.get(Resources.Demand),
    ongoing.resources.get(Resources.Demand));
});

test("idle demand accumulates without releases; a funded bottleneck resumes without inventing revenue", () => {
  const idle = new Simulation({ ...configuration, initialResources: {
    [Resources.Money]: 0, [Resources.Demand]: 0,
  } });
  idle.advanceTicks(5);
  assert.equal(idle.resources.get(Resources.Demand), 5);
  assert.equal(idle.resources.get(Resources.Releases), 0);
  assert.equal(idle.getState<RuntimeState>(RUNTIME_SYSTEM_ID).revenue, 0);

  const original = newGame().serialize(1_000);
  const build = original.systemStates[COMPILATION_SYSTEM_ID] as BuildState;
  const stalled = Simulation.restore(configuration, {
    ...original,
    resources: { ...original.resources,
      [Resources.Money]: 0, [Resources.Demand]: 40, [Resources.Source]: 1 },
    systemStates: { ...original.systemStates, [COMPILATION_SYSTEM_ID]: {
      ...build, sourceCohorts: [{
        id: "source:stalled", quantity: 1, humanPermille: 1_000,
        debtRiskPermille: 0, codingStandardsPermille: 500,
        reviewStrengthPermille: 500, testStrengthPermille: 500,
        riskTolerancePermille: 200, releaseCadencePermille: 500,
        teamId: "platform-team", createdTick: 0,
      }],
    } },
  });
  stalled.advanceTicks(3);
  assert.equal(stalled.resources.get(Resources.Source), 1);
  assert.equal(stalled.resources.get(Resources.Releases), 0);
  assert.equal(stalled.getState<RuntimeState>(RUNTIME_SYSTEM_ID).revenue, 0);
  assert.equal(stalled.getState<SourceGenerationState>(SOURCE_GENERATION_SYSTEM_ID).generated, 0);
  assert.equal(stalled.resources.get(Resources.Demand), 43);

  const restored = Simulation.restore(configuration, {
    ...stalled.serialize(4_000),
    resources: { ...stalled.serialize(4_000).resources, [Resources.Money]: 100_000 },
  });
  restored.advanceTicks(30);
  assert.ok(restored.getState<RuntimeState>(RUNTIME_SYSTEM_ID).revenue > 0);
  assert.ok(restored.getState<RuntimeState>(RUNTIME_SYSTEM_ID).lastDemandServed! >= 0);
});

test("research upgrades stay locked until completion and payment, then persist and affect real build and AI Source", () => {
  const starting = newGame().serialize(1_000);
  assert.equal(issueCommand(newGame(), "research.purchase-upgrade",
    { upgradeId: "incremental-build-cache" }).accepted, false);
  const state = starting.systemStates[RESEARCH_SYSTEM_ID] as ResearchState;
  const eligible = {
    ...starting,
    resources: { ...starting.resources, [Resources.Money]: 100_000,
      [Resources.Knowledge]: 100, [Resources.Demand]: 100 },
    systemStates: { ...starting.systemStates,
      [RESEARCH_SYSTEM_ID]: { ...state, completed: ["incremental-builds", "verified-generation"],
        selectedProjectId: null } },
  };
  const control = Simulation.restore(configuration, eligible);
  const upgraded = Simulation.restore(configuration, eligible);
  const unaffordable = Simulation.restore(configuration, { ...eligible,
    resources: { ...eligible.resources, [Resources.Money]: 0 } });
  assert.equal(issueCommand(unaffordable, "research.purchase-upgrade",
    { upgradeId: "incremental-build-cache" }).accepted, false);
  assert.deepEqual(unaffordable.getState<ResearchState>(RESEARCH_SYSTEM_ID).purchasedUpgrades, []);
  const rejected = issueCommand(upgraded, "research.purchase-upgrade", { upgradeId: "not-a-project" });
  assert.equal(rejected.accepted, false);
  assert.equal(issueCommand(upgraded, "research.purchase-upgrade",
    { upgradeId: "incremental-build-cache" }).accepted, true);
  control.advanceTicks(2);
  assert.equal(upgraded.getState<BuildState>(COMPILATION_SYSTEM_ID).lastRun!.computePerSource,
    control.getState<BuildState>(COMPILATION_SYSTEM_ID).lastRun!.computePerSource - 1);
  assert.equal(upgraded.getState<ResearchState>(RESEARCH_SYSTEM_ID).purchasedUpgrades[0],
    "incremental-build-cache");
  assert.equal(issueCommand(upgraded, "research.purchase-upgrade",
    { upgradeId: "incremental-build-cache" }).accepted, false);

  const aiControl = Simulation.restore(configuration, eligible);
  const aiVerified = Simulation.restore(configuration, eligible);
  const normal = aiControl.runTick().events.find((event) => event.type === "source.batch-generated");
  aiVerified.dispatch({ id: "activate-ai", type: "research.purchase-upgrade",
    payload: { upgradeId: "verified-ai-source" }, issuedAt: simTick(1) });
  const upgradedTick = aiVerified.runTick();
  assert.equal(upgradedTick.commandResults[0]?.accepted, true);
  const improved = upgradedTick.events.find((event) => event.type === "source.batch-generated");
  const aiStrength = (event: typeof improved) => {
    const payload = event?.payload as { artifacts?: readonly SourceArtifactCohort[] } | null;
    return payload?.artifacts?.find((artifact) => artifact.teamId === "agent-swarms")?.testStrengthPermille;
  };
  assert.ok(aiStrength(normal) !== undefined && aiStrength(improved) !== undefined);
  assert.equal(aiStrength(improved), Math.min(1_000, aiStrength(normal)! + 200));
  const restored = decodeSave(configuration, encodeSave(aiVerified, 2_000));
  assert.deepEqual(restored.getState<ResearchState>(RESEARCH_SYSTEM_ID).purchasedUpgrades,
    ["verified-ai-source"]);
  assert.deepEqual(restored.serialize(2_000), aiVerified.serialize(2_000));
});

test("a paid cache upgrade cannot bypass a compute or source funding bottleneck", () => {
  const base = newGame().serialize(1_000);
  const research = base.systemStates[RESEARCH_SYSTEM_ID] as ResearchState;
  const ready = Simulation.restore(configuration, {
    ...base, resources: { ...base.resources,
      [Resources.Money]: 80, [Resources.Knowledge]: 10 },
    systemStates: { ...base.systemStates, [RESEARCH_SYSTEM_ID]: {
      ...research, completed: ["incremental-builds"], selectedProjectId: null,
    } },
  });
  assert.equal(issueCommand(ready, "research.purchase-upgrade",
    { upgradeId: "incremental-build-cache" }).accepted, true);
  const saved = ready.serialize(1_000);
  const blocked = Simulation.restore(configuration, {
    ...saved, resources: { ...saved.resources,
      [Resources.Money]: 0, [Resources.Compute]: 0, [Resources.Demand]: 0 },
  });
  blocked.advanceTicks(3);
  assert.equal(blocked.getState<ResearchState>(RESEARCH_SYSTEM_ID)
    .purchasedUpgrades[0], "incremental-build-cache");
  assert.equal(blocked.resources.get(Resources.Binaries), 0);
  assert.equal(blocked.getState<BuildState>(COMPILATION_SYSTEM_ID).compiled, 0);
  assert.ok(blocked.resources.get(Resources.Demand) > 0,
    "unserved requests continue to arrive even while infrastructure is unfunded");
});

test("team-selective jobs reorder actual Source provenance and do not block unrelated automatic work", () => {
  const teams = DEFAULT_CORE_BALANCE_CONFIG.organization.teams;
  const balance = {
    ...DEFAULT_CORE_BALANCE_CONFIG,
    organization: { ...DEFAULT_CORE_BALANCE_CONFIG.organization,
      teams: [...teams, { ...teams[0]!, id: "quality-team", headcount: 1 }] },
    build: { ...DEFAULT_CORE_BALANCE_CONFIG.build, sourcePerTick: 6 },
  };
  const config = createCoreSimulationConfiguration({
    seed: "provenance-choices", gameVersion: "0.0.1",
    initialResources: { [Resources.Money]: 100_000 },
  }, balance);
  const base = new Simulation(config).serialize(1_000);
  const build = base.systemStates[COMPILATION_SYSTEM_ID] as BuildState;
  const original: SourceArtifactCohort = {
    id: "source:existing:platform", quantity: 6, humanPermille: 1_000,
    debtRiskPermille: 0, codingStandardsPermille: 1_000,
    reviewStrengthPermille: 1_000, testStrengthPermille: 1_000,
    riskTolerancePermille: 0, releaseCadencePermille: 500,
    teamId: "platform-team", createdTick: 0,
  };
  const risky: SourceArtifactCohort = {
    ...original, id: "source:existing:risky", teamId: "quality-team",
    codingStandardsPermille: 0, reviewStrengthPermille: 0,
    testStrengthPermille: 0, riskTolerancePermille: 1_000,
  };
  const raw = {
    ...base,
    resources: { ...base.resources, [Resources.Source]: 12 },
    systemStates: { ...base.systemStates, [COMPILATION_SYSTEM_ID]: {
      ...build, sourceCohorts: [original, risky],
      jobs: [
        { id: "job:1", requested: 6, remaining: 6, createdTick: 0, sourceTeamId: "platform-team" },
        { id: "job:2", requested: 6, remaining: 6, createdTick: 0, sourceTeamId: "quality-team" },
      ], nextJobId: 3,
    } },
  };
  const first = Simulation.restore(config, raw);
  const reordered = Simulation.restore(config, raw);
  const firstResult = first.runTick();
  reordered.dispatch({ id: "reorder", type: "build.prioritize-job",
    payload: { jobId: "job:2" }, issuedAt: simTick(1) });
  const reorderedResult = reordered.runTick();
  assert.equal(reorderedResult.commandResults[0]?.accepted, true);
  const firstBuild = first.getState<BuildState>(COMPILATION_SYSTEM_ID);
  const secondBuild = reordered.getState<BuildState>(COMPILATION_SYSTEM_ID);
  assert.equal(firstBuild.lastRun?.manualSource, 6);
  assert.equal(secondBuild.lastRun?.manualSource, 6);
  assert.equal(firstBuild.sourceCohorts.some((cohort) => cohort.id === original.id), false);
  assert.equal(secondBuild.sourceCohorts.some((cohort) => cohort.id === risky.id), false);
  const buildOutcome = (events: typeof firstResult.events) => events.find((event) =>
    event.type === "build.completed" || event.type === "build.failed")?.payload;
  assert.notDeepEqual(buildOutcome(firstResult.events), buildOutcome(reorderedResult.events),
    "quality and risk of the selected producing team must affect compilation");
  for (const game of [first, reordered]) {
    assert.equal(game.resources.get(Resources.Source),
      game.getState<BuildState>(COMPILATION_SYSTEM_ID).sourceCohorts
        .reduce((sum, cohort) => sum + cohort.quantity, 0));
  }
  const restored = decodeSave(config, encodeSave(reordered, 2_000));
  assert.deepEqual(restored.serialize(2_000), reordered.serialize(2_000));
  assert.equal(restored.getState<BuildState>(COMPILATION_SYSTEM_ID).jobs?.[0]?.sourceTeamId,
    "platform-team");
  assert.equal(issueCommand(reordered, "build.start-job",
    { quantity: 1, sourceTeamId: "invalid-team" }).accepted, false);

  const organization = base.systemStates[ORGANIZATION_SYSTEM_ID] as OrganizationState;
  const unmatched = Simulation.restore(config, {
    ...raw, resources: { ...raw.resources, [Resources.Source]: 6 },
    systemStates: { ...raw.systemStates,
      [COMPILATION_SYSTEM_ID]: { ...build, sourceCohorts: [original],
        jobs: [{ id: "job:1", requested: 6, remaining: 6, createdTick: 0,
          sourceTeamId: "quality-team" }], nextJobId: 2 },
      [ORGANIZATION_SYSTEM_ID]: { ...organization,
        teams: organization.teams.map((team) => team.id === "quality-team" ?
          { ...team, headcount: 0 } : team) },
    },
  });
  unmatched.runTick();
  assert.equal(unmatched.getState<BuildState>(COMPILATION_SYSTEM_ID).lastRun?.manualSource, 0);
  assert.ok((unmatched.getState<BuildState>(COMPILATION_SYSTEM_ID).lastRun?.automaticSource ?? 0) > 0);
  assert.equal(unmatched.getState<BuildState>(COMPILATION_SYSTEM_ID).jobs?.[0]?.remaining, 6);
});

test("schema-5 saves migrate outstanding demand, unpaid upgrades and Any Source jobs without bypassing validation", () => {
  const oldGame = newGame();
  oldGame.advanceTicks(3);
  const base = oldGame.serialize(1_000);
  const research = base.systemStates[RESEARCH_SYSTEM_ID] as ResearchState;
  const build = base.systemStates[COMPILATION_SYSTEM_ID] as BuildState;
  const legacy = {
    ...base, schemaVersion: 5,
    resources: { ...base.resources },
    systemStates: { ...base.systemStates,
      [RESEARCH_SYSTEM_ID]: { ...research, purchasedUpgrades: undefined },
      [COMPILATION_SYSTEM_ID]: { ...build, jobs: [{
        id: "job:1", requested: 1, remaining: 1, createdTick: 0,
      }] },
    },
  } as Record<string, unknown>;
  delete (legacy.resources as Record<string, unknown>)[Resources.Demand];
  const migrated = migrateSnapshot(legacy);
  assert.equal(migrated.schemaVersion, 6);
  assert.equal(migrated.resources[Resources.Demand], 40);
  assert.deepEqual((migrated.systemStates[RESEARCH_SYSTEM_ID] as ResearchState).purchasedUpgrades, []);
  assert.equal((migrated.systemStates[COMPILATION_SYSTEM_ID] as BuildState).jobs?.[0]?.sourceTeamId, null);
  const decoded = decodeSave(configuration, JSON.stringify(legacy));
  const expected = Simulation.restore(configuration, migrated);
  decoded.advanceOffline(1_000, 10_000);
  expected.advanceOffline(1_000, 10_000);
  assert.deepEqual(decoded.serialize(10_000), expected.serialize(10_000));
  assert.throws(() => decodeSave(configuration, JSON.stringify({ ...migrated,
    systemStates: { ...migrated.systemStates, [RESEARCH_SYSTEM_ID]: {
      ...(migrated.systemStates[RESEARCH_SYSTEM_ID] as ResearchState),
      purchasedUpgrades: ["bogus"],
    } },
  })), /upgrades are invalid/);
  const missingDemand = { ...migrated.resources };
  delete missingDemand[Resources.Demand];
  assert.throws(() => decodeSave(configuration, JSON.stringify({ ...migrated,
    resources: missingDemand,
  })), /market demand is missing/);
  assert.ok(newGame().getState(RESEARCH_SYSTEM_ID));
  assert.ok(newGame().getState(ORGANIZATION_SYSTEM_ID));
});

test("bounded Source cohorts retain each producer through more than 256 distinct batches", () => {
  const game = newGame();
  const snapshot = game.serialize(1_000);
  const build = snapshot.systemStates[COMPILATION_SYSTEM_ID] as BuildState;
  const sourceCohorts = Array.from({ length: 300 }, (_, index): SourceArtifactCohort => ({
    id: `source:older:${index}`, quantity: 1, humanPermille: index % 2 ? 0 : 1_000,
    debtRiskPermille: index % 2, codingStandardsPermille: 500,
    reviewStrengthPermille: 500, testStrengthPermille: 500,
    riskTolerancePermille: 300, releaseCadencePermille: 500,
    teamId: index % 2 ? "agent-swarms" : "platform-team", createdTick: 0,
  }));
  const loaded = Simulation.restore(configuration, {
    ...snapshot, resources: { ...snapshot.resources, [Resources.Source]: 300,
      [Resources.Demand]: 1_000, [Resources.Money]: 100_000 },
    systemStates: { ...snapshot.systemStates,
      [COMPILATION_SYSTEM_ID]: { ...build, sourceCohorts } },
  });
  loaded.runTick();
  const cohorts = loaded.getState<BuildState>(COMPILATION_SYSTEM_ID).sourceCohorts;
  assert.ok(cohorts.length > 256 && cohorts.length <= 1_000);
  assert.ok(cohorts.every((cohort) =>
    ["agent-swarms", "platform-team"].includes(cohort.teamId)));
  assert.equal(cohorts.reduce((sum, cohort) => sum + cohort.quantity, 0),
    loaded.resources.get(Resources.Source));
});
