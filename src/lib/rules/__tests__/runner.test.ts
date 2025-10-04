import { describe, expect, it } from "vitest";
import { chanceWithAdv } from "@/lib/rules/probability";
import {
  computeEffectiveDc,
  computeExpectedValue,
  computeOdds,
  maxFeasibleAttempts,
} from "@/lib/rules/runner";
import type { OptionalCostConfig, RiskConfig } from "@/lib/rules/types";

const baseRisk: RiskConfig = {
  id: "standard",
  label: "Standard",
  baseDc: 18,
  description: "",
  inputs: { fused: 2 },
  outputs: { superior: 1 },
  salvage: { dc: 14, returns: { fine: 3 } },
  timeMinutes: 120,
};

const optional: OptionalCostConfig = {
  resource: "rawAE",
  label: "RawAE",
  perUnitDcReduction: 4,
  minDc: 5,
};

describe("computeEffectiveDc", () => {
  it("clamps to minimum DC", () => {
    expect(computeEffectiveDc(baseRisk, 0, optional)).toBe(18);
    expect(computeEffectiveDc(baseRisk, 1, optional)).toBe(14);
    expect(computeEffectiveDc(baseRisk, 4, optional)).toBe(5);
    expect(computeEffectiveDc(baseRisk, 10, optional)).toBe(5);
  });
});

describe("maxFeasibleAttempts", () => {
  it("accounts for multiple resources and optional costs", () => {
    const inventory = { raw: 0, fine: 0, fused: 10, superior: 0, supreme: 0, rawAE: 3 };
    expect(maxFeasibleAttempts(inventory, baseRisk, 5, 1, optional)).toBe(3);
    expect(maxFeasibleAttempts(inventory, baseRisk, 5, 0, optional)).toBe(5);
  });
});

describe("chanceWithAdv", () => {
  it("remains within [0, 1] for advantage modes", () => {
    const dcs = [1, 10, 20, 30];
    const modifiers = [-5, 0, 5, 15];
    const modes = ["normal", "adv", "dis"] as const;
    for (const dc of dcs) {
      for (const mod of modifiers) {
        for (const mode of modes) {
          const chance = chanceWithAdv(dc, mod, mode);
          expect(chance).toBeGreaterThanOrEqual(0);
          expect(chance).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe("computeExpectedValue", () => {
  it("combines success and salvage expectations", () => {
    const odds = computeOdds(baseRisk, 6, "normal", 1, optional);
    const expectation = computeExpectedValue(baseRisk, odds, optional, 1);
    expect(expectation.superior).toBeGreaterThan(0);
    expect(expectation.fused).toBeLessThan(0);
    expect(expectation.rawAE).toBe(-1);
  });
});
