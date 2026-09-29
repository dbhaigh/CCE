import { Resources } from "./resources.js";
import type { Simulation } from "./simulation.js";
import { deepFreeze, type JsonObject } from "./types.js";
import {
  ORGANIZATION_SYSTEM_ID,
  SOURCE_GENERATION_SYSTEM_ID,
  TECHNICAL_DEBT_SYSTEM_ID,
} from "./layers/ids.js";
import type {
  OrganizationState,
  OrganizationPolicy,
} from "./layers/organization.js";
import type { SourceGenerationState } from "./layers/source-generation.js";
import type { DebtRemediation, TechnicalDebtState } from "./layers/technical-debt.js";

export interface DebtHeatmapCell extends JsonObject {
  readonly categoryId: string;
  readonly principal: number;
  readonly sharePermille: number;
  readonly interestPermille: number;
  readonly interestPerTick: number;
  readonly maintenanceEfficiencyPermille: number;
}

export interface PipelineVisualizationNode extends JsonObject {
  readonly id: string;
  readonly label: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly systemIds: readonly string[];
}

export interface PipelineVisualizationEdge extends JsonObject {
  readonly from: string;
  readonly to: string;
}

export interface SystemVisualizationNode extends JsonObject {
  readonly id: string;
  readonly pipelineId: string;
  readonly phase: number;
  readonly stage: number;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly eventReads: readonly string[];
  readonly emits: readonly string[];
}

export interface RollingBottleneckMetric extends JsonObject {
  readonly systemId: string;
  readonly pipelineId: string;
  readonly samples: number;
  readonly activeTicks: number;
  readonly blockedTicks: number;
  readonly idleTicks: number;
  readonly throughput: number;
  readonly resourceFlow: number;
  readonly eventsEmitted: number;
  readonly lastBottleneck: string | null;
}

export interface TeamProductivityMetric extends JsonObject {
  readonly teamId: string;
  readonly headcount: number;
  readonly fundedPeople: number;
  readonly sourceCapacity: number;
  readonly moralePermille: number;
  readonly engineeringSkillPermille: number;
  readonly policy: OrganizationPolicy;
}

export interface SwarmProductivityMetric extends JsonObject {
  readonly swarmId: string;
  readonly agents: number;
  readonly fundedAgents: number;
  readonly effectiveCapacity: number;
  readonly autonomyPermille: number;
  readonly effectiveAlignmentPermille: number;
  readonly productivityPermille: number;
}

export interface SimulationDiagnostics extends JsonObject {
  readonly tick: number;
  readonly debt: {
    readonly total: number;
    readonly peak: number;
    readonly retired: number;
    readonly remediation: DebtRemediation | null;
    readonly heatmap: readonly DebtHeatmapCell[];
  };
  readonly pipeline: {
    readonly nodes: readonly PipelineVisualizationNode[];
    readonly edges: readonly PipelineVisualizationEdge[];
    readonly systems: readonly SystemVisualizationNode[];
    readonly rollingBottlenecks: readonly RollingBottleneckMetric[];
  };
  readonly productivity: {
    readonly teams: readonly TeamProductivityMetric[];
    readonly swarms: readonly SwarmProductivityMetric[];
    readonly sourceGenerated: number;
    readonly humanAuthored: number;
    readonly aiAuthored: number;
  };
}

