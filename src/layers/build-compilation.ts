import {
  SimulationPhase,
  type CommandHandler,
  type SimulationSystem,
  type SimulationView,
  type SystemContext,
  type SystemUpdate,
} from "../contracts.js";
import { topologicalOrder } from "../graph.js";
import { Resources } from "../resources.js";
import { type JsonObject } from "../types.js";
import {
  appendBoundedCohort,
  assertCohortConservation,
  parseSourceArtifact,
  payloadField,
  type BinaryArtifactCohort,
  type SourceArtifactCohort,
  weightedPermille,
} from "./cohorts.js";
import type { SimulationLayer } from "./layer.js";
import {
  BUILD_LAYER_ID,
  COMPILATION_SYSTEM_ID,
  HARDWARE_SYSTEM_ID,
  ORGANIZATION_LAYER_ID,
  ORGANIZATION_SYSTEM_ID,
  SOURCE_GENERATION_SYSTEM_ID,
  SOURCE_LAYER_ID,
} from "./ids.js";

export {
  BUILD_LAYER_ID,
  COMPILATION_SYSTEM_ID,
  HARDWARE_SYSTEM_ID,
} from "./ids.js";

export interface HardwareProfile extends JsonObject {
  readonly id: string;
  readonly computePerTick: number;
  readonly moneyPerTick: number;
}

export interface HardwareState extends JsonObject {
  readonly profiles: readonly HardwareProfile[];
  readonly activeProfileId: string;
  readonly totalComputeProvisioned: number;
}

export interface BuildStageDefinition extends JsonObject {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly computePerSource: number;
  readonly failureChancePermille: number;
  readonly cacheablePermille: number;
}

export interface BuildState extends JsonObject {
  readonly cacheWarmthPermille: number;
  readonly compiled: number;
  readonly failures: number;
  readonly stageExecutions: Readonly<Record<string, number>>;
  readonly sourceCohorts: readonly SourceArtifactCohort[];
  readonly binaryCohortsCreated: number;
}

export interface BuildLayerOptions {
  readonly hardwareProfiles: readonly HardwareProfile[];
  readonly initialHardwareProfileId: string;
  readonly stages: readonly BuildStageDefinition[];
  readonly sourcePerTick: number;
  readonly binariesPerSource: number;
  readonly binaryBufferCapacity: number;
  readonly bugRatePermille: number;
  readonly debtUnitsPerThroughputPenalty: number;
}

export interface SelectHardwarePayload extends JsonObject {
  readonly profileId: string;
}

class HardwareSystem implements SimulationSystem<HardwareState> {
  public readonly id = HARDWARE_SYSTEM_ID;
  public readonly pipeline = BUILD_LAYER_ID;
  public readonly phase = SimulationPhase.Infrastructure;
  public readonly dependsOn = [ORGANIZATION_SYSTEM_ID];
  public readonly reads = [Resources.Money];
  public readonly writes = [Resources.Money, Resources.Compute];
  public readonly stateReads = [];
  public readonly eventReads = [];
  public readonly emits = ["build.compute-provisioned"];

  public constructor(
    private readonly profiles: readonly HardwareProfile[],
    private readonly initialProfileId: string,
  ) {
    if (!profiles.some((profile) => profile.id === initialProfileId)) {
      throw new Error(`Unknown initial hardware profile: ${initialProfileId}`);
    }
  }

  public initialState(): HardwareState {
    return {
      profiles: this.profiles,
      activeProfileId: this.initialProfileId,
      totalComputeProvisioned: 0,
    };
  }

