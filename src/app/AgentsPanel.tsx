import { Bot, CircleHelp, Users } from "lucide-react";
import React, { useEffect, useState } from "react";
import {
  MAX_SWARM_AGENTS, MAX_TEAM_HEADCOUNT, Resources, TEAM_ROLES, TEAM_SKILLS,
  type OrganizationPolicy, type TeamRole,
} from "../simulation/index.js";
import { SimulationStore, useSimulationSelector } from "./simulation-store.js";
import type { useSimulationLoop } from "./use-simulation-loop.js";

type Actions = ReturnType<typeof useSimulationLoop>;
const roleNames: Record<TeamRole, string> = {
  generalist: "Generalist",
  sourceGeneration: "Source generation",
  verification: "Verification",
  operations: "Operations",
  research: "Research",
};

const policyFields = [
  { key: "aiAllocationPermille", label: "AI allocation", detail: "Funded agents = floor(agents × allocation / 1,000), subject to credits." },
  { key: "maintenanceAllocationPermille", label: "Maintenance allocation", detail: "Each funded team's maintenance capacity = floor(team capacity × allocation / 1,000); delivery uses the rest." },
  { key: "reviewStrengthPermille", label: "Review strength", detail: "Carried with generated Source and reduces build failure and debt creation." },
  { key: "testStrengthPermille", label: "Test strength", detail: "Carried with Source into Binaries; influences build governance and testing outcomes." },
  { key: "codingStandardsPermille", label: "Coding standards", detail: "Raises governance and reduces build bugs, failures and debt creation." },
  { key: "riskTolerancePermille", label: "Risk tolerance", detail: "Higher risk lowers team morale and raises build failures and latent bugs." },
  { key: "releaseCadencePermille", label: "Release cadence", detail: "Carried through Source and Binaries into release decisions." },
] as const;
type PolicyField = typeof policyFields[number]["key"];

function policyDraft(policy: OrganizationPolicy): Record<PolicyField, string> {
  return Object.fromEntries(policyFields.map(({ key }) => [key, String(policy[key])])) as Record<PolicyField, string>;
}

export function PolicyEditor({
  id, policy, ready, onSave,
}: {
  id: string;
  policy: OrganizationPolicy;
  ready: boolean;
  onSave: (policy: OrganizationPolicy) => void;
}) {
  const signature = policyFields.map(({ key }) => policy[key]).join(",");
  const [draft, setDraft] = useState(() => policyDraft(policy));
  useEffect(() => { setDraft(policyDraft(policy)); }, [signature]);
  const valid = policyFields.every(({ key }) => draft[key].trim() !== "" &&
    Number.isSafeInteger(Number(draft[key])) && Number(draft[key]) >= 0 && Number(draft[key]) <= 1_000);
  const changed = policyFields.some(({ key }) => draft[key] !== String(policy[key]));
  return <form className="mt-4" onSubmit={(event) => {
    event.preventDefault();
    if (!ready || !valid || !changed) return;
    onSave({
      ...policy,
      ...Object.fromEntries(policyFields.map(({ key }) => [key, Number(draft[key])])),
    });
  }}>
    <p className="text-xs text-slate-400">Set each value from 0 to 1,000 (1,000 = 100%). Changes apply on save.</p>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {policyFields.map(({ key, label, detail }) => <div key={key}>
        <label className="block text-xs text-slate-300" htmlFor={`${id}-${key}`}>{label}</label>
        <input id={`${id}-${key}`} type="number" min={0} max={1_000} step={1} required
          className="mt-1 block w-full rounded-md border border-slate-600 bg-[#0c1823] px-3 py-2 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          disabled={!ready} value={draft[key]} onChange={(event) =>
            setDraft((previous) => ({ ...previous, [key]: event.target.value }))}
          aria-describedby={`${id}-${key}-detail`} />
        <p id={`${id}-${key}-detail`} className="mt-1 text-xs text-slate-500">{detail}</p>
      </div>)}
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <button className="button selected" type="submit" disabled={!ready || !valid || !changed}>Save policy</button>
      <button className="button" type="button" disabled={!changed}
        onClick={() => setDraft(policyDraft(policy))}>Discard edits</button>
    </div>
  </form>;
}

