import {
  type CommandHandler,
  type CommandResult,
  type DomainEvent,
  type EventDelivery,
  type EventDraft,
  type EventHandler,
  type GameCommand,
  type SimulationSystem,
  type SimulationView,
  type SystemContext,
  type SystemUpdate,
} from "./contracts.js";
import {
  type ExecutionPlan,
  type PipelineDefinition,
  buildExecutionPlan,
} from "./pipeline.js";
import { DeterministicRandom } from "./random.js";
import {
  type ResourceDefinition,
  type ResourceBalanceChange,
  type ResourceSnapshot,
  ResourceRegistry,
} from "./resources.js";
import {
  type DeepReadonly,
  type JsonObject,
  type JsonValue,
  type ResourceId,
  type SimTick,
  type SystemId,
  assertSafeInteger,
  cloneJson,
  deepFreeze,
  simTick,
  systemId,
} from "./types.js";

export interface SimulationConfiguration {
  readonly seed: string;
  readonly gameVersion: string;
  readonly contentHash: string;
  readonly tickDurationMs?: number;
  readonly maximumOfflineTicks?: number;
  readonly offlineProgressPolicy?: "complete" | "truncate";
  readonly maximumEventsPerTick?: number;
  readonly metricsWindowTicks?: number;
  readonly metricsSampleIntervalTicks?: number;
  readonly resources: readonly ResourceDefinition[];
  readonly initialResources?: ResourceSnapshot;
  readonly systems: readonly SimulationSystem[];
  readonly pipelines: readonly PipelineDefinition[];
  readonly commandHandlers?: readonly CommandHandler[];
  readonly eventHandlers?: readonly EventHandler[];
  readonly analyticalModels?: readonly AnalyticalOfflineModel[];
}

export interface AnalyticalOfflineView {
  readonly tick: SimTick;
  readonly resources: ReturnType<ResourceRegistry["view"]>;
  getSystemState<State extends JsonValue>(system: SystemId): DeepReadonly<State>;
}

export interface AnalyticalAdvance {
  readonly ticks: number;
  readonly resources?: readonly import("./resources.js").ResourceMutation[];
  readonly statePatches?: Readonly<Record<string, JsonObject>>;
  readonly eventCounts?: Readonly<Record<string, number>>;
  readonly eventSequencesConsumed?: number;
}

export interface AnalyticalOfflineModel {
  readonly id: string;
  readonly coveredSystems: readonly SystemId[];
  readonly coveredResources: readonly ResourceId[];
  readonly coveredEvents: readonly string[];
  readonly invariant: (view: AnalyticalOfflineView) => boolean;
  tryAdvance(
    view: AnalyticalOfflineView,
    maximumTicks: number,
  ): AnalyticalAdvance | undefined;
}

export interface SimulationSnapshot {
  readonly schemaVersion: 2 | 3 | 4 | 5 | 6;
  readonly gameVersion: string;
  readonly contentHash: string;
  readonly seed: string;
  readonly tick: number;
  readonly tickDurationMs: number;
  readonly scaledTimeRemainder: number;
  readonly nextEventSequence: number;
  readonly wallClockSavedAt: number;
  readonly resources: ResourceSnapshot;
  readonly systemStates: Readonly<Record<string, JsonValue>>;
  readonly queuedCommands: readonly GameCommand[];
  readonly pendingEvents: readonly DomainEvent[];
  readonly durableEvents?: readonly DomainEvent[];
  readonly importantEvents?: readonly DomainEvent[];
}

export interface AdvanceResult {
  readonly ticksProcessed: number;
  readonly exactTicksProcessed: number;
  readonly remainder: number;
  readonly commandResults: readonly CommandResult[];
  readonly events: readonly DomainEvent[];
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly analyticalTicksSkipped: number;
}

export interface OfflineAdvanceResult extends AdvanceResult {
  readonly elapsedMilliseconds: number;
  readonly requestedTicks: number;
  readonly discardedTicks: number;
  readonly capped: boolean;
}

export interface SystemExecutionMetric extends JsonObject {
  readonly tick: number;
  readonly systemId: string;
  readonly pipelineId: string;
  readonly status: "active" | "blocked" | "idle";
  readonly throughput: number;
  readonly resourceFlow: number;
  readonly eventsEmitted: number;
  readonly bottleneck: string | null;
}

export interface ResourceFlowTotals {
  readonly produced: Readonly<Record<string, number>>;
  readonly consumed: Readonly<Record<string, number>>;
  readonly discontinuities: number;
}

interface TickResult {
  readonly commandResults: readonly CommandResult[];
  readonly events: readonly DomainEvent[];
}

interface TickJournal {
  readonly resourceChanges: ResourceBalanceChange[];
  readonly resourceProduced?: Map<ResourceId, number>;
  readonly resourceConsumed?: Map<ResourceId, number>;
  readonly previousStates: Map<SystemId, JsonValue>;
  readonly removedCommands: GameCommand[];
  readonly previousCurrentEvents: DomainEvent[];
  readonly previousPendingEvents: DomainEvent[];
  readonly previousDurableEvents: DomainEvent[];
  readonly previousImportantEvents: DomainEvent[];
  readonly previousEmittedEvents: DomainEvent[];
  readonly nextEventSequence: number;
}

interface AccessDeclaration {
  readonly owner: SystemId;
  readonly reads: readonly ResourceId[];
  readonly writes: readonly ResourceId[];
  readonly stateReads: readonly SystemId[];
  readonly eventReads: readonly string[];
  readonly emits: readonly string[];
}

