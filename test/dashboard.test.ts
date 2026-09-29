import assert from "node:assert/strict";
import test from "node:test";
import { getGameView, issueCommand, configuration } from "../src/app/game.js";
import { gameBridge, isForeignTauriHost } from "../src/app/bridge.js";
import { ResourceRateSampler } from "../src/app/resource-rates.js";
import { debtPressureStatus } from "../src/app/debt-pressure.js";
import { SimulationWorkerRuntime } from "../src/app/worker-runtime.js";
import {
  MAX_SWARM_AGENTS, MAX_TEAM_HEADCOUNT, ORGANIZATION_SYSTEM_ID, Resources,
  Simulation, decodeSaveWithMetadata, encodeSave, type OrganizationState,
} from "../src/simulation/index.js";

function gameWithMoney(money: number) {
  return new Simulation({ ...configuration,
    initialResources: { [Resources.Money]: money, [Resources.Demand]: 40 } });
}

test("browser preview only falls back for missing CCE commands, not native storage failures", () => {
  assert.equal(isForeignTauriHost("Command bridge_identity not allowed by ACL"), true);
  assert.equal(isForeignTauriHost("unknown command bridge_identity"), true);
  assert.equal(isForeignTauriHost("Command plugin:event|listen not allowed by ACL"), false);
  assert.equal(isForeignTauriHost("Cannot read save file: access denied"), false);
});

