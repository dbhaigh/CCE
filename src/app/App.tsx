import * as Tabs from "@radix-ui/react-tabs";
import {
  Activity, Beaker, Blocks, Bot, BookOpen, CircleDollarSign, Clock3,
  FlaskConical, Gauge, GitBranch, LayoutDashboard, Save, Scale,
  Settings2, ShieldAlert, SlidersHorizontal, type LucideIcon,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { COMPILATION_SYSTEM_ID, Resources, type CrisisProtocol, type OrganizationPolicy } from "../simulation/index.js";
import { AgentsPanel, PolicyEditor } from "./AgentsPanel.js";
import { SAVE_SLOTS } from "./bridge.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { FirstRunIntro } from "./FirstRunIntro.js";
import { readPreferences } from "./preferences.js";
import { ResourceOverview } from "./ResourceOverview.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { MAX_SPEED_PERMILLE, SimulationStore, useSimulationSelector } from "./simulation-store.js";
import { useSimulationLoop } from "./use-simulation-loop.js";

type Actions = ReturnType<typeof useSimulationLoop>;

const sections: readonly { value: string; label: string; icon: LucideIcon }[] = [
  { value: "overview", label: "Resource overview", icon: LayoutDashboard },
  { value: "agents", label: "Source & agents", icon: Bot },
  { value: "build", label: "Build & compilation", icon: Blocks },
  { value: "runtime", label: "Testing & runtime", icon: Beaker },
  { value: "debt", label: "Technical debt", icon: ShieldAlert },
  { value: "policy", label: "Policy", icon: SlidersHorizontal },
  { value: "research", label: "Research / insight", icon: BookOpen },
  { value: "settings", label: "Settings & saves", icon: Settings2 },
];

function policyPreset(base: OrganizationPolicy, preset: "careful" | "aggressive"): OrganizationPolicy {
  return preset === "careful"
    ? {
        ...base, maintenanceAllocationPermille: 650, reviewStrengthPermille: 900,
        testStrengthPermille: 900, codingStandardsPermille: 900,
        riskTolerancePermille: 100, releaseCadencePermille: 250,
      }
    : {
        ...base, aiAllocationPermille: 900, maintenanceAllocationPermille: 50,
        reviewStrengthPermille: 150, testStrengthPermille: 150,
        codingStandardsPermille: 200, riskTolerancePermille: 900,
        releaseCadencePermille: 900,
      };
}

function Header({ store, actions, onOpenSettings, playbackBlocked }: {
  store: SimulationStore; actions: Actions; onOpenSettings: () => void; playbackBlocked: boolean;
}) {
  const tick = useSimulationSelector(store, (state) => state.view?.tick);
  const speed = useSimulationSelector(store, (state) => state.speed);
  const ready = useSimulationSelector(store, (state) => state.ready);
  const recovery = useSimulationSelector(store, (state) => state.recovery);
  const last = useSimulationSelector(store, (state) => state.lastRunningSpeed);
  const blocked = !ready || playbackBlocked || recovery !== null;
  return <header className="mb-4 flex flex-wrap items-center justify-between gap-4 border-b border-slate-700/60 pb-4">
    <div className="min-w-0">
      <p className="font-mono text-[10px] font-bold uppercase tracking-[.25em] text-cyan-400">Empire control // simulation online</p>
      <h1 className="mt-1 text-xl font-bold tracking-tight text-white sm:text-2xl">Code Compiler Empire</h1>
      <p className="mt-1 flex items-center gap-2 font-mono text-xs text-slate-400"><Clock3 size={13} aria-hidden /> Tick {tick?.toLocaleString() ?? "—"} · {speed === 0 ? "Paused" : `${speed / 1_000}× playback`}</p>
    </div>
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Simulation playback and save">
      <button className="button" onClick={actions.togglePause} disabled={blocked}
        aria-label={speed === 0 ? "Resume simulation" : "Pause simulation"}>
        {speed === 0 ? `Resume ${last === MAX_SPEED_PERMILLE ? "Max" : `${last / 1_000}×`}` : "Pause"}
      </button>
      {([1_000, 2_000, 5_000, MAX_SPEED_PERMILLE] as const).map((value) =>
        <button key={value} className={`button ${speed === value ? "selected" : ""}`}
          aria-pressed={speed === value} onClick={() => actions.setSpeed(value)} disabled={blocked}>
          {value === MAX_SPEED_PERMILLE ? "Max 10×" : `${value / 1_000}×`}
        </button>)}
      <button className="button ml-1 flex items-center gap-1.5 border-cyan-700/70"
        type="button" onClick={onOpenSettings} title="Open manual save slots and settings">
        <Save size={14} aria-hidden /> Save / Settings
      </button>
    </div>
  </header>;
}

function Status({ store, onOpenSettings, preferenceError }: {
  store: SimulationStore; onOpenSettings: () => void; preferenceError: string | null;
}) {
  const notice = useSimulationSelector(store, (state) => state.notice);
  const progress = useSimulationSelector(store, (state) => state.progress);
  const offline = useSimulationSelector(store, (state) => state.offlineSummary);
  const recovery = useSimulationSelector(store, (state) => state.recovery);
  return <>
    {preferenceError && <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-600/70 bg-amber-950/40 px-3 py-2 text-xs" role="alert">
      <p className="min-w-0 break-words text-amber-100">Preferences need attention: {preferenceError}</p>
      <button className="button" type="button" onClick={onOpenSettings}>Open Settings to re-save preferences</button>
    </div>}
    {recovery && <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-600/70 bg-rose-950/40 px-3 py-2 text-xs" role="alert">
      <p className="min-w-0 break-words text-rose-100">Recovery needed: {recovery}</p>
      <button className="button" type="button" onClick={onOpenSettings}>Open recovery in Settings</button>
    </div>}
    <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cyan-900/50 bg-[#0e1c28] px-3 py-2 text-xs">
    <p role="status" className="flex items-center gap-2 text-cyan-100"><Activity size={14} aria-hidden /> {notice}</p>
    {progress ? <div role="status" className="flex min-w-52 items-center gap-2 text-slate-300">
      <span className="whitespace-nowrap">Catch-up {progress.processed.toLocaleString()} / {progress.total.toLocaleString()}</span>
      <progress className="w-24 accent-cyan-400" value={progress.processed} max={Math.max(1, progress.total)} />
    </div> : offline ? <span className="text-slate-400">Last offline: {offline.ticksProcessed.toLocaleString()} ticks{offline.capped ? ` · ${offline.discardedTicks.toLocaleString()} discarded` : ""}</span> : null}
    </div>
  </>;
}

function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return <div className="mb-5">
    <h2 className="heading">{title}</h2>
    <p className="muted">{subtitle}</p>
  </div>;
}

function CausalOverview({ store }: { store: SimulationStore }) {
  const view = useSimulationSelector(store, (state) => state.view);
  if (!view) return null;
  const resource = (id: string) => view.resources.find((item) => item.id === id);
  const source = resource(Resources.Source);
  const binaries = resource(Resources.Binaries);
  const releases = resource(Resources.Releases);
  const money = resource(Resources.Money);
  const reputation = resource(Resources.Reputation);
  const automation = resource(Resources.AutomationPower);
  const incidents = resource(Resources.Incidents);
  const rate = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const sampled = (produced: number | null | undefined, consumed: number | null | undefined) =>
    view.resourceRateWindowTicks > 0 && produced != null && consumed != null
      ? `In +${rate(produced)} · out −${rate(consumed)} / tick`
      : "Gross flow awaiting exact sample";
  const fundedPeople = view.diagnostics.productivity.teams.reduce((sum, team) => sum + team.fundedPeople, 0);
  const fundedAgents = view.diagnostics.productivity.swarms.reduce((sum, swarm) => sum + swarm.fundedAgents, 0);
  const queued = view.buildJobs.reduce((sum, job) => sum + job.remaining, 0);
  const interest = view.diagnostics.debt.heatmap.reduce((sum, category) => sum + category.interestPerTick, 0);
  const buildBottleneck = view.diagnostics.pipeline.rollingBottlenecks.find(
    (item) => item.systemId === COMPILATION_SYSTEM_ID && item.lastBottleneck);
  return <section aria-labelledby="causal-overview" className="panel">
    <h2 id="causal-overview" className="font-semibold text-cyan-100">Production links · observed</h2>
    <p className="mt-1 text-xs text-slate-400">
      Balances and last-run diagnostics are actual engine output. Gross flows are sampled over {view.resourceRateWindowTicks.toLocaleString()} ticks, not forecasts.
    </p>
    <ol className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <li className="rounded-lg border border-slate-700/70 bg-[#0c1823] p-3">
        <h3 className="text-sm font-medium text-cyan-200">People + agents → Source</h3>
        <p className="mt-2 text-xs text-slate-300">{fundedPeople.toLocaleString()} funded engineers · {fundedAgents.toLocaleString()} funded agents last tick</p>
        <p className="mt-1 text-xs text-slate-400">Source: {sampled(source?.producedPerTick, source?.consumedPerTick)}</p>
      </li>
      <li className="rounded-lg border border-slate-700/70 bg-[#0c1823] p-3">
        <h3 className="text-sm font-medium text-cyan-200">Source → compilation</h3>
        <p className="mt-2 text-xs text-slate-300">{(source?.amount ?? 0).toLocaleString()} Source in stock · {queued.toLocaleString()} Source units requested by manual jobs (not reserved)</p>
        <p className="mt-1 text-xs text-slate-400">Binaries: {sampled(binaries?.producedPerTick, binaries?.consumedPerTick)}</p>
        {view.buildLastRun && <p className="mt-1 text-xs text-slate-400">
          Last build used {view.buildLastRun.manualSource.toLocaleString()} queued + {view.buildLastRun.automaticSource.toLocaleString()} automatic Source.
        </p>}
      </li>
      <li className="rounded-lg border border-slate-700/70 bg-[#0c1823] p-3">
        <h3 className="text-sm font-medium text-cyan-200">Binaries → testing → release</h3>
        <p className="mt-2 text-xs text-slate-300">{(binaries?.amount ?? 0).toLocaleString()} binaries waiting · {(releases?.amount ?? 0).toLocaleString()} releases waiting</p>
        <p className="mt-1 text-xs text-slate-400">Releases: {sampled(releases?.producedPerTick, releases?.consumedPerTick)}</p>
      </li>
      <li className="rounded-lg border border-slate-700/70 bg-[#0c1823] p-3">
        <h3 className="text-sm font-medium text-cyan-200">Debt → maintenance & build</h3>
        <p className="mt-2 text-xs text-slate-300">{view.diagnostics.debt.total.toLocaleString()} principal · {interest.toLocaleString()} category interest / tick</p>
        <p className="mt-1 text-xs text-slate-400">Last maintenance: {view.diagnostics.debt.remediation?.retired.toLocaleString() ?? "—"} retired</p>
        {buildBottleneck && <p className="mt-1 text-xs text-amber-300">Observed build bottleneck: {buildBottleneck.lastBottleneck}</p>}
      </li>
      <li className="rounded-lg border border-slate-700/70 bg-[#0c1823] p-3">
        <h3 className="text-sm font-medium text-cyan-200">Releases → funds → automation</h3>
        <p className="mt-2 text-xs text-slate-300">{(money?.amount ?? 0).toLocaleString()} credits · {(reputation?.amount ?? 0).toLocaleString()} reputation · {(automation?.amount ?? 0).toLocaleString()} automation power</p>
        <p className="mt-1 text-xs text-slate-400">Money: {sampled(money?.producedPerTick, money?.consumedPerTick)}</p>
        <p className="mt-1 text-xs text-slate-400">Reputation: {sampled(reputation?.producedPerTick, reputation?.consumedPerTick)}</p>
        <p className="mt-1 text-xs text-slate-400">Automation: {sampled(automation?.producedPerTick, automation?.consumedPerTick)} · incidents {(incidents?.amount ?? 0).toLocaleString()} (net {rate(incidents?.ratePerTick ?? 0)} / tick)</p>
      </li>
    </ol>
  </section>;
}

function BuildQueue({ store, actions }: { store: SimulationStore; actions: Actions }) {
  const view = useSimulationSelector(store, (state) => state.view);
  const ready = useSimulationSelector(store, (state) => state.ready);
  const [quantity, setQuantity] = useState("12");
  const [sourceTeamId, setSourceTeamId] = useState("");
  if (!view) return null;
  const { buildJobs: jobs, buildLimits: limits } = view;
  const queued = jobs.reduce((total, job) => total + job.remaining, 0);
  const availableSlots = Math.max(0, limits.maxJobs - jobs.length);
  const remainingCapacity = Math.max(0, limits.maxQueuedUnits - queued);
  const maximumRequest = Math.min(limits.maxUnitsPerJob, remainingCapacity);
  const requested = Number(quantity);
  const valid = quantity.trim() !== "" && Number.isSafeInteger(requested) &&
    requested > 0 && requested <= maximumRequest && availableSlots > 0;
  const source = view.resources.find((item) => item.id === Resources.Source);
  const binaries = view.resources.find((item) => item.id === Resources.Binaries);
  return <div className="panel">
    <h3 className="flex items-center gap-2 font-semibold text-cyan-100"><Blocks size={17} aria-hidden /> Build queue</h3>
    <p className="muted">{jobs.length.toLocaleString()} / {limits.maxJobs.toLocaleString()} jobs · {queued.toLocaleString()} / {limits.maxQueuedUnits.toLocaleString()} units queued</p>
    <p className="mt-2 text-xs text-slate-400">
      Source available now: {(source?.amount ?? 0).toLocaleString()} · Binaries waiting: {(binaries?.amount ?? 0).toLocaleString()} / {limits.binaryBufferCapacity.toLocaleString()} buffer capacity.
      Queueing requests does not create or reserve Source; builds consume available Source when they run.
    </p>
    <p className="mt-2 text-xs text-slate-400">
      Up to {limits.sourcePerTick.toLocaleString()} Source / tick before compute, debt or buffer constraints.
    </p>
    {view.resourceRateWindowTicks > 0 && source?.producedPerTick != null && source.consumedPerTick != null &&
      <p className="mt-2 text-xs text-slate-400">
        Observed over {view.resourceRateWindowTicks.toLocaleString()} ticks: Source +{source.producedPerTick.toLocaleString(undefined, { maximumFractionDigits: 1 })}
        {" "}/ −{source.consumedPerTick.toLocaleString(undefined, { maximumFractionDigits: 1 })} per tick
        {binaries?.producedPerTick != null && binaries.consumedPerTick != null
          ? ` · Binaries +${binaries.producedPerTick.toLocaleString(undefined, { maximumFractionDigits: 1 })} / −${binaries.consumedPerTick.toLocaleString(undefined, { maximumFractionDigits: 1 })} per tick`
          : ""}.
      </p>}
    <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={(event) => {
      event.preventDefault();
      if (ready && valid) actions.command("build.start-job", {
        quantity: requested, sourceTeamId: sourceTeamId || null,
      });
    }}>
      <div className="min-w-40 flex-1">
        <label htmlFor="build-quantity" className="block text-xs text-slate-300">Requested Source units (1–{limits.maxUnitsPerJob})</label>
        <input id="build-quantity" type="number" min={1} max={Math.max(1, maximumRequest)} step={1} required
          className="mt-1 block w-full rounded-md border border-slate-600 bg-[#0c1823] px-3 py-2 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={!ready || maximumRequest === 0 || availableSlots === 0} />
      </div>
      <div className="min-w-40 flex-1">
        <label htmlFor="build-source-team" className="block text-xs text-slate-300">Producing team</label>
        <select id="build-source-team" value={sourceTeamId} disabled={!ready}
          onChange={(event) => setSourceTeamId(event.target.value)}>
          <option value="">Any Source (including agents)</option>
          {view.teams.map((team) => <option key={team.id} value={team.id}>{team.id}</option>)}
        </select>
      </div>
      <button className="button selected" type="submit" disabled={!ready || !valid}>Queue build</button>
    </form>
    {(availableSlots === 0 || remainingCapacity === 0) && <p className="mt-2 text-xs text-amber-300">
      {availableSlots === 0 ? "Job limit reached." : "Queued-unit limit reached."} Cancel or finish a job to make room.
    </p>}
    {jobs.length === 0 && <p className="muted">No manual build jobs queued. Automatic builds may still use available Source.</p>}
    <ol className="mt-4 space-y-2" aria-label="Build jobs, in priority order">
      {jobs.map((job, index) => <li key={job.id} className="rounded-lg border border-slate-700/70 bg-[#0c1823] p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 text-sm">
            <strong className="break-all text-slate-100">{job.id}</strong>
            <p className="text-xs text-slate-400">
              {job.remaining.toLocaleString()} / {job.requested.toLocaleString()} Source units remaining · queued tick {job.createdTick.toLocaleString()}
              {" "}· {job.sourceTeamId ?? "Any Source"}
            </p>
            <p className="text-xs text-slate-500">
              {(job.succeededUnits ?? 0).toLocaleString()} successful · {(job.failedUnits ?? 0).toLocaleString()} failed units processed
            </p>
          </div>
          <span className="font-mono text-xs text-cyan-200">#{index + 1}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={`Manage build job ${job.id}`}>
          <button className="button" disabled={!ready || index === 0}
            onClick={() => actions.command("build.reorder-job", { jobId: job.id, direction: -1 })}>Move up</button>
          <button className="button" disabled={!ready || index === jobs.length - 1}
            onClick={() => actions.command("build.reorder-job", { jobId: job.id, direction: 1 })}>Move down</button>
          <button className="button" disabled={!ready || index === 0}
            onClick={() => actions.command("build.prioritize-job", { jobId: job.id })}>Prioritize</button>
          <button className="button" disabled={!ready}
            onClick={() => actions.command("build.cancel-job", { jobId: job.id })}>Cancel</button>
        </div>
      </li>)}
    </ol>
    {view.buildLastRun && <p className="mt-4 border-t border-slate-700/70 pt-3 text-xs text-slate-300">
      Last run · tick {view.buildLastRun.tick.toLocaleString()}: {view.buildLastRun.manualSource.toLocaleString()} queued Source,
      {" "}{view.buildLastRun.automaticSource.toLocaleString()} automatic Source · {view.buildLastRun.computePerSource.toLocaleString()} compute / Source
      {view.buildLastRun.failed ? " · build failure recorded" : ""}
    </p>}
  </div>;
}

function BuildHardware({ store, actions }: { store: SimulationStore; actions: Actions }) {
  const view = useSimulationSelector(store, (state) => state.view);
  const ready = useSimulationSelector(store, (state) => state.ready);
  if (!view) return null;
  const selected = view.hardwareProfiles.find((profile) => profile.id === view.hardware);
  return <div className="panel">
    <h3 className="flex items-center gap-2 font-semibold text-cyan-100"><Gauge size={17} aria-hidden /> Build hardware</h3>
    <label className="mt-4 block text-xs text-slate-400" htmlFor="hardware">Active compute profile</label>
    <select id="hardware" disabled={!ready} value={view.hardware} onChange={(event) =>
      actions.command("build.select-hardware", { profileId: event.target.value })}>
      {view.hardwareProfiles.map((profile) => <option key={profile.id} value={profile.id}>
        {profile.id} · up to {profile.computePerTick} compute / tick · {profile.moneyPerTick} credits / tick
      </option>)}
    </select>
    {selected && <p className="muted">
      {selected.id}: up to {selected.computePerTick.toLocaleString()} compute per tick at {selected.moneyPerTick.toLocaleString()} credits per tick.
      Insufficient credits reduce provisioned compute.
    </p>}
    <p className="muted">Lifetime Source processed: {view.compiled.toLocaleString()} units (includes failed builds).</p>
  </div>;
}

function BuildDiagnostics({ store }: { store: SimulationStore }) {
  const view = useSimulationSelector(store, (state) => state.view);
  if (!view) return null;
  return <>
    <div className="panel">
      <h3 className="flex items-center gap-2 font-semibold text-cyan-100"><GitBranch size={17} aria-hidden /> Build stage executions</h3>
      {view.buildStages.map((stage) => <div className="mt-3 flex justify-between border-b border-slate-700/60 pb-2 text-sm" key={stage.id}>
        <span>{stage.id}<span className="ml-2 text-xs text-slate-500">{stage.dependsOn.length ? `after ${stage.dependsOn.join(", ")}` : "entry"}</span></span>
        <span className="font-mono text-cyan-200">{stage.executions.toLocaleString()}</span>
      </div>)}
    </div>
    <div className="panel xl:col-span-2">
      <h3 className="font-semibold text-cyan-100">Pipeline diagnostics</h3>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {view.diagnostics.pipeline.nodes.map((node) => {
          const metrics = view.diagnostics.pipeline.rollingBottlenecks.filter((item) => item.pipelineId === node.id);
          return <article key={node.id} className="rounded-lg border border-slate-700/70 bg-[#0c1823] p-3">
            <h4 className="text-sm font-medium text-slate-100">{node.label}</h4>
            <p className="text-xs text-slate-400">{node.systemIds.length} systems · {metrics.reduce((sum, metric) => sum + metric.throughput, 0).toLocaleString()} sampled throughput</p>
            {metrics.filter((metric) => metric.lastBottleneck).map((metric) =>
              <p key={metric.systemId} className="mt-1 text-xs text-amber-300">{metric.systemId}: {metric.lastBottleneck}</p>)}
          </article>;
        })}
      </div>
    </div>
  </>;
}

function BuildPanel({ store, actions }: { store: SimulationStore; actions: Actions }) {
  return <section>
    <SectionHeading title="Build & compilation" subtitle="Queue existing Source for compilation; inspect funded hardware, throughput and bottlenecks." />
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <BuildQueue store={store} actions={actions} />
      <BuildHardware store={store} actions={actions} />
      <BuildDiagnostics store={store} />
    </div>
  </section>;
}

function EventLog({ store }: { store: SimulationStore }) {
  const events = useSimulationSelector(store, (state) => state.view?.importantEvents);
  if (!events) return null;
  return <div className="panel">
    <h3 className="font-semibold text-cyan-100">Important events</h3>
    <p className="mt-1 text-xs text-slate-400">Engine-recorded milestones and incidents, newest first.</p>
    {events.length === 0 && <p className="muted">No important events recorded yet.</p>}
    <ol className="mt-3 max-h-96 space-y-2 overflow-y-auto" aria-label="Important simulation events">
      {[...events].reverse().map((event) => {
        const fields = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? Object.entries(event.payload).filter(([, value]) =>
            value === null || ["string", "number", "boolean"].includes(typeof value)).slice(0, 5)
          : [];
        return <li key={event.sequence} className="rounded-md border border-slate-700/70 bg-[#0c1823] p-2 text-xs">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <strong className="break-all text-slate-200">{event.type}</strong>
            <span className="shrink-0 font-mono text-slate-400">tick {event.tick.toLocaleString()}</span>
          </div>
          {fields.length > 0 && <p className="mt-1 break-words text-slate-400">
            {fields.map(([key, value]) => `${key}: ${String(value).slice(0, 80)}`).join(" · ")}
          </p>}
        </li>;
      })}
    </ol>
  </div>;
}

const crisisFields = [
  { key: "automaticResponsePermille", label: "Automatic response budget (0–1,000)", detail: "Response budget = floor(current credits × fraction / 1,000); actual containment also needs Response Capacity.", max: 1_000 },
  { key: "outageThreshold", label: "Outage incident threshold", detail: "At or above this incident balance, an outage episode opens.", max: 1_000_000 },
  { key: "debtThreshold", label: "Debt explosion threshold", detail: "At or above this total debt, a debt-explosion episode opens.", max: 1_000_000 },
  { key: "rebellionThreshold", label: "Swarm rebellion threshold", detail: "An episode opens when instability + autonomy − morale reaches this threshold.", max: 1_000_000 },
  { key: "shutdownAutomationAtSeverity", label: "Automation shutdown severity", detail: "At this active crisis severity, response can shut down automation power.", max: 1_000_000 },
] as const;

function CrisisProtocolEditor({ protocol, ready, actions }: {
  protocol: CrisisProtocol; ready: boolean; actions: Actions;
}) {
  const [draft, setDraft] = useState(() => ({
    automaticResponsePermille: String(protocol.automaticResponsePermille),
    outageThreshold: String(protocol.outageThreshold),
    debtThreshold: String(protocol.debtThreshold),
    rebellionThreshold: String(protocol.rebellionThreshold),
    shutdownAutomationAtSeverity: String(protocol.shutdownAutomationAtSeverity),
  }));
  const signature = crisisFields.map(({ key }) => protocol[key]).join(",");
  useEffect(() => {
    setDraft({
      automaticResponsePermille: String(protocol.automaticResponsePermille),
      outageThreshold: String(protocol.outageThreshold),
      debtThreshold: String(protocol.debtThreshold),
      rebellionThreshold: String(protocol.rebellionThreshold),
      shutdownAutomationAtSeverity: String(protocol.shutdownAutomationAtSeverity),
    });
  }, [signature]);
  const valid = crisisFields.every(({ key, max }) =>
    draft[key].trim() !== "" && Number.isSafeInteger(Number(draft[key])) &&
    Number(draft[key]) >= 0 && Number(draft[key]) <= max);
  const changed = crisisFields.some(({ key }) => draft[key] !== String(protocol[key]));
  return <details className="panel">
    <summary className="cursor-pointer font-semibold text-cyan-100">Crisis response protocol</summary>
    <form className="mt-4 space-y-3" onSubmit={(event) => {
      event.preventDefault();
      if (!ready || !valid || !changed) return;
      actions.command("crisis.set-protocol", { protocol: {
        automaticResponsePermille: Number(draft.automaticResponsePermille),
        outageThreshold: Number(draft.outageThreshold),
        debtThreshold: Number(draft.debtThreshold),
        rebellionThreshold: Number(draft.rebellionThreshold),
        shutdownAutomationAtSeverity: Number(draft.shutdownAutomationAtSeverity),
      } });
    }}>
      {crisisFields.map(({ key, label, detail, max }) =>
        <div key={key}>
          <label htmlFor={`crisis-${key}`} className="block text-xs text-slate-300">{label}</label>
          <input id={`crisis-${key}`} type="number" min={0} max={max} step={1} required
            className="mt-1 block w-full rounded-md border border-slate-600 bg-[#0c1823] px-3 py-2 text-sm text-slate-100"
            aria-describedby={`crisis-${key}-detail`}
            value={draft[key]} disabled={!ready}
            onChange={(event) => setDraft((previous) => ({ ...previous, [key]: event.target.value }))} />
          <p id={`crisis-${key}-detail`} className="mt-1 text-xs text-slate-500">{detail}</p>
        </div>)}
      <button className="button selected" type="submit" disabled={!ready || !valid || !changed}>Save response protocol</button>
    </form>
  </details>;
}

function RuntimePanel({ store, actions }: { store: SimulationStore; actions: Actions }) {
  const view = useSimulationSelector(store, (state) => state.view);
  const ready = useSimulationSelector(store, (state) => state.ready);
  if (!view) return null;
  const confidence = view.resources.find((item) => item.id === Resources.TestConfidence)?.amount ?? 0;
  const incidents = view.resources.find((item) => item.id === Resources.Incidents)?.amount ?? 0;
  return <section>
    <SectionHeading title="Testing & runtime" subtitle="Release strategy, test signal, deployment queue, and important engine events." />
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="panel">
        <h3 className="flex items-center gap-2 font-semibold text-cyan-100"><FlaskConical size={17} aria-hidden /> Quality & deployment</h3>
        <p className="muted">Test confidence: {confidence / 10}% · Incidents: {incidents.toLocaleString()}</p>
        <label className="mt-4 block text-xs text-slate-400" htmlFor="deployment">Deployment strategy</label>
        <select id="deployment" disabled={!ready} value={view.strategy} onChange={(event) =>
          actions.command("runtime.set-deployment-strategy", { strategy: event.target.value })}>
          {["rolling", "canary", "all-at-once", "hot"].map((name) =>
            <option key={name} value={name}>{name}</option>)}
        </select>
        {view.backlogs.slice(1).map((item) => <p key={item.id} className="mt-2 text-xs text-slate-400">
          {item.label}: <span className="font-mono text-slate-100">{item.units.toLocaleString()}</span> units
        </p>)}
      </div>
      <EventLog store={store} />
      <CrisisProtocolEditor protocol={view.crisisProtocol} ready={ready} actions={actions} />
    </div>
  </section>;
}

function MaintenanceAllocation({ store, actions }: { store: SimulationStore; actions: Actions }) {
  const policy = useSimulationSelector(store, (state) => state.view?.policy);
  const ready = useSimulationSelector(store, (state) => state.ready);
  if (!policy) return null;
  return <MaintenanceAllocationForm policy={policy} ready={ready} actions={actions} />;
}

function MaintenanceAllocationForm({ policy, ready, actions }: {
  policy: OrganizationPolicy; ready: boolean; actions: Actions;
}) {
  const [allocation, setAllocation] = useState(String(policy.maintenanceAllocationPermille));
  useEffect(() => { setAllocation(String(policy.maintenanceAllocationPermille)); }, [policy.maintenanceAllocationPermille]);
  const value = Number(allocation);
  const valid = allocation.trim() !== "" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000;
  return <form className="panel" onSubmit={(event) => {
    event.preventDefault();
    if (ready && valid) actions.command("organization.set-policy", {
      policy: { ...policy, maintenanceAllocationPermille: value },
    });
  }}>
    <h3 className="font-semibold text-cyan-100">Global maintenance allocation</h3>
    <p className="mt-1 text-xs text-slate-400">Reserve a share of team capacity for maintenance. Team overrides keep their own allocation.</p>
    <label className="mt-3 block text-xs text-slate-300" htmlFor="debt-maintenance-allocation">Allocation (0–1,000; 1,000 = 100%)</label>
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <input id="debt-maintenance-allocation" type="number" min={0} max={1_000} step={1} required
        className="min-w-32 flex-1 rounded-md border border-slate-600 bg-[#0c1823] px-3 py-2 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
        value={allocation} onChange={(event) => setAllocation(event.target.value)} disabled={!ready} />
      <button type="submit" className="button selected" disabled={!ready || !valid || value === policy.maintenanceAllocationPermille}>Update allocation</button>
    </div>
  </form>;
}

function DebtCategory({ category, ready, terms, money, knowledge, actions }: {
  category: { categoryId: string; principal: number; interestPerTick: number; sharePermille: number; maintenanceEfficiencyPermille: number };
  ready: boolean;
  terms: { debtPerMaintenanceCapacity: number; moneyPerDebtRetired: number };
  money: number;
  knowledge: number;
  actions: Actions;
}) {
  const [amount, setAmount] = useState("1");
  const requested = Number(amount);
  const affordable = terms.moneyPerDebtRetired === 0
    ? category.principal : Math.floor(money / terms.moneyPerDebtRetired);
  const maximum = Math.min(1_000, category.principal);
  const valid = amount.trim() !== "" && Number.isSafeInteger(requested) && requested > 0 && requested <= maximum;
  return <li className="mt-5" key={category.categoryId}>
    <div className="flex flex-wrap justify-between gap-1 text-sm">
      <strong>{category.categoryId}</strong>
      <span className="font-mono text-slate-400">{category.principal.toLocaleString()} debt · {category.interestPerTick.toLocaleString()} interest / tick · {category.sharePermille / 10}% of debt</span>
    </div>
    <div className="mt-2 h-2 rounded bg-slate-800" role="meter"
      aria-label={`${category.categoryId} share of technical debt`} aria-valuemin={0}
      aria-valuemax={100} aria-valuenow={category.sharePermille / 10}>
      <div className="h-2 rounded bg-amber-500" style={{ width: `${category.sharePermille / 10}%` }} />
    </div>
    <p className="mt-2 text-xs text-slate-400">
      Maintenance efficiency {(category.maintenanceEfficiencyPermille / 10).toFixed(0)}% ·
      {" "}{terms.moneyPerDebtRetired.toLocaleString()} credits / debt retired ·
      {" "}{terms.debtPerMaintenanceCapacity.toLocaleString()} base debt / maintenance capacity.
      Knowledge ({knowledge.toLocaleString()}) also affects efficiency. At the current balance,
      {" "}up to {affordable.toLocaleString()} debt units can be funded before other tick costs;
      actual retirement can be lower.
    </p>
    <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(event) => {
      event.preventDefault();
      if (ready && valid) actions.command("debt.pay-down", { categoryId: category.categoryId, amount: requested });
    }}>
      <div className="min-w-36 flex-1">
        <label className="block text-xs text-slate-300" htmlFor={`debt-${category.categoryId}`}>Debt units to retire</label>
        <input id={`debt-${category.categoryId}`} type="number" min={1} max={Math.max(1, maximum)} step={1} required
          className="mt-1 block w-full rounded-md border border-slate-600 bg-[#0c1823] px-3 py-2 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          value={amount} onChange={(event) => setAmount(event.target.value)} disabled={!ready || maximum === 0} />
      </div>
      <button className="button selected" type="submit" disabled={!ready || !valid}>Pay down</button>
    </form>
  </li>;
}

