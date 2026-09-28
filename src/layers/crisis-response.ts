import {
  SimulationPhase,
  type CommandHandler,
  type SimulationSystem,
  type SimulationView,
  type SystemUpdate,
} from "../contracts.js";
import { Resources } from "../resources.js";
import type { JsonObject } from "../types.js";
import {
  AUTOMATION_LAYER_ID,
  AUTOMATION_SYSTEM_ID,
  CRISIS_LAYER_ID,
  CRISIS_SYSTEM_ID,
  TECHNICAL_DEBT_LAYER_ID,
  TECHNICAL_DEBT_SYSTEM_ID,
} from "./ids.js";
import type { SimulationLayer } from "./layer.js";

export { CRISIS_LAYER_ID, CRISIS_SYSTEM_ID } from "./ids.js";

export interface CrisisProtocol extends JsonObject {
  readonly automaticResponsePermille: number;
  readonly outageThreshold: number;
  readonly debtThreshold: number;
  readonly rebellionThreshold: number;
  readonly shutdownAutomationAtSeverity: number;
}

export interface CrisisState extends JsonObject {
  readonly protocol: CrisisProtocol;
  readonly outages: number;
  readonly debtExplosions: number;
  readonly rebellions: number;
  readonly resolvedSeverity: number;
  readonly nextEpisodeId: number;
  readonly episodes: readonly CrisisEpisode[];
}

export type CrisisKind = "outage" | "debt-explosion" | "rebellion";
export type CrisisStatus = "active" | "contained" | "resolved";

export interface CrisisEpisode extends JsonObject {
  readonly id: string;
  readonly kind: CrisisKind;
  readonly status: CrisisStatus;
  readonly severity: number;
  readonly openedTick: number;
  readonly resolvedTick: number | null;
}

export interface CrisisLayerOptions {
  readonly initialProtocol: CrisisProtocol;
}

export interface SetCrisisProtocolPayload extends JsonObject {
  readonly protocol: CrisisProtocol;
}

class CrisisSystem implements SimulationSystem<CrisisState> {
  public readonly id = CRISIS_SYSTEM_ID;
  public readonly pipeline = CRISIS_LAYER_ID;
  public readonly phase = SimulationPhase.Crisis;
  public readonly dependsOn = [
    AUTOMATION_SYSTEM_ID,
    TECHNICAL_DEBT_SYSTEM_ID,
  ];
  public readonly reads = [
    Resources.Incidents,
    Resources.TechnicalDebt,
    Resources.AgentInstability,
    Resources.AgentAutonomy,
    Resources.Morale,
    Resources.CrisisSeverity,
    Resources.Money,
    Resources.Reputation,
    Resources.AutomationPower,
    Resources.ResponseCapacity,
  ];
  public readonly writes = [
    Resources.Incidents,
    Resources.TechnicalDebt,
    Resources.AgentInstability,
    Resources.CrisisSeverity,
    Resources.Money,
    Resources.Reputation,
    Resources.AutomationPower,
    Resources.Insight,
    Resources.ResponseCapacity,
  ];
  public readonly stateReads = [];
  public readonly eventReads = [
    "runtime.incident",
    "debt.interest-accrued",
    "automation.instability-increased",
  ];
  public readonly emits = [
    "crisis.detected",
    "crisis.resolved",
    "crisis.escalated",
  ];

  public constructor(private readonly options: CrisisLayerOptions) {}

  public initialState(): CrisisState {
    return {
      protocol: this.options.initialProtocol,
      outages: 0,
      debtExplosions: 0,
      rebellions: 0,
      resolvedSeverity: 0,
      nextEpisodeId: 1,
      episodes: [],
    };
  }

