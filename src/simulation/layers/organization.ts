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
  ORGANIZATION_LAYER_ID,
  ORGANIZATION_SYSTEM_ID,
} from "./ids.js";
import type { SimulationLayer } from "./layer.js";
import type { SourceWorkAllocation } from "./cohorts.js";

export { ORGANIZATION_LAYER_ID, ORGANIZATION_SYSTEM_ID } from "./ids.js";

export interface TeamSkillTree extends JsonObject {
  readonly sourceGeneration: number;
  readonly verification: number;
  readonly operations: number;
  readonly research: number;
}

export type TeamSkillId =
  | "sourceGeneration"
  | "verification"
  | "operations"
  | "research";

export type TeamRole = TeamSkillId | "generalist";
export const TEAM_ROLES: readonly TeamRole[] = [
  "generalist", "sourceGeneration", "verification", "operations", "research",
];
export const TEAM_SKILLS: readonly TeamSkillId[] = [
  "sourceGeneration", "verification", "operations", "research",
];
export const MAX_TEAM_HEADCOUNT = 100;
export const MAX_SWARM_AGENTS = 100;

export interface TeamCohort extends JsonObject {
  readonly id: string;
  readonly headcount: number;
  readonly engineeringSkillPermille: number;
  readonly salaryPerTick: number;
  readonly moralePermille: number;
  readonly skillTree: TeamSkillTree;
  readonly role?: TeamRole;
}

export interface AgentSwarm extends JsonObject {
  readonly id: string;
  readonly agents: number;
  readonly autonomyPermille: number;
  readonly alignmentPermille: number;
  readonly productivityPermille: number;
  readonly operatingCostPerAgent: number;
}

export interface OrganizationPolicy extends JsonObject {
  readonly aiAllocationPermille: number;
  readonly maintenanceAllocationPermille: number;
  readonly reviewStrengthPermille: number;
  readonly testStrengthPermille: number;
  readonly codingStandardsPermille: number;
  readonly riskTolerancePermille: number;
  readonly releaseCadencePermille: number;
}

type WeightedPolicyKey =
  | "maintenanceAllocationPermille"
  | "reviewStrengthPermille"
  | "testStrengthPermille"
  | "codingStandardsPermille"
  | "riskTolerancePermille"
  | "releaseCadencePermille";

export interface TeamWorkAllocation extends SourceWorkAllocation {
  readonly policy: OrganizationPolicy;
  readonly fundedPeople?: number;
}

export interface SwarmProductivity extends JsonObject {
  readonly swarmId: string;
  readonly fundedAgents: number;
  readonly effectiveCapacity: number;
  readonly effectiveAlignmentPermille: number;
}

export interface OrganizationState extends JsonObject {
  readonly teams: readonly TeamCohort[];
  readonly agentSwarms: readonly AgentSwarm[];
  readonly policy: OrganizationPolicy;
  readonly teamPolicies: Readonly<Record<string, OrganizationPolicy>>;
  readonly teamAllocations: readonly TeamWorkAllocation[];
  readonly swarmProductivity: readonly SwarmProductivity[];
  readonly totalPayroll: number;
}

export interface SetOrganizationPolicyPayload extends JsonObject {
  readonly policy: OrganizationPolicy;
}

export interface SetTeamPolicyPayload extends JsonObject {
  readonly teamId: string;
  readonly policy: OrganizationPolicy;
}

export interface ConfigureSwarmPayload extends JsonObject {
  readonly swarmId: string;
  readonly autonomyPermille: number;
  readonly alignmentPermille: number;
}

export interface TrainTeamPayload extends JsonObject {
  readonly teamId: string;
  readonly skill: TeamSkillId;
  readonly amount: number;
}

export interface AdjustStaffPayload extends JsonObject {
  readonly teamId: string;
  readonly delta: number;
}

export interface AdjustSwarmPayload extends JsonObject {
  readonly swarmId: string;
  readonly delta: number;
}