function DebtPanel({ store, actions }: { store: SimulationStore; actions: Actions }) {
  const view = useSimulationSelector(store, (state) => state.view);
  const ready = useSimulationSelector(store, (state) => state.ready);
  if (!view) return null;
  const debt = view.diagnostics.debt;
  const money = view.resources.find((item) => item.id === Resources.Money)?.amount ?? 0;
  const knowledge = view.resources.find((item) => item.id === Resources.Knowledge)?.amount ?? 0;
  return <section>
    <SectionHeading title="Technical debt" subtitle="Inspect actual remediation and direct available maintenance toward a specific category." />
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <div className="panel">
        <p className="font-mono text-sm text-amber-200">Principal {debt.total.toLocaleString()} · Peak {debt.peak.toLocaleString()} · Retired {debt.retired.toLocaleString()}</p>
        <p className="mt-2 text-xs text-slate-400">{money.toLocaleString()} credits available. Manual pay-down uses maintenance capacity and credits; the engine checks both when the command runs.</p>
        <ul>{debt.heatmap.map((category) => <DebtCategory key={category.categoryId}
          category={category} ready={ready} terms={view.debtTerms} money={money} knowledge={knowledge} actions={actions} />)}</ul>
      </div>
      <div className="space-y-4">
        <MaintenanceAllocation store={store} actions={actions} />
        <div className="panel">
          <h3 className="font-semibold text-cyan-100">Last maintenance tick</h3>
          {debt.remediation ? <div className="mt-2 space-y-1 text-xs text-slate-300">
            <p>{debt.remediation.retired.toLocaleString()} debt retired from {debt.remediation.debtBefore.toLocaleString()} principal</p>
            <p>{debt.remediation.capacitySpent.toLocaleString()} / {debt.remediation.availableCapacity.toLocaleString()} maintenance capacity spent</p>
            <p>{debt.remediation.maintainable.toLocaleString()} maintainable · {debt.remediation.affordableDebt.toLocaleString()} affordable debt units</p>
          </div> : <p className="muted">No remediation run yet.</p>}
        </div>
        {view.lastManualPaydown && <div className="panel">
          <h3 className="font-semibold text-cyan-100">Last manual pay-down</h3>
          <p className="mt-2 text-xs text-slate-300">
            Tick {view.lastManualPaydown.tick.toLocaleString()} · {view.lastManualPaydown.categoryId}: requested {view.lastManualPaydown.requested.toLocaleString()},
            {" "}retired {view.lastManualPaydown.retired.toLocaleString()} debt using {view.lastManualPaydown.capacitySpent.toLocaleString()} maintenance capacity
            {" "}and {view.lastManualPaydown.moneySpent.toLocaleString()} credits.
          </p>
        </div>}
      </div>
    </div>
  </section>;
}

