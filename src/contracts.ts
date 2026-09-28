import type { DeterministicRandom } from "./random.js";
import type {
  ResourceMutation,
  ResourceView,
} from "./resources.js";
import type {
  DeepReadonly,
  JsonObject,
  JsonValue,
  PipelineId,
  ResourceId,
  SimTick,
  SystemId,
} from "./types.js";

export const SimulationPhase = {
  Organization: 50,
  Infrastructure: 100,
  Source: 200,
  Build: 300,
  Quality: 400,
  Runtime: 500,
  Economy: 600,
  Progression: 700,
  Automation: 750,
  Maintenance: 800,
  Crisis: 900,
} as const;

export interface GameCommand<P extends JsonValue = JsonValue> extends JsonObject {
  readonly id: string;
  readonly type: string;
  readonly issuedAt: SimTick;
  readonly payload: P;
}

export type EventDelivery = "sameTick" | "nextTick" | "durable";

export interface EventDraft<P extends JsonValue = JsonValue> extends JsonObject {
  readonly type: string;
  readonly payload: P;
  readonly delivery?: EventDelivery;
}

export interface DomainEvent<P extends JsonValue = JsonValue>
  extends EventDraft<P>, JsonObject {
  readonly sequence: number;
  readonly tick: SimTick;
  readonly sourceSystem: SystemId;
  readonly delivery?: EventDelivery;
}

export interface SystemUpdate<State extends JsonValue = JsonValue> {
  readonly resources?: readonly ResourceMutation[];
  readonly state?: State;
  readonly statePatch?: State extends JsonObject
    ? { readonly [Key in keyof State]?: State[Key] }
    : never;
  readonly events?: readonly EventDraft[];
  readonly acknowledgedEventSequences?: readonly number[];
  readonly telemetry?: SystemTelemetry;
}

export interface SystemTelemetry extends JsonObject {
  readonly status: "active" | "blocked" | "idle";
  readonly throughput?: number;
  readonly bottleneck?: string;
}

export interface SimulationView {
  readonly tick: SimTick;
  readonly resources: ResourceView;
  readonly events: readonly DomainEvent[];
  getSystemState<State extends JsonValue>(system: SystemId): DeepReadonly<State>;
}

export interface SystemContext {
  readonly tick: SimTick;
  readonly tickDurationMs: number;
  readonly random: DeterministicRandom;
}

export interface SimulationSystem<State extends JsonValue = JsonValue> {
  readonly id: SystemId;
  readonly pipeline: PipelineId;
  readonly phase: number;
  readonly dependsOn: readonly SystemId[];
  readonly reads: readonly ResourceId[];
  readonly writes: readonly ResourceId[];
  readonly stateReads: readonly SystemId[];
  readonly eventReads: readonly string[];
  readonly emits: readonly string[];
  initialState(): State;
  run(
    view: SimulationView,
    context: SystemContext,
  ): SystemUpdate<State> | undefined;
}

export interface CommandHandler<P extends JsonValue = JsonValue> {
  readonly type: string;
  readonly id: SystemId;
  readonly reads: readonly ResourceId[];
  readonly writes: readonly ResourceId[];
  readonly stateReads: readonly SystemId[];
  readonly eventReads: readonly string[];
  readonly emits: readonly string[];
  handle(
    command: GameCommand<P>,
    view: SimulationView,
    context: SystemContext,
  ): SystemUpdate | undefined;
}

export interface EventHandler<P extends JsonValue = JsonValue> {
  readonly id: SystemId;
  readonly eventType: string;
  readonly reads: readonly ResourceId[];
  readonly writes: readonly ResourceId[];
  readonly stateReads: readonly SystemId[];
  readonly emits: readonly string[];
  handle(
    event: DomainEvent<P>,
    view: SimulationView,
    context: SystemContext,
  ): SystemUpdate | undefined;
}

export interface CommandResult {
  readonly commandId: string;
  readonly accepted: boolean;
  readonly reason?: string;
}
