import type { WorkerRequest, WorkerResponse, WorkerResult } from "./protocol.js";

interface PendingRequest {
  readonly kind: WorkerRequest["kind"];
  readonly resolve: (result: WorkerResult) => void;
  readonly reject: (error: Error) => void;
  readonly progress?: (response: Extract<WorkerResponse, { kind: "progress" }>) => void;
}

export class SimulationWorkerClient {
  private nextId = 0;
  private failure: Error | null = null;
  private readonly pending = new Map<number, PendingRequest>();

  public constructor(private readonly worker: Worker) {
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onError);
    worker.addEventListener("messageerror", this.onError);
  }

  public request<K extends WorkerRequest["kind"]>(
    kind: K,
    payload: Omit<Extract<WorkerRequest, { kind: K }>, "id" | "kind">,
    progress?: PendingRequest["progress"],
  ): Promise<Extract<WorkerResult, { kind: K }>> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, {
        kind,
        resolve: (result) => resolve(result as Extract<WorkerResult, { kind: K }>),
        reject,
        ...(progress ? { progress } : {}),
      });
      try {
        this.worker.postMessage({ ...payload, id, kind });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  public dispose(): void {
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onError);
    this.worker.removeEventListener("messageerror", this.onError);
    this.failAll(new Error("Simulation worker was stopped"));
    this.worker.terminate();
  }

  private readonly onMessage = (event: MessageEvent<WorkerResponse>): void => {
    const response = event.data;
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.failAll(new Error(`Unexpected worker response ID ${response.id}`));
      return;
    }
    if (response.kind === "progress") {
      pending.progress?.(response);
      return;
    }
    this.pending.delete(response.id);
    if (response.kind === "error") {
      pending.reject(new Error(response.message));
    } else if (response.result.kind !== pending.kind) {
      pending.reject(new Error(`Unexpected worker result: ${response.result.kind}`));
    } else {
      pending.resolve(response.result);
    }
  };

  private readonly onError = (event: Event): void => {
    this.failAll(new Error(event instanceof ErrorEvent ? event.message : "Simulation worker message failed"));
    this.worker.terminate();
  };

  private failAll(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