function PolicyPanel({ store, actions }: { store: SimulationStore; actions: Actions }) {
  const policy = useSimulationSelector(store, (state) => state.view?.policy);
  const base = useSimulationSelector(store, (state) => state.view?.defaultPolicy);
  const ready = useSimulationSelector(store, (state) => state.ready);
  if (!policy || !base) return null;
  return <section>
    <SectionHeading title="Policy" subtitle="Apply a preset or set every governance field independently." />
    <div className="panel">
      <h3 className="flex items-center gap-2 font-semibold text-cyan-100"><Scale size={17} aria-hidden /> Engineering posture</h3>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {([
          { label: "Balanced", value: base },
          { label: "Careful", value: policyPreset(base, "careful") },
          { label: "Aggressive", value: policyPreset(base, "aggressive") },
        ] as const).map(({ label, value }) => <button key={label} className="button"
          disabled={!ready} onClick={() => actions.command("organization.set-policy", { policy: value })}>{label}</button>)}
      </div>
      <PolicyEditor id="global-policy" policy={policy} ready={ready}
        onSave={(value) => actions.command("organization.set-policy", { policy: value })} />
      <p className="mt-3 text-xs text-slate-400">Team overrides are edited on the Source & agents tab; global changes do not replace saved overrides.</p>
    </div>
  </section>;
}