export interface AssignTeamRolePayload extends JsonObject {
  readonly teamId: string;
  readonly role: TeamRole;
}

function roleMultiplier(role: TeamRole, skill: TeamSkillId): number {
  return role === "generalist" ? 1_000 : role === skill ? 1_200 : 750;
}

export interface OrganizationLayerOptions {
  readonly teams: readonly TeamCohort[];
  readonly agentSwarms: readonly AgentSwarm[];
  readonly initialPolicy: OrganizationPolicy;
}

class OrganizationSystem implements SimulationSystem<OrganizationState> {
  public readonly id = ORGANIZATION_SYSTEM_ID;
  public readonly pipeline = ORGANIZATION_LAYER_ID;
  public readonly phase = SimulationPhase.Organization;
  public readonly dependsOn = [];
  public readonly reads = [
    Resources.Money,
    Resources.Knowledge,
    Resources.AgentInstability,
    Resources.CrisisSeverity,
  ];
  public readonly writes = [
    Resources.Money,
    Resources.HumanCapacity,
    Resources.AgentCapacity,
    Resources.MaintenanceCapacity,
    Resources.PolicyStrength,
    Resources.CodingStandards,
    Resources.RiskTolerance,
    Resources.ReleaseCadence,
    Resources.Morale,
    Resources.AgentAutonomy,
    Resources.VerificationSkill,
    Resources.OperationsSkill,
    Resources.ResponseCapacity,
    Resources.ResearchSkill,
  ];
  public readonly stateReads = [];
  public readonly eventReads = [
    "runtime.deployed",
    "crisis.detected",
    "crisis.resolved",
  ];
  public readonly emits = ["organization.capacity-allocated"];

  public constructor(private readonly initial: OrganizationLayerOptions) {}

  public initialState(): OrganizationState {
    return {
      teams: this.initial.teams,
      agentSwarms: this.initial.agentSwarms,
      policy: this.initial.initialPolicy,
      teamPolicies: {},
      teamAllocations: [],
      swarmProductivity: [],
      totalPayroll: 0,
    };
  }

