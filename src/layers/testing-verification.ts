import {
  SimulationPhase,
  type SimulationSystem,
  type SimulationView,
  type SystemContext,
  type SystemUpdate,
} from "../contracts.js";
import { Resources } from "../resources.js";
import { type JsonObject } from "../types.js";
import {
  appendBoundedCohort,
  assertCohortConservation,
  parseBinaryArtifact,
  payloadField,
  type BinaryArtifactCohort,
  type ReleaseArtifactCohort,
  weightedPermille,
} from "./cohorts.js";
import {
  BUILD_LAYER_ID,
  COMPILATION_SYSTEM_ID,
  TESTING_LAYER_ID,
  TESTING_SYSTEM_ID,
} from "./ids.js";
import type { SimulationLayer } from "./layer.js";

export { TESTING_LAYER_ID, TESTING_SYSTEM_ID } from "./ids.js";

export interface TestSuiteCohort extends JsonObject {
  readonly id: string;
  readonly testCount: number;
  readonly computePerBinary: number;
  readonly detectionPermille: number;
  readonly flakinessPermille: number;
}

export interface TestingState extends JsonObject {
  readonly suites: readonly TestSuiteCohort[];
  readonly verified: number;
  readonly rejected: number;
  readonly detectedBugs: number;
  readonly coveragePermille: number;
  readonly binaryCohorts: readonly BinaryArtifactCohort[];
  readonly releaseCohortsCreated: number;
}

export interface TestingLayerOptions {
  readonly suites: readonly TestSuiteCohort[];
  readonly binariesPerTick: number;
  readonly releaseBufferCapacity: number;
}

class TestingSystem implements SimulationSystem<TestingState> {
  public readonly id = TESTING_SYSTEM_ID;
  public readonly pipeline = TESTING_LAYER_ID;
  public readonly phase = SimulationPhase.Quality;
  public readonly dependsOn = [COMPILATION_SYSTEM_ID];
  public readonly reads = [
    Resources.Binaries,
    Resources.Bugs,
    Resources.Compute,
    Resources.Releases,
    Resources.PolicyStrength,
    Resources.VerificationSkill,
  ];
  public readonly writes = [
    Resources.Binaries,
    Resources.Bugs,
    Resources.Compute,
    Resources.Releases,
    Resources.Insight,
    Resources.TestConfidence,
  ];
  public readonly stateReads = [];
  public readonly eventReads = ["build.completed", "build.failed"];
  public readonly emits = ["testing.verified", "testing.rejected"];

  public constructor(private readonly options: TestingLayerOptions) {}

  public initialState(): TestingState {
    return {
      suites: this.options.suites,
      verified: 0,
      rejected: 0,
      detectedBugs: 0,
      coveragePermille: 100,
      binaryCohorts: [],
      releaseCohortsCreated: 0,
    };
  }