function ResearchPanel({ store, actions }: { store: SimulationStore; actions: Actions }) {
  const view = useSimulationSelector(store, (state) => state.view);
  const ready = useSimulationSelector(store, (state) => state.ready);
  if (!view) return null;
  const insight = view.resources.find((item) => item.id === Resources.Insight)?.amount ?? 0;
  const knowledge = view.resources.find((item) => item.id === Resources.Knowledge)?.amount ?? 0;
  const money = view.resources.find((item) => item.id === Resources.Money)?.amount ?? 0;
  return <section>
    <SectionHeading title="Research / insight" subtitle="Existing project selection and actual progress towards knowledge rewards." />
    <div className="panel">
      <p className="flex items-center gap-2 font-mono text-sm text-cyan-200"><CircleDollarSign size={16} aria-hidden /> {insight.toLocaleString()} insight · {knowledge.toLocaleString()} knowledge</p>
      <label className="mt-4 block text-xs text-slate-400" htmlFor="research">Selected project · {view.completedProjects.length} completed</label>
      <select id="research" value={view.selectedProject ?? ""} disabled={!ready}
        onChange={(event) => actions.command("research.select-project", { projectId: event.target.value })}>
        <option value="" disabled>Choose project</option>
        {view.projects.map((project) => <option key={project.id} value={project.id}
          disabled={!project.dependencies.every((dependency) => view.completedProjects.includes(dependency))}>
          {project.id}{project.dependencies.every((dependency) => view.completedProjects.includes(dependency))
            ? "" : ` (requires ${project.dependencies.join(", ")})`}
        </option>)}
      </select>
      {view.projects.map((project) => <div key={project.id} className="mt-4 rounded-lg border border-slate-700/60 bg-[#0c1823] p-3 text-sm">
        <div className="flex justify-between gap-2"><strong>{project.id}</strong>
          <span className="font-mono text-cyan-200">{view.completedProjects.includes(project.id)
            ? "Complete" : `${view.researchProgress[project.id] ?? 0} / ${project.requiredProgress}`}</span>
        </div>
        <p className="mt-1 text-xs text-slate-400">{project.insightPerProgress} insight and {project.moneyPerProgress} credits / progress · reward {project.knowledgeReward} knowledge</p>
      </div>)}
      <h3 className="mt-5 text-sm font-semibold text-cyan-100">Activate researched upgrades</h3>
      <p className="mt-1 text-xs text-slate-400">Completing a project grants Knowledge; its upgrade is optional and costs Money plus Knowledge once.</p>
      {view.upgrades.map((upgrade) => {
        const purchased = view.purchasedUpgrades.includes(upgrade.id);
        const unlocked = view.completedProjects.includes(upgrade.projectId);
        return <div key={upgrade.id} className="mt-3 rounded-lg border border-slate-700/60 bg-[#0c1823] p-3 text-sm">
          <strong className="text-slate-100">{upgrade.id}</strong>
          <p className="mt-1 text-xs text-slate-400">{upgrade.description}</p>
          <p className="mt-1 text-xs text-slate-400">
            Requires {upgrade.projectId} · {upgrade.moneyCost} credits + {upgrade.knowledgeCost} Knowledge
            {" "}· {purchased ? "Purchased" : unlocked ? "Available" : "Locked"}
          </p>
          <button type="button" className="button mt-2" disabled={!ready || purchased || !unlocked ||
            money < upgrade.moneyCost || knowledge < upgrade.knowledgeCost}
            onClick={() => actions.command("research.purchase-upgrade", { upgradeId: upgrade.id })}>
            {purchased ? "Active" : "Purchase upgrade"}
          </button>
        </div>;
      })}
    </div>
  </section>;
}