  public run(view: SimulationView): SystemUpdate<OrganizationState> {
    const state = view.getSystemState<OrganizationState>(this.id);
    let budget = view.resources.get(Resources.Money);
    const instability = view.resources.get(Resources.AgentInstability);
    const crisisSeverity = view.resources.get(Resources.CrisisSeverity);
    let humanCapacity = 0;
    let maintenanceCapacity = 0;
    let payroll = 0;
    let moraleTotal = 0;
    let peopleTotal = 0;
    let verificationSkill = 0;
    let operationsSkill = 0;
    let researchSkill = 0;
    const nextTeams: TeamCohort[] = [];
    const teamAllocations: TeamWorkAllocation[] = [];

    for (const cohort of state.teams) {
      const affordablePeople = Math.min(
        cohort.headcount,
        Math.floor(budget / cohort.salaryPerTick),
      );
      const cohortPayroll = affordablePeople * cohort.salaryPerTick;
      budget -= cohortPayroll;
      payroll += cohortPayroll;
      const teamPolicy = state.teamPolicies[cohort.id] ?? state.policy;
      const moraleDelta =
        (affordablePeople < cohort.headcount ? -15 : 2) -
        Math.min(20, Math.floor(instability / 50)) -
        Math.min(20, Math.floor(crisisSeverity / 20)) -
        Math.floor(teamPolicy.riskTolerancePermille / 250) +
        Math.floor(teamPolicy.codingStandardsPermille / 250);
      const morale = Math.max(
        100,
        Math.min(
          1_000,
          cohort.moralePermille + moraleDelta,
        ),
      );
      nextTeams.push({ ...cohort, moralePermille: morale });
      const teamCapacity = Math.floor(
        (affordablePeople *
          cohort.engineeringSkillPermille *
          Math.floor(cohort.skillTree.sourceGeneration * roleMultiplier(cohort.role ?? "generalist", "sourceGeneration") / 1_000) *
          morale) /
          1_000_000_000,
      );
      const teamMaintenance = Math.floor(
        (teamCapacity * teamPolicy.maintenanceAllocationPermille) / 1_000,
      );
      maintenanceCapacity += teamMaintenance;
      const deliveryCapacity = Math.max(0, teamCapacity - teamMaintenance);
      humanCapacity += deliveryCapacity;
      teamAllocations.push({
        teamId: cohort.id,
        capacity: deliveryCapacity,
        policy: teamPolicy,
        fundedPeople: affordablePeople,
      });
      moraleTotal += morale * affordablePeople;
      peopleTotal += affordablePeople;
      verificationSkill +=
        affordablePeople * Math.floor(cohort.skillTree.verification * roleMultiplier(cohort.role ?? "generalist", "verification") / 1_000);
      operationsSkill += affordablePeople * Math.floor(cohort.skillTree.operations * roleMultiplier(cohort.role ?? "generalist", "operations") / 1_000);
      researchSkill += affordablePeople * Math.floor(cohort.skillTree.research * roleMultiplier(cohort.role ?? "generalist", "research") / 1_000);
    }

    let fundedAgents = 0;
    let agentCapacity = 0;
    let autonomyWeighted = 0;
    const swarmProductivity: SwarmProductivity[] = [];
    for (const swarm of state.agentSwarms) {
      const allocated = Math.floor(
        (swarm.agents * state.policy.aiAllocationPermille) / 1_000,
      );
      const funded = Math.min(
        allocated,
        Math.floor(budget / swarm.operatingCostPerAgent),
      );
      const cost = funded * swarm.operatingCostPerAgent;
      budget -= cost;
      payroll += cost;
      fundedAgents += funded;
      const alignment = Math.max(
        0,
        swarm.alignmentPermille - Math.min(900, instability),
      );
      const effectiveCapacity = Math.floor(
        (funded *
          swarm.productivityPermille *
          alignment *
          (1_000 + Math.floor(swarm.autonomyPermille / 2))) /
          1_000_000_000,
      );
      agentCapacity += effectiveCapacity;
      swarmProductivity.push({
        swarmId: swarm.id,
        fundedAgents: funded,
        effectiveCapacity,
        effectiveAlignmentPermille: alignment,
      });
      autonomyWeighted += funded * swarm.autonomyPermille;
    }

    agentCapacity += Math.floor(
      view.resources.get(Resources.Knowledge) / 25,
    );
    const responseCapacity =
      crisisSeverity === 0
        ? 0
        : Math.min(
            humanCapacity,
            Math.max(1, Math.floor(operationsSkill / Math.max(1, peopleTotal * 100))),
          );
    let responseRemaining = responseCapacity;
    const adjustedAllocations = teamAllocations.map((allocation) => {
      const diverted = Math.min(responseRemaining, allocation.capacity);
      responseRemaining -= diverted;
      return { ...allocation, capacity: allocation.capacity - diverted };
    });
    const deliveryHumanCapacity = humanCapacity - responseCapacity;
    const weightedPolicy = this.weightPolicy(
      adjustedAllocations,
      state.policy,
    );
    const policyStrength = Math.floor(
      (weightedPolicy.reviewStrengthPermille +
        weightedPolicy.testStrengthPermille) /
        2,
    );
    const morale =
      peopleTotal === 0 ? 0 : Math.floor(moraleTotal / peopleTotal);
    const autonomy =
      fundedAgents === 0 ? 0 : Math.floor(autonomyWeighted / fundedAgents);
    const averageVerificationSkill =
      peopleTotal === 0 ? 0 : Math.floor(verificationSkill / peopleTotal);
    const averageOperationsSkill =
      peopleTotal === 0 ? 0 : Math.floor(operationsSkill / peopleTotal);
    const averageResearchSkill =
      peopleTotal === 0 ? 0 : Math.floor(researchSkill / peopleTotal);

    return {
      resources: [
        { resource: Resources.Money, amount: -payroll, reason: "Payroll" },
        {
          resource: Resources.HumanCapacity,
          amount: deliveryHumanCapacity,
          reason: "Team delivery capacity",
        },
        {
          resource: Resources.AgentCapacity,
          amount: agentCapacity,
          reason: "Aligned swarm capacity",
        },
        {
          resource: Resources.MaintenanceCapacity,
          amount: maintenanceCapacity,
          reason: "Maintenance allocation",
        },
        {
          resource: Resources.PolicyStrength,
          amount: policyStrength,
          reason: "Engineering governance",
        },
        {
          resource: Resources.CodingStandards,
          amount: weightedPolicy.codingStandardsPermille,
          reason: "Coding standards",
        },
        {
          resource: Resources.RiskTolerance,
          amount: weightedPolicy.riskTolerancePermille,
          reason: "Risk tolerance",
        },
        {
          resource: Resources.ReleaseCadence,
          amount: weightedPolicy.releaseCadencePermille,
          reason: "Release cadence",
        },
        { resource: Resources.Morale, amount: morale, reason: "Team morale" },
        {
          resource: Resources.AgentAutonomy,
          amount: autonomy,
          reason: "Swarm autonomy",
        },
        {
          resource: Resources.VerificationSkill,
          amount: averageVerificationSkill,
          reason: "Team verification skills",
        },
        {
          resource: Resources.OperationsSkill,
          amount: averageOperationsSkill,
          reason: "Team operations skills",
        },
        {
          resource: Resources.ResearchSkill,
          amount: averageResearchSkill,
          reason: "Team research skills",
        },
        {
          resource: Resources.ResponseCapacity,
          amount: responseCapacity,
          reason: "Crisis response allocation",
        },
      ],
      statePatch: {
        teams: nextTeams,
        teamAllocations: adjustedAllocations,
        swarmProductivity,
        totalPayroll: state.totalPayroll + payroll,
      },
      acknowledgedEventSequences: view.events
        .filter((event) => event.delivery === "durable")
        .map((event) => event.sequence),
      events: [
        {
          type: "organization.capacity-allocated",
          payload: {
            humanCapacity: deliveryHumanCapacity,
            agentCapacity,
            maintenanceCapacity,
            payroll,
            policyStrength,
            morale,
            autonomy,
            verificationSkill: averageVerificationSkill,
            operationsSkill: averageOperationsSkill,
            researchSkill: averageResearchSkill,
            responseCapacity,
            teamAllocations: adjustedAllocations,
          },
        },
      ],
    };
  }