interface PreparedAccess extends AccessDeclaration {
  readonly allowedResources: ReadonlySet<ResourceId>;
  readonly allowedWrites: ReadonlySet<ResourceId>;
  readonly allowedStates: ReadonlySet<SystemId>;
  readonly eventTypes: ReadonlySet<string>;
}

const SNAPSHOT_SCHEMA_VERSION = 6;
const IMPORTANT_EVENT_LIMIT = 64;
const IMPORTANT_EVENT_TYPES = new Set([
  "build.job-queued", "build.job-reordered", "build.job-cancelled", "build.job-completed",
  "build.hardware-selected", "organization.team-staffed", "organization.swarm-staffed",
  "organization.team-role-assigned", "organization.swarm-configured",
  "organization.team-trained", "organization.policy-updated",
  "organization.team-policy-updated", "organization.team-policy-cleared",
  "research.completed", "research.selected", "research.upgrade-purchased", "crisis.protocol-updated",
  "debt.manual-paydown", "crisis.detected", "crisis.resolved", "crisis.escalated",
  "debt.interest-accrued", "runtime.incident", "runtime.strategy-updated",
]);
const THROTTLED_EVENT_TYPES = new Set([
  "crisis.resolved", "crisis.escalated", "debt.interest-accrued", "runtime.incident",
]);

export class Simulation {
  private readonly seed: string;
  private readonly gameVersion: string;
  private readonly contentHash: string;
  private readonly tickDurationMs: number;
  private readonly maximumOfflineTicks: number;
  private readonly offlineProgressPolicy: "complete" | "truncate";
  private readonly maximumEventsPerTick: number;
  private readonly metricsWindowTicks: number;
  private readonly metricsSampleIntervalTicks: number;
  private readonly systems: ReadonlyMap<SystemId, SimulationSystem>;
  private readonly executionPlan: ExecutionPlan;
  private readonly systemAccess = new Map<SystemId, PreparedAccess>();
  private readonly executionStages: readonly {
    readonly run: readonly { system: SimulationSystem; access: PreparedAccess }[];
    readonly commitOrder: readonly number[];
  }[];
  private readonly commandHandlers = new Map<string, CommandHandler>();
  private readonly eventHandlers = new Map<string, readonly EventHandler[]>();
  private readonly resourceRegistry: ResourceRegistry;
  private readonly analyticalModels: readonly AnalyticalOfflineModel[];
  private readonly systemStates = new Map<SystemId, JsonValue>();
  private readonly queuedCommands: GameCommand[] = [];

  private currentTick: SimTick = simTick(0);
  private scaledTimeRemainder = 0;
  private nextEventSequence = 1;
  private currentEvents: DomainEvent[] = [];
  private currentEventsByType = new Map<string, readonly DomainEvent[]>();
  private emittedEvents: DomainEvent[] = [];
  private pendingEvents: DomainEvent[] = [];
  private durableEvents: DomainEvent[] = [];
  private importantEvents: DomainEvent[] = [];
  private activeJournal: TickJournal | undefined;
  private lastTickWasQuiescent = false;
  private readonly systemMetrics: SystemExecutionMetric[] = [];
  private resourceProduced: Map<ResourceId, number> | null = null;
  private resourceConsumed: Map<ResourceId, number> | null = null;
  private flowDiscontinuities = 0;

