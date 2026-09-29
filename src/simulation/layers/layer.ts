import type {
  CommandHandler,
  EventHandler,
  SimulationSystem,
} from "../contracts.js";
import type { PipelineDefinition } from "../pipeline.js";
import type { PipelineId } from "../types.js";

export interface SimulationLayer {
  readonly id: PipelineId;
  readonly name: string;
  readonly pipeline: PipelineDefinition;
  readonly systems: readonly SimulationSystem[];
  readonly commandHandlers: readonly CommandHandler[];
  readonly eventHandlers: readonly EventHandler[];
  readonly feedbackLoops: readonly string[];
  readonly performanceNotes: readonly string[];
}

export interface ComposedLayers {
  readonly systems: readonly SimulationSystem[];
  readonly pipelines: readonly PipelineDefinition[];
  readonly commandHandlers: readonly CommandHandler[];
  readonly eventHandlers: readonly EventHandler[];
  readonly contentHash?: string;
}

export function composeLayers(
  layers: readonly SimulationLayer[],
  contentHash?: string,
): ComposedLayers {
  const ids = new Set<PipelineId>();
  for (const layer of layers) {
    if (ids.has(layer.id)) {
      throw new Error(`Duplicate layer: ${layer.id}`);
    }
    if (layer.pipeline.id !== layer.id) {
      throw new Error(`Layer ${layer.id} has mismatched pipeline metadata`);
    }
    ids.add(layer.id);
  }

  return {
    systems: layers.flatMap((layer) => layer.systems),
    pipelines: layers.map((layer) => layer.pipeline),
    commandHandlers: layers.flatMap((layer) => layer.commandHandlers),
    eventHandlers: layers.flatMap((layer) => layer.eventHandlers),
    ...(contentHash === undefined ? {} : { contentHash }),
  };
}