function TeamPolicy({ store, actions, teamId }: { store: SimulationStore; actions: Actions; teamId: string }) {
  const globalPolicy = useSimulationSelector(store, (state) => state.view?.policy);
  const override = useSimulationSelector(store, (state) => state.view?.teamPolicies[teamId]);
  const ready = useSimulationSelector(store, (state) => state.ready);
  const policy = override ?? globalPolicy;
  if (!policy) return null;
  return <details className="mt-4 border-t border-slate-700/70 pt-3">
    <summary className="cursor-pointer text-sm font-medium text-cyan-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300">Team policy {override ? "(override active)" : "(inherits global)"}</summary>
    <p className="mt-2 text-xs text-slate-400">
      Saving creates a full policy override for this team. Global changes do not replace a saved team override.
    </p>
    <PolicyEditor id={`policy-${teamId}`} policy={policy} ready={ready}
      onSave={(value) => actions.command("organization.set-team-policy", { teamId, policy: value })} />
    {override && <button type="button" className="button mt-2" disabled={!ready}
      onClick={() => actions.command("organization.clear-team-policy", { teamId })}>
      Inherit global policy again
    </button>}
  </details>;
}

function Teams({ store, actions }: { store: SimulationStore; actions: Actions }) {
  const teams = useSimulationSelector(store, (state) => state.view?.teams ?? []);
  const productivity = useSimulationSelector(store, (state) => state.view?.diagnostics.productivity.teams ?? []);
  const ready = useSimulationSelector(store, (state) => state.ready);
  const money = useSimulationSelector(store, (state) =>
    state.view?.resources.find((item) => item.id === Resources.Money)?.amount ?? 0);
  return <section className="panel" aria-label="Engineering teams">
    <h3 className="flex items-center gap-2 font-semibold text-cyan-100"><Users size={18} aria-hidden /> Engineering teams</h3>
    {teams.map((team) => {
      const metric = productivity.find((item) => item.teamId === team.id);
      return <article className="mt-4 rounded-xl border border-slate-700 bg-[#101c29] p-4" key={team.id}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-slate-100">{team.id}</h4>
            <p className="text-sm text-slate-400">{team.headcount} engineers · {metric?.fundedPeople ?? 0} funded this tick</p>
          </div>
          <div className="flex gap-2" aria-label={`Staffing for ${team.id}`}>
            <button className="button" disabled={!ready || team.headcount === 0}
              aria-label={`Fire one engineer from ${team.id}`}
              onClick={() => actions.command("organization.adjust-team", { teamId: team.id, delta: -1 })}>Fire −1</button>
            <button className="button selected" disabled={!ready || team.headcount >= MAX_TEAM_HEADCOUNT}
              aria-label={`Hire one engineer for ${team.id}`}
              onClick={() => actions.command("organization.adjust-team", { teamId: team.id, delta: 1 })}>Hire +1</button>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Source capacity <strong className="text-cyan-200">{metric?.sourceCapacity ?? 0}</strong> / tick ·
          morale <strong className="text-slate-200">{(team.moralePermille / 10).toFixed(1)}%</strong> ·
          skill <strong className="text-slate-200">{(team.engineeringSkillPermille / 10).toFixed(0)}%</strong>
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Hire: {team.salaryPerTick * 5} credits · salary: {team.salaryPerTick} / funded engineer / tick · cap {MAX_TEAM_HEADCOUNT}
        </p>
        <div className="mt-4">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-400" htmlFor={`role-${team.id}`}>Team focus</label>
          <select id={`role-${team.id}`} disabled={!ready} value={team.role ?? "generalist"}
            onChange={(event) => actions.command("organization.assign-team-role", {
              teamId: team.id, role: event.target.value,
            })}>
            {TEAM_ROLES.map((role) => <option key={role} value={role}>{roleNames[role]}</option>)}
          </select>
          <p className="mt-2 text-xs text-slate-500">Focused skill +20%; other skills −25%. Source capacity, verification, operations and research change in the next tick.</p>
        </div>
        <TeamPolicy store={store} actions={actions} teamId={team.id} />
        <div className="mt-4 border-t border-slate-700/70 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Skill training · 5 credits per skill point · cap 2,000</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {TEAM_SKILLS.map((skill) => {
              const amount = Math.min(10, 2_000 - team.skillTree[skill]);
              return <button key={skill} className="button" type="button"
                disabled={!ready || amount <= 0 || money < amount * 5}
                title={`${team.skillTree[skill]} / 2,000 ${skill} skill; ${amount * 5} credits for ${amount} points`}
                onClick={() => actions.command("organization.train-team", { teamId: team.id, skill, amount })}>
                Train {roleNames[skill]} +{amount}
              </button>;
            })}
          </div>
        </div>
      </article>;
    })}
  </section>;
}

