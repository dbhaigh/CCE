import {
  Simulation,
  type SimulationConfiguration,
  type SimulationSnapshot,
} from "./simulation.js";
import { cloneJson } from "./types.js";
import { contentHash } from "./content.js";
import { INITIAL_DEMAND_BACKLOG, MAX_DEMAND_BACKLOG, Resources } from "./resources.js";
import { COMPILATION_SYSTEM_ID, ORGANIZATION_SYSTEM_ID, RESEARCH_SYSTEM_ID,
  SOURCE_GENERATION_SYSTEM_ID } from "./layers/ids.js";
import { RESEARCH_UPGRADES } from "./layers/knowledge-research.js";
import { SAVE_FORMAT, SAVE_FORMAT_VERSION } from "./save-format.js";

export { SAVE_FORMAT, SAVE_FORMAT_VERSION } from "./save-format.js";
export const CURRENT_SNAPSHOT_VERSION = 6;

export interface SaveEnvelope {
  readonly format: typeof SAVE_FORMAT;
  readonly formatVersion: typeof SAVE_FORMAT_VERSION;
  readonly checksum: string;
  readonly snapshot: SimulationSnapshot;
}

type UnknownRecord = Record<string, unknown>;
type SnapshotMigration = (snapshot: UnknownRecord) => UnknownRecord;

const migrations = new Map<number, SnapshotMigration>([
  [
    1,
    (snapshot) => ({
      ...snapshot,
      schemaVersion: 2,
      nextEventSequence: snapshot.nextEventSequence ?? 1,
      pendingEvents: snapshot.pendingEvents ?? [],
    }),
  ],
  [
    2,
    (snapshot) => ({
      ...snapshot,
      schemaVersion: 3,
      pendingEvents: normalizeEvents(snapshot.pendingEvents, "nextTick"),
      durableEvents: normalizeEvents(snapshot.durableEvents, "durable"),
    }),
  ],
  [
    3,
    (snapshot) => migrateArtifactPolicy(snapshot),
  ],
  [
    4,
    (snapshot) => ({ ...snapshot, schemaVersion: 5, importantEvents: [] }),
  ],
  [
    5,
    (snapshot) => {
      const resources = isRecord(snapshot.resources) ? snapshot.resources : {};
      const states = isRecord(snapshot.systemStates) ? snapshot.systemStates : {};
      const researchValue = states[RESEARCH_SYSTEM_ID];
      const buildValue = states[COMPILATION_SYSTEM_ID];
      const research = isRecord(researchValue) ? researchValue : {};
      const build = isRecord(buildValue) ? buildValue : {};
      const inFlight = [Resources.Source, Resources.Binaries, Resources.Releases].reduce(
        (total, id) => total + (typeof resources[id] === "number" ? resources[id] : 0), 0);
      return {
        ...snapshot,
        schemaVersion: 6,
        resources: { ...resources, [Resources.Demand]: resources[Resources.Demand] ??
          Math.min(MAX_DEMAND_BACKLOG, Math.max(INITIAL_DEMAND_BACKLOG, inFlight)) },
        systemStates: {
          ...states,
          [RESEARCH_SYSTEM_ID]: { ...research, purchasedUpgrades: research.purchasedUpgrades ?? [] },
          [COMPILATION_SYSTEM_ID]: {
            ...build,
            jobs: Array.isArray(build.jobs)
              ? build.jobs.map((job) => isRecord(job) ? { ...job, sourceTeamId: job.sourceTeamId ?? null } : job)
              : build.jobs ?? [],
          },
        },
      };
    },
  ],
]);

export function encodeSave(
  simulation: Simulation,
  wallClockSavedAt: number,
): string {
  const snapshot = simulation.serialize(wallClockSavedAt);
  const envelope: SaveEnvelope = {
    format: SAVE_FORMAT,
    formatVersion: SAVE_FORMAT_VERSION,
    checksum: contentHash(snapshot),
    snapshot,
  };
  return JSON.stringify(envelope);
}

export function decodeSave(
  configuration: SimulationConfiguration,
  serialized: string,
): Simulation {
  return decodeSaveWithMetadata(configuration, serialized).simulation;
}

