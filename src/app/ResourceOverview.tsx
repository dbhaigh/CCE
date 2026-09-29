import { Activity, ArrowRight, Gauge, TrendingDown, TrendingUp } from "lucide-react";
import React, { memo } from "react";
import { Resources } from "../simulation/index.js";
import { debtPressureStatus } from "./debt-pressure.js";
import { SimulationStore, useSimulationSelector } from "./simulation-store.js";

const groups = [
  { name: "Production flow", note: "Requested work, capacity and pipeline stock", ids: [Resources.Demand, Resources.Compute, Resources.Source, Resources.Binaries, Resources.Releases, Resources.HotDeployRequests] },
  { name: "Economy & discovery", note: "Operating runway and discoveries", ids: [Resources.Money, Resources.Insight, Resources.Knowledge, Resources.AutomationPower] },
  { name: "Reliability", note: "Accumulated risk and current signals", ids: [Resources.TechnicalDebt, Resources.Bugs, Resources.Incidents, Resources.CrisisSeverity, Resources.AgentInstability, Resources.Reputation, Resources.TestConfidence] },
  { name: "Capacity & policy signals", note: "Ephemeral values recalculated each tick", ids: [
    Resources.HumanCapacity, Resources.AgentCapacity, Resources.MaintenanceCapacity,
    Resources.ResponseCapacity, Resources.PolicyStrength, Resources.CodingStandards,
    Resources.RiskTolerance, Resources.ReleaseCadence, Resources.Morale, Resources.AgentAutonomy,
    Resources.VerificationSkill, Resources.OperationsSkill, Resources.ResearchSkill,
  ] },
] as const;

const percentageSignals = new Set<string>([
  Resources.PolicyStrength, Resources.CodingStandards, Resources.RiskTolerance,
  Resources.ReleaseCadence, Resources.Morale, Resources.AgentAutonomy,
  Resources.VerificationSkill, Resources.OperationsSkill, Resources.ResearchSkill,
  Resources.TestConfidence, Resources.Reputation,
]);

function unit(id: string): string {
  if (id === Resources.Money) return "credits";
  if (id === Resources.TechnicalDebt) return "debt units";
  if (id === Resources.Compute) return "compute";
  if (percentageSignals.has(id)) return "%";
  return "units";
}