function EmergencyRecovery({ store, actions }: { store: SimulationStore; actions: Actions }) {
  const slots = useSimulationSelector(store, (state) => state.slots);
  const ready = useSimulationSelector(store, (state) => state.ready);
  const hasCurrentGame = useSimulationSelector(store, (state) => state.view !== null);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => void | Promise<void> | undefined) => {
    setError(null);
    try {
      void Promise.resolve(action()).catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const confirmReplace = (label: string) => !hasCurrentGame || window.confirm(
    `Load ${label}? This replaces the current game and any unsaved progress. Save to a manual slot first if needed.`,
  );
  return <section className="panel" aria-label="Emergency save recovery">
    <h2 className="font-semibold text-cyan-100">Save recovery</h2>
    <p className="muted">Playback is paused. Existing saves stay untouched until you choose an action.</p>
    {error && <p role="alert" className="mt-3 text-sm text-rose-300">Recovery action failed: {error}. Try another slot or backup.</p>}
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      {SAVE_SLOTS.map((slot) => {
        const info = slots.find((item) => item.slot === slot);
        const label = slot === "auto" ? "AUTO-SAVE" : `Manual ${slot.slice(-1)}`;
        return <div key={slot} className="rounded-lg border border-slate-700 bg-[#0c1823] p-3">
          <h3 className="font-semibold text-cyan-100">{label}</h3>
          <p className="mt-1 text-xs text-slate-400">
            {!info ? "Status unavailable — loading will verify the save." :
              info.corrupt ? "Corrupt primary" : info.exists ? "Saved game available" : "Empty slot"}
            {" · "}{info?.hasBackup ? "backup available" : info ? "no backup" : "backup status unknown"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {slot !== "auto" && <button className="button" type="button" disabled={!ready}
              onClick={() => {
                if (window.confirm(`Overwrite ${label} with the current game? The previous primary may be replaced.`)) {
                  run(() => actions.save(slot));
                }
              }}>Save current game</button>}
            <button className="button" type="button" disabled={info?.exists === false || info?.corrupt === true}
              onClick={() => { if (confirmReplace(label)) run(() => actions.loadSlot(slot)); }}>Load</button>
            <button className="button" type="button" disabled={info?.hasBackup === false}
              onClick={() => { if (confirmReplace(`${label} backup`)) run(() => actions.loadSlot(slot, true)); }}>
              Restore backup
            </button>
          </div>
        </div>;
      })}
    </div>
    <button className="button mt-4" type="button" onClick={() => {
      if (window.confirm("Start a new game? Unsaved progress will be lost; existing save slots remain untouched.")) {
        run(() => actions.newGame());
      }
    }}>New game…</button>
  </section>;
}

export function App() {
  const store = useMemo(() => new SimulationStore(), []);
  const actions = useSimulationLoop(store);
  const renderError = useRef(false);
  const settings = useSimulationSelector(store, (state) => state.settings);
  const introDone = useSimulationSelector(store, (state) => state.introDone);
  const ready = useSimulationSelector(store, (state) => state.ready);
  const [preferenceError, setPreferenceError] = useState(() => readPreferences().error);
  const [introError, setIntroError] = useState<string | null>(null);
  const [dashboardCrashed, setDashboardCrashed] = useState(false);
  const [tab, setTab] = useState(() => window.location.hash === "#settings" ? "settings" : "overview");
  useEffect(() => { setPreferenceError(readPreferences().error); }, [settings, introDone]);
  useEffect(() => {
    if (renderError.current) {
      actions.setSpeed(0);
      store.setSpeed(0);
    }
  }, [actions, store]);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.style.fontSize = `${settings.uiScale * 100}%`;
    return () => {
      delete document.documentElement.dataset.theme;
      document.documentElement.style.removeProperty("font-size");
    };
  }, [settings.theme, settings.uiScale]);
  const selectTab = (value: string) => {
    setDashboardCrashed(false);
    setTab(value);
  };
  const navigate = (value: string) => {
    selectTab(value);
    requestAnimationFrame(() => document.getElementById(`navigation-${value}`)?.focus());
  };
  const pauseOnRenderError = () => {
    renderError.current = true;
    actions.setSpeed(0);
    store.setSpeed(0);
    store.update({
      recovery: "Interface rendering failed. Playback is paused; use a saved slot, backup, or confirmed new game to recover.",
      notice: "Interface paused after a rendering error",
    });
  };
  return <ErrorBoundary onError={pauseOnRenderError}
    recovery={<EmergencyRecovery store={store} actions={actions} />}>
    <Tabs.Root value={tab} onValueChange={selectTab} className="min-h-screen text-slate-100 lg:flex">
    <aside className="app-sidebar border-b border-slate-700/70 px-4 py-4 lg:sticky lg:top-0 lg:h-screen lg:w-64 lg:shrink-0 lg:border-r lg:border-b-0 lg:px-4 lg:py-6">
      <div className="mb-4 flex items-center gap-2 font-mono text-xs font-bold tracking-[.2em] text-cyan-300 lg:mb-8">
        <span className="flex size-8 items-center justify-center rounded bg-cyan-500/15 text-cyan-300"><GitBranch size={18} aria-hidden /></span>
        CCE // CONTROL
      </div>
      <Tabs.List aria-label="Game sections" className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
        {sections.map(({ value, label, icon: Icon }, index) => <Tabs.Trigger key={value}
          id={`navigation-${value}`} value={value} className="nav-trigger" aria-label={`${index + 1}. ${label}`}>
          <Icon size={17} className="shrink-0" aria-hidden />
          <span className="whitespace-nowrap">{label}</span>
        </Tabs.Trigger>)}
      </Tabs.List>
      <p className="mt-6 hidden border-t border-slate-800 pt-4 font-mono text-xs text-slate-500 lg:block">
        ONE ENGINE · TWO SHELLS<br />WORKER-AUTHORITATIVE
      </p>
    </aside>
    <main className="min-w-0 flex-1 px-4 py-4 sm:px-6 lg:px-7 lg:py-6">
      <div className="mx-auto max-w-[1500px]">
        <Header store={store} actions={actions} onOpenSettings={() => navigate("settings")}
          playbackBlocked={dashboardCrashed} />
        <Status store={store} onOpenSettings={() => navigate("settings")} preferenceError={preferenceError} />
        {introError && <p role="alert" className="mb-3 rounded-lg border border-rose-600/70 bg-rose-950/40 p-3 text-sm text-rose-100">
          Introduction status could not be saved: {introError}. Retry Finish or Skip; no game save has been changed.
        </p>}
        {ready && !introDone && <FirstRunIntro onNavigate={navigate} onFinish={() => {
          try {
            actions.markIntroDone();
            setIntroError(null);
          } catch (error) {
            setIntroError(error instanceof Error ? error.message : String(error));
          }
        }} />}
        <ErrorBoundary key={tab} onOpenSettings={() => navigate("settings")}
          onError={() => {
            pauseOnRenderError();
            setDashboardCrashed(true);
          }}
          recovery={<SettingsPanel store={store} actions={actions} />}>
          <Tabs.Content value="overview" className="tab-content">
            <div className="space-y-5"><CausalOverview store={store} /><ResourceOverview store={store} /></div>
          </Tabs.Content>
          <Tabs.Content value="agents" className="tab-content"><AgentsPanel store={store} actions={actions} /></Tabs.Content>
          <Tabs.Content value="build" className="tab-content"><BuildPanel store={store} actions={actions} /></Tabs.Content>
          <Tabs.Content value="runtime" className="tab-content"><RuntimePanel store={store} actions={actions} /></Tabs.Content>
          <Tabs.Content value="debt" className="tab-content"><DebtPanel store={store} actions={actions} /></Tabs.Content>
          <Tabs.Content value="policy" className="tab-content"><PolicyPanel store={store} actions={actions} /></Tabs.Content>
          <Tabs.Content value="research" className="tab-content"><ResearchPanel store={store} actions={actions} /></Tabs.Content>
        </ErrorBoundary>
        <Tabs.Content value="settings" className="tab-content"><SettingsPanel store={store} actions={actions} /></Tabs.Content>
      </div>
    </main>
    </Tabs.Root>
  </ErrorBoundary>;
}