  private weightPolicy(
    allocations: readonly TeamWorkAllocation[],
    fallback: OrganizationPolicy,
  ): OrganizationPolicy {
    const total = allocations.reduce(
      (sum, allocation) => sum + allocation.capacity,
      0,
    );
    if (total === 0) {
      return fallback;
    }
    const weighted = (key: WeightedPolicyKey): number =>
      Math.floor(
        allocations.reduce(
          (sum, allocation) =>
            sum + allocation.capacity * allocation.policy[key],
          0,
        ) / total,
      );
    return {
      aiAllocationPermille: fallback.aiAllocationPermille,
      maintenanceAllocationPermille: weighted(
        "maintenanceAllocationPermille",
      ),
      reviewStrengthPermille: weighted("reviewStrengthPermille"),
      testStrengthPermille: weighted("testStrengthPermille"),
      codingStandardsPermille: weighted("codingStandardsPermille"),
      riskTolerancePermille: weighted("riskTolerancePermille"),
      releaseCadencePermille: weighted("releaseCadencePermille"),
    };
  }
}

function validatePolicy(policy: OrganizationPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 1_000
    ) {
      throw new Error(`${name} must be an integer from 0 to 1000`);
    }
  }
}

function createPolicyHandler(): CommandHandler<SetOrganizationPolicyPayload> {
  return {
    id: ORGANIZATION_SYSTEM_ID,
    type: "organization.set-policy",
    reads: [],
    writes: [],
    stateReads: [],
    eventReads: [],
    emits: ["organization.policy-updated"],
    handle: (command, view) => {
      validatePolicy(command.payload.policy);
      const state = view.getSystemState<OrganizationState>(
        ORGANIZATION_SYSTEM_ID,
      );
      return {
        state: { ...state, policy: command.payload.policy },
        events: [
          {
            type: "organization.policy-updated",
            payload: { policy: command.payload.policy },
          },
        ],
      };
    },
  };
}

