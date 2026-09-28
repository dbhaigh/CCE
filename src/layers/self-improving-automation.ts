import {
  SimulationPhase,
  type EventDraft,
  type SimulationSystem,
  type SimulationView,
  type SystemUpdate,
} from "../contracts.js";
import {
  MAX_HOT_DEPLOY_REQUESTS,
  Resources,
} from "../resources.js";
import type { JsonObject } from "../types.js";
import {
  AUTOMATION_LAYER_ID,
  AUTOMATION_SYSTEM_ID,
  KNOWLEDGE_LAYER_ID,
  RESEARCH_SYSTEM_ID,
  RUNTIME_LAYER_ID,
} from "./ids.js";
import type { SimulationLayer } from "./layer.js";

export {
  AUTOMATION_LAYER_ID,
  AUTOMATION_SYSTEM_ID,
} from "./ids.js";

export interface AutomationState extends JsonObject {
  readonly generations: number;
  readonly sourceGenerated: number;
  readonly hotDeploysRequested: number;
  readonly peakPower: number;
}

export interface AutomationLayerOptions {
  readonly initialPower: number;
  readonly sourceBufferCapacity: number;
  readonly maximumPower: number;
}

class AutomationSystem implements SimulationSystem<AutomationState> {
  public readonly id = AUTOMATION_SYSTEM_ID;
  public readonly pipeline = AUTOMATION_LAYER_ID;
  public readonly phase = SimulationPhase.Automation;
  public readonly dependsOn = [RESEARCH_SYSTEM_ID];
  public readonly reads = [
    Resources.AutomationPower,
    Resources.Knowledge,
    Resources.RiskTolerance,
    Resources.CodingStandards,
    Resources.PolicyStrength,
    Resources.ReleaseCadence,
    Resources.AgentAutonomy,
    Resources.Morale,
    Resources.Source,
    Resources.AgentInstability,
  ];
  public readonly writes = [
    Resources.AutomationPower,
    Resources.Source,
    Resources.TechnicalDebt,
    Resources.HotDeployRequests,
    Resources.AgentInstability,
    Resources.Insight,
  ];
  public readonly stateReads = [];
  public readonly eventReads = [
    "runtime.deployed",
    "runtime.incident",
    "research.completed",
  ];
  public readonly emits = [
    "automation.source-generated",
    "automation.self-improved",
    "automation.instability-increased",
  ];

  public constructor(private readonly options: AutomationLayerOptions) {}

  public initialState(): AutomationState {
    return {
      generations: 0,
      sourceGenerated: 0,
      hotDeploysRequested: 0,
      peakPower: this.options.initialPower,
    };
  }

