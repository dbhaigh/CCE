import { SimulationWorkerRuntime } from "./worker-runtime.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

const runtime = new SimulationWorkerRuntime();

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  void runtime.submit(event.data, (progress) => self.postMessage(progress))
    .then((response: WorkerResponse) => self.postMessage(response));
});