function createTeamPolicyHandler(): CommandHandler<SetTeamPolicyPayload> {
  return {
    id: ORGANIZATION_SYSTEM_ID,
    type: "organization.set-team-policy",
    reads: [],
    writes: [],
    stateReads: [],
    eventReads: [],
    emits: ["organization.team-policy-updated"],
    handle: (command, view) => {
      validatePolicy(command.payload.policy);
      const state = view.getSystemState<OrganizationState>(
        ORGANIZATION_SYSTEM_ID,
      );
      if (!state.teams.some((team) => team.id === command.payload.teamId)) {
        throw new Error(`Unknown team: ${command.payload.teamId}`);
      }

      return {
        state: {
          ...state,
          teamPolicies: {
            ...state.teamPolicies,
            [command.payload.teamId]: command.payload.policy,
          },
        },
        events: [
          {
            type: "organization.team-policy-updated",
            payload: {
              teamId: command.payload.teamId,
              policy: command.payload.policy,
            },
          },
        ],
      };
    },
  };
}

interface ClearTeamPolicyPayload extends JsonObject {
  readonly teamId: string;
}

function createClearTeamPolicyHandler(): CommandHandler<ClearTeamPolicyPayload> {
  return {
    id: ORGANIZATION_SYSTEM_ID,
    type: "organization.clear-team-policy",
    reads: [], writes: [], stateReads: [], eventReads: [],
    emits: ["organization.team-policy-cleared"],
    handle: (command, view) => {
      const state = view.getSystemState<OrganizationState>(ORGANIZATION_SYSTEM_ID);
      if (!state.teams.some((team) => team.id === command.payload.teamId)) {
        throw new Error(`Unknown team: ${command.payload.teamId}`);
      }
      if (!(command.payload.teamId in state.teamPolicies)) {
        throw new Error(`Team ${command.payload.teamId} already inherits global policy`);
      }
      const teamPolicies = { ...state.teamPolicies };
      delete teamPolicies[command.payload.teamId];
      return {
        statePatch: { teamPolicies },
        events: [{
          type: "organization.team-policy-cleared",
          payload: { teamId: command.payload.teamId },
        }],
      };
    },
  };
}

function createSwarmHandler(): CommandHandler<ConfigureSwarmPayload> {
  return {
    id: ORGANIZATION_SYSTEM_ID,
    type: "organization.configure-swarm",
    reads: [],
    writes: [],
    stateReads: [],
    eventReads: [],
    emits: ["organization.swarm-configured"],
    handle: (command, view) => {
      const { autonomyPermille, alignmentPermille } = command.payload;
      if (
        !Number.isSafeInteger(autonomyPermille) ||
        autonomyPermille < 0 ||
        autonomyPermille > 1_000 ||
        !Number.isSafeInteger(alignmentPermille) ||
        alignmentPermille < 0 ||
        alignmentPermille > 1_000
      ) {
        throw new Error(
          "Swarm autonomy and alignment must be from 0 to 1000",
        );
      }
      const state = view.getSystemState<OrganizationState>(
        ORGANIZATION_SYSTEM_ID,
      );
      if (
        !state.agentSwarms.some(
          (swarm) => swarm.id === command.payload.swarmId,
        )
      ) {
        throw new Error(`Unknown swarm: ${command.payload.swarmId}`);
      }
      return {
        state: {
          ...state,
          agentSwarms: state.agentSwarms.map((swarm) =>
            swarm.id === command.payload.swarmId
              ? { ...swarm, autonomyPermille, alignmentPermille }
              : swarm,
          ),
        },
        events: [
          {
            type: "organization.swarm-configured",
            payload: command.payload,
          },
        ],
      };
    },
  };
}

