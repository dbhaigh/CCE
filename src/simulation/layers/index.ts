export * from "./layer.js";
export * from "./ids.js";
export * from "./cohorts.js";
export * from "./organization.js";
export * from "./source-generation.js";
export * from "./build-compilation.js";
export * from "./testing-verification.js";
export * from "./runtime-deployment.js";
export * from "./knowledge-research.js";
export * from "./technical-debt.js";
export * from "./self-improving-automation.js";
export * from "./crisis-response.js";

import {
  createBuildCompilationLayer,
} from "./build-compilation.js";
import {
  createKnowledgeResearchLayer,
} from "./knowledge-research.js";
import { composeLayers, type ComposedLayers, type SimulationLayer } from "./layer.js";
import { createOrganizationLayer } from "./organization.js";
import { createRuntimeDeploymentLayer } from "./runtime-deployment.js";
import { createSourceGenerationLayer } from "./source-generation.js";
import { createTechnicalDebtLayer } from "./technical-debt.js";
import { createTestingVerificationLayer } from "./testing-verification.js";
import { createSelfImprovingAutomationLayer } from "./self-improving-automation.js";
import { createCrisisResponseLayer } from "./crisis-response.js";
import {
  DEFAULT_CORE_BALANCE_CONFIG,
  coreBalanceContentHash,
  type CoreBalanceConfig,
  validateCoreBalanceConfig,
} from "../balance.js";
import type { SimulationConfiguration } from "../simulation.js";
import {
  CORE_RESOURCE_DEFINITIONS,
  INITIAL_DEMAND_BACKLOG,
  Resources,
  type ResourceDefinition,
  type ResourceSnapshot,
} from "../resources.js";

export function createCoreSimulationLayers(
  balance: CoreBalanceConfig = DEFAULT_CORE_BALANCE_CONFIG,
): readonly SimulationLayer[] {
  validateCoreBalanceConfig(balance);
  return [
    createOrganizationLayer(balance.organization),
    createSourceGenerationLayer(balance.sourceGeneration),
    createBuildCompilationLayer(balance.build),
    createTestingVerificationLayer(balance.testing),
    createRuntimeDeploymentLayer(balance.runtime),
    createKnowledgeResearchLayer(balance.research),
    createTechnicalDebtLayer(balance.technicalDebt),
    createSelfImprovingAutomationLayer(balance.automation),
    createCrisisResponseLayer(balance.crisis),
  ];
}

export function createCoreSimulationModules(
  balance: CoreBalanceConfig = DEFAULT_CORE_BALANCE_CONFIG,
): ComposedLayers {
  return composeLayers(
    createCoreSimulationLayers(balance),
    coreBalanceContentHash(balance),
  );
}

export interface CoreSimulationConfigurationOptions {
  readonly seed: string;
  readonly gameVersion: string;
  readonly tickDurationMs?: number;
  readonly maximumOfflineTicks?: number;
  readonly offlineProgressPolicy?: "complete" | "truncate";
  readonly maximumEventsPerTick?: number;
  readonly metricsWindowTicks?: number;
  readonly metricsSampleIntervalTicks?: number;
  readonly resources?: readonly ResourceDefinition[];
  readonly initialResources?: ResourceSnapshot;
}

export function createCoreSimulationConfiguration(
  options: CoreSimulationConfigurationOptions,
  balance: CoreBalanceConfig = DEFAULT_CORE_BALANCE_CONFIG,
): SimulationConfiguration {
  const modules = createCoreSimulationModules(balance);
  return {
    ...options,
    contentHash: modules.contentHash ?? coreBalanceContentHash(balance),
    resources: options.resources ?? CORE_RESOURCE_DEFINITIONS,
    initialResources: { [Resources.Demand]: INITIAL_DEMAND_BACKLOG, ...options.initialResources },
    systems: modules.systems,
    pipelines: modules.pipelines,
    commandHandlers: modules.commandHandlers,
    eventHandlers: modules.eventHandlers,
  };
}