test("foreign Tauri canvas globals use browser storage without subscribing to native events", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalIsTauri = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalWarning = console.warn;
  const storage = new Map<string, string>();
  const calls: string[] = [];
  try {
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { protocol: "http:" },
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        calls.push(command);
        throw new Error(`Command ${command} not allowed by ACL`);
      } },
    } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    } });
    console.warn = () => {};
    const saved: { slot: string; revision: number }[] = [];
    const unlisten = await gameBridge.onSaved((event) => saved.push(event));
    const encoded = encodeSave(new Simulation(configuration), 1_000);
    await gameBridge.save(encoded, 4);
    assert.deepEqual(saved, [{ slot: "auto", revision: 4 }]);
    assert.deepEqual(await gameBridge.load(), { data: encoded, revision: 4 });
    assert.deepEqual(calls, ["bridge_identity"]);
    assert.equal(gameBridge.platform, "browser");
    unlisten();
  } finally {
    console.warn = originalWarning;
    for (const [name, descriptor] of [
      ["window", originalWindow], ["isTauri", originalIsTauri], ["localStorage", originalStorage],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("resource rates sample real balance deltas across ticks, including negative and idle", () => {
  const sampler = new ResourceRateSampler();
  assert.deepEqual(sampler.sample(0, [
    { id: Resources.Money, amount: 100 }, { id: Resources.Source, amount: 0 },
  ]), {
    windowTicks: 0,
    perTick: { [Resources.Money]: 0, [Resources.Source]: 0 },
    producedPerTick: { [Resources.Money]: null, [Resources.Source]: null },
    consumedPerTick: { [Resources.Money]: null, [Resources.Source]: null },
  });
  const changing = sampler.sample(2, [
    { id: Resources.Money, amount: 80 }, { id: Resources.Source, amount: 10 },
  ]);
  assert.equal(changing.windowTicks, 2);
  assert.equal(changing.perTick[Resources.Money], -10);
  assert.equal(changing.perTick[Resources.Source], 5);
  assert.equal(sampler.sample(2, [{ id: Resources.Money, amount: 80 }]), changing);
  assert.equal(sampler.sample(4, [
    { id: Resources.Money, amount: 80 }, { id: Resources.Source, amount: 10 },
  ]).perTick[Resources.Source], 0);
  assert.equal(sampler.sample(0, [{ id: Resources.Money, amount: 100 }]).windowTicks, 0);
});

test("gross flow reveals active net-zero throughput and excludes ephemeral resets", () => {
  const sampler = new ResourceRateSampler();
  const start = { produced: {}, consumed: {}, discontinuities: 0 };
  sampler.sample(0, [{ id: Resources.Compute, amount: 0 }], start);
  const active = sampler.sample(1, [{ id: Resources.Compute, amount: 0 }], {
    produced: { [Resources.Compute]: 12 },
    consumed: { [Resources.Compute]: 12 },
    discontinuities: 0,
  });
  assert.equal(active.perTick[Resources.Compute], 0);
  assert.equal(active.producedPerTick[Resources.Compute], 12);
  assert.equal(active.consumedPerTick[Resources.Compute], 12);
  const idle = sampler.sample(2, [{ id: Resources.Compute, amount: 0 }], {
    produced: { [Resources.Compute]: 12 },
    consumed: { [Resources.Compute]: 12 },
    discontinuities: 0,
  });
  assert.equal(idle.producedPerTick[Resources.Compute], 0);
  assert.equal(idle.consumedPerTick[Resources.Compute], 0);
  const reset = new ResourceRateSampler();
  reset.sample(0, [{ id: Resources.Compute, amount: 7 }], start);
  const afterReset = reset.sample(1, [{ id: Resources.Compute, amount: 0 }], start);
  assert.equal(afterReset.perTick[Resources.Compute], -7);
  assert.equal(afterReset.consumedPerTick[Resources.Compute], 0);
  assert.equal(reset.sample(20, [{ id: Resources.Compute, amount: 0 }], {
    ...start, discontinuities: 1,
  }).consumedPerTick[Resources.Compute], null);
});

test("debt pressure uses remediation spent in real ticks rather than zero leftover capacity", () => {
  const game = new Simulation(configuration);
  const sampler = new ResourceRateSampler();
  sampler.sample(game.tick, getGameView(game).resources);
  let observed = false;
  for (let tick = 0; tick < 35; tick += 1) {
    game.runTick();
    const view = getGameView(game);
    const rates = sampler.sample(game.tick, view.resources);
    const remediation = view.diagnostics.debt.remediation;
    if (view.diagnostics.debt.total === 0 || !remediation || remediation.retired === 0) continue;
    observed = true;
    assert.equal(game.resources.get(Resources.MaintenanceCapacity), 0);
    assert.ok(remediation.availableCapacity > 0);
    assert.ok(remediation.capacitySpent > 0);
    const status = debtPressureStatus(view.diagnostics.debt,
      rates.perTick[Resources.TechnicalDebt] ?? 0, rates.windowTicks);
    assert.notEqual(status.level, "stalled");
    assert.doesNotMatch(status.detail, /No maintenance capacity/);
  }
  assert.equal(observed, true, "baseline must exercise real debt retirement");

  const stalled = gameWithMoney(100_000);
  const policy = { ...getGameView(stalled).policy, maintenanceAllocationPermille: 0 };
  assert.equal(issueCommand(stalled, "organization.set-policy", { policy }).accepted, true);
  for (let tick = 0; tick < 5; tick += 1) stalled.runTick();
  const debt = getGameView(stalled).diagnostics.debt;
  assert.ok(debt.total > 0);
  assert.equal(debt.remediation?.availableCapacity, 0);
  assert.equal(debt.remediation?.retired, 0);
  assert.deepEqual(debtPressureStatus(debt, 1, 1), {
    level: "stalled", detail: "No maintenance capacity was allocated last tick.",
  });
});

test("worker projects bounded rates from real simulation without changing canonical state", async () => {
  const worker = new SimulationWorkerRuntime();
  const initial = await worker.submit({ id: 1, kind: "initialize", save: null, now: 1_000 });
  assert.equal(initial.kind, "result");
  if (initial.kind !== "result" || initial.result.kind !== "initialize") return;
  const startingMoney = initial.result.view.resources.find((resource) => resource.id === Resources.Money)?.amount ?? 0;
  const advanced = await worker.submit({ id: 2, kind: "advance", elapsedMilliseconds: 2_000, speedPermille: 1_000 });
  assert.equal(advanced.kind, "result");
  if (advanced.kind !== "result" || advanced.result.kind !== "advance" || !advanced.result.view) return;
  const view = advanced.result.view;
  assert.equal(view.resourceRateWindowTicks, 2);
  const money = view.resources.find((resource) => resource.id === Resources.Money);
  assert.equal(money?.ratePerTick, ((money?.amount ?? 0) - startingMoney) / 2);
  assert.equal(view.resources.length, configuration.resources.length);
  const compute = view.resources.find((resource) => resource.id === Resources.Compute);
  assert.ok((compute?.producedPerTick ?? 0) > 0);
  assert.ok((compute?.consumedPerTick ?? 0) > 0);
  const snapshot = await worker.submit({ id: 3, kind: "snapshot", now: 3_000 });
  assert.equal(snapshot.kind, "result");
  if (snapshot.kind !== "result" || snapshot.result.kind !== "snapshot") return;
  assert.equal(decodeSaveWithMetadata(configuration, snapshot.result.data).simulation.tick, view.tick);
});

test("staffing costs, funded productivity and zero/cap constraints are authoritative", () => {
  const game = gameWithMoney(1_000_000);
  const baseline = gameWithMoney(1_000_000);
  assert.equal(issueCommand(game, "organization.adjust-team", { teamId: "platform-team", delta: 1 }).accepted, true);
  baseline.runTick();
  const current = game.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID);
  const before = baseline.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID);
  assert.equal(current.teams[0]?.headcount, 11);
  assert.equal(current.totalPayroll - before.totalPayroll, 2);
  assert.equal(getGameView(game).diagnostics.productivity.teams[0]?.fundedPeople, 11);
  assert.equal(issueCommand(game, "organization.adjust-swarm", { swarmId: "compiler-swarm", delta: 1 }).accepted, true);
  assert.equal(game.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID).agentSwarms[0]?.agents, 5);
  assert.equal(issueCommand(game, "organization.adjust-team", { teamId: "platform-team", delta: -10 }).accepted, true);
  assert.equal(issueCommand(game, "organization.adjust-team", { teamId: "platform-team", delta: -1 }).accepted, true);
  assert.equal(game.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID).teams[0]?.headcount, 0);
  assert.match(issueCommand(game, "organization.adjust-team", { teamId: "platform-team", delta: -1 }).reason ?? "", /between 0/);
  assert.equal(issueCommand(game, "organization.adjust-swarm", { swarmId: "compiler-swarm", delta: -5 }).accepted, true);
  assert.match(issueCommand(game, "organization.adjust-swarm", { swarmId: "compiler-swarm", delta: -1 }).reason ?? "", /between 0/);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(issueCommand(game, "organization.adjust-team", { teamId: "platform-team", delta: 10 }).accepted, true);
    assert.equal(issueCommand(game, "organization.adjust-swarm", { swarmId: "compiler-swarm", delta: 10 }).accepted, true);
  }
  assert.equal(game.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID).teams[0]?.headcount, MAX_TEAM_HEADCOUNT);
  assert.equal(game.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID).agentSwarms[0]?.agents, MAX_SWARM_AGENTS);
  assert.match(issueCommand(game, "organization.adjust-team", { teamId: "platform-team", delta: 1 }).reason ?? "", /headcount/);
  assert.match(issueCommand(game, "organization.adjust-swarm", { swarmId: "compiler-swarm", delta: 1 }).reason ?? "", /agents/);
});