  public run(view: SimulationView): SystemUpdate<HardwareState> {
    const state = view.getSystemState<HardwareState>(this.id);
    const profile = state.profiles.find(
      (candidate) => candidate.id === state.activeProfileId,
    );
    if (profile === undefined) {
      throw new Error(`Active hardware profile is missing: ${state.activeProfileId}`);
    }

    const fundedPermille =
      profile.moneyPerTick === 0
        ? 1_000
        : Math.min(
            1_000,
            Math.floor(
              (view.resources.get(Resources.Money) * 1_000) /
                profile.moneyPerTick,
            ),
          );
    const compute = Math.floor(
      (profile.computePerTick * fundedPermille) / 1_000,
    );
    const cost = Math.floor(
      (profile.moneyPerTick * fundedPermille) / 1_000,
    );
    return {
      resources: [
        {
          resource: Resources.Money,
          amount: -cost,
          reason: `Hardware profile ${profile.id}`,
        },
        {
          resource: Resources.Compute,
          amount: compute,
          reason: `Hardware profile ${profile.id}`,
        },
      ],
      statePatch: {
        totalComputeProvisioned: state.totalComputeProvisioned + compute,
      },
      events: [
        {
          type: "build.compute-provisioned",
          payload: { profileId: profile.id, compute, cost },
        },
      ],
    };
  }
}

class BuildSystem implements SimulationSystem<BuildState> {
  public readonly id = COMPILATION_SYSTEM_ID;
  public readonly pipeline = BUILD_LAYER_ID;
  public readonly phase = SimulationPhase.Build;
  public readonly dependsOn = [SOURCE_GENERATION_SYSTEM_ID];
  public readonly reads = [
    Resources.Source,
    Resources.Compute,
    Resources.Binaries,
    Resources.TechnicalDebt,
    Resources.PolicyStrength,
    Resources.CodingStandards,
    Resources.RiskTolerance,
    Resources.Knowledge,
  ];
  public readonly writes = [
    Resources.Source,
    Resources.Compute,
    Resources.Binaries,
    Resources.Bugs,
    Resources.Insight,
    Resources.TechnicalDebt,
  ];
  public readonly stateReads = [];
  public readonly eventReads = [
    "source.batch-generated",
    "automation.source-generated",
  ];
  public readonly emits = [
    "build.completed",
    "build.failed",
    "build.cache-updated",
  ];

  private readonly stageOrder: readonly BuildStageDefinition[];

  public constructor(private readonly options: BuildLayerOptions) {
    this.stageOrder = this.orderStages(options.stages);
  }

  public initialState(): BuildState {
    return {
      cacheWarmthPermille: 0,
      compiled: 0,
      failures: 0,
      stageExecutions: Object.fromEntries(
        this.stageOrder.map((stage) => [stage.id, 0]),
      ),
      sourceCohorts: [],
      binaryCohortsCreated: 0,
    };
  }

