import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOSAVE_INTERVALS, DEFAULT_PREFERENCES, INTRO_STORAGE_KEY, PREFERENCES_STORAGE_KEY,
  defaultPreferences, readPreferences, validatePreferences, validateSettings, writeIntroDone, writePreferences,
} from "../src/app/preferences.js";
import { SimulationStore } from "../src/app/simulation-store.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test("preferences load defaults without writing any game or preference data", () => {
  const storage = memoryStorage();
  assert.equal(defaultPreferences.autosaveIntervalSeconds, 30);
  assert.deepEqual(readPreferences(storage), {
    settings: defaultPreferences, introDone: false, preferences: DEFAULT_PREFERENCES, error: null,
  });
  assert.equal(storage.getItem(PREFERENCES_STORAGE_KEY), null);
  assert.equal(storage.getItem(INTRO_STORAGE_KEY), null);
});

test("server-side preference reads do not require window or localStorage", () => {
  assert.equal(typeof window, "undefined");
  assert.equal(typeof localStorage, "undefined");
  assert.deepEqual(readPreferences(), {
    settings: defaultPreferences, introDone: false, preferences: DEFAULT_PREFERENCES, error: null,
  });
  assert.deepEqual(new SimulationStore().getState().settings, defaultPreferences);
});

test("preferences validate all allowed values and reject corrupt or extra game data", () => {
  const valid = { ...defaultPreferences, defaultSpeed: 0, uiScale: 1.25, theme: "midnight",
    autosaveIntervalSeconds: 15, introCompleted: true };
  assert.equal(validatePreferences(valid), true);
  assert.equal(validateSettings(defaultPreferences), true);
  assert.equal(AUTOSAVE_INTERVALS.length, 5);
  for (const invalid of [
    null, [], {}, { ...valid, defaultSpeed: 3_000 }, { ...valid, uiScale: 1.2 },
    { ...valid, theme: "light" }, { ...valid, autosaveIntervalSeconds: 1_000 },
    { ...valid, introCompleted: "true" }, { ...valid, simulation: { tick: 1 } },
  ]) assert.equal(validatePreferences(invalid), false);
  assert.equal(validateSettings({ ...defaultPreferences, simulation: { tick: 1 } }), false);
});

test("preferences persist theme, speed, scale, interval and intro completion independently", () => {
  const storage = memoryStorage();
  const updated = { ...defaultPreferences, defaultSpeed: 5_000 as const, uiScale: 1.1 as const,
    theme: "midnight" as const, autosaveIntervalSeconds: 120 as const };
  writePreferences(updated, storage);
  writeIntroDone(true, storage);
  assert.deepEqual(readPreferences(storage), { settings: updated, introDone: true,
    preferences: { ...updated, introCompleted: true }, error: null });
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(PREFERENCES_STORAGE_KEY) ?? "{}")).sort(),
    ["defaultSpeed", "uiScale", "theme", "autosaveIntervalSeconds"].sort());
  writeIntroDone(false, storage);
  assert.equal(readPreferences(storage).introDone, false);
  assert.deepEqual(readPreferences(storage).settings, updated);
  assert.equal(storage.getItem("code-compiler-empire.save"), null);
});

test("invalid stored preferences report errors without overwriting the stored value", () => {
  const storage = memoryStorage();
  for (const raw of ["{", JSON.stringify({ ...defaultPreferences, uiScale: 12 })]) {
    storage.setItem(PREFERENCES_STORAGE_KEY, raw);
    const result = readPreferences(storage);
    assert.deepEqual(result.preferences, DEFAULT_PREFERENCES);
    assert.match(result.error ?? "", /settings/);
    assert.equal(storage.getItem(PREFERENCES_STORAGE_KEY), raw);
  }
  storage.setItem(INTRO_STORAGE_KEY, "not-a-boolean");
  assert.match(readPreferences(storage).error ?? "", /introduction status/);
  assert.equal(storage.getItem(INTRO_STORAGE_KEY), "not-a-boolean");
  assert.throws(() => writePreferences({ ...defaultPreferences, uiScale: 20 } as never, storage),
    /invalid application settings/);
  assert.throws(() => writeIntroDone("yes" as never, storage), /must be a boolean/);
});

test("blocked preference storage reports read errors and propagates write errors", () => {
  const denied = new Error("Storage denied");
  const result = readPreferences({ getItem: () => { throw denied; } });
  assert.deepEqual(result.preferences, DEFAULT_PREFERENCES);
  assert.match(result.error ?? "", /Storage denied/);
  assert.throws(() => writePreferences(defaultPreferences, { setItem: () => { throw denied; } }), /Storage denied/);
  assert.throws(() => writeIntroDone(true, { setItem: () => { throw denied; } }), /Storage denied/);
});