test("invalid staffing and unaffordable hires reject without changing headcount", () => {
  const game = gameWithMoney(0);
  for (const [type, payload] of [
    ["organization.adjust-team", { teamId: "platform-team", delta: 1 }],
    ["organization.adjust-swarm", { swarmId: "compiler-swarm", delta: 1 }],
    ["organization.adjust-team", { teamId: "platform-team", delta: 0 }],
    ["organization.adjust-team", { teamId: "platform-team", delta: 11 }],
    ["organization.adjust-team", { teamId: "missing", delta: 1 }],
  ] as const) {
    assert.equal(issueCommand(game, type, payload).accepted, false);
  }
  const state = game.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID);
  assert.equal(state.teams[0]?.headcount, 10);
  assert.equal(state.agentSwarms[0]?.agents, 4);
});

test("team role shifts real source and research capacity and survives save/offline", () => {
  const generalist = gameWithMoney(100_000);
  const source = gameWithMoney(100_000);
  const research = gameWithMoney(100_000);
  generalist.runTick();
  assert.equal(issueCommand(source, "organization.assign-team-role", {
    teamId: "platform-team", role: "sourceGeneration",
  }).accepted, true);
  assert.equal(issueCommand(research, "organization.assign-team-role", {
    teamId: "platform-team", role: "research",
  }).accepted, true);
  assert.ok(getGameView(source).diagnostics.productivity.teams[0]!.sourceCapacity >
    getGameView(generalist).diagnostics.productivity.teams[0]!.sourceCapacity);
  assert.ok(getGameView(source).diagnostics.productivity.sourceGenerated >
    getGameView(generalist).diagnostics.productivity.sourceGenerated);
  assert.ok(research.resources.get(Resources.ResearchSkill) > generalist.resources.get(Resources.ResearchSkill));
  assert.ok(getGameView(research).diagnostics.productivity.teams[0]!.sourceCapacity <
    getGameView(generalist).diagnostics.productivity.teams[0]!.sourceCapacity);
  assert.match(issueCommand(source, "organization.assign-team-role", {
    teamId: "platform-team", role: "invalid",
  }).reason ?? "", /Unknown team role/);
  const serialized = encodeSave(research, 10_000);
  const restored = decodeSaveWithMetadata({
    ...configuration, initialResources: { [Resources.Money]: 100_000 },
  }, serialized).simulation;
  assert.equal(restored.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID).teams[0]?.role, "research");
  research.advanceOffline(10_000, 15_000);
  restored.advanceOffline(10_000, 15_000);
  assert.deepEqual(restored.serialize(15_000), research.serialize(15_000));
});