function createTrainingHandler(): CommandHandler<TrainTeamPayload> {
  return {
    id: ORGANIZATION_SYSTEM_ID,
    type: "organization.train-team",
    reads: [Resources.Money],
    writes: [Resources.Money],
    stateReads: [],
    eventReads: [],
    emits: ["organization.team-trained"],
    handle: (command, view) => {
      if (!Number.isSafeInteger(command.payload.amount) ||
        command.payload.amount < 1 || command.payload.amount > 100) {
        throw new Error("Training amount must be an integer from 1 to 100");
      }
      if (!TEAM_SKILLS.includes(command.payload.skill)) {
        throw new Error(`Unknown team skill: ${command.payload.skill}`);
      }
      const state = view.getSystemState<OrganizationState>(
        ORGANIZATION_SYSTEM_ID,
      );
      const team = state.teams.find(
        (candidate) => candidate.id === command.payload.teamId,
      );
      if (team === undefined) {
        throw new Error(`Unknown team: ${command.payload.teamId}`);
      }
      if (team.skillTree[command.payload.skill] + command.payload.amount > 2_000) {
        throw new Error(`Training would exceed the skill cap of 2000 for ${command.payload.skill}`);
      }
      const cost = command.payload.amount * 5;
      if (!view.resources.has(Resources.Money, cost)) {
        throw new Error("Insufficient Money for training");
      }
      const skillTree = {
        ...team.skillTree,
        [command.payload.skill]: team.skillTree[command.payload.skill] + command.payload.amount,
      };
      return {
        resources: [
          {
            resource: Resources.Money,
            amount: -cost,
            reason: "Team skill training",
          },
        ],
        state: {
          ...state,
          teams: state.teams.map((candidate) =>
            candidate.id === team.id
              ? {
                  ...candidate,
                  moralePermille: Math.min(
                    1_000,
                    candidate.moralePermille +
                      Math.floor(command.payload.amount / 2),
                  ),
                  skillTree,
                }
              : candidate,
          ),
        },
        events: [
          {
            type: "organization.team-trained",
            payload: {
              teamId: team.id,
              skill: command.payload.skill,
              amount: command.payload.amount,
            },
          },
        ],
      };
    },
  };
}

function validateAdjustment(delta: number): void {
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 10) {
    throw new Error("Staff change must be an integer between -10 and 10, excluding zero");
  }
}

function createStaffHandler(): CommandHandler<AdjustStaffPayload> {
  return {
    id: ORGANIZATION_SYSTEM_ID,
    type: "organization.adjust-team",
    reads: [Resources.Money],
    writes: [Resources.Money],
    stateReads: [],
    eventReads: [],
    emits: ["organization.team-staffed"],
    handle: (command, view) => {
      const { teamId, delta } = command.payload;
      validateAdjustment(delta);
      const state = view.getSystemState<OrganizationState>(ORGANIZATION_SYSTEM_ID);
      const team = state.teams.find((item) => item.id === teamId);
      if (!team) throw new Error(`Unknown team: ${teamId}`);
      const headcount = team.headcount + delta;
      if (headcount < 0 || headcount > MAX_TEAM_HEADCOUNT) {
        throw new Error(`Team headcount must be between 0 and ${MAX_TEAM_HEADCOUNT}`);
      }
      const cost = Math.max(0, delta) * team.salaryPerTick * 5;
      if (!view.resources.has(Resources.Money, cost)) throw new Error("Insufficient Money to hire engineers");
      return {
        resources: cost ? [{ resource: Resources.Money, amount: -cost, reason: "Engineer onboarding" }] : [],
        state: {
          ...state,
          teams: state.teams.map((item) => item.id === teamId ? { ...item, headcount } : item),
        },
        events: [{ type: "organization.team-staffed", payload: { teamId, delta, headcount } }],
      };
    },
  };
}

