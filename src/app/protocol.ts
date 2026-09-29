import type { CommandResult, CrisisProtocol, OrganizationPolicy } from "../simulation/index.js";
import type { GameView } from "./game.js";

export const MAX_SPEED_PERMILLE = 10_000;
export type PlaybackSpeed = 0 | 1_000 | 2_000 | 5_000 | typeof MAX_SPEED_PERMILLE;
export const PLAYBACK_SPEEDS: readonly PlaybackSpeed[] = [0, 1_000, 2_000, 5_000, MAX_SPEED_PERMILLE];
export type CommandPayload = Record<string, string | number | boolean | null | OrganizationPolicy | CrisisProtocol>;
export type SnapshotCatchUp =
  | { readonly kind: "foreground"; readonly elapsedMilliseconds: number; readonly speedPermille: number }
  | { readonly kind: "offline"; readonly savedAt: number };

export type WorkerRequest =
  | { readonly id: number; readonly kind: "initialize"; readonly save: string | null; readonly now: number }
  | { readonly id: number; readonly kind: "advance"; readonly elapsedMilliseconds: number; readonly speedPermille: number }
  | { readonly id: number; readonly kind: "offline"; readonly savedAt: number; readonly now: number }
  | { readonly id: number; readonly kind: "command"; readonly commandType: string; readonly payload: CommandPayload }
  | { readonly id: number; readonly kind: "snapshot"; readonly now: number; readonly catchUp?: SnapshotCatchUp };

export interface OfflineSummary {
  readonly elapsedMilliseconds: number;
  readonly requestedTicks: number;
  readonly ticksProcessed: number;
  readonly exactTicksProcessed: number;
  readonly analyticalTicksSkipped: number;
  readonly discardedTicks: number;
  readonly capped: boolean;
  readonly remainder: number;
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly commandResults: readonly CommandResult[];
}

export type WorkerResult =
  | { readonly kind: "initialize"; readonly view: GameView; readonly offline: OfflineSummary | null }
  | { readonly kind: "advance"; readonly view: GameView | null; readonly commandResults: readonly CommandResult[] }
  | { readonly kind: "offline"; readonly view: GameView; readonly offline: OfflineSummary }
  | { readonly kind: "command"; readonly view: GameView; readonly commandResult: CommandResult }
  | {
      readonly kind: "snapshot";
      readonly data: string;
      readonly view: GameView | null;
      readonly offline: OfflineSummary | null;
    };

export type WorkerResponse =
  | { readonly id: number; readonly kind: "result"; readonly result: WorkerResult }
  | { readonly id: number; readonly kind: "error"; readonly message: string }
  | {
      readonly id: number;
      readonly kind: "progress";
      readonly phase: "offline" | "advance";
      readonly ticksProcessed: number;
      readonly requestedTicks: number;
    };