  public run(
    view: SimulationView,
    context: SystemContext,
  ): SystemUpdate<BuildState> | undefined {
    const state = view.getSystemState<BuildState>(this.id);
    let sourceCohorts = state.sourceCohorts;
    for (const event of view.events) {
      const rawArtifacts = payloadField(event.payload, "artifacts");
      const artifacts = Array.isArray(rawArtifacts)
        ? rawArtifacts.map(parseSourceArtifact).filter(
            (artifact): artifact is SourceArtifactCohort =>
              artifact !== undefined,
          )
        : [
            parseSourceArtifact(payloadField(event.payload, "artifact")),
          ].filter(
            (artifact): artifact is SourceArtifactCohort =>
              artifact !== undefined,
          );
      for (const artifact of artifacts) {
        sourceCohorts = appendBoundedCohort(
          sourceCohorts,
          artifact,
          256,
          (left, right) =>
            left.humanPermille === right.humanPermille &&
            left.debtRiskPermille === right.debtRiskPermille,
          (left, right) => ({
            ...left,
            quantity: left.quantity + right.quantity,
          }),
          (left, right) => ({
            ...left,
            id: `compacted:${left.id}:${right.id}`,
            quantity: left.quantity + right.quantity,
            humanPermille: weightedPermille(
              left.humanPermille,
              left.quantity,
              right.humanPermille,
              right.quantity,
            ),
            debtRiskPermille: weightedPermille(
              left.debtRiskPermille,
              left.quantity,
              right.debtRiskPermille,
              right.quantity,
            ),
            codingStandardsPermille: weightedPermille(
              left.codingStandardsPermille,
              left.quantity,
              right.codingStandardsPermille,
              right.quantity,
            ),
            reviewStrengthPermille: weightedPermille(
              left.reviewStrengthPermille,
              left.quantity,
              right.reviewStrengthPermille,
              right.quantity,
            ),
            testStrengthPermille: weightedPermille(
              left.testStrengthPermille,
              left.quantity,
              right.testStrengthPermille,
              right.quantity,
            ),
            riskTolerancePermille: weightedPermille(
              left.riskTolerancePermille,
              left.quantity,
              right.riskTolerancePermille,
              right.quantity,
            ),
            releaseCadencePermille: weightedPermille(
              left.releaseCadencePermille,
              left.quantity,
              right.releaseCadencePermille,
              right.quantity,
            ),
            teamId:
              left.teamId === right.teamId ? left.teamId : "compacted",
            createdTick: Math.min(left.createdTick, right.createdTick),
          }),
        );
      }
    }
    assertCohortConservation(
      "Source",
      view.resources.get(Resources.Source),
      sourceCohorts,
    );
    const debt = view.resources.get(Resources.TechnicalDebt);
    const policy = view.resources.get(Resources.PolicyStrength);
    const standards = view.resources.get(Resources.CodingStandards);
    const risk = view.resources.get(Resources.RiskTolerance);
    const knowledge = view.resources.get(Resources.Knowledge);
    const debtPenalty = Math.floor(
      debt / this.options.debtUnitsPerThroughputPenalty,
    );
    const effectiveThroughput = Math.max(
      1,
      this.options.sourcePerTick - debtPenalty,
    );
    const rawComputePerSource = this.stageOrder.reduce(
      (total, stage) => total + stage.computePerSource,
      0,
    );
    const cacheableCompute = this.stageOrder.reduce(
      (total, stage) =>
        total +
        Math.floor(
          (stage.computePerSource * stage.cacheablePermille) / 1_000,
        ),
      0,
    );
    const cacheSavings = Math.floor(
      (cacheableCompute * state.cacheWarmthPermille) / 1_000,
    );
    const computePerSource = Math.max(1, rawComputePerSource - cacheSavings);
    const availableBinaryBuffer = Math.floor(
      (this.options.binaryBufferCapacity -
        view.resources.get(Resources.Binaries)) /
        this.options.binariesPerSource,
    );
    const consumed = Math.max(
      0,
      Math.min(
        effectiveThroughput,
        view.resources.get(Resources.Source),
        Math.floor(view.resources.get(Resources.Compute) / computePerSource),
        availableBinaryBuffer,
      ),
    );
    if (consumed === 0) {
      return {
        ...(sourceCohorts === state.sourceCohorts
          ? {}
          : { statePatch: { sourceCohorts } }),
        telemetry: {
          status: "blocked",
          throughput: 0,
          bottleneck:
            view.resources.get(Resources.Source) === 0
              ? "source"
              : availableBinaryBuffer <= 0
                ? "binary-buffer-full"
                : "compute",
        },
      };
    }
    const sourcePolicy = this.averageSourcePolicy(sourceCohorts, consumed);
    const localGovernance = Math.floor(
      (sourcePolicy.reviewStrengthPermille +
        sourcePolicy.testStrengthPermille) /
        2,
    );

    const baseFailureRate = this.stageOrder.reduce(
      (total, stage) => total + stage.failureChancePermille,
      0,
    );
    const failureRate = Math.max(
      0,
      Math.min(
        950,
        baseFailureRate +
          debtPenalty * 15 +
          Math.floor(sourcePolicy.riskTolerancePermille / 8) -
          Math.floor(localGovernance / 4) -
          Math.floor(sourcePolicy.codingStandardsPermille / 5),
      ),
    );
    const failed = context.random.chance("build-failure", failureRate);
    const binaries = failed ? 0 : consumed * this.options.binariesPerSource;
    const bugRate = Math.max(
      0,
      Math.min(
        1_000,
        this.options.bugRatePermille +
          debtPenalty * 20 -
          Math.floor(policy / 5) -
        Math.floor(sourcePolicy.codingStandardsPermille / 4) +
        Math.floor(sourcePolicy.riskTolerancePermille / 6) -
          Math.min(200, knowledge),
      ),
    );
    const bugs = failed
      ? 0
      : this.stochasticRate(context, "build-bugs", consumed, bugRate);
    const debtCreated = failed
      ? 2
      : this.stochasticRate(
          context,
          "build-debt",
          consumed,
          Math.max(0, 150 - Math.floor(localGovernance / 5)),
        );
    const cacheWarmth = Math.min(
      950,
      state.cacheWarmthPermille +
        25 +
        Math.floor(knowledge / 20) -
        Math.min(100, debtPenalty),
    );
    const stageExecutions = Object.fromEntries(
      this.stageOrder.map((stage) => [
        stage.id,
        (state.stageExecutions[stage.id] ?? 0) + consumed,
      ]),
    );
    const remainingSourceCohorts = this.consumeSourceCohorts(
      sourceCohorts,
      consumed,
    );
    const artifact: BinaryArtifactCohort | undefined =
      binaries === 0
        ? undefined
        : {
            id: `binary:${context.tick}`,
            quantity: binaries,
            latentDefects: bugs,
            buildConfidencePermille: Math.max(0, 1_000 - failureRate),
            reviewStrengthPermille:
              sourcePolicy.reviewStrengthPermille,
            testStrengthPermille: sourcePolicy.testStrengthPermille,
            riskTolerancePermille: sourcePolicy.riskTolerancePermille,
            releaseCadencePermille: sourcePolicy.releaseCadencePermille,
            createdTick: context.tick,
          };

    return {
      resources: [
        {
          resource: Resources.Source,
          amount: -consumed,
          reason: "Build graph input",
        },
        {
          resource: Resources.Compute,
          amount: -(consumed * computePerSource),
          reason: "Build graph execution",
        },
        {
          resource: Resources.Binaries,
          amount: binaries,
          reason: "Linked build artifacts",
        },
        {
          resource: Resources.Bugs,
          amount: bugs,
          reason: "Build-time latent defects",
        },
        {
          resource: Resources.Insight,
          amount: failed ? 2 : 1,
          reason: "Compiler diagnostics",
        },
        {
          resource: Resources.TechnicalDebt,
          amount: debtCreated,
          reason: "Build graph complexity",
        },
      ],
      statePatch: {
        cacheWarmthPermille: cacheWarmth,
        compiled: state.compiled + consumed,
        failures: state.failures + (failed ? 1 : 0),
        stageExecutions,
        sourceCohorts: remainingSourceCohorts,
        binaryCohortsCreated:
          state.binaryCohortsCreated + (artifact === undefined ? 0 : 1),
      },
      events: [
        {
          type: failed ? "build.failed" : "build.completed",
          payload: {
            sourceConsumed: consumed,
            binaries,
            bugs,
            debt: debtCreated,
            computePerSource,
            artifact: artifact ?? null,
            debtCategoryId: "build-fragility",
          },
        },
        {
          type: "build.cache-updated",
          payload: { warmthPermille: cacheWarmth },
        },
      ],
      telemetry: { status: "active", throughput: binaries },
    };
  }

