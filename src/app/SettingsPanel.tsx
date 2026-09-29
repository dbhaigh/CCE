import React, { useState } from "react";
import type { SaveSlot, SlotInfo } from "./bridge.js";
import { AUTOSAVE_INTERVALS, defaultPreferences, UI_SCALES, type AppSettings } from "./preferences.js";
import { SimulationStore, PLAYBACK_SPEEDS, useSimulationSelector } from "./simulation-store.js";
import type { useSimulationLoop } from "./use-simulation-loop.js";

type Actions = ReturnType<typeof useSimulationLoop>;
type ActionRunner = (action: () => void | Promise<void> | undefined) => void;
const manualSlots = ["manual-1", "manual-2", "manual-3"] as const satisfies readonly SaveSlot[];

function slotLabel(slot: SaveSlot): string {
  return slot === "auto" ? "AUTO-SAVE" : `Manual ${slot.slice(-1)}`;
}

function savedAt(value: number | null): string {
  if (value === null) return "No recorded save time";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Invalid save time";
}

function SlotCard({ slot, info, active, ready, hasCurrentGame, actions, runAction }: {
  slot: SaveSlot;
  info: SlotInfo | undefined;
  active: boolean;
  ready: boolean;
  hasCurrentGame: boolean;
  actions: Actions;
  runAction: ActionRunner;
}) {
  const label = slotLabel(slot);
  const replaceCurrent = (source: string): boolean => !hasCurrentGame ||
    window.confirm(`Load ${source}? This replaces the current game and any unsaved progress. Save to a manual slot first if you want to keep it.`);
  return <article className="rounded-lg border border-slate-700 bg-[#0c1823] p-4" aria-label={`${label} slot`}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="font-semibold text-cyan-100">{label}</h3>
      {active && <span className="text-xs text-cyan-300">Active slot</span>}
    </div>
    {!info ? <div className="mt-2 text-sm text-amber-300">
      <p>Slot status unavailable. Reload to retry reading slots.</p>
      <button type="button" className="button mt-2" onClick={() => {
        if (!hasCurrentGame || window.confirm("Reload and retry? Any unsaved progress in the current game may be lost.")) {
          window.location.reload();
        }
      }}>Reload slot status</button>
    </div> :
      <div className="mt-2 space-y-1 text-xs text-slate-400">
        <p className={info.corrupt ? "text-rose-300" : info.exists ? "text-slate-200" : "text-slate-400"}>
          {info.corrupt ? "Corrupt save — do not overwrite until you have checked its backup" :
            info.exists ? "Saved game available" : "Empty slot"}
          {info.legacy ? " · legacy save" : ""}
        </p>
        {info.exists && <p>Saved: {savedAt(info.savedAt)} · revision {info.revision.toLocaleString()}</p>}
        <p>{info.hasBackup ? "Backup available (verified when loaded)" : "No backup available"}</p>
        {info.error && <p role="alert" className="break-words text-rose-300">Slot error: {info.error}</p>}
      </div>}
    <div className="mt-4 flex flex-wrap gap-2">
      {slot !== "auto" && <button type="button" className="button selected"
        disabled={!ready || !info}
        title={info?.corrupt ? "Load and verify the backup before replacing a corrupt primary save" : `Save the current game to ${label}`}
        onClick={() => {
          if (info?.exists && !window.confirm(info.corrupt
            ? `The ${label} primary save is corrupt. Replace it with the current game? Check its backup first; the corrupt primary may be needed for manual recovery.`
            : `Overwrite ${label}? Its previous primary save will be replaced; a backup may be retained.`)) return;
          runAction(() => actions.save(slot));
        }}>Save to {label}</button>}
      <button type="button" className="button" disabled={!info?.exists || info.corrupt}
        onClick={() => { if (replaceCurrent(label)) runAction(() => actions.loadSlot(slot)); }}>Load {label}</button>
      <button type="button" className="button" disabled={!info?.hasBackup}
        title={`Verify and load the ${label} backup into memory; save to a manual slot to keep it`}
        onClick={() => { if (replaceCurrent(`${label} backup`)) runAction(() => actions.loadSlot(slot, true)); }}>
        Restore backup
      </button>
      <button type="button" className="button" disabled={!info?.exists && !info?.hasBackup && !info?.corrupt}
        onClick={() => {
          if (window.confirm(`Delete ${label} and its backup? This cannot be undone. The current game in memory is not deleted.`)) {
            runAction(() => actions.deleteSlot(slot));
          }
        }}>Delete {label}</button>
    </div>
  </article>;
}