  public constructor(
    private readonly configuration: SimulationConfiguration,
    snapshot?: SimulationSnapshot,
  ) {
    this.seed = configuration.seed;
    this.gameVersion = configuration.gameVersion;
    this.contentHash = configuration.contentHash;
    this.tickDurationMs = configuration.tickDurationMs ?? 1_000;
    this.maximumOfflineTicks = configuration.maximumOfflineTicks ?? 86_400;
    this.offlineProgressPolicy =
      configuration.offlineProgressPolicy ?? "complete";
    this.maximumEventsPerTick = configuration.maximumEventsPerTick ?? 10_000;
    this.metricsWindowTicks = configuration.metricsWindowTicks ?? 120;
    this.metricsSampleIntervalTicks =
      configuration.metricsSampleIntervalTicks ?? 10;
    this.analyticalModels = [...(configuration.analyticalModels ?? [])].sort(
      (left, right) => left.id.localeCompare(right.id),
    );

    assertSafeInteger(this.tickDurationMs, "Tick duration");
    assertSafeInteger(this.maximumOfflineTicks, "Maximum offline ticks");
    assertSafeInteger(this.maximumEventsPerTick, "Maximum events per tick");
    assertSafeInteger(this.metricsWindowTicks, "Metrics window ticks");
    assertSafeInteger(
      this.metricsSampleIntervalTicks,
      "Metrics sample interval",
    );
    if (
      this.tickDurationMs <= 0 ||
      this.maximumOfflineTicks <= 0 ||
      this.maximumEventsPerTick <= 0 ||
      this.metricsWindowTicks <= 0 ||
      this.metricsSampleIntervalTicks <= 0
    ) {
      throw new RangeError("Simulation timing values are out of range");
    }

    this.systems = new Map(
      configuration.systems.map((system) => [system.id, system]),
    );
    if (this.systems.size !== configuration.systems.length) {
      throw new Error("System IDs must be unique");
    }
    const configuredSystemIds = new Set(this.systems.keys());
    const configuredResourceIds = new Set(
      [
        ...configuration.systems,
        ...(configuration.commandHandlers ?? []),
        ...(configuration.eventHandlers ?? []),
      ].flatMap((participant) => [
        ...participant.reads,
        ...participant.writes,
      ]),
    );
    const configuredEventTypes = new Set(
      [
        ...configuration.systems.flatMap((system) => [
          ...system.eventReads,
          ...system.emits,
        ]),
        ...(configuration.commandHandlers ?? []).flatMap((handler) => [
          ...handler.eventReads,
          ...handler.emits,
        ]),
        ...(configuration.eventHandlers ?? []).flatMap((handler) => [
          handler.eventType,
          ...handler.emits,
        ]),
      ],
    );
    for (const model of this.analyticalModels) {
      const covered = new Set(model.coveredSystems);
      const coveredResources = new Set(model.coveredResources);
      const coveredEvents = new Set(model.coveredEvents);
      if (
        covered.size !== configuredSystemIds.size ||
        [...configuredSystemIds].some((id) => !covered.has(id))
      ) {
        throw new Error(
          `Analytical model ${model.id} must cover every configured system`,
        );
      }
      if (
        coveredResources.size !== configuredResourceIds.size ||
        [...configuredResourceIds].some(
          (id) => !coveredResources.has(id),
        )
      ) {
        throw new Error(
          `Analytical model ${model.id} must cover every accessed resource`,
        );
      }
      if (
        coveredEvents.size !== configuredEventTypes.size ||
        [...configuredEventTypes].some((type) => !coveredEvents.has(type))
      ) {
        throw new Error(
          `Analytical model ${model.id} must cover every system event`,
        );
      }
    }
    this.executionPlan = buildExecutionPlan(
      configuration.systems,
      configuration.pipelines,
    );
    for (const system of configuration.systems) {
      this.systemAccess.set(system.id, this.prepareAccess({
        owner: system.id,
        reads: system.reads,
        writes: system.writes,
        stateReads: system.stateReads,
        eventReads: system.eventReads,
        emits: system.emits,
      }));
    }
    this.executionStages = this.executionPlan.stages.map((stage) => {
      const run = stage.systems.map((system) => {
        const access = this.systemAccess.get(system.id);
        if (access === undefined) throw new Error(`Missing access declaration for ${system.id}`);
        return { system, access };
      });
      const commitOrder = run.map((_, index) => index)
        .sort((left, right) => run[left]!.system.id.localeCompare(run[right]!.system.id));
      return { run, commitOrder };
    });

    for (const handler of configuration.commandHandlers ?? []) {
      if (this.commandHandlers.has(handler.type)) {
        throw new Error(`Duplicate command handler for ${handler.type}`);
      }
      this.commandHandlers.set(handler.type, handler);
    }

    const handlersByEvent = new Map<string, EventHandler[]>();
    for (const handler of configuration.eventHandlers ?? []) {
      const handlers = handlersByEvent.get(handler.eventType) ?? [];
      handlers.push(handler);
      handlersByEvent.set(handler.eventType, handlers);
    }
    this.validateEventHandlerGraph(handlersByEvent);
    for (const [eventType, handlers] of handlersByEvent) {
      this.eventHandlers.set(
        eventType,
        handlers.sort((left, right) => left.id.localeCompare(right.id)),
      );
    }

    if (snapshot === undefined) {
      this.resourceRegistry = new ResourceRegistry(
        configuration.resources,
        configuration.initialResources,
      );
      for (const system of configuration.systems) {
        this.systemStates.set(
          system.id,
          deepFreeze(cloneJson(system.initialState())) as JsonValue,
        );
      }
    } else {
      this.validateSnapshot(snapshot);
      this.resourceRegistry = new ResourceRegistry(
        configuration.resources,
        snapshot.resources,
      );
      this.currentTick = simTick(snapshot.tick);
      this.scaledTimeRemainder = snapshot.scaledTimeRemainder;
      this.nextEventSequence = snapshot.nextEventSequence;
      this.queuedCommands.push(...snapshot.queuedCommands.map(cloneJson));
      this.pendingEvents.push(
        ...snapshot.pendingEvents.map((event) => ({
          ...cloneJson(event),
          delivery: event.delivery ?? "nextTick" as const,
        })),
      );
      this.durableEvents.push(
        ...(snapshot.durableEvents ?? []).map((event) => ({
          ...cloneJson(event),
          delivery: "durable" as const,
        })),
      );
      this.importantEvents = (snapshot.importantEvents ?? []).map(cloneJson);

      for (const system of configuration.systems) {
        const state = snapshot.systemStates[system.id];
        if (state === undefined) {
          throw new Error(`Snapshot has no state for system ${system.id}`);
        }
        this.systemStates.set(
          system.id,
          deepFreeze(cloneJson(state)) as JsonValue,
        );
      }
    }
  }

  public get tick(): SimTick {
    return this.currentTick;
  }

  public get timeRemainder(): number {
    return this.scaledTimeRemainder;
  }

  public get plan(): ExecutionPlan {
    return this.executionPlan;
  }

  public get resources() {
    return this.resourceRegistry.view();
  }

  public get events(): readonly DomainEvent[] {
    return this.currentEvents;
  }

  public getImportantEvents(): readonly DomainEvent[] {
    return this.importantEvents;
  }

  public getRecentSystemMetrics(): readonly SystemExecutionMetric[] {
    return this.systemMetrics;
  }

  public enableResourceFlowTelemetry(): void {
    if (this.resourceProduced !== null) return;
    this.resourceProduced = new Map();
    this.resourceConsumed = new Map();
  }

  public getResourceFlowTotals(): ResourceFlowTotals | null {
    if (this.resourceProduced === null || this.resourceConsumed === null) return null;
    return {
      produced: Object.fromEntries(this.resourceProduced),
      consumed: Object.fromEntries(this.resourceConsumed),
      discontinuities: this.flowDiscontinuities,
    };
  }

