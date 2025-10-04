import type { AdvMode } from "./types";

export function clampInt(value: number, min = 0): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.trunc(value));
}

export function chanceNormal(dc: number, modifier: number): number {
  const required = dc - modifier;
  const minRoll = Math.max(1, Math.ceil(required));
  const successFaces = 21 - minRoll;
  const probability = successFaces / 20;
  if (required <= 1) return 1;
  if (required > 20) return 0;
  return Math.min(1, Math.max(0, probability));
}

export function chanceWithAdv(dc: number, modifier: number, mode: AdvMode): number {
  const base = chanceNormal(dc, modifier);
  switch (mode) {
    case "adv":
      return 1 - (1 - base) ** 2;
    case "dis":
      return base ** 2;
    default:
      return base;
  }
}

export interface AdvantageRoll {
  roll: number;
  other: number;
}

export function pickAdvantage({ roll, other }: AdvantageRoll, mode: AdvMode): number {
  if (mode === "adv") {
    return Math.max(roll, other);
  }
  if (mode === "dis") {
    return Math.min(roll, other);
  }
  return roll;
}
