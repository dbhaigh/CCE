import { pipelineId, systemId } from "../types.js";

export const ORGANIZATION_LAYER_ID = pipelineId("layer.organization");
export const SOURCE_LAYER_ID = pipelineId("layer.source-generation");
export const BUILD_LAYER_ID = pipelineId("layer.build-compilation");
export const TESTING_LAYER_ID = pipelineId("layer.testing-verification");
export const RUNTIME_LAYER_ID = pipelineId("layer.runtime-deployment");
export const KNOWLEDGE_LAYER_ID = pipelineId("layer.knowledge-research");
export const TECHNICAL_DEBT_LAYER_ID = pipelineId(
  "layer.technical-debt-maintenance",
);
export const AUTOMATION_LAYER_ID = pipelineId("layer.self-improving-automation");
export const CRISIS_LAYER_ID = pipelineId("layer.crisis-response");

export const ORGANIZATION_SYSTEM_ID = systemId("organization.capacity");
export const SOURCE_GENERATION_SYSTEM_ID = systemId("source.generation");
export const HARDWARE_SYSTEM_ID = systemId("build.hardware");
export const COMPILATION_SYSTEM_ID = systemId("build.compilation");
export const TESTING_SYSTEM_ID = systemId("testing.verification");
export const RUNTIME_SYSTEM_ID = systemId("runtime.deployment");
export const INCIDENT_RESPONSE_SYSTEM_ID = systemId(
  "runtime.incident-response",
);
export const RESEARCH_SYSTEM_ID = systemId("research.knowledge");
export const TECHNICAL_DEBT_SYSTEM_ID = systemId("debt.maintenance");
export const AUTOMATION_SYSTEM_ID = systemId("automation.closed-loop");
export const CRISIS_SYSTEM_ID = systemId("crisis.response");
