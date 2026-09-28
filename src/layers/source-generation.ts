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
  ORGANIZATION_LAYER_ID,
  ORGANIZATION_SYSTEM_ID,
  SOURCE_GENERATION_SYSTEM_ID,
  SOURCE_LAYER_ID,
} from "./ids.js";
import {
  parseSourceWorkAllocations,
  payloadField,
  type SourceWorkAllocation,
} from "./cohorts.js";
import type { SimulationLayer } from "./layer.js";

export { SOURCE_GENERATION_SYSTEM_ID, SOURCE_LAYER_ID } from "./ids.js";

export interface SourceGenerationState extends JsonObject {
  readonly generated: number;
  readonly humanAuthored: number;
  readonly aiAuthored: number;
}

export interface SourceGenerationOptions {
  readonly humanProductivity: number;
  readonly agentProductivity: number;
  readonly computePerSource: number;
  readonly sourceBufferCapacity: number;
  readonly baseDebtRatePermille: number;
}

class SourceGenerationSystem
  implements SimulationSystem<SourceGenerationState>
{
  public readonly id = SOURCE_GENERATION_SYSTEM_ID;
  public readonly pipeline = SOURCE_LAYER_ID;
  public readonly phase = SimulationPhase.Source;
  public readonly dependsOn = [ORGANIZATION_SYSTEM_ID];
  public readonly reads = [
    Resources.HumanCapacity,
    Resources.AgentCapacity,
    Resources.Compute,
    Resources.Source,
    Resources.Knowledge,
    Resources.PolicyStrength,
    Resources.CodingStandards,
    Resources.RiskTolerance,
    Resources.ReleaseCadence,
  ];
  public readonly writes = [
    Resources.HumanCapacity,
    Resources.AgentCapacity,
    Resources.Compute,
    Resources.Source,
    Resources.TechnicalDebt,
    Resources.Insight,
  ];
  public readonly stateReads = [];
  public readonly eventReads = [
    "organization.policy-updated",
    "organization.capacity-allocated",
  ];
  public readonly emits = ["source.batch-generated"];

  public constructor(private readonly options: SourceGenerationOptions) {}

  public initialState(): SourceGenerationState {
    return { generated: 0, humanAuthored: 0, aiAuthored: 0 };
  }

  public run(
    view: SimulationView,
    context: SystemContext,
  ): SystemUpdate<SourceGenerationState> | undefined {
    const humanCapacity = view.resources.get(Resources.HumanCapacity);
    const agentCapacity = view.resources.get(Resources.AgentCapacity);
    const humanPotential = humanCapacity * this.options.humanProductivity;
    const agentPotential = agentCapacity * this.options.agentProductivity;
    const computeLimit = Math.floor(
      view.resources.get(Resources.Compute) / this.options.computePerSource,
    );
    const bufferLimit =
      this.options.sourceBufferCapacity -
      view.resources.get(Resources.Source);
    const generated = Math.max(
      0,
      Math.min(humanPotential + agentPotential, computeLimit, bufferLimit),
    );
    if (generated === 0) {
      return {
        telemetry: {
          status: "blocked",
          throughput: 0,
          bottleneck:
            bufferLimit <= 0
              ? "source-buffer-full"
              : computeLimit <= 0
                ? "compute"
                : "authoring-capacity",
        },
      };
    }

    const humanAuthored = Math.min(generated, humanPotential);
    const aiAuthored = generated - humanAuthored;
    const humansUsed = Math.ceil(
      humanAuthored / this.options.humanProductivity,
    );
    const agentsUsed = Math.ceil(
      aiAuthored / this.options.agentProductivity,
    );
    const policyStrength = view.resources.get(Resources.PolicyStrength);
    const standards = view.resources.get(Resources.CodingStandards);
    const risk = view.resources.get(Resources.RiskTolerance);
    const knowledge = view.resources.get(Resources.Knowledge);
    const debtRate = Math.max(
      0,
      this.options.baseDebtRatePermille +
        Math.floor((aiAuthored * 300) / generated) -
        Math.floor(policyStrength / 3) -
        Math.floor(standards / 4) +
        Math.floor(risk / 5) -
        Math.min(250, knowledge),
    );
    const scaledDebt = generated * debtRate;
    const wholeDebt = Math.floor(scaledDebt / 1_000);
    const debt =
      wholeDebt +
      (context.random.chance("source-debt", scaledDebt % 1_000) ? 1 : 0);
    const insight = Math.floor(humanAuthored / 8);
    const state = view.getSystemState<SourceGenerationState>(this.id);
    const allocations = parseSourceWorkAllocations(
      payloadField(
        view.events.find(
          (event) => event.type === "organization.capacity-allocated",
        )?.payload,
        "teamAllocations",
      ),
    );
    const artifacts = this.createArtifacts(
      allocations,
      humanAuthored,
      aiAuthored,
      debtRate,
      standards,
      policyStrength,
      policyStrength,
      risk,
      view.resources.get(Resources.ReleaseCadence),
      context.tick,
    );

    return {
      resources: [
        {
          resource: Resources.HumanCapacity,
          amount: -humansUsed,
          reason: "Human source authoring",
        },
        {
          resource: Resources.AgentCapacity,
          amount: -agentsUsed,
          reason: "AI source authoring",
        },
        {
          resource: Resources.Compute,
          amount: -(generated * this.options.computePerSource),
          reason: "Source tooling",
        },
        {
          resource: Resources.Source,
          amount: generated,
          reason: "Generated source batch",
        },
        {
          resource: Resources.TechnicalDebt,
          amount: debt,
          reason: "Source complexity and rushed generation",
        },
        {
          resource: Resources.Insight,
          amount: insight,
          reason: "Human engineering discoveries",
        },
      ],
      statePatch: {
        generated: state.generated + generated,
        humanAuthored: state.humanAuthored + humanAuthored,
        aiAuthored: state.aiAuthored + aiAuthored,
      },
      events: [
        {
          type: "source.batch-generated",
          payload: {
            generated,
            humanAuthored,
            aiAuthored,
            debt,
            debtCategoryId: "source-complexity",
            artifacts,
          },
        },
      ],
      telemetry: { status: "active", throughput: generated },
    };
  }

  private createArtifacts(
    allocations: readonly SourceWorkAllocation[],
    humanAuthored: number,
    aiAuthored: number,
    debtRiskPermille: number,
    standards: number,
    reviewStrength: number,
    testStrength: number,
    risk: number,
    cadence: number,
    tick: number,
  ): readonly JsonObject[] {
    const artifacts: JsonObject[] = [];
    const availableHuman = allocations.reduce(
      (total, allocation) => total + allocation.capacity,
      0,
    );
    let remainingHuman = humanAuthored;
    for (const [index, allocation] of allocations.entries()) {
      if (remainingHuman === 0 || allocation.capacity === 0) {
        continue;
      }
      const quantity =
        index === allocations.length - 1 || availableHuman === 0
          ? remainingHuman
          : Math.min(
              remainingHuman,
              Math.floor(
                (humanAuthored * allocation.capacity) / availableHuman,
              ),
            );
      if (quantity === 0) {
        continue;
      }
      remainingHuman -= quantity;
      artifacts.push({
        id: `source:${tick}:${allocation.teamId}`,
        quantity,
        humanPermille: 1_000,
        debtRiskPermille,
        codingStandardsPermille:
          allocation.policy.codingStandardsPermille,
        reviewStrengthPermille:
          allocation.policy.reviewStrengthPermille,
        testStrengthPermille:
          allocation.policy.testStrengthPermille,
        riskTolerancePermille: allocation.policy.riskTolerancePermille,
        releaseCadencePermille:
          allocation.policy.releaseCadencePermille,
        teamId: allocation.teamId,
        createdTick: tick,
      });
    }
    if (remainingHuman > 0) {
      artifacts.push({
        id: `source:${tick}:human-overflow`,
        quantity: remainingHuman,
        humanPermille: 1_000,
        debtRiskPermille,
        codingStandardsPermille: standards,
        reviewStrengthPermille: reviewStrength,
        testStrengthPermille: testStrength,
        riskTolerancePermille: risk,
        releaseCadencePermille: cadence,
        teamId: "organization",
        createdTick: tick,
      });
    }
    if (aiAuthored > 0) {
      artifacts.push({
        id: `source:${tick}:agents`,
        quantity: aiAuthored,
        humanPermille: 0,
        debtRiskPermille,
        codingStandardsPermille: standards,
        reviewStrengthPermille: reviewStrength,
        testStrengthPermille: testStrength,
        riskTolerancePermille: risk,
        releaseCadencePermille: cadence,
        teamId: "agent-swarms",
        createdTick: tick,
      });
    }
    return artifacts;
  }
}

export function createSourceGenerationLayer(
  options: SourceGenerationOptions,
): SimulationLayer {
  return {
    id: SOURCE_LAYER_ID,
    name: "Source Generation",
    pipeline: {
      id: SOURCE_LAYER_ID,
      displayName: "Source Generation",
      dependsOn: [ORGANIZATION_LAYER_ID],
      inputs: [
        Resources.HumanCapacity,
        Resources.AgentCapacity,
        Resources.Compute,
        Resources.Knowledge,
        Resources.PolicyStrength,
        Resources.CodingStandards,
        Resources.RiskTolerance,
      ],
      outputs: [
        Resources.Source,
        Resources.TechnicalDebt,
        Resources.Insight,
      ],
    },
    systems: [new SourceGenerationSystem(options)],
    commandHandlers: [],
    eventHandlers: [],
    feedbackLoops: [
      "AI raises source throughput but creates more debt unless policy and accumulated knowledge compensate.",
    ],
    performanceNotes: [
      "Human and AI workers are processed as aggregate capacities; no per-agent tick work is required.",
    ],
  };
}