export function decodeSaveWithMetadata(
  configuration: SimulationConfiguration,
  serialized: string,
): { readonly simulation: Simulation; readonly wallClockSavedAt: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      `Save data is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const snapshotInput = extractSnapshot(parsed);
  const snapshot = migrateSnapshot(snapshotInput);
  const compatibleSnapshot = configuration.gameVersion === "0.0.1" &&
    snapshot.gameVersion === "0.1.0" &&
    snapshot.contentHash === configuration.contentHash
    ? { ...snapshot, gameVersion: configuration.gameVersion }
    : snapshot;
  return {
    simulation: Simulation.restore(configuration, compatibleSnapshot),
    wallClockSavedAt: compatibleSnapshot.wallClockSavedAt,
  };
}

export function migrateSnapshot(input: unknown): SimulationSnapshot {
  if (!isRecord(input)) {
    throw new Error("Save snapshot must be an object");
  }
  let snapshot = cloneJson(input);
  let version = integerField(snapshot, "schemaVersion");
  if (version < 1 || version > CURRENT_SNAPSHOT_VERSION) {
    throw new Error(`Unsupported snapshot schema ${version}`);
  }
  while (version < CURRENT_SNAPSHOT_VERSION) {
    const migration = migrations.get(version);
    if (migration === undefined) {
      throw new Error(`No migration registered for snapshot schema ${version}`);
    }
    snapshot = migration(snapshot);
    const nextVersion = integerField(snapshot, "schemaVersion");
    if (nextVersion !== version + 1) {
      throw new Error(
        `Migration ${version} produced invalid schema ${nextVersion}`,
      );
    }
    version = nextVersion;
  }
  validateCurrentSnapshot(snapshot);
  return snapshot as unknown as SimulationSnapshot;
}

function extractSnapshot(parsed: unknown): unknown {
  if (!isRecord(parsed) || parsed.format !== SAVE_FORMAT) {
    return parsed;
  }
  if (parsed.formatVersion !== SAVE_FORMAT_VERSION) {
    throw new Error(`Unsupported save format version ${String(parsed.formatVersion)}`);
  }
  if (typeof parsed.checksum !== "string") {
    throw new Error("Save envelope has no checksum");
  }
  const actual = contentHash(parsed.snapshot);
  if (actual !== parsed.checksum) {
    throw new Error("Save checksum mismatch");
  }
  return parsed.snapshot;
}

function validateCurrentSnapshot(snapshot: UnknownRecord): void {
  for (const field of [
    "schemaVersion",
    "tick",
    "tickDurationMs",
    "scaledTimeRemainder",
    "nextEventSequence",
    "wallClockSavedAt",
  ]) {
    const value = integerField(snapshot, field);
    if (value < 0) {
      throw new Error(`Snapshot ${field} cannot be negative`);
    }
  }
  if (snapshot.schemaVersion !== CURRENT_SNAPSHOT_VERSION) {
    throw new Error(`Snapshot migration did not reach the current schema`);
  }
  if (snapshot.tickDurationMs === 0) {
    throw new Error("Snapshot tickDurationMs must be positive");
  }
  if (snapshot.nextEventSequence === 0) {
    throw new Error("Snapshot nextEventSequence must be positive");
  }
  for (const field of ["gameVersion", "contentHash", "seed"]) {
    if (typeof snapshot[field] !== "string") {
      throw new Error(`Snapshot ${field} must be a string`);
    }
  }
  for (const field of ["resources", "systemStates"]) {
    if (!isRecord(snapshot[field])) {
      throw new Error(`Snapshot ${field} must be an object`);
    }
    for (const [resource, amount] of Object.entries(
      snapshot.resources as UnknownRecord,
    )) {
      if (typeof amount !== "number" || !Number.isSafeInteger(amount)) {
        throw new Error(`Snapshot resource ${resource} must be a safe integer`);
      }
    }
  }
  for (const field of ["queuedCommands", "pendingEvents", "durableEvents"]) {
    if (!Array.isArray(snapshot[field])) {
      throw new Error(`Snapshot ${field} must be an array`);
    }
    if (!Array.isArray(snapshot.importantEvents) || snapshot.importantEvents.length > 64) {
      throw new Error("Snapshot importantEvents must contain at most 64 events");
    }
  }
  for (const command of snapshot.queuedCommands as unknown[]) {
    if (
      !isRecord(command) ||
      typeof command.id !== "string" ||
      typeof command.type !== "string" ||
      typeof command.issuedAt !== "number" ||
      !Number.isSafeInteger(command.issuedAt)
    ) {
      throw new Error("Snapshot contains an invalid command");
    }
  }
  const states = snapshot.systemStates as UnknownRecord;
  if (states[SOURCE_GENERATION_SYSTEM_ID] !== undefined) {
    const demand = (snapshot.resources as UnknownRecord)[Resources.Demand];
    if (typeof demand !== "number" || !Number.isSafeInteger(demand) ||
      demand < 0 || demand > MAX_DEMAND_BACKLOG) {
      throw new Error("Snapshot market demand is missing or invalid");
    }
  }
  const research = states[RESEARCH_SYSTEM_ID];
  if (isRecord(research) && (!Array.isArray(research.purchasedUpgrades) ||
    research.purchasedUpgrades.some((id) => typeof id !== "string" ||
      !RESEARCH_UPGRADES.some((upgrade) => upgrade.id === id &&
        Array.isArray(research.completed) && research.completed.includes(upgrade.projectId))) ||
    new Set(research.purchasedUpgrades).size !== research.purchasedUpgrades.length)) {
    throw new Error("Snapshot research upgrades are invalid");
  }
  const organization = states[ORGANIZATION_SYSTEM_ID];
  const teamIds = isRecord(organization) && Array.isArray(organization.teams)
    ? organization.teams.filter(isRecord).map((team) => team.id) : [];
  const build = states[COMPILATION_SYSTEM_ID];
  if (isRecord(build) && Array.isArray(build.jobs) && build.jobs.some(
    (job) => !isRecord(job) || (job.sourceTeamId !== null &&
      (typeof job.sourceTeamId !== "string" || !teamIds.includes(job.sourceTeamId))))) {
    throw new Error("Snapshot build job source team is invalid");
  }
  for (const event of [
    ...(snapshot.pendingEvents as unknown[]),
    ...(snapshot.durableEvents as unknown[]),
    ...(snapshot.importantEvents as unknown[]),
  ]) {
    if (
      !isRecord(event) ||
      typeof event.type !== "string" ||
      typeof event.sourceSystem !== "string" ||
      typeof event.sequence !== "number" ||
      !Number.isSafeInteger(event.sequence) ||
      typeof event.tick !== "number" ||
      !Number.isSafeInteger(event.tick) ||
      !["sameTick", "nextTick", "durable"].includes(String(event.delivery))
    ) {
      throw new Error("Snapshot contains an invalid queued event");
    }
    for (const event of [
      ...(snapshot.pendingEvents as unknown[]),
      ...(snapshot.durableEvents as unknown[]),
    ]) {
      if (isRecord(event) && event.delivery === "sameTick") {
        throw new Error("Queued save events cannot have same-tick delivery");
      }
    }
  }
}

function normalizeEvents(
  value: unknown,
  delivery: "nextTick" | "durable",
): readonly unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Snapshot event queue must be an array");
  }
  return value.map((event) => {
    if (!isRecord(event)) {
      throw new Error("Snapshot event must be an object");
    }
    return { ...event, delivery: event.delivery ?? delivery };
  });
}

function migrateArtifactPolicy(snapshot: UnknownRecord): UnknownRecord {
  const states = isRecord(snapshot.systemStates)
    ? cloneJson(snapshot.systemStates)
    : {};
  const organization = isRecord(states["organization.capacity"])
    ? states["organization.capacity"]
    : {};
  const policy = isRecord(organization.policy) ? organization.policy : {};
  const review =
    typeof policy.reviewStrengthPermille === "number"
      ? policy.reviewStrengthPermille
      : 500;
  const testing =
    typeof policy.testStrengthPermille === "number"
      ? policy.testStrengthPermille
      : 500;
  for (const [systemId, cohortField] of [
    ["build.compilation", "sourceCohorts"],
    ["testing.verification", "binaryCohorts"],
    ["runtime.deployment", "releaseCohorts"],
  ] as const) {
    const state = states[systemId];
    if (isRecord(state) && Array.isArray(state[cohortField])) {
      states[systemId] = {
        ...state,
        [cohortField]: state[cohortField].map((cohort) =>
          withArtifactPolicy(cohort, review, testing),
        ),
      };
    }
  }
  return {
    ...snapshot,
    schemaVersion: 4,
    systemStates: states,
    pendingEvents: migrateEventPolicies(
      snapshot.pendingEvents,
      review,
      testing,
    ),
    durableEvents: migrateEventPolicies(
      snapshot.durableEvents,
      review,
      testing,
    ),
  };
}

function migrateEventPolicies(
  events: unknown,
  review: number,
  testing: number,
): readonly unknown[] {
  if (!Array.isArray(events)) {
    return [];
  }
  return events.map((event) => {
    if (!isRecord(event) || !isRecord(event.payload)) {
      return event;
    }
    const payload = event.payload;
    return {
      ...event,
      payload: {
        ...payload,
        ...(payload.artifact === undefined
          ? {}
          : {
              artifact: withArtifactPolicy(
                payload.artifact,
                review,
                testing,
              ),
            }),
        ...(Array.isArray(payload.artifacts)
          ? {
              artifacts: payload.artifacts.map((artifact) =>
                withArtifactPolicy(artifact, review, testing),
              ),
            }
          : {}),
      },
    };
  });
}

function withArtifactPolicy(
  cohort: unknown,
  review: number,
  testing: number,
): unknown {
  return isRecord(cohort)
    ? {
        ...cohort,
        reviewStrengthPermille:
          cohort.reviewStrengthPermille ?? review,
        testStrengthPermille: cohort.testStrengthPermille ?? testing,
      }
    : cohort;
}

function integerField(record: UnknownRecord, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Snapshot ${field} must be a safe integer`);
  }
  return value;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
