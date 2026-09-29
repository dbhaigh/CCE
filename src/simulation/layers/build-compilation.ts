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
  RESEARCH_SYSTEM_ID,
} from "./ids.js";
import type { ResearchState } from "./knowledge-research.js";
import type { OrganizationState } from "./organization.js";

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
  readonly jobs?: readonly BuildJob[];
  readonly nextJobId?: number;
  readonly lastRun?: BuildRun;
}

export interface BuildJob extends JsonObject {
  readonly id: string;
  readonly requested: number;
  readonly remaining: number;
  readonly createdTick: number;
  readonly sourceTeamId: string | null;
  readonly succeededUnits?: number;
  readonly failedUnits?: number;
}

export interface BuildRun extends JsonObject {
  readonly tick: number;
  readonly manualSource: number;
  readonly automaticSource: number;
  readonly computePerSource: number;
  readonly failed: boolean;
}

export const MAX_BUILD_JOBS = 16;
export const MAX_BUILD_UNITS_PER_JOB = 256;
export const MAX_QUEUED_BUILD_UNITS = 1_000;

export interface StartBuildJobPayload extends JsonObject {
  readonly quantity: number;
  readonly sourceTeamId?: string | null;
}

export interface BuildJobIdPayload extends JsonObject {
  readonly jobId: string;
}

export interface ReorderBuildJobPayload extends BuildJobIdPayload {
  readonly direction: number;
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
  public readonly stateReads = [RESEARCH_SYSTEM_ID];
  public readonly eventReads = [
    "source.batch-generated",
    "automation.source-generated",
  ];
  public readonly emits = [
    "build.completed",
    "build.failed",
    "build.cache-updated",
    "build.job-completed",
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
      jobs: [],
      nextJobId: 1,
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
          1_000,
          (left, right) =>
            left.teamId === right.teamId &&
            left.humanPermille === right.humanPermille &&
            left.debtRiskPermille === right.debtRiskPermille &&
            left.codingStandardsPermille === right.codingStandardsPermille &&
            left.reviewStrengthPermille === right.reviewStrengthPermille &&
            left.testStrengthPermille === right.testStrengthPermille &&
            left.riskTolerancePermille === right.riskTolerancePermille &&
            left.releaseCadencePermille === right.releaseCadencePermille,
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
    const cacheUpgrade = view.getSystemState<ResearchState>(RESEARCH_SYSTEM_ID)
      .purchasedUpgrades.includes("incremental-build-cache") ? 1 : 0;
    const computePerSource = Math.max(1, rawComputePerSource - cacheSavings - cacheUpgrade);
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
    const remainingByCohort = sourceCohorts.map((cohort) => cohort.quantity);
    const selectedSource: SourceArtifactCohort[] = [];
    const allocations: number[] = [];
    let availableCapacity = consumed;
    const select = (limit: number, teamId: string | null): number => {
      let selected = 0;
      for (let index = 0; index < sourceCohorts.length && selected < limit; index += 1) {
        const cohort = sourceCohorts[index];
        const available = remainingByCohort[index] ?? 0;
        if (!cohort || available === 0 || (teamId !== null && cohort.teamId !== teamId)) continue;
        const quantity = Math.min(limit - selected, available);
        remainingByCohort[index] = available - quantity;
        selectedSource.push({ ...cohort, quantity });
        selected += quantity;
      }
      return selected;
    };
    for (const job of state.jobs ?? []) {
      const allocated = select(Math.min(availableCapacity, job.remaining), job.sourceTeamId ?? null);
      allocations.push(allocated);
      availableCapacity -= allocated;
    }
    const automaticSource = select(availableCapacity, null);
    const manualSource = consumed - automaticSource;
    if (manualSource + automaticSource !== consumed) {
      throw new Error("Build selection did not conserve available Source");
    }
    const remainingSourceCohorts = sourceCohorts.flatMap((cohort, index) => {
      const quantity = remainingByCohort[index] ?? 0;
      return quantity === 0 ? [] : [{ ...cohort, quantity }];
    });
    const sourcePolicy = this.averageSourcePolicy(selectedSource, consumed);
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
    const jobs: BuildJob[] = [];
    const completedJobs: BuildJob[] = [];
    for (const [index, job] of (state.jobs ?? []).entries()) {
      const allocated = allocations[index] ?? 0;
      const updated = allocated === 0 ? job : {
        ...job,
        remaining: job.remaining - allocated,
        succeededUnits: (job.succeededUnits ?? 0) + (failed ? 0 : allocated),
        failedUnits: (job.failedUnits ?? 0) + (failed ? allocated : 0),
      };
      if (updated.remaining === 0) completedJobs.push(updated);
      else jobs.push(updated);
    }
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
        jobs,
        lastRun: {
          tick: context.tick, manualSource, automaticSource, computePerSource, failed,
        },
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
        ...completedJobs.map((job) => ({
          type: "build.job-completed",
          payload: {
            jobId: job.id, requested: job.requested,
            succeededUnits: job.succeededUnits ?? 0, failedUnits: job.failedUnits ?? 0,
          },
        })),
      ],
      telemetry: { status: "active", throughput: binaries },
    };
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