export function createSimulationDiagnostics(
  simulation: Simulation,
): SimulationDiagnostics {
  const debt = simulation.getState<TechnicalDebtState>(
    TECHNICAL_DEBT_SYSTEM_ID,
  );
  const totalDebt = simulation.resources.get(Resources.TechnicalDebt);
  const heatmap = debt.categories.map((category) => {
    const principal = debt.principalByCategory[category.id] ?? 0;
    return {
      categoryId: category.id,
      principal,
      sharePermille:
        totalDebt === 0 ? 0 : Math.floor((principal * 1_000) / totalDebt),
      interestPermille: category.interestPermille,
      interestPerTick: Math.floor(
        (principal * category.interestPermille) / 1_000,
      ),
      maintenanceEfficiencyPermille:
        category.maintenanceEfficiencyPermille,
    };
  });

  const organization = simulation.getState<OrganizationState>(
    ORGANIZATION_SYSTEM_ID,
  );
  const source = simulation.getState<SourceGenerationState>(
    SOURCE_GENERATION_SYSTEM_ID,
  );
  const allocationByTeam = new Map(
    organization.teamAllocations.map((allocation) => [
      allocation.teamId,
      allocation,
    ]),
  );
  const swarmById = new Map(
    organization.swarmProductivity.map((metric) => [
      metric.swarmId,
      metric,
    ]),
  );

  const pipelineNodes = simulation.plan.pipelines.map((pipeline) => ({
    id: pipeline.id,
    label: pipeline.displayName,
    inputs: [...(pipeline.inputs ?? [])],
    outputs: [...(pipeline.outputs ?? [])],
    systemIds: simulation.plan.stages.flatMap((stage) =>
      stage.systems
        .filter((system) => system.pipeline === pipeline.id)
        .map((system) => system.id),
    ),
  }));
  const systems = simulation.plan.stages.flatMap((stage, stageIndex) =>
    stage.systems.map((system) => ({
      id: system.id,
      pipelineId: system.pipeline,
      phase: system.phase,
      stage: stageIndex,
      reads: [...system.reads],
      writes: [...system.writes],
      eventReads: [...system.eventReads],
      emits: [...system.emits],
    })),
  );
  const rollingBySystem = new Map<string, RollingBottleneckMetric>();
  for (const metric of simulation.getRecentSystemMetrics()) {
    const current = rollingBySystem.get(metric.systemId);
    rollingBySystem.set(metric.systemId, {
      systemId: metric.systemId,
      pipelineId: metric.pipelineId,
      samples: (current?.samples ?? 0) + 1,
      activeTicks:
        (current?.activeTicks ?? 0) + (metric.status === "active" ? 1 : 0),
      blockedTicks:
        (current?.blockedTicks ?? 0) + (metric.status === "blocked" ? 1 : 0),
      idleTicks:
        (current?.idleTicks ?? 0) + (metric.status === "idle" ? 1 : 0),
      throughput: (current?.throughput ?? 0) + metric.throughput,
      resourceFlow: (current?.resourceFlow ?? 0) + metric.resourceFlow,
      eventsEmitted:
        (current?.eventsEmitted ?? 0) + metric.eventsEmitted,
      lastBottleneck:
        metric.bottleneck ?? current?.lastBottleneck ?? null,
    });
  }

  return deepFreeze({
    tick: simulation.tick,
    debt: {
      total: totalDebt,
      peak: debt.peakDebt,
      retired: debt.retired,
      remediation: debt.lastRemediation ?? null,
      heatmap,
    },
    pipeline: {
      nodes: pipelineNodes,
      edges: simulation.plan.pipelines.flatMap((pipeline) =>
        (pipeline.dependsOn ?? []).map((dependency) => ({
          from: dependency,
          to: pipeline.id,
        })),
      ),
      systems,
      rollingBottlenecks: [...rollingBySystem.values()].sort((left, right) =>
        left.systemId.localeCompare(right.systemId),
      ),
    },
    productivity: {
      teams: organization.teams.map((team) => {
        const allocation = allocationByTeam.get(team.id);
        return {
          teamId: team.id,
          headcount: team.headcount,
          fundedPeople: allocation?.fundedPeople ?? 0,
          sourceCapacity: allocation?.capacity ?? 0,
          moralePermille: team.moralePermille,
          engineeringSkillPermille: team.engineeringSkillPermille,
          policy: allocation?.policy ?? organization.policy,
        };
      }),
      swarms: organization.agentSwarms.map((swarm) => {
        const metric = swarmById.get(swarm.id);
        return {
          swarmId: swarm.id,
          agents: swarm.agents,
          fundedAgents: metric?.fundedAgents ?? 0,
          effectiveCapacity: metric?.effectiveCapacity ?? 0,
          autonomyPermille: swarm.autonomyPermille,
          effectiveAlignmentPermille:
            metric?.effectiveAlignmentPermille ?? swarm.alignmentPermille,
          productivityPermille: swarm.productivityPermille,
        };
      }),
      sourceGenerated: source.generated,
      humanAuthored: source.humanAuthored,
      aiAuthored: source.aiAuthored,
    },
  }) as SimulationDiagnostics;
}
