import {
  SimulationPhase,
  type CommandHandler,
  type SimulationSystem,
  type SimulationView,
  type SystemContext,
  type SystemUpdate,
} from "../contracts.js";
import { contentHash } from "../content.js";
import type { PipelineDefinition } from "../pipeline.js";
import { CORE_RESOURCE_DEFINITIONS, Resources } from "../resources.js";
import { decodeSave, encodeSave } from "../save.js";
import {
  Simulation,
  type OfflineAdvanceResult,
  type SimulationConfiguration,
} from "../simulation.js";
import {
  type JsonObject,
  type SimTick,
  pipelineId,
  simTick,
  systemId,
} from "../types.js";

const WORKFORCE_PIPELINE_ID = pipelineId("slice.workforce");
const COMPUTE_PIPELINE_ID = pipelineId("slice.binary-compute");
const SOURCE_PIPELINE_ID = pipelineId("slice.source");
const COMPILATION_PIPELINE_ID = pipelineId("slice.compilation");

export const SLICE_WORKFORCE_SYSTEM_ID = systemId("slice.workforce");
export const SLICE_BINARY_COMPUTE_SYSTEM_ID = systemId(
  "slice.binary-compute",
);
export const SLICE_SOURCE_SYSTEM_ID = systemId("slice.source");
export const SLICE_COMPILATION_SYSTEM_ID = systemId("slice.compilation");

const SLICE_BALANCE = {
  hireCost: 20,
  maximumAgents: 20,
  bootstrapCompute: 4,
  computePerBinary: 2,
  fastSourcePerAgent: 2,
  strictSourcePerAgent: 1,
  fastCompileThroughput: 8,
  strictCompileThroughput: 5,
  debtPerCompilePenalty: 10,
} as const;

export interface SliceWorkforceState extends JsonObject {
  readonly agents: number;
  readonly strictPolicy: boolean;
  readonly totalHired: number;
}

export interface SliceSourceState extends JsonObject {
  readonly generated: number;
  readonly debtCreated: number;
}

export interface SliceCompilationState extends JsonObject {
  readonly compiled: number;
  readonly debtCreated: number;
  readonly lastThroughput: number;
  readonly lastDebtPenalty: number;
}

export interface SliceBinaryComputeState extends JsonObject {
  readonly totalComputeGenerated: number;
  readonly lastComputeGenerated: number;
}

export interface HireAgentsPayload extends JsonObject {
  readonly count: number;
}

export interface TogglePolicyPayload extends JsonObject {
  readonly strict: boolean;
}

export interface VerticalSliceStatus extends JsonObject {
  readonly tick: number;
  readonly agents: number;
  readonly strictPolicy: boolean;
  readonly source: number;
  readonly binaries: number;
  readonly compute: number;
  readonly technicalDebt: number;
  readonly compiledTotal: number;
  readonly compileThroughput: number;
  readonly debtPenalty: number;
  readonly totalComputeGenerated: number;
  readonly money: number;
}

class WorkforceSystem implements SimulationSystem<SliceWorkforceState> {
  public readonly id = SLICE_WORKFORCE_SYSTEM_ID;
  public readonly pipeline = WORKFORCE_PIPELINE_ID;
  public readonly phase = SimulationPhase.Organization;
  public readonly dependsOn = [];
  public readonly reads = [];
  public readonly writes = [
    Resources.AgentCapacity,
    Resources.CodingStandards,
    Resources.RiskTolerance,
  ];
  public readonly stateReads = [];
  public readonly eventReads = [];
  public readonly emits = ["slice.workforce-ready"];

  public initialState(): SliceWorkforceState {
    return { agents: 0, strictPolicy: false, totalHired: 0 };
  }

  public run(view: SimulationView): SystemUpdate<SliceWorkforceState> {
    const state = view.getSystemState<SliceWorkforceState>(this.id);
    return {
      resources: [
        {
          resource: Resources.AgentCapacity,
          amount: state.agents,
          reason: "Hired coding agents",
        },
        {
          resource: Resources.CodingStandards,
          amount: state.strictPolicy ? 900 : 200,
          reason: "Active coding policy",
        },
        {
          resource: Resources.RiskTolerance,
          amount: state.strictPolicy ? 100 : 800,
          reason: "Active coding policy",
        },
      ],
      events: [{
        type: "slice.workforce-ready",
        payload: {
          agents: state.agents,
          strictPolicy: state.strictPolicy,
        },
      }],
      telemetry: {
        status: state.agents === 0 ? "blocked" : "active",
        throughput: state.agents,
        ...(state.agents === 0 ? { bottleneck: "no-agents" } : {}),
      },
    };
  }
}