function buildJobHandler<P extends JsonObject>(
  type: string,
  emits: string,
  update: (payload: P, state: BuildState, tick: number, view: SimulationView) => {
    readonly jobs: readonly BuildJob[];
    readonly nextJobId?: number;
    readonly details: JsonObject;
  },
): CommandHandler<P> {
  return {
    id: COMPILATION_SYSTEM_ID, type, reads: [], writes: [], stateReads: [ORGANIZATION_SYSTEM_ID],
    eventReads: [], emits: [emits],
    handle: (command, view) => {
      const state = view.getSystemState<BuildState>(COMPILATION_SYSTEM_ID);
      const result = update(command.payload, state, view.tick, view);
      return {
        statePatch: {
          jobs: result.jobs,
          ...(result.nextJobId === undefined ? {} : { nextJobId: result.nextJobId }),
        },
        events: [{ type: emits, payload: result.details }],
      };
    },
  };
}

const startJob = buildJobHandler<StartBuildJobPayload>(
  "build.start-job", "build.job-queued", (payload, state, tick, view) => {
    const quantity = payload.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_BUILD_UNITS_PER_JOB) {
      throw new Error(`Build job quantity must be between 1 and ${MAX_BUILD_UNITS_PER_JOB}`);
    }
    const jobs = state.jobs ?? [];
    if (jobs.length >= MAX_BUILD_JOBS ||
      jobs.reduce((sum, job) => sum + job.remaining, 0) + quantity > MAX_QUEUED_BUILD_UNITS) {
      throw new Error(`Build queue is full (max ${MAX_BUILD_JOBS} jobs, ${MAX_QUEUED_BUILD_UNITS} source units)`);
    }
    const sourceTeamId = payload.sourceTeamId ?? null;
    if (sourceTeamId !== null &&
      !view.getSystemState<OrganizationState>(ORGANIZATION_SYSTEM_ID)
        .teams.some((team) => team.id === sourceTeamId)) {
      throw new Error(`Unknown source-producing team: ${sourceTeamId}`);
    }
    const nextJobId = state.nextJobId ?? 1;
    if (!Number.isSafeInteger(nextJobId) || nextJobId < 1) throw new Error("Invalid build job sequence");
    const job = { id: `job:${nextJobId}`, requested: quantity, remaining: quantity, createdTick: tick, sourceTeamId };
    return { jobs: [...jobs, job], nextJobId: nextJobId + 1,
      details: { jobId: job.id, quantity, sourceTeamId } };
  },
);

const cancelJob = buildJobHandler<BuildJobIdPayload>(
  "build.cancel-job", "build.job-cancelled", (payload, state) => {
    const jobs = state.jobs ?? [];
    const job = jobs.find((entry) => entry.id === payload.jobId);
    if (!job) throw new Error(`Unknown queued build job: ${payload.jobId}`);
    return { jobs: jobs.filter((entry) => entry.id !== job.id),
      details: { jobId: job.id, unbuilt: job.remaining } };
  },
);

function moveJob(payload: BuildJobIdPayload, state: BuildState, direction?: number) {
  const jobs = [...(state.jobs ?? [])];
  const index = jobs.findIndex((job) => job.id === payload.jobId);
  if (index < 0) throw new Error(`Unknown queued build job: ${payload.jobId}`);
  const destination = direction === undefined ? 0 : index + direction;
  if (destination < 0 || destination >= jobs.length) throw new Error("Build job cannot move beyond queue bounds");
  const [job] = jobs.splice(index, 1);
  if (!job) throw new Error("Build job disappeared during reorder");
  jobs.splice(destination, 0, job);
  return { jobs, details: { jobId: job.id, position: destination + 1 } };
}

const reorderJob = buildJobHandler<ReorderBuildJobPayload>(
  "build.reorder-job", "build.job-reordered", (payload, state) => {
    if (payload.direction !== -1 && payload.direction !== 1) {
      throw new Error("Build reorder direction must be -1 or 1");
    }
    return moveJob(payload, state, payload.direction);
  },
);
const prioritizeJob = buildJobHandler<BuildJobIdPayload>(
  "build.prioritize-job", "build.job-reordered", (payload, state) => moveJob(payload, state),
);

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
    commandHandlers: [createHardwareHandler(), startJob, cancelJob, reorderJob, prioritizeJob],
    eventHandlers: [],
    feedbackLoops: [
      "Successful builds warm the cache and reduce later compute cost; debt invalidates those gains and increases failures.",
    ],
    performanceNotes: [
      "The build DAG is topologically compiled once, then processed as aggregate artifact batches.",
    ],
  };
}
