import type { SimulationDiagnostics } from "../simulation/index.js";

type Debt = SimulationDiagnostics["debt"];

export interface DebtPressureStatus {
  readonly level: "stable" | "monitoring" | "stalled" | "growing" | "balanced" | "improving";
  readonly detail: string;
}

export function debtPressureStatus(debt: Debt, netPerTick: number, sampledTicks: number): DebtPressureStatus {
  if (debt.total === 0) return { level: "stable", detail: "No outstanding debt." };
  const remediation = debt.remediation;
  if (remediation === null) {
    return { level: "monitoring", detail: "Awaiting the first maintenance tick." };
  }
  if (remediation.availableCapacity === 0) {
    return { level: "stalled", detail: "No maintenance capacity was allocated last tick." };
  }
  if (remediation.affordableDebt === 0) {
    return { level: "stalled", detail: "Maintenance was available, but credits could not fund debt retirement last tick." };
  }
  if (remediation.maintainable === 0) {
    return { level: "stalled", detail: "Maintenance was allocated, but effective output was below one debt unit last tick." };
  }
  if (remediation.retired === 0) {
    return { level: "stalled", detail: "Maintenance could not retire the observed debt last tick." };
  }
  if (sampledTicks === 0) {
    return { level: "monitoring", detail: "Retirement is active; awaiting a second worker sample for net trend." };
  }
  if (netPerTick > 0) {
    return { level: "growing", detail: `Despite retirement, net debt grew by ${netPerTick.toFixed(2)} units / tick across ${sampledTicks} sampled ticks.` };
  }
  if (netPerTick < 0) {
    return { level: "improving", detail: `Net debt fell by ${Math.abs(netPerTick).toFixed(2)} units / tick across ${sampledTicks} sampled ticks.` };
  }
  return { level: "balanced", detail: `New debt offset retirement across ${sampledTicks} sampled ticks.` };
}