function formatted(value: number, id: string): string {
  return (percentageSignals.has(id) ? value / 10 : value).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

const ResourceCard = memo(function ResourceCard({ store, id }: { store: SimulationStore; id: string }) {
  const amount = useSimulationSelector(store, (state) =>
    state.view?.resources.find((item) => item.id === id)?.amount ?? 0);
  const rate = useSimulationSelector(store, (state) =>
    state.view?.resources.find((item) => item.id === id)?.ratePerTick ?? 0);
  const produced = useSimulationSelector(store, (state) =>
    state.view?.resources.find((item) => item.id === id)?.producedPerTick ?? null);
  const consumed = useSimulationSelector(store, (state) =>
    state.view?.resources.find((item) => item.id === id)?.consumedPerTick ?? null);
  const name = useSimulationSelector(store, (state) =>
    state.view?.resources.find((item) => item.id === id)?.displayName ?? id);
  const hasRates = useSimulationSelector(store, (state) => (state.view?.resourceRateWindowTicks ?? 0) > 0);
  const negative = rate < 0;
  const dangerous = id === Resources.TechnicalDebt || id === Resources.Bugs ||
    id === Resources.Incidents || id === Resources.AgentInstability;
  const rateTone = rate === 0 ? "text-slate-500" : (negative !== dangerous ? "text-rose-300" : "text-emerald-300");
  return <article className="rounded-xl border border-slate-700/70 bg-[#111d2a] px-4 py-3">
    <h4 className="truncate text-xs font-medium uppercase tracking-[.12em] text-slate-400" title={name}>{name}</h4>
    <p className="mt-2 text-xl font-semibold tabular-nums text-slate-50">
      {formatted(amount, id)} <span className="text-xs font-normal text-slate-400">{unit(id)}</span>
    </p>
    <p className={`mt-2 flex items-center gap-1 text-xs tabular-nums ${rateTone}`}
      aria-label={`${name} net balance change ${rate >= 0 ? "plus " : "minus "}${formatted(Math.abs(rate), id)} ${unit(id)} per tick`}>
      {rate > 0 ? <TrendingUp size={13} aria-hidden /> : rate < 0 ? <TrendingDown size={13} aria-hidden /> : <Activity size={13} aria-hidden />}
      {!hasRates ? "Awaiting first tick" : `Net ${rate > 0 ? "+" : rate < 0 ? "−" : ""}${formatted(Math.abs(rate), id)} / tick`}
    </p>
    {produced !== null && consumed !== null
      ? <p className="mt-1 text-xs tabular-nums text-slate-400"
        aria-label={`${name} produced ${formatted(produced, id)} and consumed ${formatted(consumed, id)} ${unit(id)} per tick; resets excluded`}>
        In +{formatted(produced, id)} · Out −{formatted(consumed, id)} / tick
      </p>
      : <p className="mt-1 text-xs text-slate-500">Gross flow awaiting exact sample</p>}
  </article>;
});

function DebtPressure({ store }: { store: SimulationStore }) {
  const debt = useSimulationSelector(store, (state) => state.view?.diagnostics.debt);
  const netDebtPerTick = useSimulationSelector(store, (state) =>
    state.view?.resources.find((item) => item.id === Resources.TechnicalDebt)?.ratePerTick ?? 0);
  const sampledTicks = useSimulationSelector(store, (state) => state.view?.resourceRateWindowTicks ?? 0);
  if (!debt) return null;
  const pressure = debtPressureStatus(debt, netDebtPerTick, sampledTicks);
  const tone = pressure.level === "stalled" || pressure.level === "growing"
    ? "border-rose-500/40 bg-rose-950/30 text-rose-200"
    : pressure.level === "balanced" || pressure.level === "monitoring"
      ? "border-amber-500/40 bg-amber-950/30 text-amber-200"
      : "border-emerald-500/30 bg-emerald-950/20 text-emerald-200";
  const interest = debt.heatmap.reduce((total, category) => total + category.interestPerTick, 0);
  return <div className={`rounded-xl border px-4 py-3 text-sm ${tone}`}>
    <div className="flex flex-wrap items-center justify-between gap-2 font-semibold">
      <span className="flex items-center gap-2"><Gauge size={17} aria-hidden /> Debt pressure: {pressure.level}</span>
      <span className="tabular-nums">{debt.total.toLocaleString()} debt · {interest.toLocaleString()} interest / tick</span>
    </div>
    <p className="mt-1 text-xs opacity-80">{pressure.detail}
      {debt.remediation && ` Last tick: ${debt.remediation.retired} retired of ${debt.remediation.debtBefore} outstanding; ${debt.remediation.availableCapacity} allocated capacity, ${debt.remediation.capacitySpent} spent; effective potential ${debt.remediation.maintainable}, funding cap ${debt.remediation.affordableDebt}.`}
    </p>
  </div>;
}

function Flow({ store }: { store: SimulationStore }) {
  const backlogs = useSimulationSelector(store, (state) => state.view?.backlogs);
  const market = useSimulationSelector(store, (state) => state.view?.market);
  const bottlenecks = useSimulationSelector(store, (state) =>
    state.view?.diagnostics.pipeline.rollingBottlenecks);
  return <div className="panel">
    <h3 className="text-sm font-semibold text-slate-100">Production path · actual queue depths</h3>
    {market && <p className="mt-2 text-xs text-slate-300">
      Unmet requests: {market.outstanding.toLocaleString()} / {market.capacity.toLocaleString()} ·
      {" "}{market.inFlight.toLocaleString()} units in the Source → build → test pipeline ·
      {" "}{market.unassigned.toLocaleString()} requests not yet in production.
      {" "}Last deployment satisfied {market.lastServed.toLocaleString()} requests and generated
      {" "}{market.lastReferrals.toLocaleString()} referrals; organic arrivals also add bounded demand each tick.
    </p>}
    <div className="mt-3 grid gap-2 sm:grid-cols-3">
      {backlogs?.filter((backlog) => backlog.id !== "demand").slice(0, 3).map((backlog, index) =>
        <div key={backlog.id} className="flex items-center gap-2 rounded-lg border border-slate-700/60 bg-[#0b1621] p-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-slate-400">{["Source → build", "Binaries → tests", "Releases → deploy"][index]}</p>
            <p className="mt-1 font-mono text-lg text-cyan-200">{backlog.units.toLocaleString()} <span className="text-xs text-slate-400">units</span></p>
            {backlog.cohorts !== null && <p className="text-xs text-slate-500">{backlog.cohorts} cohorts</p>}
          </div>
          {index < 2 && <ArrowRight size={15} className="shrink-0 text-cyan-600" aria-hidden />}
        </div>)}
    </div>
    {bottlenecks?.filter((item) => item.lastBottleneck && item.blockedTicks > 0).slice(0, 3).map((item) =>
      <p key={item.systemId} className="mt-2 text-xs text-amber-300">
        {item.systemId}: {item.lastBottleneck} ({item.blockedTicks} blocked sampled ticks)
      </p>)}
  </div>;
}

export function ResourceOverview({ store }: { store: SimulationStore }) {
  const ids = useSimulationSelector(store, (state) => state.resourceIds);
  return <section aria-label="Resource Overview" className="space-y-5">
    <div>
      <h2 className="heading">Resource overview</h2>
      <p className="muted">Live balances, net changes and measured production/consumption per simulated tick. Ephemeral resets are not consumption.</p>
    </div>
    <DebtPressure store={store} />
    <Flow store={store} />
    {groups.map((group) => <section key={group.name} aria-label={group.name}>
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-[.16em] text-cyan-300">{group.name}</h3>
        <span className="text-xs text-slate-500">{group.note}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {group.ids.filter((id) => ids.includes(id)).map((id) =>
          <ResourceCard key={id} store={store} id={id} />)}
      </div>
    </section>)}
  </section>;
}
