import type {
  AnalyticalOfflineModel,
  AnalyticalOfflineView,
} from "./simulation.js";
import type { ResourceMutation } from "./resources.js";
import {
  type JsonObject,
  type SystemId,
  assertSafeInteger,
} from "./types.js";

export interface FixedRateStateCounter {
  readonly system: SystemId;
  readonly field: string;
  readonly amountPerTick: number;
}

export interface FixedRateAnalyticalOptions {
  readonly id: string;
  readonly coveredSystems: readonly SystemId[];
  readonly coveredResources: AnalyticalOfflineModel["coveredResources"];
  readonly coveredEvents: readonly string[];
  readonly invariant: (view: AnalyticalOfflineView) => boolean;
  readonly isApplicable: (view: AnalyticalOfflineView) => boolean;
  readonly resourceRates?: readonly ResourceMutation[];
  readonly stateCounters?: readonly FixedRateStateCounter[];
  readonly eventRates?: Readonly<Record<string, number>>;
  readonly maximumBatchTicks?: number;
}

export function createFixedRateAnalyticalModel(
  options: FixedRateAnalyticalOptions,
): AnalyticalOfflineModel {
  for (const rate of options.resourceRates ?? []) {
    assertSafeInteger(rate.amount, `Resource rate for ${rate.resource}`);
  }
  for (const counter of options.stateCounters ?? []) {
    assertSafeInteger(
      counter.amountPerTick,
      `State rate for ${counter.system}.${counter.field}`,
    );
  }
  for (const [type, rate] of Object.entries(options.eventRates ?? {})) {
    assertSafeInteger(rate, `Event rate for ${type}`);
    if (rate < 0) {
      throw new Error(`Event rate for ${type} cannot be negative`);
    }
  }
  if (options.maximumBatchTicks !== undefined) {
    assertSafeInteger(options.maximumBatchTicks, "Maximum analytical batch");
    if (options.maximumBatchTicks <= 0) {
      throw new Error("Maximum analytical batch must be positive");
    }
  }

  return {
    id: options.id,
    coveredSystems: options.coveredSystems,
    coveredResources: options.coveredResources,
    coveredEvents: options.coveredEvents,
    invariant: options.invariant,
    tryAdvance: (view, maximumTicks) => {
      if (!options.isApplicable(view)) {
        return undefined;
      }
      const ticks = Math.min(
        maximumTicks,
        options.maximumBatchTicks ?? maximumTicks,
      );
      const statePatches: Record<string, JsonObject> = {};
      for (const counter of options.stateCounters ?? []) {
        const state = view.getSystemState<JsonObject>(counter.system);
        const current = state[counter.field];
        if (typeof current !== "number" || !Number.isSafeInteger(current)) {
          throw new Error(
            `Fixed-rate counter ${counter.system}.${counter.field} is not a safe integer`,
          );
        }
        const next = current + counter.amountPerTick * ticks;
        assertSafeInteger(
          next,
          `Fixed-rate counter ${counter.system}.${counter.field}`,
        );
        statePatches[counter.system] = {
          ...(statePatches[counter.system] ?? {}),
          [counter.field]: next,
        };
      }
      const resources = (options.resourceRates ?? []).map((rate) => {
        const amount = rate.amount * ticks;
        assertSafeInteger(amount, `Analytical mutation for ${rate.resource}`);
        return { ...rate, amount };
      });
      const eventCounts = Object.fromEntries(
        Object.entries(options.eventRates ?? {}).map(([type, rate]) => {
          const count = rate * ticks;
          assertSafeInteger(count, `Analytical event count for ${type}`);
          return [type, count];
        }),
      );
      return { ticks, resources, statePatches, eventCounts };
    },
  };
}
