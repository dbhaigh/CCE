import type { BuildLayerOptions } from "./layers/build-compilation.js";
import type { CrisisLayerOptions } from "./layers/crisis-response.js";
import type { KnowledgeLayerOptions } from "./layers/knowledge-research.js";
import type { OrganizationLayerOptions } from "./layers/organization.js";
import type { RuntimeLayerOptions } from "./layers/runtime-deployment.js";
import type { AutomationLayerOptions } from "./layers/self-improving-automation.js";
import type { SourceGenerationOptions } from "./layers/source-generation.js";
import type { TechnicalDebtLayerOptions } from "./layers/technical-debt.js";
import type { TestingLayerOptions } from "./layers/testing-verification.js";
import { cloneJson, deepFreeze } from "./types.js";
import { contentHash } from "./content.js";

export interface CoreBalanceConfig {
  readonly balanceVersion: 1;
  readonly organization: OrganizationLayerOptions;
  readonly sourceGeneration: SourceGenerationOptions;
  readonly build: BuildLayerOptions;
  readonly testing: TestingLayerOptions;
  readonly runtime: RuntimeLayerOptions;
  readonly research: KnowledgeLayerOptions;
  readonly technicalDebt: TechnicalDebtLayerOptions;
  readonly automation: AutomationLayerOptions;
  readonly crisis: CrisisLayerOptions;
}

export const DEFAULT_CORE_BALANCE_CONFIG: CoreBalanceConfig = deepFreeze({
  balanceVersion: 1,
  organization: {
    teams: [{
      id: "platform-team",
      headcount: 10,
      engineeringSkillPermille: 1_000,
      salaryPerTick: 2,
      moralePermille: 850,
      skillTree: {
        sourceGeneration: 1_000,
        verification: 700,
        operations: 600,
        research: 500,
      },
    }],
    agentSwarms: [{
      id: "compiler-swarm",
      agents: 4,
      autonomyPermille: 400,
      alignmentPermille: 950,
      productivityPermille: 1_000,
      operatingCostPerAgent: 2,
    }],
    initialPolicy: {
      aiAllocationPermille: 500,
      maintenanceAllocationPermille: 200,
      reviewStrengthPermille: 500,
      testStrengthPermille: 500,
      codingStandardsPermille: 600,
      riskTolerancePermille: 300,
      releaseCadencePermille: 500,
    },
  },
  sourceGeneration: {
    humanProductivity: 2,
    agentProductivity: 3,
    computePerSource: 1,
    sourceBufferCapacity: 1_000,
    baseDebtRatePermille: 250,
  },
  build: {
    hardwareProfiles: [
      { id: "balanced", computePerTick: 80, moneyPerTick: 20 },
      { id: "high-throughput", computePerTick: 160, moneyPerTick: 55 },
    ],
    initialHardwareProfileId: "balanced",
    stages: [
      {
        id: "parse",
        dependsOn: [],
        computePerSource: 1,
        failureChancePermille: 5,
        cacheablePermille: 900,
      },
      {
        id: "compile",
        dependsOn: ["parse"],
        computePerSource: 2,
        failureChancePermille: 15,
        cacheablePermille: 700,
      },
      {
        id: "link",
        dependsOn: ["compile"],
        computePerSource: 1,
        failureChancePermille: 5,
        cacheablePermille: 500,
      },
    ],
    sourcePerTick: 12,
    binariesPerSource: 1,
    binaryBufferCapacity: 500,
    bugRatePermille: 200,
    debtUnitsPerThroughputPenalty: 20,
  },
  testing: {
    suites: [
      {
        id: "unit",
        testCount: 500,
        computePerBinary: 1,
        detectionPermille: 500,
        flakinessPermille: 5,
      },
      {
        id: "integration",
        testCount: 100,
        computePerBinary: 2,
        detectionPermille: 700,
        flakinessPermille: 20,
      },
      {
        id: "system",
        testCount: 25,
        computePerBinary: 3,
        detectionPermille: 850,
        flakinessPermille: 35,
      },
    ],
    binariesPerTick: 8,
    releaseBufferCapacity: 100,
  },
  runtime: {
    services: [{
      id: "hosted-apps",
      serviceCount: 20,
      revenuePerRelease: 12,
      baseIncidentChancePermille: 80,
    }],
    initialStrategy: "rolling",
    releasesPerTick: 6,
  },
  research: {
    projects: [
      {
        id: "incremental-builds",
        requiredProgress: 20,
        insightPerProgress: 1,
        moneyPerProgress: 1,
        knowledgeReward: 20,
        dependencies: [],
      },
      {
        id: "verified-generation",
        requiredProgress: 40,
        insightPerProgress: 2,
        moneyPerProgress: 2,
        knowledgeReward: 50,
        dependencies: ["incremental-builds"],
      },
    ],
    initialProjectId: "incremental-builds",
    progressPerTick: 4,
  },
  technicalDebt: {
    categories: [
      {
        id: "source-complexity",
        interestPermille: 100,
        maintenanceEfficiencyPermille: 1_000,
      },
      {
        id: "build-fragility",
        interestPermille: 150,
        maintenanceEfficiencyPermille: 800,
      },
    ],
    debtPerMaintenanceCapacity: 2,
    moneyPerDebtRetired: 1,
    debtPerInterestBug: 10,
  },
  automation: {
    initialPower: 10,
    sourceBufferCapacity: 1_000,
    maximumPower: 1_000_000,
  },
  crisis: {
    initialProtocol: {
      automaticResponsePermille: 100,
      outageThreshold: 3,
      debtThreshold: 100,
      rebellionThreshold: 800,
      shutdownAutomationAtSeverity: 100,
    },
  },
});