function Swarms({ store, actions }: { store: SimulationStore; actions: Actions }) {
  const swarms = useSimulationSelector(store, (state) => state.view?.swarms ?? []);
  const productivity = useSimulationSelector(store, (state) => state.view?.diagnostics.productivity.swarms ?? []);
  const ready = useSimulationSelector(store, (state) => state.ready);
  return <section className="panel" aria-label="Agent swarms">
    <h3 className="flex items-center gap-2 font-semibold text-cyan-100"><Bot size={18} aria-hidden /> Agent swarms</h3>
    {swarms.map((swarm) => {
      const metric = productivity.find((item) => item.swarmId === swarm.id);
      return <article className="mt-4 rounded-xl border border-slate-700 bg-[#101c29] p-4" key={swarm.id}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-slate-100">{swarm.id}</h4>
            <p className="text-sm text-slate-400">{swarm.agents} agents · {metric?.fundedAgents ?? 0} funded this tick</p>
          </div>
          <div className="flex gap-2" aria-label={`Staffing for ${swarm.id}`}>
            <button className="button" disabled={!ready || swarm.agents === 0}
              aria-label={`Retire one agent from ${swarm.id}`}
              onClick={() => actions.command("organization.adjust-swarm", { swarmId: swarm.id, delta: -1 })}>Retire −1</button>
            <button className="button selected" disabled={!ready || swarm.agents >= MAX_SWARM_AGENTS}
              aria-label={`Recruit one agent for ${swarm.id}`}
              onClick={() => actions.command("organization.adjust-swarm", { swarmId: swarm.id, delta: 1 })}>Recruit +1</button>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Effective capacity <strong className="text-cyan-200">{metric?.effectiveCapacity ?? 0}</strong> / tick ·
          alignment <strong className="text-slate-200">{((metric?.effectiveAlignmentPermille ?? swarm.alignmentPermille) / 10).toFixed(1)}%</strong> ·
          autonomy <strong className="text-slate-200">{(swarm.autonomyPermille / 10).toFixed(0)}%</strong>
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Recruit: {swarm.operatingCostPerAgent * 5} credits · upkeep: {swarm.operatingCostPerAgent} / funded agent / tick · cap {MAX_SWARM_AGENTS}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {([-100, 100] as const).map((delta) => <button className="button" key={delta}
            disabled={!ready || swarm.autonomyPermille + delta < 0 || swarm.autonomyPermille + delta > 1_000}
            onClick={() => actions.command("organization.configure-swarm", {
              swarmId: swarm.id,
              autonomyPermille: swarm.autonomyPermille + delta,
              alignmentPermille: swarm.alignmentPermille,
            })}>{delta > 0 ? "Increase autonomy" : "Decrease autonomy"}</button>)}
          {([-100, 100] as const).map((delta) => <button className="button" key={`alignment-${delta}`}
            disabled={!ready || swarm.alignmentPermille + delta < 0 || swarm.alignmentPermille + delta > 1_000}
            title="Effective swarm capacity scales with funded agents, alignment and autonomy; instability reduces effective alignment."
            onClick={() => actions.command("organization.configure-swarm", {
              swarmId: swarm.id,
              autonomyPermille: swarm.autonomyPermille,
              alignmentPermille: swarm.alignmentPermille + delta,
            })}>{delta > 0 ? "Increase alignment" : "Decrease alignment"}</button>)}
        </div>
      </article>;
    })}
  </section>;
}

export function AgentsPanel({ store, actions }: { store: SimulationStore; actions: Actions }) {
  return <section aria-label="Source Generation and Agents" className="space-y-5">
    <div>
      <h2 className="heading">Source generation / agents</h2>
      <p className="muted">Staff teams and swarms, shift engineering focus, and monitor funded output.</p>
      <p className="mt-2 flex items-center gap-2 text-xs text-slate-500"><CircleHelp size={13} aria-hidden /> Onboarding costs credits now; payroll and agent upkeep are paid each simulated tick. Unfunded staff produce no capacity.</p>
    </div>
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Teams store={store} actions={actions} />
      <Swarms store={store} actions={actions} />
    </div>
  </section>;
}