  public getState<State extends JsonValue>(
    id: SystemId,
  ): DeepReadonly<State> {
    const state = this.systemStates.get(id);
    if (state === undefined) {
      throw new Error(`Unknown system state: ${id}`);
    }
    return state as DeepReadonly<State>;
  }

  public dispatch(command: GameCommand): void {
    if (this.queuedCommands.some((queued) => queued.id === command.id)) {
      throw new Error(`Duplicate queued command ID: ${command.id}`);
    }
    this.queuedCommands.push(cloneJson(command));
    this.queuedCommands.sort((left, right) =>
      left.issuedAt - right.issuedAt || left.id.localeCompare(right.id),
    );
  }

  public runTick(): TickResult {
    const journal = this.createJournal();
    this.activeJournal = journal;
    try {
      const result = this.executeTick();
      this.lastTickWasQuiescent = this.isJournalQuiescent(journal, result);
      if (this.resourceProduced !== null && this.resourceConsumed !== null) {
        for (const [resource, amount] of journal.resourceProduced ?? []) {
          this.resourceProduced.set(resource, (this.resourceProduced.get(resource) ?? 0) + amount);
        }
        for (const [resource, amount] of journal.resourceConsumed ?? []) {
          this.resourceConsumed.set(resource, (this.resourceConsumed.get(resource) ?? 0) + amount);
        }
      }
      this.activeJournal = undefined;
      return result;
    } catch (error) {
      this.rollbackJournal(journal);
      this.lastTickWasQuiescent = false;
      this.activeJournal = undefined;
      throw error;
    }
  }

  private executeTick(): TickResult {
    const tick = simTick(this.currentTick + 1);
    this.currentEvents = [...this.pendingEvents, ...this.durableEvents];
    this.rebuildEventIndex();
    this.emittedEvents = [...this.currentEvents];
    this.pendingEvents = [];
    this.durableEvents = [...this.durableEvents];
    this.activeJournal?.resourceChanges.push(
      ...this.resourceRegistry.resetTickResources(),
    );
    const commandResults = this.processCommands(tick);
    const tickMetrics: SystemExecutionMetric[] = [];
    const collectMetrics =
      tick % this.metricsSampleIntervalTicks === 0;

    for (const stage of this.executionStages) {
      const updates = stage.run.map(({ system, access }) => ({
        system,
        access,
        update: system.run(
          this.createView(tick, access),
          this.createContext(tick, system.id),
        ),
      }));

      for (const index of stage.commitOrder) {
        const entry = updates[index];
        if (entry === undefined) throw new Error("Execution stage lost a system");
        const { system, access, update } = entry;
        if (collectMetrics) {
          const resourceFlow = (update?.resources ?? []).reduce(
            (total, mutation) => total + Math.abs(mutation.amount),
            0,
          );
          tickMetrics.push({
            tick,
            systemId: system.id,
            pipelineId: system.pipeline,
            status:
              update?.telemetry?.status ??
              (update === undefined ? "idle" : "active"),
            throughput:
              update?.telemetry?.throughput ??
              (update?.resources ?? []).reduce(
                (total, mutation) =>
                  total + Math.max(0, mutation.amount),
                0,
              ),
            resourceFlow,
            eventsEmitted: update?.events?.length ?? 0,
            bottleneck: update?.telemetry?.bottleneck ?? null,
          });
        }
        this.commitUpdate(access, update, tick, "current");
      }
    }

    this.dispatchEvents(tick);
    if (collectMetrics) {
      this.recordSystemMetrics(tickMetrics);
    }
    const logged = [...this.emittedEvents, ...this.durableEvents, ...this.pendingEvents].filter((event) => {
      if (event.tick !== tick || !IMPORTANT_EVENT_TYPES.has(event.type)) return false;
      if (!THROTTLED_EVENT_TYPES.has(event.type)) return true;
      return !this.importantEvents.some((entry) =>
        entry.type === event.type && tick - entry.tick < 30);
    });
    if (logged.length > 0) this.importantEvents = [...this.importantEvents, ...logged].slice(-IMPORTANT_EVENT_LIMIT);
    this.currentTick = tick;
    return {
      commandResults,
      events: [...this.emittedEvents],
    };
  }

  public advanceTicks(ticks: number, collectEvents = true): AdvanceResult {
    assertSafeInteger(ticks, "Tick count");
    if (ticks < 0) {
      throw new RangeError("Tick count cannot be negative");
    }

    const commandResults: CommandResult[] = [];
    const events: DomainEvent[] = [];
    const eventCounts: Record<string, number> = {};
    for (let index = 0; index < ticks; index += 1) {
      const result = this.runTick();
      commandResults.push(...result.commandResults);
      for (const event of result.events) {
        eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
      }
      if (collectEvents) {
        events.push(...result.events);
      }
    }
    return {
      ticksProcessed: ticks,
      exactTicksProcessed: ticks,
      remainder: this.scaledTimeRemainder,
      commandResults,
      events,
      eventCounts,
      analyticalTicksSkipped: 0,
    };
  }