function createSwarmStaffHandler(): CommandHandler<AdjustSwarmPayload> {
  return {
    id: ORGANIZATION_SYSTEM_ID,
    type: "organization.adjust-swarm",
    reads: [Resources.Money],
    writes: [Resources.Money],
    stateReads: [],
    eventReads: [],
    emits: ["organization.swarm-staffed"],
    handle: (command, view) => {
      const { swarmId, delta } = command.payload;
      validateAdjustment(delta);
      const state = view.getSystemState<OrganizationState>(ORGANIZATION_SYSTEM_ID);
      const swarm = state.agentSwarms.find((item) => item.id === swarmId);
      if (!swarm) throw new Error(`Unknown swarm: ${swarmId}`);
      const agents = swarm.agents + delta;
      if (agents < 0 || agents > MAX_SWARM_AGENTS) {
        throw new Error(`Swarm agents must be between 0 and ${MAX_SWARM_AGENTS}`);
      }
      const cost = Math.max(0, delta) * swarm.operatingCostPerAgent * 5;
      if (!view.resources.has(Resources.Money, cost)) throw new Error("Insufficient Money to recruit agents");
      return {
        resources: cost ? [{ resource: Resources.Money, amount: -cost, reason: "Agent onboarding" }] : [],
        state: {
          ...state,
          agentSwarms: state.agentSwarms.map((item) => item.id === swarmId ? { ...item, agents } : item),
        },
        events: [{ type: "organization.swarm-staffed", payload: { swarmId, delta, agents } }],
      };
    },
  };
}

function createRoleHandler(): CommandHandler<AssignTeamRolePayload> {
  return {
    id: ORGANIZATION_SYSTEM_ID,
    type: "organization.assign-team-role",
    reads: [],
    writes: [],
    stateReads: [],
    eventReads: [],
    emits: ["organization.team-role-assigned"],
    handle: (command, view) => {
      const { teamId, role } = command.payload;
      if (!TEAM_ROLES.includes(role)) throw new Error(`Unknown team role: ${role}`);
      const state = view.getSystemState<OrganizationState>(ORGANIZATION_SYSTEM_ID);
      if (!state.teams.some((team) => team.id === teamId)) throw new Error(`Unknown team: ${teamId}`);
      return {
        state: {
          ...state,
          teams: state.teams.map((team) => team.id === teamId ? { ...team, role } : team),
        },
        events: [{ type: "organization.team-role-assigned", payload: { teamId, role } }],
      };
    },
  };
}

export function createOrganizationLayer(
  options: OrganizationLayerOptions,
): SimulationLayer {
  return {
    id: ORGANIZATION_LAYER_ID,
    name: "Organizational & Policy",
    pipeline: {
      id: ORGANIZATION_LAYER_ID,
      displayName: "Organizational & Policy",
      inputs: [
        Resources.Money,
        Resources.Knowledge,
        Resources.AgentInstability,
        Resources.CrisisSeverity,
      ],
      outputs: [
        Resources.HumanCapacity,
        Resources.AgentCapacity,
        Resources.MaintenanceCapacity,
        Resources.PolicyStrength,
        Resources.CodingStandards,
        Resources.RiskTolerance,
        Resources.ReleaseCadence,
        Resources.Morale,
        Resources.AgentAutonomy,
        Resources.VerificationSkill,
        Resources.OperationsSkill,
        Resources.ResponseCapacity,
        Resources.ResearchSkill,
      ],
    },
    systems: [new OrganizationSystem(options)],
    commandHandlers: [
      createPolicyHandler(),
      createTeamPolicyHandler(),
      createClearTeamPolicyHandler(),
      createSwarmHandler(),
      createTrainingHandler(),
      createStaffHandler(),
      createSwarmStaffHandler(),
      createRoleHandler(),
    ],
    eventHandlers: [],
    feedbackLoops: [
      "Revenue funds skilled teams and swarms; risk, morale, alignment, and instability determine effective capacity.",
    ],
    performanceNotes: [
      "People and agents are aggregated into team and swarm cohorts.",
    ],
  };
}