class BinaryComputeSystem
  implements SimulationSystem<SliceBinaryComputeState>
{
  public readonly id = SLICE_BINARY_COMPUTE_SYSTEM_ID;
  public readonly pipeline = COMPUTE_PIPELINE_ID;
  public readonly phase = SimulationPhase.Infrastructure;
  public readonly dependsOn = [];
  public readonly reads = [Resources.Binaries];
  public readonly writes = [Resources.Compute];
  public readonly stateReads = [];
  public readonly eventReads = [];
  public readonly emits = ["slice.compute-generated"];

  public initialState(): SliceBinaryComputeState {
    return { totalComputeGenerated: 0, lastComputeGenerated: 0 };
  }

  public run(
    view: SimulationView,
  ): SystemUpdate<SliceBinaryComputeState> {
    const state = view.getSystemState<SliceBinaryComputeState>(this.id);
    const generated =
      SLICE_BALANCE.bootstrapCompute +
      view.resources.get(Resources.Binaries) *
        SLICE_BALANCE.computePerBinary;
    return {
      resources: [{
        resource: Resources.Compute,
        amount: generated,
        reason: "Compiled binaries running as build workers",
      }],
      statePatch: {
        totalComputeGenerated: state.totalComputeGenerated + generated,
        lastComputeGenerated: generated,
      },
      events: [{
        type: "slice.compute-generated",
        payload: { generated },
      }],
      telemetry: { status: "active", throughput: generated },
    };
  }
}

class SourceSystem implements SimulationSystem<SliceSourceState> {
  public readonly id = SLICE_SOURCE_SYSTEM_ID;
  public readonly pipeline = SOURCE_PIPELINE_ID;
  public readonly phase = SimulationPhase.Source;
  public readonly dependsOn = [SLICE_WORKFORCE_SYSTEM_ID];
  public readonly reads = [
    Resources.AgentCapacity,
    Resources.CodingStandards,
    Resources.RiskTolerance,
    Resources.Source,
  ];
  public readonly writes = [
    Resources.AgentCapacity,
    Resources.Source,
    Resources.TechnicalDebt,
  ];
  public readonly stateReads = [];
  public readonly eventReads = ["slice.workforce-ready"];
  public readonly emits = ["slice.source-generated"];

  public initialState(): SliceSourceState {
    return { generated: 0, debtCreated: 0 };
  }

  public run(
    view: SimulationView,
  ): SystemUpdate<SliceSourceState> | undefined {
    const agents = view.resources.get(Resources.AgentCapacity);
    const strict = view.resources.get(Resources.CodingStandards) >= 500;
    const perAgent = strict
      ? SLICE_BALANCE.strictSourcePerAgent
      : SLICE_BALANCE.fastSourcePerAgent;
    const generated = Math.min(
      agents * perAgent,
      1_000 - view.resources.get(Resources.Source),
    );
    if (generated === 0) {
      return {
        telemetry: {
          status: "blocked",
          throughput: 0,
          bottleneck: agents === 0 ? "no-agents" : "source-buffer-full",
        },
      };
    }
    const debt = strict
      ? Math.floor(generated / 8)
      : Math.max(1, Math.ceil(generated / 2));
    const state = view.getSystemState<SliceSourceState>(this.id);
    return {
      resources: [
        {
          resource: Resources.AgentCapacity,
          amount: -agents,
          reason: "Agent source production",
        },
        {
          resource: Resources.Source,
          amount: generated,
          reason: "Agent-generated source",
        },
        {
          resource: Resources.TechnicalDebt,
          amount: debt,
          reason: strict ? "Reviewed source" : "Rushed source",
        },
      ],
      statePatch: {
        generated: state.generated + generated,
        debtCreated: state.debtCreated + debt,
      },
      events: [{
        type: "slice.source-generated",
        payload: { generated, debt, strict },
      }],
      telemetry: { status: "active", throughput: generated },
    };
  }
}

