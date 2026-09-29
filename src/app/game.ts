import {
  COMPILATION_SYSTEM_ID,
  CRISIS_SYSTEM_ID,
  type BuildState,
  DEFAULT_CORE_BALANCE_CONFIG,
  HARDWARE_SYSTEM_ID,
  MAX_BUILD_JOBS,
  MAX_BUILD_UNITS_PER_JOB,
  MAX_QUEUED_BUILD_UNITS,
  ORGANIZATION_SYSTEM_ID,
  RESEARCH_SYSTEM_ID,
  RESEARCH_UPGRADES,
  MAX_DEMAND_BACKLOG,
  RUNTIME_SYSTEM_ID,
  Resources,
  Simulation,
  TESTING_SYSTEM_ID,
  TECHNICAL_DEBT_SYSTEM_ID,
  createCoreSimulationConfiguration,
  createSimulationDiagnostics,
  encodeSave,
  simTick,
  type HardwareState,
  type CrisisState,
  type CrisisProtocol,
  type OrganizationPolicy,
  type OrganizationState,
  type ResearchState,
  type RuntimeState,
  type TestingState,
  type TechnicalDebtState,
} from "../simulation/index.js";
import type { ResourceRateSampler } from "./resource-rates.js";

export const configuration = createCoreSimulationConfiguration({
  seed: "desktop-empire",
  gameVersion: "0.0.1",
  initialResources: { [Resources.Money]: 1_000 },
});

export function newGame(): Simulation {
  return new Simulation(configuration);
}

export function saveGame(game: Simulation, now: number): string {
  return encodeSave(game, now);
}

export function getGameView(game: Simulation, rateSampler?: ResourceRateSampler) {
  const diagnostics = createSimulationDiagnostics(game);
  const organization = game.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID);
  const hardware = game.getState<HardwareState>(HARDWARE_SYSTEM_ID);
  const runtime = game.getState<RuntimeState>(RUNTIME_SYSTEM_ID);
  const research = game.getState<ResearchState>(RESEARCH_SYSTEM_ID);
  const build = game.getState<BuildState>(COMPILATION_SYSTEM_ID);
  const testing = game.getState<TestingState>(TESTING_SYSTEM_ID);
  const debt = game.getState<TechnicalDebtState>(TECHNICAL_DEBT_SYSTEM_ID);
  const crisis = game.getState<CrisisState>(CRISIS_SYSTEM_ID);
  const balances = configuration.resources.map(({ id, displayName }) => ({
    id, displayName, amount: game.resources.get(id),
  }));
  const rates = rateSampler?.sample(game.tick, balances, game.getResourceFlowTotals());
  return {
    tick: game.tick,
    resourceRateWindowTicks: rates?.windowTicks ?? 0,
    resources: balances.map((balance) => ({
      ...balance,
      ratePerTick: rates?.perTick[balance.id] ?? 0,
      producedPerTick: rates?.producedPerTick[balance.id] ?? null,
      consumedPerTick: rates?.consumedPerTick[balance.id] ?? null,
    })),
    diagnostics,
    policy: organization.policy,
    teamPolicies: organization.teamPolicies,
    defaultPolicy: DEFAULT_CORE_BALANCE_CONFIG.organization.initialPolicy,
    swarms: organization.agentSwarms,
    teams: organization.teams,
    hardware: hardware.activeProfileId,
    hardwareProfiles: hardware.profiles,
    strategy: runtime.strategy,
    projects: research.projects,
    researchProgress: research.progress,
    selectedProject: research.selectedProjectId,
    completedProjects: research.completed,
    purchasedUpgrades: research.purchasedUpgrades,
    upgrades: RESEARCH_UPGRADES,
    importantEvents: game.getImportantEvents().slice(-64).map((event) => ({
      sequence: event.sequence, tick: event.tick, type: event.type, payload: event.payload,
    })),
    compiled: build.compiled,
    buildJobs: build.jobs ?? [],
    buildLastRun: build.lastRun ?? null,
    buildLimits: {
      maxJobs: MAX_BUILD_JOBS, maxUnitsPerJob: MAX_BUILD_UNITS_PER_JOB,
      maxQueuedUnits: MAX_QUEUED_BUILD_UNITS,
      sourcePerTick: DEFAULT_CORE_BALANCE_CONFIG.build.sourcePerTick,
      binaryBufferCapacity: DEFAULT_CORE_BALANCE_CONFIG.build.binaryBufferCapacity,
    },
    debtTerms: {
      debtPerMaintenanceCapacity: DEFAULT_CORE_BALANCE_CONFIG.technicalDebt.debtPerMaintenanceCapacity,
      moneyPerDebtRetired: DEFAULT_CORE_BALANCE_CONFIG.technicalDebt.moneyPerDebtRetired,
    },
    lastManualPaydown: debt.lastManualPaydown ?? null,
    crisisProtocol: crisis.protocol,
    buildStages: DEFAULT_CORE_BALANCE_CONFIG.build.stages.map((stage) => ({
      id: stage.id,
      dependsOn: stage.dependsOn,
      executions: build.stageExecutions[stage.id] ?? 0,
    })),
    backlogs: [
      { id: "source", label: "Source waiting for build", units: game.resources.get(Resources.Source), cohorts: build.sourceCohorts.length },
      { id: "binaries", label: "Binaries waiting for tests", units: game.resources.get(Resources.Binaries), cohorts: testing.binaryCohorts.length },
      { id: "releases", label: "Releases waiting for deployment", units: game.resources.get(Resources.Releases), cohorts: runtime.releaseCohorts.length },
      { id: "hot-deploy", label: "Hot deploy requests", units: game.resources.get(Resources.HotDeployRequests), cohorts: null },
      { id: "demand", label: "Unmet market requests", units: game.resources.get(Resources.Demand), cohorts: null },
    ],
    market: {
      outstanding: game.resources.get(Resources.Demand),
      inFlight: game.resources.get(Resources.Source) + game.resources.get(Resources.Binaries) +
        game.resources.get(Resources.Releases),
      unassigned: Math.max(0, game.resources.get(Resources.Demand) -
        game.resources.get(Resources.Source) - game.resources.get(Resources.Binaries) -
        game.resources.get(Resources.Releases)),
      capacity: MAX_DEMAND_BACKLOG,
      lastServed: runtime.lastDemandServed ?? 0,
      lastReferrals: runtime.lastDemandCreated ?? 0,
    },
  };
}

export type GameView = ReturnType<typeof getGameView>;

let nextCommandId = 0;

export function issueCommand(
  game: Simulation,
  type: string,
  payload: Record<string, string | number | boolean | null | OrganizationPolicy | CrisisProtocol>,
): import("../simulation/index.js").CommandResult {
  const id = `ui:${++nextCommandId}`;
  game.dispatch({ id, type, payload, issuedAt: simTick(game.tick + 1) });
  const result = game.runTick().commandResults.find((command) => command.commandId === id);
  if (result === undefined) {
    throw new Error(`Command ${type} was not processed`);
  }
  return result;
}
