import { useEffect, useMemo, useRef } from "react";
import { gameBridge, type SaveSlot } from "./bridge.js";
import { readPreferences, validateSettings, writeIntroDone, writePreferences, type AppSettings } from "./preferences.js";
import type { CommandPayload } from "./protocol.js";
import { SimulationLoop, browserLoopClock } from "./simulation-loop.js";
import type { PlaybackSpeed } from "./simulation-store.js";
import { SimulationStore } from "./simulation-store.js";
import { SimulationWorkerClient } from "./worker-client.js";

export function useSimulationLoop(store: SimulationStore) {
  const loop = useRef<SimulationLoop | null>(null);

  useEffect(() => {
    const preferences = readPreferences();
    store.update({ settings: preferences.settings, introDone: preferences.introDone });
    store.setSpeed(preferences.settings.defaultSpeed);
    const createTransport = () => new SimulationWorkerClient(
      new Worker(new URL("./simulation.worker.ts", import.meta.url), { type: "module" }),
    );
    const current = new SimulationLoop(store, createTransport(), gameBridge, browserLoopClock, createTransport);
    loop.current = current;
    void current.start().then(() => {
      if (preferences.error !== null && loop.current === current && store.getState().recovery === null) {
        store.update({ notice: preferences.error });
      }
    });
    return () => {
      current.stop();
      loop.current = null;
    };
  }, [store]);

  return useMemo(() => ({
    setSpeed: (speed: PlaybackSpeed) => loop.current?.setSpeed(speed),
    togglePause: () => loop.current?.togglePause(),
    command: (type: string, payload: CommandPayload) =>
      loop.current?.command(type, payload).catch((error: unknown) =>
        store.update({ notice: `Command failed: ${error instanceof Error ? error.message : String(error)}` })),
    save: (slot: SaveSlot = "auto") => {
      const current = loop.current;
      if (current === null) return Promise.reject(new Error("Simulation controller is not mounted"));
      return current.save(slot).catch((error: unknown) => {
        store.update({ notice: `Save failed: ${error instanceof Error ? error.message : String(error)}` });
        throw error;
      });
    },
    loadSlot: (slot: SaveSlot, backup = false) => {
      const current = loop.current;
      if (current === null) return Promise.reject(new Error("Simulation controller is not mounted"));
      return current.loadSlot(slot, backup).catch((error: unknown) => {
        store.update({ notice: `Load failed: ${error instanceof Error ? error.message : String(error)}` });
        throw error;
      });
    },
    deleteSlot: (slot: SaveSlot) => {
      const current = loop.current;
      if (current === null) return Promise.reject(new Error("Simulation controller is not mounted"));
      return current.deleteSlot(slot).catch((error: unknown) => {
        store.update({ notice: `Delete failed: ${error instanceof Error ? error.message : String(error)}` });
        throw error;
      });
    },
    newGame: () => {
      const current = loop.current;
      if (current === null) return Promise.reject(new Error("Simulation controller is not mounted"));
      return current.newGame().catch((error: unknown) => {
        store.update({ notice: `New game failed: ${error instanceof Error ? error.message : String(error)}` });
        throw error;
      });
    },
    updateSettings: (patch: Partial<AppSettings>) => {
      const settings: AppSettings = { ...store.getState().settings, ...patch };
      try {
        if (!validateSettings(settings)) throw new Error("Invalid application settings");
        writePreferences(settings);
        store.update({ settings, notice: "Settings saved" });
      } catch (error) {
        store.update({ notice: `Settings failed: ${error instanceof Error ? error.message : String(error)}` });
        throw error;
      }
    },
    markIntroDone: () => {
      try {
        writeIntroDone(true);
        store.update({ introDone: true });
      } catch (error) {
        store.update({ notice: `Introduction status could not be saved: ${
          error instanceof Error ? error.message : String(error)
        }` });
        throw error;
      }
    },
  }), [store]);
}
