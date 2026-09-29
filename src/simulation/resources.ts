import {
  type ResourceId,
  assertSafeInteger,
  resourceId,
} from "./types.js";

export interface ResourceDefinition {
  readonly id: ResourceId;
  readonly displayName: string;
  readonly allowNegative?: boolean;
  readonly maximum?: number;
  readonly resetEachTick?: boolean;
}

export interface ResourceMutation {
  readonly resource: ResourceId;
  readonly amount: number;
  readonly reason: string;
}

export interface ResourceBalanceChange {
  readonly resource: ResourceId;
  readonly previous: number;
  readonly next: number;
}

export interface ResourceSnapshot {
  readonly [resource: string]: number;
}

export interface ResourceView {
  get(resource: ResourceId): number;
  has(resource: ResourceId, amount: number): boolean;
  entries(): readonly (readonly [ResourceId, number])[];
}

export const Resources = {
  Compute: resourceId("core.compute"),
  HumanCapacity: resourceId("core.human-capacity"),
  AgentCapacity: resourceId("core.agent-capacity"),
  MaintenanceCapacity: resourceId("core.maintenance-capacity"),
  PolicyStrength: resourceId("core.policy-strength"),
  CodingStandards: resourceId("core.coding-standards"),
  RiskTolerance: resourceId("core.risk-tolerance"),
  ReleaseCadence: resourceId("core.release-cadence"),
  Morale: resourceId("core.morale"),
  AgentAutonomy: resourceId("core.agent-autonomy"),
  VerificationSkill: resourceId("core.verification-skill"),
  OperationsSkill: resourceId("core.operations-skill"),
  ResponseCapacity: resourceId("core.response-capacity"),
  ResearchSkill: resourceId("core.research-skill"),
  Demand: resourceId("core.demand"),
  Source: resourceId("core.source"),
  Binaries: resourceId("core.binaries"),
  Releases: resourceId("core.releases"),
  Bugs: resourceId("core.bugs"),
  Incidents: resourceId("core.incidents"),
  Insight: resourceId("core.insight"),
  Knowledge: resourceId("core.knowledge"),
  TestConfidence: resourceId("core.test-confidence"),
  Reputation: resourceId("core.reputation"),
  AutomationPower: resourceId("core.automation-power"),
  HotDeployRequests: resourceId("core.hot-deploy-requests"),
  CrisisSeverity: resourceId("core.crisis-severity"),
  AgentInstability: resourceId("core.agent-instability"),
  Money: resourceId("core.money"),
  TechnicalDebt: resourceId("core.technical-debt"),
} as const;

export const MAX_HOT_DEPLOY_REQUESTS = 1_000;
export const MAX_DEMAND_BACKLOG = 2_000;
export const INITIAL_DEMAND_BACKLOG = 40;

