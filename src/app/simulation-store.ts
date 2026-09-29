import { useCallback, useSyncExternalStore } from "react";
import type { GameView } from "./game.js";
import type { SaveSlot, SlotInfo } from "./bridge.js";
import { defaultPreferences, readPreferences, type AppSettings } from "./preferences.js";
import type { OfflineSummary, PlaybackSpeed } from "./protocol.js";

export { MAX_SPEED_PERMILLE, PLAYBACK_SPEEDS } from "./protocol.js";
export type { PlaybackSpeed } from "./protocol.js";

export interface SimulationUiState {
  readonly view: GameView | null;
  readonly resourceIds: readonly string[];
  readonly notice: string;
  readonly speed: PlaybackSpeed;
  readonly lastRunningSpeed: Exclude<PlaybackSpeed, 0>;
  readonly ready: boolean;
  readonly progress: { readonly processed: number; readonly total: number } | null;
  readonly offlineSummary: OfflineSummary | null;
  readonly slots: readonly SlotInfo[];
  readonly activeSlot: SaveSlot | null;
  readonly recovery: string | null;
  readonly settings: AppSettings;
  readonly introDone: boolean;
}

export class SimulationStore {
  private state: SimulationUiState = {
    view: null,
    resourceIds: [],
    notice: "Loading empire...",
    speed: 1_000,
    lastRunningSpeed: 1_000,
    ready: false,
    progress: null,
    offlineSummary: null,
    slots: [],
    activeSlot: null,
    recovery: null,
    settings: defaultPreferences,
    introDone: false,
  };
  private readonly listeners = new Set<() => void>();

  public constructor() {
    if (typeof localStorage === "undefined") return;
    const preferences = readPreferences();
    this.state = {
      ...this.state,
      settings: preferences.settings,
      introDone: preferences.introDone,
      speed: preferences.settings.defaultSpeed,
      lastRunningSpeed: preferences.settings.defaultSpeed || 1_000,
      notice: preferences.error ?? this.state.notice,
    };
  }

  public readonly getState = (): SimulationUiState => this.state;

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  public update(patch: Partial<SimulationUiState>): void {
    if (Object.entries(patch).every(([key, value]) =>
      Object.is(this.state[key as keyof SimulationUiState], value))) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  public setView(view: GameView): void {
    const previous = this.state.view;
    const equal = (before: unknown, after: unknown): boolean => {
      if (Object.is(before, after)) return true;
      if (typeof before !== "object" || before === null ||
        typeof after !== "object" || after === null) return false;
      if (Array.isArray(before) !== Array.isArray(after)) return false;
      const left = Object.entries(before);
      const right = Object.entries(after);
      return left.length === right.length &&
        left.every(([key, value]) => equal(value, (after as Record<string, unknown>)[key]));
    };
    const retain = <T,>(before: T, after: T): T => equal(before, after) ? before : after;
    const projected = previous === null ? view : {
      ...view,
      policy: retain(previous.policy, view.policy),
      teamPolicies: retain(previous.teamPolicies, view.teamPolicies),
      defaultPolicy: retain(previous.defaultPolicy, view.defaultPolicy),
      teams: retain(previous.teams, view.teams),
      swarms: retain(previous.swarms, view.swarms),
      buildJobs: retain(previous.buildJobs, view.buildJobs),
      importantEvents: retain(previous.importantEvents, view.importantEvents),
      buildLimits: retain(previous.buildLimits, view.buildLimits),
      debtTerms: retain(previous.debtTerms, view.debtTerms),
      crisisProtocol: retain(previous.crisisProtocol, view.crisisProtocol),
      hardwareProfiles: retain(previous.hardwareProfiles, view.hardwareProfiles),
      projects: retain(previous.projects, view.projects),
      completedProjects: retain(previous.completedProjects, view.completedProjects),
      purchasedUpgrades: retain(previous.purchasedUpgrades, view.purchasedUpgrades),
      upgrades: retain(previous.upgrades, view.upgrades),
    };
    this.update({
      view: projected,
      ...(this.state.resourceIds.length === 0
        ? { resourceIds: view.resources.map((resource) => resource.id) }
        : {}),
    });
  }

  public setSpeed(speed: PlaybackSpeed): void {
    this.update({
      speed,
      ...(speed === 0 ? {} : { lastRunningSpeed: speed }),
    });
  }
}

export function useSimulationSelector<T>(
  store: SimulationStore,
  select: (state: SimulationUiState) => T,
): T {
  const getSnapshot = useCallback(() => select(store.getState()), [store, select]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
