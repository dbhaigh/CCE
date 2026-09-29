import {
  SimulationPhase,
  type CommandHandler,
  type SimulationSystem,
  type SimulationView,
  type SystemUpdate,
} from "../contracts.js";
import { topologicalOrder } from "../graph.js";
import { Resources } from "../resources.js";
import { type JsonObject } from "../types.js";
import type { SimulationLayer } from "./layer.js";
import {
  KNOWLEDGE_LAYER_ID,
  RESEARCH_SYSTEM_ID,
  RUNTIME_LAYER_ID,
  RUNTIME_SYSTEM_ID,
} from "./ids.js";

export { KNOWLEDGE_LAYER_ID, RESEARCH_SYSTEM_ID } from "./ids.js";

export interface ResearchProject extends JsonObject {
  readonly id: string;
  readonly requiredProgress: number;
  readonly insightPerProgress: number;
  readonly moneyPerProgress: number;
  readonly knowledgeReward: number;
  readonly dependencies: readonly string[];
}

export interface ResearchState extends JsonObject {
  readonly projects: readonly ResearchProject[];
  readonly selectedProjectId: string | null;
  readonly progress: Readonly<Record<string, number>>;
  readonly completed: readonly string[];
  readonly purchasedUpgrades: readonly string[];
}

export const RESEARCH_UPGRADES = [
  { id: "incremental-build-cache", projectId: "incremental-builds",
    moneyCost: 80, knowledgeCost: 10, description: "Save 1 Compute per compiled Source (minimum 1)." },
  { id: "verified-ai-source", projectId: "verified-generation",
    moneyCost: 160, knowledgeCost: 20, description: "Add 200/1,000 test strength to new AI-authored Source (maximum 1,000)." },
] as const;

export interface KnowledgeLayerOptions {
  readonly projects: readonly ResearchProject[];
  readonly initialProjectId: string | null;
  readonly progressPerTick: number;
}

export interface SelectResearchPayload extends JsonObject {
  readonly projectId: string;
}

class ResearchSystem implements SimulationSystem<ResearchState> {
  public readonly id = RESEARCH_SYSTEM_ID;
  public readonly pipeline = KNOWLEDGE_LAYER_ID;
  public readonly phase = SimulationPhase.Progression;
  public readonly dependsOn = [RUNTIME_SYSTEM_ID];
  public readonly reads = [
    Resources.Insight,
    Resources.Money,
    Resources.ResearchSkill,
  ];
  public readonly writes = [
    Resources.Insight,
    Resources.Money,
    Resources.Knowledge,
  ];
  public readonly stateReads = [];
  public readonly eventReads = ["runtime.incident", "runtime.deployed"];
  public readonly emits = ["research.progressed", "research.completed"];

  public constructor(private readonly options: KnowledgeLayerOptions) {
    this.validateProjects(options.projects);
    if (
      options.initialProjectId !== null &&
      !options.projects.some(
        (project) => project.id === options.initialProjectId,
      )
    ) {
      throw new Error(
        `Unknown initial research project: ${options.initialProjectId}`,
      );
    }
  }

  public initialState(): ResearchState {
    return {
      projects: this.options.projects,
      selectedProjectId: this.options.initialProjectId,
      progress: {},
      completed: [],
      purchasedUpgrades: [],
    };
  }

  public run(view: SimulationView): SystemUpdate<ResearchState> | undefined {
    const state = view.getSystemState<ResearchState>(this.id);
    if (state.selectedProjectId === null) {
      return undefined;
    }
    const project = state.projects.find(
      (candidate) => candidate.id === state.selectedProjectId,
    );
    if (project === undefined || state.completed.includes(project.id)) {
      return undefined;
    }
    if (
      !project.dependencies.every((dependency) =>
        state.completed.includes(dependency),
      )
    ) {
      return undefined;
    }

    const currentProgress = state.progress[project.id] ?? 0;
    const incidentBonus = view.events.filter(
      (event) => event.type === "runtime.incident",
    ).length;
    const possibleProgress = Math.min(
      this.options.progressPerTick +
        incidentBonus +
        Math.floor(view.resources.get(Resources.ResearchSkill) / 500),
      project.requiredProgress - currentProgress,
      Math.floor(
        view.resources.get(Resources.Insight) / project.insightPerProgress,
      ),
      project.moneyPerProgress === 0
        ? Number.MAX_SAFE_INTEGER
        : Math.floor(
            view.resources.get(Resources.Money) / project.moneyPerProgress,
          ),
    );
    if (possibleProgress <= 0) {
      return undefined;
    }

    const nextProgress = currentProgress + possibleProgress;
    const completed = nextProgress >= project.requiredProgress;
    return {
      resources: [
        {
          resource: Resources.Insight,
          amount: -(possibleProgress * project.insightPerProgress),
          reason: `Research project ${project.id}`,
        },
        {
          resource: Resources.Money,
          amount: -(possibleProgress * project.moneyPerProgress),
          reason: `Research project ${project.id}`,
        },
        {
          resource: Resources.Knowledge,
          amount:
            possibleProgress + (completed ? project.knowledgeReward : 0),
          reason: `Research project ${project.id}`,
        },
      ],
      statePatch: {
        progress: { ...state.progress, [project.id]: nextProgress },
        completed: completed
          ? [...state.completed, project.id]
          : state.completed,
        selectedProjectId: completed ? null : project.id,
      },
      events: [
        {
          type: completed ? "research.completed" : "research.progressed",
          payload: {
            projectId: project.id,
            progress: nextProgress,
            completed,
          },
        },
      ],
    };
  }