  public run(view: SimulationView): SystemUpdate<CrisisState> | undefined {
    const state = view.getSystemState<CrisisState>(this.id);
    const incidents = view.resources.get(Resources.Incidents);
    const debt = view.resources.get(Resources.TechnicalDebt);
    const instability = view.resources.get(Resources.AgentInstability);
    const autonomy = view.resources.get(Resources.AgentAutonomy);
    const morale = view.resources.get(Resources.Morale);
    const outage = incidents >= state.protocol.outageThreshold;
    const debtExplosion = debt >= state.protocol.debtThreshold;
    const rebellion =
      instability + autonomy - morale >=
      state.protocol.rebellionThreshold;
    const triggers: readonly {
      readonly kind: CrisisKind;
      readonly active: boolean;
      readonly severity: number;
    }[] = [
      { kind: "outage", active: outage, severity: incidents * 5 },
      {
        kind: "debt-explosion",
        active: debtExplosion,
        severity: Math.floor(
          debt / Math.max(1, state.protocol.debtThreshold),
        ),
      },
      {
        kind: "rebellion",
        active: rebellion,
        severity: Math.floor((instability + autonomy - morale) / 10),
      },
    ];
    let nextEpisodeId = state.nextEpisodeId;
    let episodes = state.episodes.map((episode) => ({ ...episode }));
    const opened: CrisisEpisode[] = [];
    let escalatedSeverity = 0;
    for (const trigger of triggers) {
      const existing = episodes.find(
        (episode) =>
          episode.kind === trigger.kind && episode.status !== "resolved",
      );
      if (trigger.active && existing === undefined) {
        const episode: CrisisEpisode = {
          id: `crisis:${nextEpisodeId}`,
          kind: trigger.kind,
          status: "active",
          severity: Math.max(1, trigger.severity),
          openedTick: view.tick,
          resolvedTick: null,
        };
        nextEpisodeId += 1;
        episodes.push(episode);
        opened.push(episode);
      } else if (trigger.active && existing !== undefined) {
        const nextSeverity = Math.max(1, trigger.severity);
        if (
          existing.status === "contained" ||
          nextSeverity > existing.severity
        ) {
          escalatedSeverity += Math.max(
            0,
            nextSeverity - existing.severity,
          );
          episodes = episodes.map((episode) =>
            episode.id === existing.id
              ? {
                  ...episode,
                  severity: Math.max(episode.severity, nextSeverity),
                  status: "active" as const,
                }
              : episode,
          );
        }
      } else if (!trigger.active && existing?.status === "contained") {
        episodes = episodes.map((episode) =>
          episode.id === existing.id
            ? {
                ...episode,
                status: "resolved" as const,
                resolvedTick: view.tick,
              }
            : episode,
        );
      }
    }
    const detectedSeverity = opened.reduce(
      (total, episode) => total + episode.severity,
      0,
    ) + escalatedSeverity;
    let severityBudget = 1_000_000_000;
    episodes = episodes.map((episode) => {
      if (episode.status === "resolved") {
        return episode;
      }
      const severity = Math.min(episode.severity, severityBudget);
      severityBudget -= severity;
      return { ...episode, severity };
    });
    const existingSeverity = view.resources.get(Resources.CrisisSeverity);
    const totalSeverity = episodes.reduce(
      (total, episode) =>
        total + (episode.status === "resolved" ? 0 : episode.severity),
      0,
    );
    if (totalSeverity === 0) {
      const boundedEpisodes = episodes.slice(-64);
      const episodesChanged =
        JSON.stringify(boundedEpisodes) !== JSON.stringify(state.episodes);
      if (!episodesChanged && existingSeverity === 0) {
        return undefined;
      }
      return {
        ...(existingSeverity === 0
          ? {}
          : {
              resources: [{
                resource: Resources.CrisisSeverity,
                amount: -existingSeverity,
                reason: "Reconcile crisis episode severity",
              }],
            }),
        ...(episodesChanged
          ? {
              statePatch: {
                episodes: boundedEpisodes,
                nextEpisodeId,
              },
            }
          : {}),
      };
    }

    const responseBudget = Math.floor(
      (view.resources.get(Resources.Money) *
        state.protocol.automaticResponsePermille) /
        1_000,
    );
    const responseCapacity = view.resources.get(Resources.ResponseCapacity);
    const resolved = Math.min(
      totalSeverity,
      responseBudget,
      responseCapacity,
    );
    const unresolved = totalSeverity - resolved;
    const automationPower = view.resources.get(Resources.AutomationPower);
    const automationShutdown =
      totalSeverity >= state.protocol.shutdownAutomationAtSeverity
        ? Math.min(automationPower, Math.max(1, resolved))
        : 0;
    const incidentReduction = Math.min(incidents, Math.floor(resolved / 5));
    const debtReduction = Math.min(debt, Math.floor(resolved / 2));
    const instabilityReduction = Math.min(instability, resolved);
    const reputation = view.resources.get(Resources.Reputation);
    const reputationLoss = Math.min(reputation, unresolved);
    const nextInstability = Math.min(
      1_000_000_000,
      instability -
        instabilityReduction +
        Math.floor(unresolved / 2),
    );
    let remainingResolution = resolved;
    episodes = episodes.map((episode) => {
      if (episode.status === "resolved" || remainingResolution === 0) {
        return episode;
      }
      const episodeResolved = Math.min(
        episode.severity,
        remainingResolution,
      );
      remainingResolution -= episodeResolved;
      const severity = episode.severity - episodeResolved;
      return {
        ...episode,
        severity,
        status: severity === 0 ? "contained" as const : "active" as const,
      };
    });
    const nextSeverity = episodes.reduce(
      (total, episode) =>
        total + (episode.status === "resolved" ? 0 : episode.severity),
      0,
    );
    const events = [
      ...(opened.length === 0
        ? []
        : [{
            type: "crisis.detected",
            delivery: "durable" as const,
            payload: {
              episodes: opened,
              detectedSeverity,
            },
          }]),
      {
        type: resolved > 0 ? "crisis.resolved" : "crisis.escalated",
        payload: { resolved, unresolved, automationShutdown },
      },
    ];

    return {
      resources: [
        {
          resource: Resources.CrisisSeverity,
          amount: nextSeverity - existingSeverity,
          reason: "Crisis detection and response",
        },
        {
          resource: Resources.Money,
          amount: -resolved,
          reason: "Emergency response budget",
        },
        {
          resource: Resources.Incidents,
          amount: -incidentReduction,
          reason: "Outage response",
        },
        {
          resource: Resources.TechnicalDebt,
          amount: -debtReduction,
          reason: "Emergency debt remediation",
        },
        {
          resource: Resources.AgentInstability,
          amount: nextInstability - instability,
          reason: "Swarm containment",
        },
        {
          resource: Resources.AutomationPower,
          amount: -automationShutdown,
          reason: "Automation circuit breaker",
        },
        {
          resource: Resources.Reputation,
          amount: -reputationLoss,
          reason: "Public crisis impact",
        },
        {
          resource: Resources.Insight,
          amount: Math.floor(resolved / 2),
          reason: "Crisis postmortem",
        },
        {
          resource: Resources.ResponseCapacity,
          amount: -resolved,
          reason: "Emergency response work",
        },
      ],
      statePatch: {
        outages:
          state.outages +
          opened.filter((episode) => episode.kind === "outage").length,
        debtExplosions:
          state.debtExplosions +
          opened.filter((episode) => episode.kind === "debt-explosion")
            .length,
        rebellions:
          state.rebellions +
          opened.filter((episode) => episode.kind === "rebellion").length,
        resolvedSeverity: state.resolvedSeverity + resolved,
        nextEpisodeId,
        episodes: episodes.slice(-64),
      },
      events,
    };
  }
}

