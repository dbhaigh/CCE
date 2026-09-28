import type { SimTick, SystemId } from "./types.js";

const UINT32_RANGE = 0x1_0000_0000;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class DeterministicRandom {
  public constructor(
    private readonly seed: string,
    private readonly tick: SimTick,
    private readonly system: SystemId,
  ) {}

  public unit(key: string, ordinal = 0): number {
    return fnv1a(`${this.seed}|${this.tick}|${this.system}|${key}|${ordinal}`) /
      UINT32_RANGE;
  }

  public integer(key: string, minimum: number, maximum: number, ordinal = 0): number {
    if (
      !Number.isSafeInteger(minimum) ||
      !Number.isSafeInteger(maximum) ||
      maximum < minimum
    ) {
      throw new RangeError("Random integer bounds must be ordered safe integers");
    }
    return minimum + Math.floor(this.unit(key, ordinal) * (maximum - minimum + 1));
  }

  public chance(key: string, probabilityPermille: number, ordinal = 0): boolean {
    if (probabilityPermille < 0 || probabilityPermille > 1_000) {
      throw new RangeError("Probability must be between 0 and 1000 permille");
    }
    return this.integer(key, 1, 1_000, ordinal) <= probabilityPermille;
  }
}