export const CORE_RESOURCE_DEFINITIONS: readonly ResourceDefinition[] = [
  { id: Resources.Compute, displayName: "Compute", resetEachTick: true },
  {
    id: Resources.HumanCapacity,
    displayName: "Human Capacity",
    resetEachTick: true,
  },
  {
    id: Resources.AgentCapacity,
    displayName: "Agent Capacity",
    resetEachTick: true,
  },
  {
    id: Resources.MaintenanceCapacity,
    displayName: "Maintenance Capacity",
    resetEachTick: true,
  },
  {
    id: Resources.PolicyStrength,
    displayName: "Policy Strength",
    resetEachTick: true,
  },
  {
    id: Resources.CodingStandards,
    displayName: "Coding Standards",
    resetEachTick: true,
  },
  {
    id: Resources.RiskTolerance,
    displayName: "Risk Tolerance",
    resetEachTick: true,
  },
  {
    id: Resources.ReleaseCadence,
    displayName: "Release Cadence",
    resetEachTick: true,
  },
  { id: Resources.Morale, displayName: "Morale", resetEachTick: true },
  {
    id: Resources.AgentAutonomy,
    displayName: "Agent Autonomy",
    resetEachTick: true,
  },
  {
    id: Resources.VerificationSkill,
    displayName: "Verification Skill",
    resetEachTick: true,
  },
  {
    id: Resources.OperationsSkill,
    displayName: "Operations Skill",
    resetEachTick: true,
  },
  {
    id: Resources.ResponseCapacity,
    displayName: "Response Capacity",
    resetEachTick: true,
  },
  {
    id: Resources.ResearchSkill,
    displayName: "Research Skill",
    resetEachTick: true,
  },
  { id: Resources.Demand, displayName: "Unmet Demand", maximum: MAX_DEMAND_BACKLOG },
  { id: Resources.Source, displayName: "Source", maximum: 1_000 },
  { id: Resources.Binaries, displayName: "Binaries", maximum: 500 },
  { id: Resources.Releases, displayName: "Releases", maximum: 100 },
  { id: Resources.Bugs, displayName: "Bugs" },
  { id: Resources.Incidents, displayName: "Incidents" },
  { id: Resources.Insight, displayName: "Insight" },
  { id: Resources.Knowledge, displayName: "Knowledge" },
  {
    id: Resources.TestConfidence,
    displayName: "Test Confidence",
    resetEachTick: true,
  },
  { id: Resources.Reputation, displayName: "Reputation", maximum: 1_000 },
  {
    id: Resources.AutomationPower,
    displayName: "Automation Power",
    maximum: 1_000_000_000,
  },
  {
    id: Resources.HotDeployRequests,
    displayName: "Hot Deploy Requests",
    maximum: MAX_HOT_DEPLOY_REQUESTS,
  },
  {
    id: Resources.CrisisSeverity,
    displayName: "Crisis Severity",
    maximum: 1_000_000_000,
  },
  {
    id: Resources.AgentInstability,
    displayName: "Agent Instability",
    maximum: 1_000_000_000,
  },
  { id: Resources.Money, displayName: "Money" },
  { id: Resources.TechnicalDebt, displayName: "Technical Debt" },
];

class FrozenResourceView implements ResourceView {
  public constructor(
    private readonly balances: ReadonlyMap<ResourceId, number>,
    private readonly allowed?: ReadonlySet<ResourceId>,
  ) {}

  public get(resource: ResourceId): number {
    if (this.allowed !== undefined && !this.allowed.has(resource)) {
      throw new Error(`Undeclared resource read: ${resource}`);
    }
    return this.balances.get(resource) ?? 0;
  }

  public has(resource: ResourceId, amount: number): boolean {
    assertSafeInteger(amount, "Resource amount");
    return this.get(resource) >= amount;
  }

  public entries(): readonly (readonly [ResourceId, number])[] {
    return [...this.balances.entries()].filter(
      ([id]) => this.allowed === undefined || this.allowed.has(id),
    );
  }
}

export class ResourceRegistry {
  private readonly definitions = new Map<ResourceId, ResourceDefinition>();
  private balances = new Map<ResourceId, number>();
  private scopedViews = new WeakMap<ReadonlySet<ResourceId>, ResourceView>();
  private readonly resettable: ResourceId[] = [];

  public constructor(
    definitions: readonly ResourceDefinition[],
    initialBalances: ResourceSnapshot = {},
  ) {
    for (const definition of definitions) {
      if (this.definitions.has(definition.id)) {
        throw new Error(`Duplicate resource definition: ${definition.id}`);
      }
      if (
        definition.maximum !== undefined &&
        (!Number.isSafeInteger(definition.maximum) || definition.maximum < 0)
      ) {
        throw new Error(`Invalid maximum for resource ${definition.id}`);
      }
      this.definitions.set(definition.id, { ...definition });
      this.balances.set(definition.id, 0);
      if (definition.resetEachTick) this.resettable.push(definition.id);
    }

    for (const [rawId, amount] of Object.entries(initialBalances)) {
      const id = resourceId(rawId);
      this.assertDefined(id);
      this.validateBalance(id, amount);
      this.balances.set(id, amount);
    }
  }