function validateProtocol(protocol: CrisisProtocol): void {
  for (const [name, value] of Object.entries(protocol)) {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new Error(`${name} must be a non-negative integer`);
    }
  }
  if (protocol.automaticResponsePermille > 1_000) {
    throw new Error("automaticResponsePermille cannot exceed 1000");
  }
}

function createProtocolHandler(): CommandHandler<SetCrisisProtocolPayload> {
  return {
    id: CRISIS_SYSTEM_ID,
    type: "crisis.set-protocol",
    reads: [],
    writes: [],
    stateReads: [],
    eventReads: [],
    emits: ["crisis.protocol-updated"],
    handle: (command, view) => {
      validateProtocol(command.payload.protocol);
      const state = view.getSystemState<CrisisState>(CRISIS_SYSTEM_ID);
      return {
        state: { ...state, protocol: command.payload.protocol },
        events: [
          {
            type: "crisis.protocol-updated",
            payload: { protocol: command.payload.protocol },
          },
        ],
      };
    },
  };
}

export function createCrisisResponseLayer(
  options: CrisisLayerOptions,
): SimulationLayer {
  validateProtocol(options.initialProtocol);
  return {
    id: CRISIS_LAYER_ID,
    name: "Crisis Detection & Response",
    pipeline: {
      id: CRISIS_LAYER_ID,
      displayName: "Crisis Detection & Response",
      dependsOn: [AUTOMATION_LAYER_ID, TECHNICAL_DEBT_LAYER_ID],
      inputs: [
        Resources.Incidents,
        Resources.TechnicalDebt,
        Resources.AgentInstability,
        Resources.Morale,
        Resources.Money,
      ],
      outputs: [
        Resources.CrisisSeverity,
        Resources.Insight,
      ],
    },
    systems: [new CrisisSystem(options)],
    commandHandlers: [createProtocolHandler()],
    eventHandlers: [],
    feedbackLoops: [
      "Crisis protocols spend reserves and suppress automation before outages, debt, or rebellions cascade.",
      "Underfunded responses increase instability and can turn one crisis into the next.",
    ],
    performanceNotes: [
      "Crises are thresholded aggregate states rather than per-incident entities.",
    ],
  };
}