class CompilationSystem
  implements SimulationSystem<SliceCompilationState>
{
  public readonly id = SLICE_COMPILATION_SYSTEM_ID;
  public readonly pipeline = COMPILATION_PIPELINE_ID;
  public readonly phase = SimulationPhase.Build;
  public readonly dependsOn = [SLICE_SOURCE_SYSTEM_ID];
  public readonly reads = [
    Resources.Source,
    Resources.Compute,
    Resources.Binaries,
    Resources.TechnicalDebt,
    Resources.CodingStandards,
  ];
  public readonly writes = [
    Resources.Source,
    Resources.Compute,
    Resources.Binaries,
    Resources.TechnicalDebt,
  ];
  public readonly stateReads = [];
  public readonly eventReads = ["slice.source-generated"];
  public readonly emits = ["slice.compiled"];

  public initialState(): SliceCompilationState {
    return {
      compiled: 0,
      debtCreated: 0,
      lastThroughput: 0,
      lastDebtPenalty: 0,
    };
  }

  public run(
    view: SimulationView,
    _context: SystemContext,
  ): SystemUpdate<SliceCompilationState> {
    const strict = view.resources.get(Resources.CodingStandards) >= 500;
    const baseThroughput = strict
      ? SLICE_BALANCE.strictCompileThroughput
      : SLICE_BALANCE.fastCompileThroughput;
    const debtPenalty = Math.floor(
      view.resources.get(Resources.TechnicalDebt) /
        SLICE_BALANCE.debtPerCompilePenalty,
    );
    const throughput = Math.max(1, baseThroughput - debtPenalty);
    const compiled = Math.min(
      throughput,
      view.resources.get(Resources.Source),
      view.resources.get(Resources.Compute),
      500 - view.resources.get(Resources.Binaries),
    );
    const state = view.getSystemState<SliceCompilationState>(this.id);
    if (compiled === 0) {
      return {
        statePatch: {
          lastThroughput: throughput,
          lastDebtPenalty: debtPenalty,
        },
        telemetry: {
          status: "blocked",
          throughput: 0,
          bottleneck:
            view.resources.get(Resources.Source) === 0
              ? "source"
              : view.resources.get(Resources.Compute) === 0
                ? "compute"
                : "binary-buffer-full",
        },
      };
    }
    const debt = strict
      ? Math.floor(compiled / 10)
      : Math.max(1, Math.ceil(compiled / 3));
    return {
      resources: [
        {
          resource: Resources.Source,
          amount: -compiled,
          reason: "Compilation input",
        },
        {
          resource: Resources.Compute,
          amount: -compiled,
          reason: "Compiler execution",
        },
        {
          resource: Resources.Binaries,
          amount: compiled,
          reason: "Compiled binaries",
        },
        {
          resource: Resources.TechnicalDebt,
          amount: debt,
          reason: strict ? "Conservative build" : "Fast build shortcuts",
        },
      ],
      statePatch: {
        compiled: state.compiled + compiled,
        debtCreated: state.debtCreated + debt,
        lastThroughput: throughput,
        lastDebtPenalty: debtPenalty,
      },
      events: [{
        type: "slice.compiled",
        payload: { compiled, debt, throughput, debtPenalty },
      }],
      telemetry: { status: "active", throughput: compiled },
    };
  }
}

const pipelines: readonly PipelineDefinition[] = [
  {
    id: WORKFORCE_PIPELINE_ID,
    displayName: "Workforce & Policy",
    inputs: [Resources.Money],
    outputs: [
      Resources.AgentCapacity,
      Resources.CodingStandards,
      Resources.RiskTolerance,
    ],
  },
  {
    id: COMPUTE_PIPELINE_ID,
    displayName: "Binary Compute",
    inputs: [Resources.Binaries],
    outputs: [Resources.Compute],
  },
  {
    id: SOURCE_PIPELINE_ID,
    displayName: "Agent Source",
    dependsOn: [WORKFORCE_PIPELINE_ID],
    inputs: [Resources.AgentCapacity],
    outputs: [Resources.Source, Resources.TechnicalDebt],
  },
  {
    id: COMPILATION_PIPELINE_ID,
    displayName: "Compilation",
    dependsOn: [SOURCE_PIPELINE_ID],
    inputs: [
      Resources.Source,
      Resources.Compute,
      Resources.TechnicalDebt,
    ],
    outputs: [Resources.Binaries, Resources.TechnicalDebt],
  },
];

