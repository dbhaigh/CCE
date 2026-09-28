import {
  SimulationPhase,
  type CommandHandler,
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
  parseReleaseArtifact,
  payloadField,
  type ReleaseArtifactCohort,
  weightedPermille,
} from "./cohorts.js";
import type { SimulationLayer } from "./layer.js";
import {
  INCIDENT_RESPONSE_SYSTEM_ID,
  RUNTIME_LAYER_ID,
  RUNTIME_SYSTEM_ID,
  TESTING_LAYER_ID,
  TESTING_SYSTEM_ID,
} from "./ids.js";

export {
  INCIDENT_RESPONSE_SYSTEM_ID,
  RUNTIME_LAYER_ID,
  RUNTIME_SYSTEM_ID,
} from "./ids.js";

export type DeploymentStrategy =
  | "all-at-once"
  | "rolling"
  | "canary"
  | "hot";

export interface ServiceCohort extends JsonObject {
  readonly id: string;
  readonly serviceCount: number;
  readonly revenuePerRelease: number;
  readonly baseIncidentChancePermille: number;
}

export interface RuntimeState extends JsonObject {
  readonly services: readonly ServiceCohort[];
  readonly strategy: DeploymentStrategy;
  readonly deployed: number;
  readonly revenue: number;
  readonly incidentsCreated: number;
  readonly releaseCohorts: readonly ReleaseArtifactCohort[];
}

export interface RuntimeLayerOptions {
  readonly services: readonly ServiceCohort[];
  readonly initialStrategy: DeploymentStrategy;
  readonly releasesPerTick: number;
}

export interface SetDeploymentStrategyPayload extends JsonObject {
  readonly strategy: DeploymentStrategy;
}

class RuntimeSystem implements SimulationSystem<RuntimeState> {
  public readonly id = RUNTIME_SYSTEM_ID;
  public readonly pipeline = RUNTIME_LAYER_ID;
  public readonly phase = SimulationPhase.Runtime;
  public readonly dependsOn = [TESTING_SYSTEM_ID];
  public readonly reads = [
    Resources.Releases,
    Resources.Bugs,
    Resources.TestConfidence,
    Resources.Reputation,
    Resources.HotDeployRequests,
    Resources.RiskTolerance,
    Resources.OperationsSkill,
  ];
  public readonly writes = [
    Resources.Releases,
    Resources.Bugs,
    Resources.Money,
    Resources.Incidents,
    Resources.Insight,
    Resources.Reputation,
    Resources.HotDeployRequests,
  ];
  public readonly stateReads = [];
  public readonly eventReads = ["testing.verified", "testing.rejected"];
  public readonly emits = ["runtime.deployed", "runtime.incident"];

  public constructor(private readonly options: RuntimeLayerOptions) {}

  public initialState(): RuntimeState {
    return {
      services: this.options.services,
      strategy: this.options.initialStrategy,
      deployed: 0,
      revenue: 0,
      incidentsCreated: 0,
      releaseCohorts: [],
    };
  }

