import type { JsonObject } from "../types.js";

export interface SourceArtifactCohort extends JsonObject {
  readonly id: string;
  readonly quantity: number;
  readonly humanPermille: number;
  readonly debtRiskPermille: number;
  readonly codingStandardsPermille: number;
  readonly reviewStrengthPermille: number;
  readonly testStrengthPermille: number;
  readonly riskTolerancePermille: number;
  readonly releaseCadencePermille: number;
  readonly teamId: string;
  readonly createdTick: number;
}

export interface BinaryArtifactCohort extends JsonObject {
  readonly id: string;
  readonly quantity: number;
  readonly latentDefects: number;
  readonly buildConfidencePermille: number;
  readonly reviewStrengthPermille: number;
  readonly testStrengthPermille: number;
  readonly riskTolerancePermille: number;
  readonly releaseCadencePermille: number;
  readonly createdTick: number;
}

export interface ReleaseArtifactCohort extends JsonObject {
  readonly id: string;
  readonly quantity: number;
  readonly residualDefects: number;
  readonly confidencePermille: number;
  readonly reviewStrengthPermille: number;
  readonly testStrengthPermille: number;
  readonly riskTolerancePermille: number;
  readonly releaseCadencePermille: number;
  readonly createdTick: number;
}

export interface DebtCohort extends JsonObject {
  readonly categoryId: string;
  readonly principal: number;
}

export interface ArtifactPolicy extends JsonObject {
  readonly codingStandardsPermille: number;
  readonly reviewStrengthPermille: number;
  readonly testStrengthPermille: number;
  readonly riskTolerancePermille: number;
  readonly releaseCadencePermille: number;
}

export interface SourceWorkAllocation extends JsonObject {
  readonly teamId: string;
  readonly capacity: number;
  readonly policy: ArtifactPolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseSourceArtifact(
  value: unknown,
): SourceArtifactCohort | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isSafeNonNegativeInteger(value.quantity) ||
    !isSafeNonNegativeInteger(value.humanPermille) ||
    !isSafeNonNegativeInteger(value.debtRiskPermille) ||
    !isSafeNonNegativeInteger(value.codingStandardsPermille) ||
    !isSafeNonNegativeInteger(value.reviewStrengthPermille) ||
    !isSafeNonNegativeInteger(value.testStrengthPermille) ||
    !isSafeNonNegativeInteger(value.riskTolerancePermille) ||
    !isSafeNonNegativeInteger(value.releaseCadencePermille) ||
    typeof value.teamId !== "string" ||
    !isSafeNonNegativeInteger(value.createdTick)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    quantity: value.quantity,
    humanPermille: value.humanPermille,
    debtRiskPermille: value.debtRiskPermille,
    codingStandardsPermille: value.codingStandardsPermille,
    reviewStrengthPermille: value.reviewStrengthPermille,
    testStrengthPermille: value.testStrengthPermille,
    riskTolerancePermille: value.riskTolerancePermille,
    releaseCadencePermille: value.releaseCadencePermille,
    teamId: value.teamId,
    createdTick: value.createdTick,
  };
}

export function parseBinaryArtifact(
  value: unknown,
): BinaryArtifactCohort | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isSafeNonNegativeInteger(value.quantity) ||
    !isSafeNonNegativeInteger(value.latentDefects) ||
    !isSafeNonNegativeInteger(value.buildConfidencePermille) ||
    !isSafeNonNegativeInteger(value.reviewStrengthPermille) ||
    !isSafeNonNegativeInteger(value.testStrengthPermille) ||
    !isSafeNonNegativeInteger(value.riskTolerancePermille) ||
    !isSafeNonNegativeInteger(value.releaseCadencePermille) ||
    !isSafeNonNegativeInteger(value.createdTick)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    quantity: value.quantity,
    latentDefects: value.latentDefects,
    buildConfidencePermille: value.buildConfidencePermille,
    reviewStrengthPermille: value.reviewStrengthPermille,
    testStrengthPermille: value.testStrengthPermille,
    riskTolerancePermille: value.riskTolerancePermille,
    releaseCadencePermille: value.releaseCadencePermille,
    createdTick: value.createdTick,
  };
}

