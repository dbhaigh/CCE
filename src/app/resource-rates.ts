export interface ResourceReading {
  readonly id: string;
  readonly amount: number;
}

export interface ResourceRates {
  readonly windowTicks: number;
  readonly perTick: Readonly<Record<string, number>>;
  readonly producedPerTick: Readonly<Record<string, number | null>>;
  readonly consumedPerTick: Readonly<Record<string, number | null>>;
}

export class ResourceRateSampler {
  private previousTick: number | null = null;
  private previous = new Map<string, number>();
  private previousFlow: ResourceFlowTotals | null = null;
  private latest: ResourceRates = { windowTicks: 0, perTick: {}, producedPerTick: {}, consumedPerTick: {} };

  public sample(tick: number, resources: readonly ResourceReading[], flow: ResourceFlowTotals | null = null): ResourceRates {
    if (this.previousTick !== null && tick === this.previousTick) return this.latest;
    const windowTicks = this.previousTick !== null && tick > this.previousTick
      ? tick - this.previousTick : 0;
    const perTick: Record<string, number> = {};
    const producedPerTick: Record<string, number | null> = {};
    const consumedPerTick: Record<string, number | null> = {};
    const exactFlow = windowTicks > 0 && flow !== null && this.previousFlow !== null &&
      flow.discontinuities === this.previousFlow.discontinuities;
    for (const resource of resources) {
      const before = this.previous.get(resource.id);
      perTick[resource.id] = before === undefined || windowTicks === 0
        ? 0 : (resource.amount - before) / windowTicks;
      producedPerTick[resource.id] = exactFlow
        ? ((flow.produced[resource.id] ?? 0) - (this.previousFlow?.produced[resource.id] ?? 0)) / windowTicks
        : null;
      consumedPerTick[resource.id] = exactFlow
        ? ((flow.consumed[resource.id] ?? 0) - (this.previousFlow?.consumed[resource.id] ?? 0)) / windowTicks
        : null;
    }
    this.previousTick = tick;
    this.previous = new Map(resources.map(({ id, amount }) => [id, amount]));
    this.previousFlow = flow;
    this.latest = { windowTicks, perTick, producedPerTick, consumedPerTick };
    return this.latest;
  }
}
import type { ResourceFlowTotals } from "../simulation/index.js";