function createHireHandler(): CommandHandler<HireAgentsPayload> {
  return {
    id: SLICE_WORKFORCE_SYSTEM_ID,
    type: "slice.hire-agents",
    reads: [Resources.Money],
    writes: [Resources.Money],
    stateReads: [],
    eventReads: [],
    emits: ["slice.agents-hired"],
    handle: (command, view) => {
      const { count } = command.payload;
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error("Agent count must be a positive integer");
      }
      const state = view.getSystemState<SliceWorkforceState>(
        SLICE_WORKFORCE_SYSTEM_ID,
      );
      if (state.agents + count > SLICE_BALANCE.maximumAgents) {
        throw new Error(`Cannot exceed ${SLICE_BALANCE.maximumAgents} agents`);
      }
      const cost = count * SLICE_BALANCE.hireCost;
      if (!view.resources.has(Resources.Money, cost)) {
        throw new Error("Insufficient Money to hire agents");
      }
      return {
        resources: [{
          resource: Resources.Money,
          amount: -cost,
          reason: "Agent hiring",
        }],
        statePatch: {
          agents: state.agents + count,
          totalHired: state.totalHired + count,
        },
        events: [{
          type: "slice.agents-hired",
          payload: { count, cost },
        }],
      };
    },
  };
}

function createPolicyHandler(): CommandHandler<TogglePolicyPayload> {
  return {
    id: SLICE_WORKFORCE_SYSTEM_ID,
    type: "slice.set-strict-policy",
    reads: [],
    writes: [],
    stateReads: [],
    eventReads: [],
    emits: ["slice.policy-changed"],
    handle: (command) => ({
      statePatch: { strictPolicy: command.payload.strict },
      events: [{
        type: "slice.policy-changed",
        payload: { strict: command.payload.strict },
      }],
    }),
  };
}

export function createVerticalSliceConfiguration(
  seed = "vertical-slice",
): SimulationConfiguration {
  const systems: readonly SimulationSystem[] = [
    new WorkforceSystem(),
    new BinaryComputeSystem(),
    new SourceSystem(),
    new CompilationSystem(),
  ];
  return {
    seed,
    gameVersion: "vertical-slice-1",
    contentHash: contentHash(SLICE_BALANCE),
    tickDurationMs: 1_000,
    resources: CORE_RESOURCE_DEFINITIONS,
    initialResources: { [Resources.Money]: 120 },
    systems,
    pipelines,
    commandHandlers: [createHireHandler(), createPolicyHandler()],
  };
}

export function createVerticalSliceGame(
  seed = "vertical-slice",
): Simulation {
  return new Simulation(createVerticalSliceConfiguration(seed));
}

export function hireAgents(
  simulation: Simulation,
  count: number,
  issuedAt: SimTick = simTick(simulation.tick + 1),
): void {
  simulation.dispatch({
    id: `hire:${simulation.tick}:${count}`,
    type: "slice.hire-agents",
    issuedAt,
    payload: { count },
  });
}

export function setStrictPolicy(
  simulation: Simulation,
  strict: boolean,
  issuedAt: SimTick = simTick(simulation.tick + 1),
): void {
  simulation.dispatch({
    id: `policy:${simulation.tick}:${strict}`,
    type: "slice.set-strict-policy",
    issuedAt,
    payload: { strict },
  });
}

export function saveVerticalSlice(
  simulation: Simulation,
  wallClockSavedAt: number,
): string {
  return encodeSave(simulation, wallClockSavedAt);
}

export function loadVerticalSlice(
  serialized: string,
  seed = "vertical-slice",
): Simulation {
  return decodeSave(createVerticalSliceConfiguration(seed), serialized);
}

export function advanceVerticalSliceOffline(
  simulation: Simulation,
  savedAt: number,
  now: number,
): OfflineAdvanceResult {
  return simulation.advanceOffline(savedAt, now);
}

export function getVerticalSliceStatus(
  simulation: Simulation,
): VerticalSliceStatus {
  const workforce = simulation.getState<SliceWorkforceState>(
    SLICE_WORKFORCE_SYSTEM_ID,
  );
  const compilation = simulation.getState<SliceCompilationState>(
    SLICE_COMPILATION_SYSTEM_ID,
  );
  const compute = simulation.getState<SliceBinaryComputeState>(
    SLICE_BINARY_COMPUTE_SYSTEM_ID,
  );
  return {
    tick: simulation.tick,
    agents: workforce.agents,
    strictPolicy: workforce.strictPolicy,
    source: simulation.resources.get(Resources.Source),
    binaries: simulation.resources.get(Resources.Binaries),
    compute: simulation.resources.get(Resources.Compute),
    technicalDebt: simulation.resources.get(Resources.TechnicalDebt),
    compiledTotal: compilation.compiled,
    compileThroughput: compilation.lastThroughput,
    debtPenalty: compilation.lastDebtPenalty,
    totalComputeGenerated: compute.totalComputeGenerated,
    money: simulation.resources.get(Resources.Money),
  };
}
