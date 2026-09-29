import assert from "node:assert/strict";
import test from "node:test";
import { getGameView, newGame } from "../src/app/game.js";
import { MAX_SPEED_PERMILLE, SimulationStore } from "../src/app/simulation-store.js";
import {
  COMPILATION_SYSTEM_ID,
  CORE_RESOURCE_DEFINITIONS,
  ORGANIZATION_SYSTEM_ID,
  Resources,
  RUNTIME_SYSTEM_ID,
  TESTING_SYSTEM_ID,
  type BuildState,
  type OrganizationState,
  type RuntimeState,
  type TestingState,
} from "../src/simulation/index.js";

test("projection exposes every defined resource and actual stage, cohort, agent and backlog data", () => {
  const game = newGame();
  game.advanceTicks(8);
  const view = getGameView(game);
  assert.deepEqual(view.resources.map((resource) => resource.id), CORE_RESOURCE_DEFINITIONS.map((resource) => resource.id));
  for (const id of [Resources.Compute, Resources.Source, Resources.Binaries, Resources.Insight, Resources.Money, Resources.TechnicalDebt]) {
    assert.equal(view.resources.find((resource) => resource.id === id)?.amount, game.resources.get(id));
  }
  const build = game.getState<BuildState>(COMPILATION_SYSTEM_ID);
  const testing = game.getState<TestingState>(TESTING_SYSTEM_ID);
  const runtime = game.getState<RuntimeState>(RUNTIME_SYSTEM_ID);
  const organization = game.getState<OrganizationState>(ORGANIZATION_SYSTEM_ID);
  assert.deepEqual(view.teams, organization.teams);
  assert.deepEqual(view.swarms, organization.agentSwarms);
  assert.deepEqual(view.buildStages.map((stage) => [stage.id, stage.executions]),
    ["parse", "compile", "link"].map((id) => [id, build.stageExecutions[id] ?? 0]));
  assert.deepEqual(view.backlogs.map(({ units, cohorts }) => [units, cohorts]), [
    [game.resources.get(Resources.Source), build.sourceCohorts.length],
    [game.resources.get(Resources.Binaries), testing.binaryCohorts.length],
    [game.resources.get(Resources.Releases), runtime.releaseCohorts.length],
    [game.resources.get(Resources.HotDeployRequests), null],
    [game.resources.get(Resources.Demand), null],
  ]);
});

test("store subscriptions preserve stable selector snapshots across unrelated updates", () => {
  const store = new SimulationStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  const first = getGameView(newGame());
  store.setView(first);
  const original = store.getState().view;
  const ids = store.getState().resourceIds;
  assert.equal(ids.length, CORE_RESOURCE_DEFINITIONS.length);
  store.setView(getGameView(newGame()));
  assert.equal(store.getState().resourceIds, ids);
  assert.equal(store.getState().view?.policy, original?.policy);
  assert.equal(store.getState().view?.teams, original?.teams);
  assert.equal(store.getState().view?.swarms, original?.swarms);
  assert.equal(store.getState().view?.buildJobs, original?.buildJobs);
  assert.equal(store.getState().view?.importantEvents, original?.importantEvents);
  assert.equal(store.getState().view?.teamPolicies, original?.teamPolicies);
  const selectedMoney = () => store.getState().view?.resources.find((resource) => resource.id === Resources.Money)?.amount;
  const originalMoney = selectedMoney();
  store.update({ notice: "Saved" });
  store.setSpeed(MAX_SPEED_PERMILLE);
  assert.equal(selectedMoney(), originalMoney);
  assert.equal(store.getState().speed, MAX_SPEED_PERMILLE);
  const prior = notifications;
  store.update({ notice: "Saved" });
  assert.equal(notifications, prior);
  unsubscribe();
  store.update({ notice: "Changed" });
  assert.equal(notifications, prior);
});