export function parseCoreBalanceConfig(serialized: string): CoreBalanceConfig {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      `Balance configuration is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  validateBalanceData(value, "balance");
  if (!isRecord(value) || value.balanceVersion !== 1) {
    throw new Error("Unsupported or missing balanceVersion");
  }
  for (const section of [
    "organization",
    "sourceGeneration",
    "build",
    "testing",
    "runtime",
    "research",
    "technicalDebt",
    "automation",
    "crisis",
  ]) {
    if (!isRecord(value[section])) {
      throw new Error(`Balance section ${section} must be an object`);
    }
  }
  validateShape(value, DEFAULT_CORE_BALANCE_CONFIG, "balance");
  const balance = deepFreeze(cloneJson(value)) as unknown as CoreBalanceConfig;
  validateCoreBalanceConfig(balance);
  return balance;
}

export function coreBalanceContentHash(balance: CoreBalanceConfig): string {
  validateCoreBalanceConfig(balance);
  return contentHash(balance);
}

export function validateCoreBalanceConfig(
  balance: CoreBalanceConfig,
): void {
  if (balance.balanceVersion !== 1) {
    throw new Error(`Unsupported balance version ${balance.balanceVersion}`);
  }
  assertNonEmptyUnique(balance.organization.teams, "team");
  assertNonEmptyUnique(balance.organization.agentSwarms, "agent swarm");
  for (const team of balance.organization.teams) {
    positive(team.headcount, `Team ${team.id} headcount`);
    positive(team.engineeringSkillPermille, `Team ${team.id} skill`);
    positive(team.salaryPerTick, `Team ${team.id} salary`);
    permille(team.moralePermille, `Team ${team.id} morale`);
    for (const [skill, value] of Object.entries(team.skillTree)) {
      if (typeof value !== "number") {
        throw new Error(`Team ${team.id} ${skill} must be numeric`);
      }
      nonNegative(value, `Team ${team.id} ${skill}`);
    }
  }
  for (const swarm of balance.organization.agentSwarms) {
    positive(swarm.agents, `Swarm ${swarm.id} agents`);
    permille(swarm.autonomyPermille, `Swarm ${swarm.id} autonomy`);
    permille(swarm.alignmentPermille, `Swarm ${swarm.id} alignment`);
    positive(swarm.productivityPermille, `Swarm ${swarm.id} productivity`);
    positive(swarm.operatingCostPerAgent, `Swarm ${swarm.id} cost`);
  }
  for (const [name, value] of Object.entries(
    balance.organization.initialPolicy,
  )) {
    if (typeof value !== "number") {
      throw new Error(`Policy ${name} must be numeric`);
    }
    permille(value, `Policy ${name}`);
  }
  positive(balance.sourceGeneration.humanProductivity, "Human productivity");
  positive(balance.sourceGeneration.agentProductivity, "Agent productivity");
  positive(balance.sourceGeneration.computePerSource, "Source compute");
  positive(balance.sourceGeneration.sourceBufferCapacity, "Source buffer");
  permille(
    balance.sourceGeneration.baseDebtRatePermille,
    "Source debt rate",
  );

  assertNonEmptyUnique(balance.build.hardwareProfiles, "hardware profile");
  if (
    !balance.build.hardwareProfiles.some(
      (profile) => profile.id === balance.build.initialHardwareProfileId,
    )
  ) {
    throw new Error("Initial hardware profile is not defined");
  }
  assertNonEmptyUnique(balance.build.stages, "build stage");
  positive(balance.build.sourcePerTick, "Build source throughput");
  positive(balance.build.binariesPerSource, "Binaries per source");
  positive(balance.build.binaryBufferCapacity, "Binary buffer");
  permille(balance.build.bugRatePermille, "Build bug rate");
  positive(
    balance.build.debtUnitsPerThroughputPenalty,
    "Debt throughput divisor",
  );
  for (const stage of balance.build.stages) {
    positive(stage.computePerSource, `Stage ${stage.id} compute`);
    permille(stage.failureChancePermille, `Stage ${stage.id} failure`);
    permille(stage.cacheablePermille, `Stage ${stage.id} cacheability`);
  }

  assertNonEmptyUnique(balance.testing.suites, "test suite");
  positive(balance.testing.binariesPerTick, "Testing throughput");
  positive(balance.testing.releaseBufferCapacity, "Release buffer");
  for (const suite of balance.testing.suites) {
    positive(suite.testCount, `Suite ${suite.id} test count`);
    positive(suite.computePerBinary, `Suite ${suite.id} compute`);
    permille(suite.detectionPermille, `Suite ${suite.id} detection`);
    permille(suite.flakinessPermille, `Suite ${suite.id} flakiness`);
  }

  assertNonEmptyUnique(balance.runtime.services, "service cohort");
  positive(balance.runtime.releasesPerTick, "Runtime throughput");
  for (const service of balance.runtime.services) {
    positive(service.serviceCount, `Service ${service.id} count`);
    nonNegative(service.revenuePerRelease, `Service ${service.id} revenue`);
    permille(
      service.baseIncidentChancePermille,
      `Service ${service.id} incidents`,
    );
  }

  assertNonEmptyUnique(balance.research.projects, "research project");
  if (
    !balance.research.projects.some(
      (project) => project.id === balance.research.initialProjectId,
    )
  ) {
    throw new Error("Initial research project is not defined");
  }
  positive(balance.research.progressPerTick, "Research throughput");

  assertNonEmptyUnique(balance.technicalDebt.categories, "debt category");
  positive(
    balance.technicalDebt.debtPerMaintenanceCapacity,
    "Debt maintenance rate",
  );
  nonNegative(
    balance.technicalDebt.moneyPerDebtRetired,
    "Debt retirement cost",
  );
  positive(balance.technicalDebt.debtPerInterestBug, "Debt bug divisor");
  for (const category of balance.technicalDebt.categories) {
    permille(category.interestPermille, `Debt ${category.id} interest`);
    positive(
      category.maintenanceEfficiencyPermille,
      `Debt ${category.id} efficiency`,
    );
  }

  nonNegative(balance.automation.initialPower, "Initial automation power");
  positive(balance.automation.sourceBufferCapacity, "Automation source buffer");
  positive(balance.automation.maximumPower, "Maximum automation power");
  if (balance.automation.initialPower > balance.automation.maximumPower) {
    throw new Error("Initial automation power exceeds its maximum");
  }
  permille(
    balance.crisis.initialProtocol.automaticResponsePermille,
    "Automatic crisis response",
  );
  positive(balance.crisis.initialProtocol.outageThreshold, "Outage threshold");
  positive(balance.crisis.initialProtocol.debtThreshold, "Debt threshold");
  positive(
    balance.crisis.initialProtocol.rebellionThreshold,
    "Rebellion threshold",
  );
  positive(
    balance.crisis.initialProtocol.shutdownAutomationAtSeverity,
    "Automation shutdown threshold",
  );
}

function assertNonEmptyUnique<T extends { readonly id: string }>(
  values: readonly T[],
  label: string,
): void {
  if (values.length === 0) {
    throw new Error(`At least one ${label} is required`);
  }
  const ids = new Set(values.map((value) => value.id));
  if (ids.size !== values.length) {
    throw new Error(`${label} IDs must be unique`);
  }
}

function positive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function nonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function permille(value: number, label: string): void {
  nonNegative(value, label);
  if (value > 1_000) {
    throw new Error(`${label} cannot exceed 1000`);
  }
}

function validateShape(
  value: unknown,
  template: unknown,
  path: string,
): void {
  if (Array.isArray(template)) {
    if (!Array.isArray(value)) {
      throw new Error(`${path} must be an array`);
    }
    const itemTemplate = template[0];
    if (itemTemplate !== undefined) {
      value.forEach((entry, index) =>
        validateShape(entry, itemTemplate, `${path}[${index}]`),
      );
    }
    return;
  }
  if (isRecord(template)) {
    if (!isRecord(value)) {
      throw new Error(`${path} must be an object`);
    }
    for (const [key, childTemplate] of Object.entries(template)) {
      if (!(key in value)) {
        throw new Error(`${path}.${key} is required`);
      }
      validateShape(value[key], childTemplate, `${path}.${key}`);
    }
    return;
  }
  if (typeof value !== typeof template) {
    throw new Error(`${path} has the wrong data type`);
  }
}

function validateBalanceData(value: unknown, path: string): void {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${path} must contain non-negative safe integers`);
    }
    const key = path.split(".").at(-1) ?? "";
    if (key.endsWith("Permille") && value > 1_000) {
      throw new Error(`${path} cannot exceed 1000`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateBalanceData(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) {
    throw new Error(`${path} contains unsupported data`);
  }
  for (const [key, child] of Object.entries(value)) {
    validateBalanceData(child, `${path}.${key}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
