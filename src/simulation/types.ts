export type Brand<T, Name extends string> = T & {
  readonly __brand: Name;
};

export type ResourceId = Brand<string, "ResourceId">;
export type SystemId = Brand<string, "SystemId">;
export type PipelineId = Brand<string, "PipelineId">;
export type SimTick = Brand<number, "SimTick">;

export type JsonPrimitive = boolean | number | string | null;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | JsonObject;

export type DeepReadonly<T> =
  T extends JsonPrimitive
    ? T
    : T extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export const resourceId = (value: string): ResourceId => value as ResourceId;
export const systemId = (value: string): SystemId => value as SystemId;
export const pipelineId = (value: string): PipelineId => value as PipelineId;
export const simTick = (value: number): SimTick => value as SimTick;

export function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer, received ${value}`);
  }
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as object)) {
      deepFreeze(child);
    }
  }

  return value as DeepReadonly<T>;
}
