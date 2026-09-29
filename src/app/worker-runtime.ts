import {
  decodeSaveWithMetadata,
  type CommandResult,
  type OfflineAdvanceResult,
  type Simulation,
} from "../simulation/index.js";
import { configuration, getGameView, issueCommand, newGame, saveGame } from "./game.js";
import { MAX_SPEED_PERMILLE, type OfflineSummary, type WorkerRequest, type WorkerResponse, type WorkerResult } from "./protocol.js";
import { ResourceRateSampler } from "./resource-rates.js";

const chunkTicks = 256;
const progressIntervalMs = 100;

function yieldToMessages(): Promise<void> {
  if (typeof MessageChannel === "undefined") {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

function mergeCounts(target: Record<string, number>, source: Readonly<Record<string, number>>) {
  for (const [type, count] of Object.entries(source)) {
    target[type] = (target[type] ?? 0) + count;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SimulationWorkerRuntime {
  private game: Simulation | null = null;
  private resourceRates = new ResourceRateSampler();
  private fatalError: Error | null = null;
  private tail: Promise<void> = Promise.resolve();

  public submit(
    request: WorkerRequest,
    emit: (response: WorkerResponse) => void = () => {},
    yieldControl: () => Promise<void> = yieldToMessages,
  ): Promise<WorkerResponse> {
    const response = this.tail.then(
      async (): Promise<WorkerResponse> => {
        try {
          const result = await this.handle(request, emit, yieldControl);
          return { id: request.id, kind: "result", result };
        } catch (error) {
          if (request.kind === "initialize" || request.kind === "advance" || request.kind === "offline" ||
            (request.kind === "snapshot" && request.catchUp !== undefined)) {
            this.fatalError = error instanceof Error ? error : new Error(message(error));
          }
          return { id: request.id, kind: "error", message: message(error) };
        }
      },
    );
    this.tail = response.then(() => undefined);
    return response;
  }

  private currentGame(): Simulation {
    if (this.game === null) throw new Error("Simulation is not initialized");
    return this.game;
  }

  private async handle(
    request: WorkerRequest,
    emit: (response: WorkerResponse) => void,
    yieldControl: () => Promise<void>,
  ): Promise<WorkerResult> {
    switch (request.kind) {
      case "initialize": {
        this.fatalError = null;
        let offline: OfflineSummary | null = null;
        if (request.save === null) {
          this.game = newGame();
        } else {
          const { simulation, wallClockSavedAt } = decodeSaveWithMetadata(configuration, request.save);
          this.game = simulation;
          simulation.enableResourceFlowTelemetry();
          this.resourceRates = new ResourceRateSampler();
          getGameView(simulation, this.resourceRates);
          offline = await this.advanceOffline(request.id, wallClockSavedAt, request.now, emit, yieldControl);
        }
        if (request.save === null) this.resourceRates = new ResourceRateSampler();
        this.currentGame().enableResourceFlowTelemetry();
        return { kind: "initialize", view: getGameView(this.currentGame(), this.resourceRates), offline };
      }
      case "advance": {
        const game = this.currentGame();
        const previousTick = game.tick;
        const commandResults = await this.advanceRealTime(
          request.id, request.elapsedMilliseconds, request.speedPermille, emit, yieldControl,
        );
        return {
          kind: "advance",
          view: game.tick === previousTick ? null : getGameView(game, this.resourceRates),
          commandResults,
        };
      }
      case "offline":
        return {
          kind: "offline",
          offline: await this.advanceOffline(request.id, request.savedAt, request.now, emit, yieldControl),
          view: getGameView(this.currentGame(), this.resourceRates),
        };
      case "command": {
        const game = this.currentGame();
        const commandResult = issueCommand(game, request.commandType, request.payload);
        return { kind: "command", view: getGameView(game, this.resourceRates), commandResult };
      }
      case "snapshot": {
        if (this.fatalError !== null) {
          throw new Error(`Cannot save after failed advancement: ${this.fatalError.message}`);
        }
        const game = this.currentGame();
        const previousTick = game.tick;
        let offline: OfflineSummary | null = null;
        if (request.catchUp?.kind === "foreground") {
          const results = await this.advanceRealTime(
            request.id, request.catchUp.elapsedMilliseconds,
            request.catchUp.speedPermille, emit, yieldControl,
          );
          const rejected = results.find((result) => !result.accepted);
          if (rejected) throw new Error(rejected.reason ?? "Command rejected during save");
        } else if (request.catchUp?.kind === "offline") {
          offline = await this.advanceOffline(
            request.id, request.catchUp.savedAt, request.now, emit, yieldControl,
          );
          const rejected = offline.commandResults.find((result) => !result.accepted);
          if (rejected) throw new Error(rejected.reason ?? "Command rejected during save");
        }
        return {
          kind: "snapshot",
          data: saveGame(game, request.now),
          view: game.tick === previousTick ? null : getGameView(game, this.resourceRates),
          offline,
        };
      }
    }
  }

  private async advanceRealTime(
    id: number,
    elapsedMilliseconds: number,
    speedPermille: number,
    emit: (response: WorkerResponse) => void,
    yieldControl: () => Promise<void>,
  ): Promise<CommandResult[]> {
    if (!Number.isSafeInteger(speedPermille) || speedPermille < 0 ||
      speedPermille > MAX_SPEED_PERMILLE) {
      throw new RangeError(`Speed must be between 0 and ${MAX_SPEED_PERMILLE}`);
    }
    const game = this.currentGame();
    const commandResults: CommandResult[] = [];
    const tickDuration = configuration.tickDurationMs ?? 1_000;
    const chunkMilliseconds = speedPermille === 0
      ? elapsedMilliseconds
      : Math.max(1, Math.floor((chunkTicks * tickDuration * 1_000) / speedPermille));
    let remaining = elapsedMilliseconds;
    do {
      const elapsed = Math.min(remaining, chunkMilliseconds);
      const result = game.advanceRealTime(elapsed, speedPermille);
      commandResults.push(...result.commandResults);
      remaining -= elapsed;
      if (remaining > 0) {
        emit({
          kind: "progress", id, phase: "advance",
          ticksProcessed: game.tick,
          requestedTicks: game.tick + Math.ceil((remaining * speedPermille) / (tickDuration * 1_000)),
        });
        await yieldControl();
      }
    } while (remaining > 0);
    return commandResults;
  }

  private async advanceOffline(
    id: number,
    savedAt: number,
    now: number,
    emit: (response: WorkerResponse) => void,
    yieldControl: () => Promise<void>,
  ): Promise<OfflineSummary> {
    const game = this.currentGame();
    const elapsedMilliseconds = Math.max(0, now - savedAt);
    const tickDuration = configuration.tickDurationMs ?? 1_000;
    const remainder = game.timeRemainder;
    const requestedTicks = Math.floor((remainder + elapsedMilliseconds * 1_000) / (tickDuration * 1_000));
    const eventCounts: Record<string, number> = {};
    const commandResults: CommandResult[] = [];
    let ticksProcessed = 0;
    let exactTicksProcessed = 0;
    let analyticalTicksSkipped = 0;
    let discardedTicks = 0;
    let capped = false;
    let currentRemainder = remainder;
    let cursor = savedAt;
    let lastProgressAt = 0;

    do {
      const next = Math.min(now, cursor + chunkTicks * tickDuration);
      const report: OfflineAdvanceResult = game.advanceOffline(cursor, next);
      ticksProcessed += report.ticksProcessed;
      exactTicksProcessed += report.exactTicksProcessed;
      analyticalTicksSkipped += report.analyticalTicksSkipped;
      discardedTicks += report.discardedTicks;
      capped ||= report.capped;
      currentRemainder = report.remainder;
      commandResults.push(...report.commandResults);
      mergeCounts(eventCounts, report.eventCounts);
      cursor = next;
      if (cursor < now) {
        const timestamp = Date.now();
        if (timestamp - lastProgressAt >= progressIntervalMs) {
          emit({ id, kind: "progress", phase: "offline", ticksProcessed, requestedTicks });
          lastProgressAt = timestamp;
        }
        await yieldControl();
      }
    } while (cursor < now);
    emit({ id, kind: "progress", phase: "offline", ticksProcessed, requestedTicks });
    return {
      elapsedMilliseconds, requestedTicks, ticksProcessed, exactTicksProcessed,
      analyticalTicksSkipped, discardedTicks, capped, remainder: currentRemainder,
      eventCounts, commandResults,
    };
  }
}