export function parseReleaseArtifact(
  value: unknown,
): ReleaseArtifactCohort | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isSafeNonNegativeInteger(value.quantity) ||
    !isSafeNonNegativeInteger(value.residualDefects) ||
    !isSafeNonNegativeInteger(value.confidencePermille) ||
    !isSafeNonNegativeInteger(value.reviewStrengthPermille) ||
    !isSafeNonNegativeInteger(value.testStrengthPermille) ||
    !isSafeNonNegativeInteger(value.riskTolerancePermille) ||
    !isSafeNonNegativeInteger(value.releaseCadencePermille) ||
    !isSafeNonNegativeInteger(value.createdTick)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    quantity: value.quantity,
    residualDefects: value.residualDefects,
    confidencePermille: value.confidencePermille,
    reviewStrengthPermille: value.reviewStrengthPermille,
    testStrengthPermille: value.testStrengthPermille,
    riskTolerancePermille: value.riskTolerancePermille,
    releaseCadencePermille: value.releaseCadencePermille,
    createdTick: value.createdTick,
  };
}

export function payloadField(
  payload: unknown,
  field: string,
): unknown {
  return isRecord(payload) ? payload[field] : undefined;
}

export function parseSourceWorkAllocations(
  value: unknown,
): readonly SourceWorkAllocation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.teamId !== "string" ||
      !isSafeNonNegativeInteger(candidate.capacity) ||
      !isRecord(candidate.policy) ||
      !isSafeNonNegativeInteger(
        candidate.policy.codingStandardsPermille,
      ) ||
      !isSafeNonNegativeInteger(candidate.policy.reviewStrengthPermille) ||
      !isSafeNonNegativeInteger(candidate.policy.testStrengthPermille) ||
      !isSafeNonNegativeInteger(candidate.policy.riskTolerancePermille) ||
      !isSafeNonNegativeInteger(candidate.policy.releaseCadencePermille)
    ) {
      return [];
    }
    return [{
      teamId: candidate.teamId,
      capacity: candidate.capacity,
      policy: {
        codingStandardsPermille:
          candidate.policy.codingStandardsPermille,
        reviewStrengthPermille:
          candidate.policy.reviewStrengthPermille,
        testStrengthPermille:
          candidate.policy.testStrengthPermille,
        riskTolerancePermille:
          candidate.policy.riskTolerancePermille,
        releaseCadencePermille:
          candidate.policy.releaseCadencePermille,
      },
    }];
  });
}

export function appendBoundedCohort<T extends JsonObject>(
  cohorts: readonly T[],
  cohort: T,
  maximumCohorts: number,
  canMerge: (left: T, right: T) => boolean,
  merge: (left: T, right: T) => T,
  compact: (left: T, right: T) => T,
): readonly T[] {
  const last = cohorts.at(-1);
  const appended =
    last !== undefined && canMerge(last, cohort)
      ? [...cohorts.slice(0, -1), merge(last, cohort)]
      : [...cohorts, cohort];
  if (appended.length <= maximumCohorts) {
    return appended;
  }
  for (let index = 0; index < appended.length - 1; index += 1) {
    const left = appended[index];
    const right = appended[index + 1];
    if (left !== undefined && right !== undefined && canMerge(left, right)) {
      return [
        ...appended.slice(0, index),
        merge(left, right),
        ...appended.slice(index + 2),
      ];
    }
  }
  const [first, second, ...rest] = appended;
  return first === undefined || second === undefined
    ? appended
    : [compact(first, second), ...rest];
}

export function weightedPermille(
  leftValue: number,
  leftQuantity: number,
  rightValue: number,
  rightQuantity: number,
): number {
  const quantity = leftQuantity + rightQuantity;
  return quantity === 0
    ? 0
    : Math.floor(
        (leftValue * leftQuantity + rightValue * rightQuantity) / quantity,
      );
}

export function totalCohortQuantity(
  cohorts: readonly { readonly quantity: number }[],
): number {
  return cohorts.reduce((total, cohort) => total + cohort.quantity, 0);
}

export function assertCohortConservation(
  resourceName: string,
  resourceQuantity: number,
  cohorts: readonly { readonly quantity: number }[],
): void {
  const cohortQuantity = totalCohortQuantity(cohorts);
  if (cohortQuantity !== resourceQuantity) {
    throw new Error(
      `${resourceName} cohort quantity ${cohortQuantity} does not match resource quantity ${resourceQuantity}`,
    );
  }
}