  public run(
    view: SimulationView,
    context: SystemContext,
  ): SystemUpdate<RuntimeState> | undefined {
    const state = view.getSystemState<RuntimeState>(this.id);
    let releaseCohorts = state.releaseCohorts;
    for (const event of view.events) {
      const artifact = parseReleaseArtifact(
        payloadField(event.payload, "artifact"),
      );
      if (artifact !== undefined) {
        releaseCohorts = appendBoundedCohort(
          releaseCohorts,
          artifact,
          256,
          (left, right) =>
            left.confidencePermille === right.confidencePermille,
          (left, right) => ({
            ...left,
            quantity: left.quantity + right.quantity,
            residualDefects:
              left.residualDefects + right.residualDefects,
          }),
          (left, right) => ({
            ...left,
            id: `compacted:${left.id}:${right.id}`,
            quantity: left.quantity + right.quantity,
            residualDefects:
              left.residualDefects + right.residualDefects,
            confidencePermille: weightedPermille(
              left.confidencePermille,
              left.quantity,
              right.confidencePermille,
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
      "Releases",
      view.resources.get(Resources.Releases),
      releaseCohorts,
    );
    const strategyLimit =
      state.strategy === "canary"
        ? 1
        : state.strategy === "rolling"
          ? Math.max(1, Math.floor(this.options.releasesPerTick / 2))
          : state.strategy === "hot"
            ? this.options.releasesPerTick * 2
          : this.options.releasesPerTick;
    const hotDeployRequests = view.resources.get(Resources.HotDeployRequests);
    const deployed = Math.min(
      strategyLimit + hotDeployRequests,
      view.resources.get(Resources.Releases),
    );
    if (deployed === 0) {
      return {
        ...(releaseCohorts === state.releaseCohorts
          ? {}
          : { statePatch: { releaseCohorts } }),
        telemetry: {
          status: "blocked",
          throughput: 0,
          bottleneck: "releases",
        },
      };
    }

    const serviceWeight = state.services.reduce(
      (total, cohort) => total + cohort.serviceCount,
      0,
    );
    const averageRevenue =
      serviceWeight === 0
        ? 0
        : Math.floor(
            state.services.reduce(
              (total, cohort) =>
                total + cohort.serviceCount * cohort.revenuePerRelease,
              0,
            ) / serviceWeight,
          );
    const averageIncidentChance =
      serviceWeight === 0
        ? 0
        : Math.floor(
            state.services.reduce(
              (total, cohort) =>
                total +
                cohort.serviceCount * cohort.baseIncidentChancePermille,
              0,
            ) / serviceWeight,
          );
    const strategyRisk =
      state.strategy === "all-at-once"
        ? 150
        : state.strategy === "rolling"
          ? 50
          : state.strategy === "hot"
            ? 300
            : -100;
    const selectedArtifacts = this.selectReleaseCohorts(
      releaseCohorts,
      deployed,
    );
    const confidenceReduction = Math.min(
      600,
      Math.floor(selectedArtifacts.confidencePermille / 2),
    );
    const bugPressure = Math.min(
      600,
      selectedArtifacts.residualDefects * 100,
    );
    const incidentChance = Math.max(
      0,
      Math.min(
        950,
        averageIncidentChance +
          strategyRisk +
        Math.floor(selectedArtifacts.riskTolerancePermille / 4) +
          bugPressure -
          Math.floor(view.resources.get(Resources.OperationsSkill) / 3) -
          confidenceReduction,
      ),
    );
    const incidents = context.random.chance(
      "deployment-incident",
      incidentChance,
    )
      ? 1
      : 0;
    const reputation = view.resources.get(Resources.Reputation);
    const reputationBonus = Math.min(500, reputation);
    const revenue = Math.floor(
      (deployed * averageRevenue * (1_000 + reputationBonus)) / 1_000,
    );
    const escapedBugs = Math.min(
      incidents,
      selectedArtifacts.residualDefects,
      view.resources.get(Resources.Bugs),
    );
    const remainingReleaseCohorts = this.consumeReleaseCohorts(
      releaseCohorts,
      deployed,
    );
    const consumedHotDeploys = Math.min(hotDeployRequests, deployed);

    return {
      resources: [
        {
          resource: Resources.Releases,
          amount: -deployed,
          reason: `Deployment strategy ${state.strategy}`,
        },
        {
          resource: Resources.Bugs,
          amount: -escapedBugs,
          reason: "Production defect discovered",
        },
        {
          resource: Resources.Money,
          amount: revenue,
          reason: "Runtime service revenue",
        },
        {
          resource: Resources.Incidents,
          amount: incidents,
          reason: "Production incidents",
        },
        {
          resource: Resources.Insight,
          amount: incidents,
          reason: "Production telemetry",
        },
        {
          resource: Resources.Reputation,
          amount:
            incidents > 0
              ? -Math.min(25, reputation)
              : reputation < 1_000
                ? 1
                : 0,
          reason:
            incidents > 0
              ? "Incident reputation damage"
              : "Reliable deployment",
        },
        {
          resource: Resources.HotDeployRequests,
          amount: -consumedHotDeploys,
          reason: "Automatic hot deployment",
        },
      ],
      statePatch: {
        deployed: state.deployed + deployed,
        revenue: state.revenue + revenue,
        incidentsCreated: state.incidentsCreated + incidents,
        releaseCohorts: remainingReleaseCohorts,
      },
      events: [
        {
          type: incidents > 0 ? "runtime.incident" : "runtime.deployed",
          payload: { deployed, revenue, incidents, strategy: state.strategy },
        },
      ],
      telemetry: { status: "active", throughput: deployed },
    };
  }

  private selectReleaseCohorts(
    cohorts: readonly ReleaseArtifactCohort[],
    quantity: number,
  ): {
    readonly confidencePermille: number;
    readonly residualDefects: number;
    readonly riskTolerancePermille: number;
    readonly releaseCadencePermille: number;
  } {
    let remaining = quantity;
    let selectedTotal = 0;
    let confidence = 0;
    let defects = 0;
    let risk = 0;
    let cadence = 0;
    for (const cohort of cohorts) {
      const selected = Math.min(remaining, cohort.quantity);
      selectedTotal += selected;
      confidence += selected * cohort.confidencePermille;
      risk += selected * cohort.riskTolerancePermille;
      cadence += selected * cohort.releaseCadencePermille;
      defects += Math.ceil(
        (cohort.residualDefects * selected) / Math.max(1, cohort.quantity),
      );
      remaining -= selected;
      if (remaining === 0) {
        break;
      }
    }
    return {
      confidencePermille:
        selectedTotal === 0 ? 0 : Math.floor(confidence / selectedTotal),
      residualDefects: defects,
      riskTolerancePermille:
        selectedTotal === 0 ? 0 : Math.floor(risk / selectedTotal),
      releaseCadencePermille:
        selectedTotal === 0 ? 0 : Math.floor(cadence / selectedTotal),
    };
  }

  private consumeReleaseCohorts(
    cohorts: readonly ReleaseArtifactCohort[],
    quantity: number,
  ): readonly ReleaseArtifactCohort[] {
    let remaining = quantity;
    const result: ReleaseArtifactCohort[] = [];
    for (const cohort of cohorts) {
      const consumed = Math.min(remaining, cohort.quantity);
      remaining -= consumed;
      if (cohort.quantity > consumed) {
        result.push({
          ...cohort,
          quantity: cohort.quantity - consumed,
          residualDefects: Math.max(
            0,
            cohort.residualDefects -
              Math.ceil(
                (cohort.residualDefects * consumed) /
                  Math.max(1, cohort.quantity),
              ),
          ),
        });
      }
    }
    return result;
  }
}

export interface IncidentResponseState extends JsonObject {
  readonly resolved: number;
  readonly totalCost: number;
}

class IncidentResponseSystem
  implements SimulationSystem<IncidentResponseState>
{
  public readonly id = INCIDENT_RESPONSE_SYSTEM_ID;
  public readonly pipeline = RUNTIME_LAYER_ID;
  public readonly phase = SimulationPhase.Economy;
  public readonly dependsOn = [RUNTIME_SYSTEM_ID];
  public readonly reads = [Resources.Incidents, Resources.Money];
  public readonly writes = [
    Resources.Incidents,
    Resources.Money,
    Resources.Insight,
    Resources.Reputation,
  ];
  public readonly stateReads = [];
  public readonly eventReads = ["runtime.incident"];
  public readonly emits = ["runtime.incident-resolved"];

  public initialState(): IncidentResponseState {
    return { resolved: 0, totalCost: 0 };
  }

  public run(
    view: SimulationView,
  ): SystemUpdate<IncidentResponseState> | undefined {
    const incidentCost = 5;
    const resolved = Math.min(
      2,
      view.resources.get(Resources.Incidents),
      Math.floor(view.resources.get(Resources.Money) / incidentCost),
    );
    if (resolved === 0) {
      return undefined;
    }

    const cost = resolved * incidentCost;
    const state = view.getSystemState<IncidentResponseState>(this.id);
    return {
      resources: [
        {
          resource: Resources.Incidents,
          amount: -resolved,
          reason: "Incident response",
        },
        {
          resource: Resources.Money,
          amount: -cost,
          reason: "Incident response cost",
        },
        {
          resource: Resources.Insight,
          amount: resolved * 2,
          reason: "Incident postmortems",
        },
        {
          resource: Resources.Reputation,
          amount: resolved,
          reason: "Incident recovery",
        },
      ],
      statePatch: {
        resolved: state.resolved + resolved,
        totalCost: state.totalCost + cost,
      },
      events: [
        {
          type: "runtime.incident-resolved",
          payload: { resolved, cost },
        },
      ],
    };
  }
}

function createDeploymentStrategyHandler(): CommandHandler<SetDeploymentStrategyPayload> {
  return {
    id: RUNTIME_SYSTEM_ID,
    type: "runtime.set-deployment-strategy",
    reads: [],
    writes: [],
    stateReads: [],
    eventReads: [],
    emits: ["runtime.strategy-updated"],
    handle: (command, view) => {
      const strategies: readonly DeploymentStrategy[] = [
        "all-at-once",
        "rolling",
        "canary",
        "hot",
      ];
      if (!strategies.includes(command.payload.strategy)) {
        throw new Error(`Unknown deployment strategy: ${command.payload.strategy}`);
      }
      const state = view.getSystemState<RuntimeState>(RUNTIME_SYSTEM_ID);
      return {
        state: { ...state, strategy: command.payload.strategy },
        events: [
          {
            type: "runtime.strategy-updated",
            payload: { strategy: command.payload.strategy },
          },
        ],
      };
    },
  };
}

export function createRuntimeDeploymentLayer(
  options: RuntimeLayerOptions,
): SimulationLayer {
  return {
    id: RUNTIME_LAYER_ID,
    name: "Runtime & Deployment",
    pipeline: {
      id: RUNTIME_LAYER_ID,
      displayName: "Runtime & Deployment",
      dependsOn: [TESTING_LAYER_ID],
      inputs: [
        Resources.Releases,
        Resources.Bugs,
        Resources.TestConfidence,
        Resources.Reputation,
        Resources.HotDeployRequests,
        Resources.RiskTolerance,
        Resources.OperationsSkill,
      ],
      outputs: [
        Resources.Money,
        Resources.Incidents,
        Resources.Insight,
        Resources.Reputation,
      ],
    },
    systems: [new RuntimeSystem(options), new IncidentResponseSystem()],
    commandHandlers: [createDeploymentStrategyHandler()],
    eventHandlers: [],
    feedbackLoops: [
      "Reliable deployments build reputation and revenue that fund the organization; risky releases create costly incidents.",
    ],
    performanceNotes: [
      "Services are represented as cohorts sharing revenue and risk characteristics.",
    ],
  };
}