function PreferencesControls({ settings, introDone, actions, runAction }: {
  settings: AppSettings; introDone: boolean; actions: Actions; runAction: ActionRunner;
}) {
  return <div className="panel">
    <h3 className="font-semibold text-cyan-100">Display and playback preferences</h3>
    <p className="muted">Stored separately from the game. Theme and scale change immediately; the default speed applies next time the app starts.</p>
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <div>
        <label htmlFor="settings-default-speed" className="text-xs text-slate-300">Default playback speed</label>
        <select id="settings-default-speed" value={settings.defaultSpeed}
          onChange={(event) => runAction(() => actions.updateSettings({
            defaultSpeed: Number(event.target.value) as AppSettings["defaultSpeed"],
          }))}>
          {PLAYBACK_SPEEDS.map((speed) => <option key={speed} value={speed}>{speed === 0 ? "Paused" : `${speed / 1_000}×`}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="settings-autosave" className="text-xs text-slate-300">Auto-save interval</label>
        <select id="settings-autosave" value={settings.autosaveIntervalSeconds}
          onChange={(event) => runAction(() => actions.updateSettings({
            autosaveIntervalSeconds: Number(event.target.value) as AppSettings["autosaveIntervalSeconds"],
          }))}>
          {AUTOSAVE_INTERVALS.map((interval) => <option key={interval} value={interval}>
            {interval < 60 ? `${interval} seconds` : `${interval / 60} minute${interval === 60 ? "" : "s"}`}
          </option>)}
        </select>
      </div>
      <div>
        <label htmlFor="settings-scale" className="text-xs text-slate-300">Interface scale</label>
        <select id="settings-scale" value={settings.uiScale}
          onChange={(event) => runAction(() => actions.updateSettings({
            uiScale: Number(event.target.value) as AppSettings["uiScale"],
          }))}>
          {UI_SCALES.map((scale) => <option key={scale} value={scale}>{Math.round(scale * 100)}%</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="settings-theme" className="text-xs text-slate-300">Theme</label>
        <select id="settings-theme" value={settings.theme}
          onChange={(event) => runAction(() => actions.updateSettings({
            theme: event.target.value as AppSettings["theme"],
          }))}>
          <option value="dark">Dark</option>
          <option value="midnight">Midnight</option>
        </select>
      </div>
    </div>
    <div className="mt-4 flex flex-wrap gap-2">
      <button className="button" type="button"
        title="Rewrite preferences even when the displayed values have not changed"
        onClick={() => runAction(() => actions.updateSettings({ ...settings }))}>Re-save shown preferences</button>
      <button className="button" type="button"
        onClick={() => runAction(() => actions.updateSettings({ ...defaultPreferences }))}>
        Restore preference defaults
      </button>
      {!introDone && <button className="button" type="button"
        onClick={() => runAction(() => actions.markIntroDone())}>Mark introduction complete</button>}
    </div>
  </div>;
}

export function SettingsPanel({ store, actions }: { store: SimulationStore; actions: Actions }) {
  const [operationError, setOperationError] = useState<string | null>(null);
  const settings = useSimulationSelector(store, (state) => state.settings);
  const introDone = useSimulationSelector(store, (state) => state.introDone);
  const slotInfo = useSimulationSelector(store, (state) => state.slots);
  const active = useSimulationSelector(store, (state) => state.activeSlot);
  const ready = useSimulationSelector(store, (state) => state.ready);
  const hasCurrentGame = useSimulationSelector(store, (state) => state.view !== null);
  const recovery = useSimulationSelector(store, (state) => state.recovery);
  const runAction: ActionRunner = (action) => {
    setOperationError(null);
    try {
      void Promise.resolve(action()).catch((error: unknown) =>
        setOperationError(error instanceof Error ? error.message : String(error)));
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    }
  };
  return <section aria-label="Settings and saves" className="space-y-5">
    <div>
      <h2 className="heading">Settings & saves</h2>
      <p className="muted">Three manual save slots and a separate automatic save. Loading replaces the game in memory; preferences are independent of saves.</p>
    </div>
    {operationError && <div className="rounded-lg border border-rose-600/70 bg-rose-950/40 p-3 text-sm text-rose-100" role="alert">
      Operation failed: {operationError}. Check the slot status before retrying; you can try another slot or its backup.
    </div>}
    {recovery && <div className="rounded-xl border border-rose-600/70 bg-rose-950/40 p-4" role="alert">
      <h3 className="font-semibold text-rose-200">Save or startup recovery needed</h3>
      <p className="mt-2 break-words text-sm text-rose-100">{recovery}</p>
      <p className="mt-2 text-xs text-slate-300">Try a backup below (verified on load), another slot, or start a new game. Nothing will be erased without your confirmation.</p>
      <button type="button" className="button mt-3" onClick={() => {
        if (!hasCurrentGame || window.confirm("Reload and retry? Any unsaved progress in the current game may be lost.")) {
          window.location.reload();
        }
      }}>Reload and retry</button>
    </div>}
    <div className="panel">
      <h3 className="font-semibold text-cyan-100">Game management</h3>
      <p className="muted">Auto-save writes only to AUTO-SAVE. Manual saves never happen automatically.</p>
      <button className="button mt-3" type="button"
        onClick={() => {
          if (window.confirm("Start a new game? Current unsaved progress will be lost. Existing save slots remain available.")) {
            runAction(() => actions.newGame());
          }
        }}>New game…</button>
    </div>
    <div>
      <h3 className="mb-3 font-semibold text-cyan-100">Manual slots</h3>
      <div className="grid gap-3 lg:grid-cols-3">
        {manualSlots.map((slot) => <SlotCard key={slot} slot={slot}
          info={slotInfo.find((info) => info.slot === slot)} active={active === slot}
          hasCurrentGame={hasCurrentGame} ready={ready} actions={actions} runAction={runAction} />)}
      </div>
    </div>
    <div>
      <h3 className="mb-3 font-semibold text-cyan-100">Automatic save</h3>
      <SlotCard slot="auto" info={slotInfo.find((info) => info.slot === "auto")}
        active={active === "auto"} hasCurrentGame={hasCurrentGame} ready={ready} actions={actions} runAction={runAction} />
    </div>
    <PreferencesControls settings={settings} introDone={introDone} actions={actions} runAction={runAction} />
  </section>;
}