  public get(resource: ResourceId): number {
    this.assertDefined(resource);
    return this.balances.get(resource) ?? 0;
  }

  public view(allowed?: readonly ResourceId[] | ReadonlySet<ResourceId>): ResourceView {
    return new FrozenResourceView(
      this.balances, allowed === undefined ? undefined : new Set(allowed),
    );
  }

  public viewPrepared(allowed: ReadonlySet<ResourceId>): ResourceView {
    const cached = this.scopedViews.get(allowed);
    if (cached !== undefined) return cached;
    const view = new FrozenResourceView(this.balances, new Set(allowed));
    this.scopedViews.set(allowed, view);
    return view;
  }

  public resetTickResources(): readonly ResourceBalanceChange[] {
    const changes: ResourceBalanceChange[] = [];
    for (const resource of this.resettable) {
      const previous = this.balances.get(resource) ?? 0;
      if (previous !== 0) {
        changes.push({ resource, previous, next: 0 });
        this.balances.set(resource, 0);
      }
    }
    return changes;
  }

  public restore(snapshot: ResourceSnapshot): void {
    const replacement = new ResourceRegistry(
      [...this.definitions.values()],
      snapshot,
    );
    this.balances = new Map(replacement.balances);
    // Prior views retain the old balances, as before restoration.
    this.scopedViews = new WeakMap();
  }

  public applyTransaction(
    mutations: readonly ResourceMutation[],
  ): readonly ResourceBalanceChange[] {
    if (mutations.length === 0) return [];
    if (mutations.length === 1) {
      const mutation = mutations[0];
      if (mutation === undefined) throw new Error("Missing resource mutation");
      this.assertDefined(mutation.resource);
      assertSafeInteger(mutation.amount, `Mutation for ${mutation.resource}`);
      const previous = this.balances.get(mutation.resource) ?? 0;
      const next = previous + mutation.amount;
      this.validateBalance(mutation.resource, next);
      this.balances.set(mutation.resource, next);
      return [{ resource: mutation.resource, previous, next }];
    }
    const nextValues = new Map<ResourceId, number>();

    for (const mutation of mutations) {
      this.assertDefined(mutation.resource);
      assertSafeInteger(mutation.amount, `Mutation for ${mutation.resource}`);
      const balance =
        (nextValues.get(mutation.resource) ??
          this.balances.get(mutation.resource) ??
          0) + mutation.amount;
      this.validateBalance(mutation.resource, balance);
      nextValues.set(mutation.resource, balance);
    }

    const changes = [...nextValues.entries()].map(
      ([resource, next]): ResourceBalanceChange => ({
        resource,
        previous: this.balances.get(resource) ?? 0,
        next,
      }),
    );
    for (const change of changes) {
      this.balances.set(change.resource, change.next);
    }
    return changes;
  }

  public rollback(changes: readonly ResourceBalanceChange[]): void {
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      const change = changes[index];
      if (change !== undefined) {
        this.balances.set(change.resource, change.previous);
      }
    }
  }

  public serialize(): ResourceSnapshot {
    return Object.fromEntries(
      [...this.balances.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, amount]) => [id, amount]),
    );
  }

  private assertDefined(resource: ResourceId): void {
    if (!this.definitions.has(resource)) {
      throw new Error(`Unknown resource: ${resource}`);
    }
  }

  private validateBalance(resource: ResourceId, amount: number): void {
    assertSafeInteger(amount, `Balance for ${resource}`);
    const definition = this.definitions.get(resource);
    if (definition === undefined) {
      throw new Error(`Unknown resource: ${resource}`);
    }
    if (!definition.allowNegative && amount < 0) {
      throw new Error(`Insufficient ${definition.displayName}`);
    }
    if (definition.maximum !== undefined && amount > definition.maximum) {
      throw new Error(`${definition.displayName} exceeds its maximum`);
    }
  }
}
