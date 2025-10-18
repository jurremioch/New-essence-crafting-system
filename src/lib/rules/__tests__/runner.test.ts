import { describe, expect, it } from "vitest";
import { chanceWithAdv } from "@/lib/rules/probability";
import {
  computeEffectiveDc,
  computeExpectedValue,
  computeOdds,
  maxFeasibleAttempts,
  runAction,
} from "@/lib/rules/runner";
import type { ActionConfig, Inventory, OptionalCostConfig, RiskConfig } from "@/lib/rules/types";

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

const makeInventory = (patch: Partial<Inventory> = {}): Inventory => ({
  raw: 0,
  fine: 0,
  fused: 0,
  superior: 0,
  supreme: 0,
  rawAE: 0,
  rawElemental: 0,
  fineElemental: 0,
  fusedElemental: 0,
  superiorElemental: 0,
  supremeElemental: 0,
  fineArcane: 0,
  ...patch,
});

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
    const inventory = makeInventory({ fused: 10, rawAE: 3 });
    expect(maxFeasibleAttempts(inventory, baseRisk, 5, 1, optional)).toBe(3);
    expect(maxFeasibleAttempts(inventory, baseRisk, 5, 0, optional)).toBe(5);
  });

  it("returns all attempts when there are no costs", () => {
    const freeRisk: RiskConfig = {
      ...baseRisk,
      inputs: {},
    };
    const inventory = makeInventory();
    expect(maxFeasibleAttempts(inventory, freeRisk, 4, 0, undefined)).toBe(4);
  });

  it("uses combined resource requirements across inputs and optional cost", () => {
    const sharedResourceRisk: RiskConfig = {
      ...baseRisk,
      inputs: { fused: 2 },
    };
    const sharedOptional: OptionalCostConfig = {
      resource: "fused",
      label: "Extra Fused",
      perUnitDcReduction: 1,
      minDc: 10,
    };
    const inventory = makeInventory({ fused: 5 });
    expect(maxFeasibleAttempts(inventory, sharedResourceRisk, 10, 1, sharedOptional)).toBe(1);
  });

  it("respects flex inputs when computing feasibility", () => {
    const flexRisk: RiskConfig = {
      ...baseRisk,
      inputs: { rawElemental: 1 },
      outputs: { fineElemental: 1 },
      salvage: undefined,
      flexInputs: [
        {
          id: "raw-any",
          label: "Raw essence (any family)",
          amount: 1,
          options: ["raw", "rawElemental"],
        },
      ],
    };
    const inventory = makeInventory({ rawElemental: 2, raw: 2 });
    expect(maxFeasibleAttempts(inventory, flexRisk, 5, 0, undefined)).toBe(2);
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

describe("runAction staged salvage", () => {
  const stagedAction: ActionConfig = {
    id: "staged",
    tier: "T5",
    title: "Test",
    subtitle: "",
    gradient: { from: "", to: "" },
    risks: [
      {
        id: "staged",
        label: "Staged",
        baseDc: 24,
        inputs: { superiorElemental: 1, fusedElemental: 1 },
        outputs: { supremeElemental: 1 },
        salvage: {
          stages: [
            { dc: 22, returns: { superiorElemental: 1 } },
            { dc: 18, returns: { fusedElemental: 1 } },
          ],
        },
        timeMinutes: 120,
      },
    ],
  };

  it("applies staged salvage sequentially", () => {
    const risk = stagedAction.risks[0];
    const strategy = {
      salvageRolls: [5, 18],
      nextCheckPair: (): [number, number] => [1, 1],
      nextSalvage() {
        return this.salvageRolls.shift() ?? 1;
      },
    };

    const result = runAction({
      action: stagedAction,
      risk,
      attempts: 1,
      inventory: makeInventory({ superiorElemental: 1, fusedElemental: 1 }),
      modifier: 0,
      rollMode: "normal",
      rollStrategy: strategy,
      extraCost: 0,
    });

    expect(result.attempts).toHaveLength(1);
    const attempt = result.attempts[0];
    const stages = Array.isArray(attempt.salvage) ? attempt.salvage : [];
    expect(stages).toHaveLength(2);
    expect(stages[0].success).toBe(false);
    expect(stages[1].success).toBe(true);
    expect(result.finalInventory.fusedElemental).toBe(1);
    expect(result.finalInventory.superiorElemental).toBe(0);
  });
});
