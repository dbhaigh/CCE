import { PLAYBACK_SPEEDS, type PlaybackSpeed } from "./protocol.js";

export interface AppSettings {
  readonly defaultSpeed: PlaybackSpeed;
  readonly uiScale: 0.9 | 1 | 1.1 | 1.25;
  readonly theme: "dark" | "midnight";
  readonly autosaveIntervalSeconds: 15 | 30 | 60 | 120 | 300;
}

export interface AppPreferences extends AppSettings {
  readonly introCompleted: boolean;
}

export const PREFERENCES_STORAGE_KEY = "code-compiler-empire.preferences";
export const INTRO_STORAGE_KEY = "code-compiler-empire.introDone";
export const UI_SCALES = [0.9, 1, 1.1, 1.25] as const;
export const AUTOSAVE_INTERVALS = [15, 30, 60, 120, 300] as const;
export const defaultPreferences: AppSettings = Object.freeze({
  defaultSpeed: 1_000,
  uiScale: 1,
  theme: "dark",
  autosaveIntervalSeconds: 30,
});
export const DEFAULT_PREFERENCES: AppPreferences = Object.freeze({
  ...defaultPreferences,
  introCompleted: false,
});

export function validateSettings(value: unknown): value is AppSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expected = ["defaultSpeed", "uiScale", "theme", "autosaveIntervalSeconds"];
  return Object.keys(record).length === expected.length &&
    expected.every((key) => Object.hasOwn(record, key)) &&
    PLAYBACK_SPEEDS.some((speed) => speed === record.defaultSpeed) &&
    UI_SCALES.some((scale) => scale === record.uiScale) &&
    (record.theme === "dark" || record.theme === "midnight") &&
    AUTOSAVE_INTERVALS.some((interval) => interval === record.autosaveIntervalSeconds);
}

export function validatePreferences(value: unknown): value is AppPreferences {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!Object.hasOwn(value, "introCompleted")) return false;
  const { introCompleted, ...settings } = value as AppPreferences;
  return typeof introCompleted === "boolean" && validateSettings(settings);
}

export interface PreferencesReadResult {
  readonly settings: AppSettings;
  readonly introDone: boolean;
  readonly preferences: AppPreferences;
  readonly error: string | null;
}

export function readPreferences(storage?: Pick<Storage, "getItem">): PreferencesReadResult {
  if (storage === undefined && typeof window === "undefined" && typeof localStorage === "undefined") {
    return { settings: defaultPreferences, introDone: false, preferences: DEFAULT_PREFERENCES, error: null };
  }
  let settings: AppSettings = defaultPreferences;
  let introDone = false;
  const errors: string[] = [];
  try {
    const source = storage ?? localStorage;
    const rawSettings = source.getItem(PREFERENCES_STORAGE_KEY);
    if (rawSettings !== null) {
      try {
        const parsed: unknown = JSON.parse(rawSettings);
        if (validateSettings(parsed)) settings = parsed;
        else errors.push("Stored settings are invalid; defaults are shown without changing stored data.");
      } catch (error) {
        errors.push(`Stored settings could not be parsed: ${error instanceof Error ? error.message : String(error)}. Defaults are shown without changing stored data.`);
      }
    }
    const rawIntro = source.getItem(INTRO_STORAGE_KEY);
    if (rawIntro === "true") introDone = true;
    else if (rawIntro !== null && rawIntro !== "false") {
      errors.push("Stored introduction status is invalid; the introduction will be shown without changing stored data.");
    }
  } catch (error) {
    errors.push(`Preferences could not be read: ${error instanceof Error ? error.message : String(error)}. Unavailable values use defaults without changing stored data.`);
  }
  return { settings, introDone, preferences: { ...settings, introCompleted: introDone },
    error: errors.length > 0 ? errors.join(" ") : null };
}

export function writePreferences(settings: AppSettings, storage: Pick<Storage, "setItem"> = localStorage): void {
  if (!validateSettings(settings)) throw new Error("Cannot save invalid application settings");
  storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(settings));
}

export function writeIntroDone(done: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
  if (typeof done !== "boolean") throw new Error("Introduction completion must be a boolean");
  storage.setItem(INTRO_STORAGE_KEY, String(done));
}