  public run(
    view: SimulationView,
    context: SystemContext,
  ): SystemUpdate<TestingState> | undefined {
    const state = view.getSystemState<TestingState>(this.id);
    let binaryCohorts = state.binaryCohorts;
    for (const event of view.events) {
      const artifact = parseBinaryArtifact(
        payloadField(event.payload, "artifact"),
      );
      if (artifact !== undefined) {
        binaryCohorts = appendBoundedCohort(
          binaryCohorts,
          artifact,
          256,
          (left, right) =>
            left.buildConfidencePermille === right.buildConfidencePermille,
          (left, right) => ({
            ...left,
            quantity: left.quantity + right.quantity,
            latentDefects: left.latentDefects + right.latentDefects,
          }),
          (left, right) => ({
            ...left,
            id: `compacted:${left.id}:${right.id}`,
            quantity: left.quantity + right.quantity,
            latentDefects: left.latentDefects + right.latentDefects,
            buildConfidencePermille: weightedPermille(
            left.buildConfidencePermille,
            left.quantity,
            right.buildConfidencePermille,
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
            createdTick: Math.min(left.createdTick, right.createdTick),
          }),
        );
      }
    }
    assertCohortConservation(
      "Binaries",
      view.resources.get(Resources.Binaries),
      binaryCohorts,
    );
    const policy =
      binaryCohorts[0]?.testStrengthPermille ??
      view.resources.get(Resources.PolicyStrength);
    const activeSuiteCount = Math.max(
      1,
      Math.ceil((state.suites.length * Math.max(100, policy)) / 1_000),
    );
    const activeSuites = state.suites.slice(0, activeSuiteCount);
    const computePerBinary = Math.max(
      1,
      activeSuites.reduce(
        (total, suite) => total + suite.computePerBinary,
        0,
      ),
    );
    const releaseCapacity =
      this.options.releaseBufferCapacity -
      view.resources.get(Resources.Releases);
    const processed = Math.max(
      0,
      Math.min(
        this.options.binariesPerTick,
        view.resources.get(Resources.Binaries),
        Math.floor(view.resources.get(Resources.Compute) / computePerBinary),
        releaseCapacity,
      ),
    );
    if (processed === 0) {
      return {
        ...(binaryCohorts === state.binaryCohorts
          ? {}
          : { statePatch: { binaryCohorts } }),
        telemetry: {
          status: "blocked",
          throughput: 0,
          bottleneck:
            view.resources.get(Resources.Binaries) === 0
              ? "binaries"
              : releaseCapacity <= 0
                ? "release-buffer-full"
                : "compute",
        },
      };
    }

    const detectionPermille = Math.min(
      950,
      Math.floor(
        activeSuites.reduce(
          (total, suite) => total + suite.detectionPermille,
          0,
        ) / activeSuites.length,
      ) +
        Math.floor(state.coveragePermille / 5) +
        Math.floor(policy / 5) +
        Math.floor(
          view.resources.get(Resources.VerificationSkill) / 5,
        ),
    );
    const cohortDefects = this.defectsInPrefix(binaryCohorts, processed);
    const detectableBugs = Math.min(
      view.resources.get(Resources.Bugs),
      processed,
      cohortDefects,
    );
    const detectedBugs = this.stochasticRate(
      context,
      "detected-bugs",
      detectableBugs,
      detectionPermille,
    );
    const flaky = activeSuites.some((suite, index) =>
      context.random.chance(
        `suite-flake:${suite.id}`,
        suite.flakinessPermille,
        index,
      ),
    );
    const rejected = Math.min(processed, detectedBugs + (flaky ? 1 : 0));
    const released = processed - rejected;
    const coverageGain = Math.max(
      1,
      Math.floor(
        activeSuites.reduce((total, suite) => total + suite.testCount, 0) /
          100,
      ),
    );
    const coveragePermille = Math.min(
      1_000,
      state.coveragePermille + coverageGain,
    );
    const remainingBinaryCohorts = this.consumeBinaryCohorts(
      binaryCohorts,
      processed,
      detectedBugs,
    );
    const averageBuildConfidence = this.averageBuildConfidence(
      binaryCohorts,
      processed,
    );
    const artifactPolicy = this.averageArtifactPolicy(
      binaryCohorts,
      processed,
    );
    const releaseArtifact: ReleaseArtifactCohort | undefined =
      released === 0
        ? undefined
        : {
            id: `release:${context.tick}`,
            quantity: released,
            residualDefects: Math.max(0, cohortDefects - detectedBugs),
            confidencePermille: Math.min(
              1_000,
              Math.floor(
                (averageBuildConfidence + detectionPermille) / 2,
              ),
            ),
            reviewStrengthPermille:
              artifactPolicy.reviewStrengthPermille,
            testStrengthPermille: artifactPolicy.testStrengthPermille,
            riskTolerancePermille: artifactPolicy.riskTolerancePermille,
            releaseCadencePermille: artifactPolicy.releaseCadencePermille,
            createdTick: context.tick,
          };

    return {
      resources: [
        {
          resource: Resources.Binaries,
          amount: -processed,
          reason: "Verification input",
        },
        {
          resource: Resources.Compute,
          amount: -(processed * computePerBinary),
          reason: "Test suite execution",
        },
        {
          resource: Resources.Bugs,
          amount: -detectedBugs,
          reason: "Defects caught before release",
        },
        {
          resource: Resources.Releases,
          amount: released,
          reason: "Verified release artifacts",
        },
        {
          resource: Resources.Insight,
          amount: detectedBugs + (flaky ? 1 : 0),
          reason: "Verification diagnostics",
        },
        {
          resource: Resources.TestConfidence,
          amount: released,
          reason: "Accumulated verification evidence",
        },
      ],
      statePatch: {
        verified: state.verified + released,
        rejected: state.rejected + rejected,
        detectedBugs: state.detectedBugs + detectedBugs,
        coveragePermille,
        binaryCohorts: remainingBinaryCohorts,
        releaseCohortsCreated:
          state.releaseCohortsCreated +
          (releaseArtifact === undefined ? 0 : 1),
      },
      events: [
        {
          type: rejected > 0 ? "testing.rejected" : "testing.verified",
          payload: {
            processed,
            released,
            rejected,
            detectedBugs,
            coveragePermille,
            artifact: releaseArtifact ?? null,
          },
        },
      ],
      telemetry: { status: "active", throughput: released },
    };
  }

  private defectsInPrefix(
    cohorts: readonly BinaryArtifactCohort[],
    quantity: number,
  ): number {
    let remaining = quantity;
    let defects = 0;
    for (const cohort of cohorts) {
      const selected = Math.min(remaining, cohort.quantity);
      defects += Math.ceil(
        (cohort.latentDefects * selected) / Math.max(1, cohort.quantity),
      );
      remaining -= selected;
      if (remaining === 0) {
        break;
      }
    }
    return defects;
  }

  private averageBuildConfidence(
    cohorts: readonly BinaryArtifactCohort[],
    quantity: number,
  ): number {
    let remaining = quantity;
    let weighted = 0;
    let selectedTotal = 0;
    for (const cohort of cohorts) {
      const selected = Math.min(remaining, cohort.quantity);
      weighted += selected * cohort.buildConfidencePermille;
      selectedTotal += selected;
      remaining -= selected;
      if (remaining === 0) {
        break;
      }
    }
    return selectedTotal === 0 ? 0 : Math.floor(weighted / selectedTotal);
  }

  private consumeBinaryCohorts(
    cohorts: readonly BinaryArtifactCohort[],
    quantity: number,
    detectedBugs: number,
  ): readonly BinaryArtifactCohort[] {
    let remaining = quantity;
    let remainingDetected = detectedBugs;
    const result: BinaryArtifactCohort[] = [];
    for (const cohort of cohorts) {
      const consumed = Math.min(remaining, cohort.quantity);
      remaining -= consumed;
      const defectsInConsumed = Math.ceil(
        (cohort.latentDefects * consumed) / Math.max(1, cohort.quantity),
      );
      const removedDefects = Math.min(remainingDetected, defectsInConsumed);
      remainingDetected -= removedDefects;
      if (cohort.quantity > consumed) {
        result.push({
          ...cohort,
          quantity: cohort.quantity - consumed,
          latentDefects: Math.max(
            0,
            cohort.latentDefects - defectsInConsumed,
          ),
        });
      }
    }
    return result;
  }

  private averageArtifactPolicy(
    cohorts: readonly BinaryArtifactCohort[],
    quantity: number,
  ): {
    readonly riskTolerancePermille: number;
    readonly releaseCadencePermille: number;
    readonly reviewStrengthPermille: number;
    readonly testStrengthPermille: number;
  } {
    let remaining = quantity;
    let selected = 0;
    let risk = 0;
    let cadence = 0;
    let review = 0;
    let testing = 0;
    for (const cohort of cohorts) {
      const amount = Math.min(remaining, cohort.quantity);
      selected += amount;
      risk += amount * cohort.riskTolerancePermille;
      cadence += amount * cohort.releaseCadencePermille;
      review += amount * cohort.reviewStrengthPermille;
      testing += amount * cohort.testStrengthPermille;
      remaining -= amount;
      if (remaining === 0) {
        break;
      }
    }
    if (selected === 0) {
      throw new Error("Cannot test binaries without provenance cohorts");
    }
    return {
      riskTolerancePermille: Math.floor(risk / selected),
      releaseCadencePermille: Math.floor(cadence / selected),
      reviewStrengthPermille: Math.floor(review / selected),
      testStrengthPermille: Math.floor(testing / selected),
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
}

export function createTestingVerificationLayer(
  options: TestingLayerOptions,
): SimulationLayer {
  return {
    id: TESTING_LAYER_ID,
    name: "Testing & Verification",
    pipeline: {
      id: TESTING_LAYER_ID,
      displayName: "Testing & Verification",
      dependsOn: [BUILD_LAYER_ID],
      inputs: [
        Resources.Binaries,
        Resources.Bugs,
        Resources.Compute,
        Resources.PolicyStrength,
        Resources.VerificationSkill,
      ],
      outputs: [
        Resources.Releases,
        Resources.Insight,
        Resources.TestConfidence,
      ],
    },
    systems: [new TestingSystem(options)],
    commandHandlers: [],
    eventHandlers: [],
    feedbackLoops: [
      "Stronger policy activates more suites, spending compute now to catch bugs and protect later runtime revenue.",
    ],
    performanceNotes: [
      "Tests are grouped into suite cohorts and resolved statistically per artifact batch.",
    ],
  };
}