  public advanceRealTime(
    elapsedMilliseconds: number,
    speedPermille = 1_000,
  ): AdvanceResult {
    assertSafeInteger(elapsedMilliseconds, "Elapsed milliseconds");
    assertSafeInteger(speedPermille, "Speed permille");
    if (elapsedMilliseconds < 0 || speedPermille < 0) {
      throw new RangeError("Elapsed time and speed cannot be negative");
    }

    const scaledElapsed = elapsedMilliseconds * speedPermille;
    assertSafeInteger(scaledElapsed, "Scaled elapsed time");
    const threshold = this.tickDurationMs * 1_000;
    const available = this.scaledTimeRemainder + scaledElapsed;
    const ticks = Math.floor(available / threshold);
    this.scaledTimeRemainder = available % threshold;
    return this.advanceTicks(ticks);
  }

  public advanceOffline(
    wallClockSavedAt: number,
    wallClockNow: number,
  ): OfflineAdvanceResult {
    assertSafeInteger(wallClockSavedAt, "Saved wall-clock time");
    assertSafeInteger(wallClockNow, "Current wall-clock time");
    const elapsedMilliseconds = Math.max(0, wallClockNow - wallClockSavedAt);
    const threshold = this.tickDurationMs * 1_000;
    const requestedTicks = Math.floor(
      (this.scaledTimeRemainder + elapsedMilliseconds * 1_000) / threshold,
    );
    const ticks =
      this.offlineProgressPolicy === "truncate"
        ? Math.min(requestedTicks, this.maximumOfflineTicks)
        : requestedTicks;
    const discardedTicks = requestedTicks - ticks;
    this.scaledTimeRemainder =
      (this.scaledTimeRemainder + elapsedMilliseconds * 1_000) % threshold;
    const result = this.advanceOfflineTicks(ticks);

    return {
      ...result,
      elapsedMilliseconds,
      requestedTicks,
      discardedTicks,
      capped: discardedTicks > 0,
    };
  }