  private validateProjects(projects: readonly ResearchProject[]): void {
    topologicalOrder(projects, "Research project graph");
  }
}

function createPurchaseUpgradeHandler(): CommandHandler<{ readonly upgradeId: string } & JsonObject> {
  return {
    id: RESEARCH_SYSTEM_ID,
    type: "research.purchase-upgrade",
    reads: [Resources.Money, Resources.Knowledge],
    writes: [Resources.Money, Resources.Knowledge],
    stateReads: [],
    eventReads: [],
    emits: ["research.upgrade-purchased"],
    handle: (command, view) => {
      const upgrade = RESEARCH_UPGRADES.find((item) => item.id === command.payload.upgradeId);
      if (!upgrade) throw new Error(`Unknown research upgrade: ${command.payload.upgradeId}`);
      const state = view.getSystemState<ResearchState>(RESEARCH_SYSTEM_ID);
      if (!state.completed.includes(upgrade.projectId)) {
        throw new Error(`Complete ${upgrade.projectId} before purchasing ${upgrade.id}`);
      }
      if (state.purchasedUpgrades.includes(upgrade.id)) {
        throw new Error(`Upgrade already purchased: ${upgrade.id}`);
      }
      if (!view.resources.has(Resources.Money, upgrade.moneyCost) ||
        !view.resources.has(Resources.Knowledge, upgrade.knowledgeCost)) {
        throw new Error(`Insufficient Money or Knowledge for ${upgrade.id}`);
      }
      return {
        resources: [
          { resource: Resources.Money, amount: -upgrade.moneyCost, reason: `Upgrade ${upgrade.id}` },
          { resource: Resources.Knowledge, amount: -upgrade.knowledgeCost, reason: `Upgrade ${upgrade.id}` },
        ],
        statePatch: { purchasedUpgrades: [...state.purchasedUpgrades, upgrade.id] },
        events: [{ type: "research.upgrade-purchased", payload: { upgradeId: upgrade.id } }],
      };
    },
  };
}

function createResearchHandler(): CommandHandler<SelectResearchPayload> {
  return {
    id: RESEARCH_SYSTEM_ID,
    type: "research.select-project",
    reads: [],
    writes: [],
    stateReads: [],
    eventReads: [],
    emits: ["research.selected"],
    handle: (command, view) => {
      const state = view.getSystemState<ResearchState>(RESEARCH_SYSTEM_ID);
      const project = state.projects.find(
        (candidate) => candidate.id === command.payload.projectId,
      );
      if (project === undefined) {
        throw new Error(`Unknown research project: ${command.payload.projectId}`);
      }
      if (
        !project.dependencies.every((dependency) =>
          state.completed.includes(dependency),
        )
      ) {
        throw new Error(`Research dependencies are incomplete for ${project.id}`);
      }
      return {
        state: { ...state, selectedProjectId: project.id },
        events: [
          {
            type: "research.selected",
            payload: { projectId: project.id },
          },
        ],
      };
    },
  };
}

export function createKnowledgeResearchLayer(
  options: KnowledgeLayerOptions,
): SimulationLayer {
  return {
    id: KNOWLEDGE_LAYER_ID,
    name: "Knowledge & Research",
    pipeline: {
      id: KNOWLEDGE_LAYER_ID,
      displayName: "Knowledge & Research",
      dependsOn: [RUNTIME_LAYER_ID],
      inputs: [
        Resources.Insight,
        Resources.Money,
        Resources.ResearchSkill,
      ],
      outputs: [Resources.Knowledge],
    },
    systems: [new ResearchSystem(options)],
    commandHandlers: [createResearchHandler(), createPurchaseUpgradeHandler()],
    eventHandlers: [],
    feedbackLoops: [
      "Build, test, and runtime evidence becomes knowledge that improves AI productivity and build caching on later ticks.",
    ],
    performanceNotes: [
      "Only the selected project advances; the project graph is immutable definition data.",
    ],
  };
}