  private consumeSourceCohorts(
    cohorts: readonly SourceArtifactCohort[],
    quantity: number,
  ): readonly SourceArtifactCohort[] {
    let remaining = quantity;
    const result: SourceArtifactCohort[] = [];
    for (const cohort of cohorts) {
      const consumed = Math.min(remaining, cohort.quantity);
      remaining -= consumed;
      if (cohort.quantity > consumed) {
        result.push({ ...cohort, quantity: cohort.quantity - consumed });
      }
    }
    return result;
  }

  private averageSourcePolicy(
    cohorts: readonly SourceArtifactCohort[],
    quantity: number,
  ): {
    readonly codingStandardsPermille: number;
    readonly reviewStrengthPermille: number;
    readonly testStrengthPermille: number;
    readonly riskTolerancePermille: number;
    readonly releaseCadencePermille: number;
  } {
    let remaining = quantity;
    let selected = 0;
    let standards = 0;
    let review = 0;
    let testing = 0;
    let risk = 0;
    let cadence = 0;
    for (const cohort of cohorts) {
      const amount = Math.min(remaining, cohort.quantity);
      selected += amount;
      standards += amount * cohort.codingStandardsPermille;
      review += amount * cohort.reviewStrengthPermille;
      testing += amount * cohort.testStrengthPermille;
      risk += amount * cohort.riskTolerancePermille;
      cadence += amount * cohort.releaseCadencePermille;
      remaining -= amount;
      if (remaining === 0) {
        break;
      }
    }
    if (selected === 0) {
      throw new Error("Cannot build source without provenance cohorts");
    }
    return {
      codingStandardsPermille: Math.floor(standards / selected),
      reviewStrengthPermille: Math.floor(review / selected),
      testStrengthPermille: Math.floor(testing / selected),
      riskTolerancePermille: Math.floor(risk / selected),
      releaseCadencePermille: Math.floor(cadence / selected),
    };
  }