  public serialize(wallClockSavedAt: number): SimulationSnapshot {
    assertSafeInteger(wallClockSavedAt, "Save wall-clock time");
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      gameVersion: this.gameVersion,
      contentHash: this.contentHash,
      seed: this.seed,
      tick: this.currentTick,
      tickDurationMs: this.tickDurationMs,
      scaledTimeRemainder: this.scaledTimeRemainder,
      nextEventSequence: this.nextEventSequence,
      wallClockSavedAt,
      resources: this.resourceRegistry.serialize(),
      systemStates: Object.fromEntries(
        [...this.systemStates.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, state]) => [id, cloneJson(state)]),
      ),
      queuedCommands: this.queuedCommands.map(cloneJson),
      pendingEvents: this.pendingEvents.map(cloneJson),
      durableEvents: this.durableEvents.map(cloneJson),
      importantEvents: this.importantEvents.map(cloneJson),
    };
  }

  public static restore(
    configuration: SimulationConfiguration,
    snapshot: SimulationSnapshot,
  ): Simulation {
    return new Simulation(configuration, snapshot);
  }

  private processCommands(tick: SimTick): CommandResult[] {
    const due = this.queuedCommands.filter((command) => command.issuedAt <= tick);
    this.queuedCommands.splice(0, due.length);
    this.activeJournal?.removedCommands.push(...due);
    const results: CommandResult[] = [];

    for (const command of due) {
      const handler = this.commandHandlers.get(command.type);
      if (handler === undefined) {
        results.push({
          commandId: command.id,
          accepted: false,
          reason: `No handler registered for ${command.type}`,
        });
        continue;
      }

      try {
        const update = handler.handle(
          command,
          this.createView(tick, {
            owner: handler.id,
            reads: handler.reads,
            writes: handler.writes,
            stateReads: handler.stateReads,
            eventReads: handler.eventReads,
            emits: handler.emits,
          }),
          this.createContext(tick, handler.id),
        );
        this.commitUpdate(
          {
            owner: handler.id,
            reads: handler.reads,
            writes: handler.writes,
            stateReads: handler.stateReads,
            eventReads: handler.eventReads,
            emits: handler.emits,
          },
          update,
          tick,
          "current",
        );
        results.push({ commandId: command.id, accepted: true });
      } catch (error) {
        results.push({
          commandId: command.id,
          accepted: false,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  private dispatchEvents(tick: SimTick): void {
    const eventsToDispatch = [...this.currentEvents];
    for (const event of eventsToDispatch) {
      for (const handler of this.eventHandlers.get(event.type) ?? []) {
        const update = handler.handle(
          event,
          this.createView(tick, {
            owner: handler.id,
            reads: handler.reads,
            writes: handler.writes,
            stateReads: handler.stateReads,
            eventReads: [handler.eventType],
            emits: handler.emits,
          }),
          this.createContext(tick, handler.id),
        );
        this.commitUpdate(
          {
            owner: handler.id,
            reads: handler.reads,
            writes: handler.writes,
            stateReads: handler.stateReads,
            eventReads: [handler.eventType],
            emits: handler.emits,
          },
          update,
          tick,
          "next",
        );
      }
    }
  }

  private createView(
    tick: SimTick,
    access: AccessDeclaration,
  ): SimulationView {
    const prepared = this.prepareAccess(access);
    return {
      tick,
      resources: this.resourceRegistry.viewPrepared(prepared.allowedResources),
      events:
        prepared.eventTypes.size === 0
          ? []
          : [...prepared.eventTypes].flatMap(
              (type) => this.currentEventsByType.get(type) ?? [],
            ).sort((left, right) => left.sequence - right.sequence),
      getSystemState: <State extends JsonValue>(
        id: SystemId,
      ): DeepReadonly<State> => {
        if (!prepared.allowedStates.has(id)) {
          throw new Error(
            `System ${access.owner} attempted undeclared state read from ${id}`,
          );
        }
        const state = this.systemStates.get(id);
        if (state === undefined) {
          throw new Error(`Unknown system state: ${id}`);
        }
        return state as DeepReadonly<State>;
      },
    };
  }

  private prepareAccess(access: AccessDeclaration): PreparedAccess {
    if ("allowedWrites" in access) return access as PreparedAccess;
    return {
      ...access,
      allowedResources: new Set([...access.reads, ...access.writes]),
      allowedWrites: new Set(access.writes),
      allowedStates: new Set([access.owner, ...access.stateReads]),
      eventTypes: new Set(access.eventReads),
    };
  }

  private createContext(tick: SimTick, id: SystemId): SystemContext {
    return {
      tick,
      tickDurationMs: this.tickDurationMs,
      random: new DeterministicRandom(this.seed, tick, id),
    };
  }

  private commitUpdate(
    access: AccessDeclaration,
    update: SystemUpdate | undefined,
    tick: SimTick,
    eventTarget: "current" | "next",
  ): void {
    if (update === undefined) {
      return;
    }

    const allowed = this.prepareAccess(access).allowedWrites;
    const mutations = update.resources ?? [];
    for (const mutation of mutations) {
      if (!allowed.has(mutation.resource)) {
        throw new Error(
          `System ${access.owner} attempted undeclared write to ${mutation.resource}`,
        );
      }
    }

    const eventTypes = new Set(access.emits);
    for (const event of update.events ?? []) {
      if (!eventTypes.has(event.type)) {
        throw new Error(
          `System ${access.owner} attempted undeclared event ${event.type}`,
        );
      }
    }

    const acknowledgements = update.acknowledgedEventSequences ?? [];
    if (acknowledgements.length > 0) {
      const visibleDurable = new Map(
        this.currentEvents
          .filter(
            (event) =>
              event.delivery === "durable" &&
              access.eventReads.includes(event.type),
          )
          .map((event) => [event.sequence, event]),
      );
      for (const sequence of acknowledgements) {
        assertSafeInteger(sequence, "Acknowledged event sequence");
        if (!visibleDurable.has(sequence)) {
          throw new Error(
            `System ${access.owner} cannot acknowledge unavailable durable event ${sequence}`,
          );
        }
      }
    }

    let nextState: JsonValue | undefined;
    if (update.state !== undefined && update.statePatch !== undefined) {
      throw new Error(
        `System ${access.owner} returned both state and statePatch`,
      );
    }
    if (update.state !== undefined || update.statePatch !== undefined) {
      if (!this.systems.has(access.owner)) {
        throw new Error(
          `Non-system ${access.owner} cannot own persistent state`,
        );
      }
      if (update.state !== undefined) {
        nextState = deepFreeze(cloneJson(update.state)) as JsonValue;
      } else {
        const current = this.systemStates.get(access.owner);
        if (
          current === null ||
          typeof current !== "object" ||
          Array.isArray(current)
        ) {
          throw new Error(
            `System ${access.owner} cannot patch non-object state`,
          );
        }
        const patch = deepFreeze(cloneJson(update.statePatch ?? {}));
        nextState = Object.freeze({ ...current, ...patch }) as JsonValue;
      }
    }

    this.assertEventCapacity(update.events ?? [], eventTarget);
    this.activeJournal?.resourceChanges.push(
      ...this.resourceRegistry.applyTransaction(mutations),
    );
    if (this.activeJournal?.resourceProduced && this.activeJournal.resourceConsumed) {
      for (const mutation of mutations) {
        if (mutation.amount > 0) {
          const produced = this.activeJournal.resourceProduced;
          produced.set(mutation.resource, (produced.get(mutation.resource) ?? 0) + mutation.amount);
        } else if (mutation.amount < 0) {
          const consumed = this.activeJournal.resourceConsumed;
          consumed.set(mutation.resource, (consumed.get(mutation.resource) ?? 0) - mutation.amount);
        }
      }
    }
    if (nextState !== undefined) {
      if (!this.activeJournal?.previousStates.has(access.owner)) {
        const previous = this.systemStates.get(access.owner);
        if (previous !== undefined) {
          this.activeJournal?.previousStates.set(access.owner, previous);
        }
      }
      this.systemStates.set(access.owner, nextState);
    }
    if (acknowledgements.length > 0) {
      const acknowledged = new Set(acknowledgements);
      this.durableEvents = this.durableEvents.filter(
        (event) => !acknowledged.has(event.sequence),
      );
    }
    this.appendEvents(access.owner, update.events ?? [], tick, eventTarget);
  }

  private appendEvents(
    source: SystemId,
    drafts: readonly EventDraft[],
    tick: SimTick,
    target: "current" | "next",
  ): void {
    for (const draft of drafts) {
      const delivery: EventDelivery =
        draft.delivery ?? (target === "current" ? "sameTick" : "nextTick");
      const event: DomainEvent = {
        sequence: this.nextEventSequence,
        tick,
        sourceSystem: source,
        type: draft.type,
        payload: cloneJson(draft.payload),
        delivery,
      };
      if (delivery === "sameTick") {
        this.currentEvents.push(event);
        const indexed = this.currentEventsByType.get(event.type) ?? [];
        this.currentEventsByType.set(event.type, [...indexed, event]);
        this.emittedEvents.push(event);
      } else if (delivery === "nextTick") {
        this.pendingEvents.push(event);
      } else {
        this.durableEvents.push(event);
      }
      this.nextEventSequence += 1;
    }
  }

  private assertEventCapacity(
    drafts: readonly EventDraft[],
    target: "current" | "next",
  ): void {
    let sameTick = 0;
    let deferred = 0;
    for (const draft of drafts) {
      const delivery =
        draft.delivery ?? (target === "current" ? "sameTick" : "nextTick");
      if (delivery === "sameTick") {
        sameTick += 1;
      } else {
        deferred += 1;
      }
    }
    if (
      this.emittedEvents.length + sameTick > this.maximumEventsPerTick ||
      this.currentEvents.length + sameTick > this.maximumEventsPerTick ||
      this.pendingEvents.length +
        this.durableEvents.length +
        deferred >
        this.maximumEventsPerTick
    ) {
      throw new Error(
        `Event limit of ${this.maximumEventsPerTick} exceeded`,
      );
    }
  }

  private createJournal(): TickJournal {
    return {
      resourceChanges: [],
      ...(this.resourceProduced === null ? {} : {
        resourceProduced: new Map<ResourceId, number>(),
        resourceConsumed: new Map<ResourceId, number>(),
      }),
      previousStates: new Map(),
      removedCommands: [],
      previousCurrentEvents: this.currentEvents,
      previousPendingEvents: this.pendingEvents,
      previousDurableEvents: this.durableEvents,
      previousImportantEvents: this.importantEvents,
      previousEmittedEvents: this.emittedEvents,
      nextEventSequence: this.nextEventSequence,
    };
  }

  private rollbackJournal(journal: TickJournal): void {
    this.resourceRegistry.rollback(journal.resourceChanges);
    for (const [id, state] of journal.previousStates) {
      this.systemStates.set(id, state);
    }
    this.queuedCommands.push(...journal.removedCommands);
    this.queuedCommands.sort((left, right) =>
      left.issuedAt - right.issuedAt || left.id.localeCompare(right.id),
    );
    this.currentEvents = journal.previousCurrentEvents;
    this.rebuildEventIndex();
    this.pendingEvents = journal.previousPendingEvents;
    this.durableEvents = journal.previousDurableEvents;
    this.importantEvents = journal.previousImportantEvents;
    this.emittedEvents = journal.previousEmittedEvents;
    this.nextEventSequence = journal.nextEventSequence;
  }

  private advanceOfflineTicks(ticks: number): AdvanceResult {
    const commandResults: CommandResult[] = [];
    const eventCounts: Record<string, number> = {};
    let processed = 0;
    let skipped = 0;

    while (processed < ticks) {
      const result = this.runTick();
      processed += 1;
      commandResults.push(...result.commandResults);
      for (const event of result.events) {
        eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
      }

      if (this.lastTickWasQuiescent) {
        const remaining = ticks - processed;
        const nextCommand = this.queuedCommands[0];
        const untilCommand =
          nextCommand === undefined
            ? remaining
            : Math.max(0, nextCommand.issuedAt - this.currentTick - 1);
        const analytical = Math.min(remaining, untilCommand);
        this.currentTick = simTick(this.currentTick + analytical);
        if (analytical > 0) this.flowDiscontinuities += 1;
        processed += analytical;
        skipped += analytical;
      }

      const remaining = ticks - processed;
      const nextCommand = this.queuedCommands[0];
      const untilCommand =
        nextCommand === undefined
          ? remaining
          : Math.max(0, nextCommand.issuedAt - this.currentTick - 1);
      const analyticalLimit = Math.min(remaining, untilCommand);
      if (
        analyticalLimit > 0 &&
        this.pendingEvents.length === 0 &&
        this.durableEvents.length === 0
      ) {
        const advance = this.tryAnalyticalAdvance(analyticalLimit);
        if (advance !== undefined) {
          processed += advance.ticks;
          skipped += advance.ticks;
          for (const [type, count] of Object.entries(
            advance.eventCounts ?? {},
          )) {
            eventCounts[type] = (eventCounts[type] ?? 0) + count;
          }
        }
      }
    }

    return {
      ticksProcessed: processed,
      exactTicksProcessed: processed - skipped,
      remainder: this.scaledTimeRemainder,
      commandResults,
      events: [],
      eventCounts,
      analyticalTicksSkipped: skipped,
    };
  }

  private tryAnalyticalAdvance(
    maximumTicks: number,
  ): AnalyticalAdvance | undefined {
    const view: AnalyticalOfflineView = {
      tick: this.currentTick,
      resources: this.resourceRegistry.view(),
      getSystemState: <State extends JsonValue>(
        system: SystemId,
      ): DeepReadonly<State> => this.getState<State>(system),
    };
    for (const model of this.analyticalModels) {
      const advance = model.tryAdvance(view, maximumTicks);
      if (advance === undefined) {
        continue;
      }
      assertSafeInteger(advance.ticks, `${model.id} analytical ticks`);
      if (advance.ticks <= 0 || advance.ticks > maximumTicks) {
        throw new Error(
          `Analytical model ${model.id} returned invalid tick count ${advance.ticks}`,
        );
      }
      const sequenceCount =
        advance.eventSequencesConsumed ??
        Object.values(advance.eventCounts ?? {}).reduce(
          (total, count) => total + count,
          0,
        );
      assertSafeInteger(
        sequenceCount,
        `${model.id} analytical event sequence count`,
      );
      for (const [type, count] of Object.entries(
        advance.eventCounts ?? {},
      )) {
        assertSafeInteger(count, `${model.id} event count for ${type}`);
        if (count < 0) {
          throw new Error(
            `Analytical model ${model.id} returned a negative event count`,
          );
        }
      }

      const nextStates = new Map<SystemId, JsonValue>();
      for (const [rawId, patch] of Object.entries(
        advance.statePatches ?? {},
      )) {
        const id = systemId(rawId);
        const current = this.systemStates.get(id);
        if (
          current === undefined ||
          current === null ||
          typeof current !== "object" ||
          Array.isArray(current)
        ) {
          throw new Error(
            `Analytical model ${model.id} cannot patch state ${rawId}`,
          );
        }
        nextStates.set(
          id,
          Object.freeze({
            ...current,
            ...deepFreeze(cloneJson(patch)),
          }) as JsonValue,
        );
      }

      const previousTick = this.currentTick;
      const previousSequence = this.nextEventSequence;
      const previousStates = new Map<SystemId, JsonValue>();
      for (const id of nextStates.keys()) {
        const previous = this.systemStates.get(id);
        if (previous !== undefined) {
          previousStates.set(id, previous);
        }
      }
      const resourceChanges = this.resourceRegistry.applyTransaction(
        advance.resources ?? [],
      );
      for (const [id, state] of nextStates) {
        this.systemStates.set(id, state);
      }
      this.currentTick = simTick(this.currentTick + advance.ticks);
      this.nextEventSequence += sequenceCount;
      assertSafeInteger(
        this.nextEventSequence,
        `${model.id} next event sequence`,
      );
      const endpointView: AnalyticalOfflineView = {
        tick: this.currentTick,
        resources: this.resourceRegistry.view(),
        getSystemState: <State extends JsonValue>(
          system: SystemId,
        ): DeepReadonly<State> => this.getState<State>(system),
      };
      let invariantHolds: boolean;
      try {
        invariantHolds = model.invariant(endpointView);
      } catch (error) {
        this.resourceRegistry.rollback(resourceChanges);
        for (const [id, state] of previousStates) {
          this.systemStates.set(id, state);
        }
        this.currentTick = previousTick;
        this.nextEventSequence = previousSequence;
        throw error;
      }
      if (!invariantHolds) {
        this.resourceRegistry.rollback(resourceChanges);
        for (const [id, state] of previousStates) {
          this.systemStates.set(id, state);
        }
        this.currentTick = previousTick;
        this.nextEventSequence = previousSequence;
        return undefined;
      }
      this.flowDiscontinuities += 1;
      this.currentEvents = [];
      this.currentEventsByType = new Map();
      this.emittedEvents = [];
      this.lastTickWasQuiescent = false;
      return advance;
    }
    return undefined;
  }

  private isJournalQuiescent(
    journal: TickJournal,
    result: TickResult,
  ): boolean {
    if (
      result.events.length > 0 ||
      this.pendingEvents.length > 0 ||
      this.durableEvents.length > 0
    ) {
      return false;
    }

    const resourceNet = new Map<ResourceId, number>();
    for (const change of journal.resourceChanges) {
      resourceNet.set(
        change.resource,
        (resourceNet.get(change.resource) ?? 0) +
          change.next -
          change.previous,
      );
    }
    if ([...resourceNet.values()].some((amount) => amount !== 0)) {
      return false;
    }

    if (journal.previousStates.size > 0) {
      return false;
    }
    return true;
  }

  private rebuildEventIndex(): void {
    const index = new Map<string, DomainEvent[]>();
    for (const event of this.currentEvents) {
      const events = index.get(event.type) ?? [];
      events.push(event);
      index.set(event.type, events);
    }
    this.currentEventsByType = index;
  }

  private recordSystemMetrics(
    metrics: readonly SystemExecutionMetric[],
  ): void {
    this.systemMetrics.push(...metrics);
    const maximum = this.metricsWindowTicks * Math.max(1, this.systems.size);
    if (this.systemMetrics.length > maximum) {
      this.systemMetrics.splice(0, this.systemMetrics.length - maximum);
    }
  }

  private validateEventHandlerGraph(
    handlersByEvent: ReadonlyMap<string, readonly EventHandler[]>,
  ): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (eventType: string): void => {
      if (visited.has(eventType)) {
        return;
      }
      if (visiting.has(eventType)) {
        throw new Error(
          `Event handler graph contains a cycle at ${eventType}`,
        );
      }

      visiting.add(eventType);
      for (const handler of handlersByEvent.get(eventType) ?? []) {
        for (const emittedType of handler.emits) {
          if (handlersByEvent.has(emittedType)) {
            visit(emittedType);
          }
        }
      }
      visiting.delete(eventType);
      visited.add(eventType);
    };

    for (const eventType of handlersByEvent.keys()) {
      visit(eventType);
    }
  }

  private validateSnapshot(snapshot: SimulationSnapshot): void {
    if (
      snapshot.schemaVersion !== 2 &&
      snapshot.schemaVersion !== 3 &&
      snapshot.schemaVersion !== 4 &&
      snapshot.schemaVersion !== 5 &&
      snapshot.schemaVersion !== 6
    ) {
      throw new Error(`Unsupported snapshot schema ${snapshot.schemaVersion}`);
    }
    if (
      snapshot.seed !== this.seed ||
      snapshot.gameVersion !== this.gameVersion ||
      snapshot.contentHash !== this.contentHash
    ) {
      throw new Error("Snapshot does not match the simulation configuration");
    }
    if (snapshot.tickDurationMs !== this.tickDurationMs) {
      throw new Error("Snapshot tick duration does not match configuration");
    }
    assertSafeInteger(snapshot.tick, "Snapshot tick");
    assertSafeInteger(
      snapshot.scaledTimeRemainder,
      "Snapshot scaled-time remainder",
    );
  }
}
