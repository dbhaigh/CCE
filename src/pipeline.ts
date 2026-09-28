import type { SimulationSystem } from "./contracts.js";
import type { PipelineId, ResourceId, SystemId } from "./types.js";

export interface PipelineDefinition {
  readonly id: PipelineId;
  readonly displayName: string;
  readonly dependsOn?: readonly PipelineId[];
  readonly inputs?: readonly ResourceId[];
  readonly outputs?: readonly ResourceId[];
}

export interface ExecutionStage {
  readonly phase: number;
  readonly systems: readonly SimulationSystem[];
}

export interface ExecutionPlan {
  readonly stages: readonly ExecutionStage[];
  readonly pipelines: readonly PipelineDefinition[];
}

function intersects(
  left: readonly ResourceId[],
  right: readonly ResourceId[],
): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

function conflicts(
  left: SimulationSystem,
  right: SimulationSystem,
): boolean {
  return (
    intersects(left.writes, right.writes) ||
    intersects(left.writes, right.reads) ||
    intersects(right.writes, left.reads) ||
    left.stateReads.includes(right.id) ||
    right.stateReads.includes(left.id) ||
    left.emits.some((eventType) => right.eventReads.includes(eventType)) ||
    right.emits.some((eventType) => left.eventReads.includes(eventType))
  );
}

function validatePipelineGraph(
  pipelines: readonly PipelineDefinition[],
): Set<PipelineId> {
  const pipelineIds = new Set<PipelineId>();
  for (const pipeline of pipelines) {
    if (pipelineIds.has(pipeline.id)) {
      throw new Error(`Duplicate pipeline: ${pipeline.id}`);
    }
    pipelineIds.add(pipeline.id);
  }

  const visiting = new Set<PipelineId>();
  const visited = new Set<PipelineId>();
  const visit = (id: PipelineId): void => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new Error(`Pipeline dependency graph contains a cycle at ${id}`);
    }
    visiting.add(id);
    const pipeline = pipelines.find((candidate) => candidate.id === id);
    if (pipeline === undefined) {
      throw new Error(`Unknown pipeline: ${id}`);
    }
    for (const dependency of pipeline.dependsOn ?? []) {
      if (!pipelineIds.has(dependency)) {
        throw new Error(`Pipeline ${id} depends on unknown pipeline ${dependency}`);
      }
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of pipelineIds) {
    visit(id);
  }
  return pipelineIds;
}

export function buildExecutionPlan(
  systems: readonly SimulationSystem[],
  pipelines: readonly PipelineDefinition[],
): ExecutionPlan {
  const byId = new Map<SystemId, SimulationSystem>();
  const pipelineIds = validatePipelineGraph(pipelines);

  for (const system of systems) {
    if (byId.has(system.id)) {
      throw new Error(`Duplicate system: ${system.id}`);
    }
    if (!pipelineIds.has(system.pipeline)) {
      throw new Error(
        `System ${system.id} references unknown pipeline ${system.pipeline}`,
      );
    }
    byId.set(system.id, system);
  }

  for (const system of systems) {
    for (const dependencyId of system.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (dependency === undefined) {
        throw new Error(
          `System ${system.id} depends on unknown system ${dependencyId}`,
        );
      }
      if (dependency.phase > system.phase) {
        throw new Error(
          `System ${system.id} depends on later-phase system ${dependencyId}`,
        );
      }
      if (
        dependency.pipeline !== system.pipeline &&
        !(pipelines
          .find((pipeline) => pipeline.id === system.pipeline)
          ?.dependsOn?.includes(dependency.pipeline) ?? false)
      ) {
        throw new Error(
          `Pipeline ${system.pipeline} must declare dependency on ${dependency.pipeline}`,
        );
      }
    }
  }

  const remaining = new Set(byId.keys());
  const completed = new Set<SystemId>();
  const stages: ExecutionStage[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((id) => byId.get(id))
      .filter((system): system is SimulationSystem => system !== undefined)
      .filter((system) =>
        system.dependsOn.every((dependency) => completed.has(dependency)),
      )
      .sort((left, right) =>
        left.phase - right.phase || left.id.localeCompare(right.id),
      );

    if (ready.length === 0) {
      throw new Error(
        `System dependency graph contains a cycle: ${[...remaining].join(", ")}`,
      );
    }

    const phase = ready[0]?.phase;
    if (phase === undefined) {
      throw new Error("Execution planner reached an invalid empty stage");
    }

    const stageSystems: SimulationSystem[] = [];
    for (const candidate of ready) {
      if (candidate.phase !== phase) {
        break;
      }
      if (!stageSystems.some((existing) => conflicts(existing, candidate))) {
        stageSystems.push(candidate);
      }
    }

    for (const system of stageSystems) {
      remaining.delete(system.id);
      completed.add(system.id);
    }
    stages.push({ phase, systems: stageSystems });
  }

  return {
    stages,
    pipelines: [...pipelines].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}