  public run(view: SimulationView): SystemUpdate<AutomationState> | undefined {
    const state = view.getSystemState<AutomationState>(this.id);
    const currentPower =
      view.resources.get(Resources.AutomationPower) === 0 &&
      state.generations === 0
        ? this.options.initialPower
        : view.resources.get(Resources.AutomationPower);
    const knowledge = view.resources.get(Resources.Knowledge);
    const risk = view.resources.get(Resources.RiskTolerance);
    const standards = view.resources.get(Resources.CodingStandards);
    const policyStrength = view.resources.get(Resources.PolicyStrength);
    const cadence = view.resources.get(Resources.ReleaseCadence);
    const autonomy = view.resources.get(Resources.AgentAutonomy);
    const morale = view.resources.get(Resources.Morale);
    const successfulDeployments = view.events.filter(
      (event) => event.type === "runtime.deployed",
    ).length;
    const incidents = view.events.filter(
      (event) => event.type === "runtime.incident",
    ).length;

    const recursivePressure = Math.max(
      0,
      risk + autonomy - standards - 500,
    );
    const recursiveGain = Math.floor(
      (currentPower * recursivePressure) / 10_000,
    );
    const evidenceGain =
      successfulDeployments + Math.floor(knowledge / 100);
    const desiredGain = recursiveGain + evidenceGain;
    const powerGain = Math.min(
      desiredGain,
      this.options.maximumPower - currentPower,
    );
    const effectivePower = currentPower + powerGain;
    const sourceCapacity =
      this.options.sourceBufferCapacity -
      view.resources.get(Resources.Source);
    const generated = Math.max(
      0,
      Math.min(
        sourceCapacity,
        Math.floor(
          (effectivePower * (500 + risk + autonomy)) / 20_000,
        ),
      ),
    );
    const unsafePressure = Math.max(
      0,
      risk + autonomy - standards - morale,
    );
    const desiredHotDeploys = Math.floor((generated * cadence) / 1_000);
    const hotDeploys = Math.min(
      desiredHotDeploys,
      MAX_HOT_DEPLOY_REQUESTS -
        view.resources.get(Resources.HotDeployRequests),
    );
    const droppedHotDeploys = desiredHotDeploys - hotDeploys;
    const debt =
      Math.floor((generated * unsafePressure) / 1_000) +
      droppedHotDeploys;
    const instability =
      Math.floor(unsafePressure / 25) +
      Math.floor(effectivePower / 5_000) +
      incidents * 5;
    const instabilityGain = Math.min(
      instability,
      1_000_000_000 -
        view.resources.get(Resources.AgentInstability),
    );
    if (
      powerGain === 0 &&
      generated === 0 &&
      debt === 0 &&
      instabilityGain === 0
    ) {
      return undefined;
    }

    const events: EventDraft[] = [
      {
        type: "automation.self-improved",
        payload: { powerGain, effectivePower, recursivePressure },
      },
    ];
    if (generated > 0) {
      events.push({
        type: "automation.source-generated",
        delivery: "nextTick",
        payload: {
          generated,
          debt,
          hotDeploys,
          droppedHotDeploys,
          debtCategoryId: "source-complexity",
          artifact: {
            id: `automation-source:${view.tick}`,
            quantity: generated,
            humanPermille: 0,
            debtRiskPermille: Math.min(1_000, unsafePressure),
            codingStandardsPermille: standards,
            reviewStrengthPermille: policyStrength,
            testStrengthPermille: policyStrength,
            riskTolerancePermille: risk,
            releaseCadencePermille: cadence,
            teamId: "automation",
            createdTick: view.tick,
          },
        },
      });
    }
    if (instabilityGain > 0) {
      events.push({
        type: "automation.instability-increased",
        payload: { instability: instabilityGain, unsafePressure },
      });
    }

    return {
      resources: [
        {
          resource: Resources.AutomationPower,
          amount:
            state.generations === 0 &&
            view.resources.get(Resources.AutomationPower) === 0
              ? effectivePower
              : powerGain,
          reason: "Recursive automation improvement",
        },
        {
          resource: Resources.Source,
          amount: generated,
          reason: "Runtime-generated source",
        },
        {
          resource: Resources.TechnicalDebt,
          amount: debt,
          reason: "Unreviewed recursive generation",
        },
        {
          resource: Resources.HotDeployRequests,
          amount: hotDeploys,
          reason: "Automated hot-deploy queue",
        },
        {
          resource: Resources.AgentInstability,
          amount: instabilityGain,
          reason: "Autonomous swarm instability",
        },
        {
          resource: Resources.Insight,
          amount: successfulDeployments + incidents,
          reason: "Closed-loop runtime evidence",
        },
      ],
      statePatch: {
        generations: state.generations + 1,
        sourceGenerated: state.sourceGenerated + generated,
        hotDeploysRequested:
          state.hotDeploysRequested + hotDeploys,
        peakPower: Math.max(state.peakPower, effectivePower),
      },
      events,
    };
  }
}

export function createSelfImprovingAutomationLayer(
  options: AutomationLayerOptions,
): SimulationLayer {
  return {
    id: AUTOMATION_LAYER_ID,
    name: "Self-Improving Automation",
    pipeline: {
      id: AUTOMATION_LAYER_ID,
      displayName: "Self-Improving Automation",
      dependsOn: [RUNTIME_LAYER_ID, KNOWLEDGE_LAYER_ID],
      inputs: [
        Resources.Knowledge,
        Resources.RiskTolerance,
        Resources.CodingStandards,
        Resources.ReleaseCadence,
        Resources.AgentAutonomy,
        Resources.Morale,
      ],
      outputs: [
        Resources.AutomationPower,
        Resources.Source,
        Resources.TechnicalDebt,
        Resources.HotDeployRequests,
        Resources.AgentInstability,
      ],
    },
    systems: [new AutomationSystem(options)],
    commandHandlers: [],
    eventHandlers: [],
    feedbackLoops: [
      "Deployments improve automation, automation generates source, and that source re-enters build, verification, and deployment.",
      "High autonomy and risk recursively compound power, debt, hot deploys, and instability.",
    ],
    performanceNotes: [
      "The entire swarm is modeled as aggregate power and bounded artifact cohorts.",
    ],
  };
}