  private stochasticRate(
    context: SystemContext,
    key: string,
    units: number,
    ratePermille: number,
  ): number {
    const scaled = units * ratePermille;
    return (
      Math.floor(scaled / 1_000) +
      (context.random.chance(key, scaled % 1_000) ? 1 : 0)
    );
  }

  private orderStages(
    stages: readonly BuildStageDefinition[],
  ): readonly BuildStageDefinition[] {
    return topologicalOrder(
      stages.map((stage) => ({
        ...stage,
        dependencies: stage.dependsOn,
      })),
      "Build stage graph",
    );
  }
}

function createHardwareHandler(): CommandHandler<SelectHardwarePayload> {
  return {
    id: HARDWARE_SYSTEM_ID,
    type: "build.select-hardware",
    reads: [],
    writes: [],
    stateReads: [],
    eventReads: [],
    emits: ["build.hardware-selected"],
    handle: (command, view) => {
      const state = view.getSystemState<HardwareState>(HARDWARE_SYSTEM_ID);
      if (
        !state.profiles.some(
          (profile) => profile.id === command.payload.profileId,
        )
      ) {
        throw new Error(`Unknown hardware profile: ${command.payload.profileId}`);
      }
      return {
        state: { ...state, activeProfileId: command.payload.profileId },
        events: [
          {
            type: "build.hardware-selected",
            payload: { profileId: command.payload.profileId },
          },
        ],
      };
    },
  };
}

export function createBuildCompilationLayer(
  options: BuildLayerOptions,
): SimulationLayer {
  return {
    id: BUILD_LAYER_ID,
    name: "Build & Compilation",
    pipeline: {
      id: BUILD_LAYER_ID,
      displayName: "Build & Compilation",
      dependsOn: [ORGANIZATION_LAYER_ID, SOURCE_LAYER_ID],
      inputs: [
        Resources.Source,
        Resources.Compute,
        Resources.TechnicalDebt,
        Resources.PolicyStrength,
        Resources.CodingStandards,
        Resources.RiskTolerance,
        Resources.Knowledge,
      ],
      outputs: [
        Resources.Binaries,
        Resources.Bugs,
        Resources.Insight,
        Resources.TechnicalDebt,
      ],
    },
    systems: [
      new HardwareSystem(
        options.hardwareProfiles,
        options.initialHardwareProfileId,
      ),
      new BuildSystem(options),
    ],
    commandHandlers: [createHardwareHandler()],
    eventHandlers: [],
    feedbackLoops: [
      "Successful builds warm the cache and reduce later compute cost; debt invalidates those gains and increases failures.",
    ],
    performanceNotes: [
      "The build DAG is topologically compiled once, then processed as aggregate artifact batches.",
    ],
  };
}
