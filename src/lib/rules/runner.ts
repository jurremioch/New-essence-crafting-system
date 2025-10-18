import { chanceNormal, chanceWithAdv, pickAdvantage } from "./probability";
import type {
  ActionConfig,
  ActionRunResult,
  AdvMode,
  AttemptResult,
  Inventory,
  OptionalCostConfig,
  Resource,
  ResourceMap,
  RiskConfig,
  RollDetail,
} from "./types";

export interface RollStrategy {
  nextCheckPair(): [number, number];
  nextSalvage(): number;
}

export interface RunOptions {
  action: ActionConfig;
  risk: RiskConfig;
  attempts: number;
  inventory: Inventory;
  modifier: number;
  rollMode: AdvMode;
  rollStrategy: RollStrategy;
  extraCost?: number;
}

export const RESOURCE_ORDER: Resource[] = ["raw", "fine", "fused", "superior", "supreme", "rawAE"];

export function cloneInventory(source: Inventory): Inventory {
  const clone: Inventory = { raw: 0, fine: 0, fused: 0, superior: 0, supreme: 0, rawAE: 0 };
  for (const key of RESOURCE_ORDER) {
    clone[key] = source[key] ?? 0;
  }
  return clone;
}

export function computeEffectiveDc(risk: RiskConfig, extraCost: number, optional?: OptionalCostConfig): number {
  if (!optional || extraCost <= 0) {
    return risk.baseDc;
  }
  const reduction = extraCost * optional.perUnitDcReduction;
  return Math.max(optional.minDc, risk.baseDc - reduction);
}

export function totalRequirements(risk: RiskConfig, attempts: number, extraCost: number, optional?: OptionalCostConfig): ResourceMap {
  const requirements: ResourceMap = {};
  for (const key of Object.keys(risk.inputs) as Resource[]) {
    requirements[key] = (risk.inputs[key] ?? 0) * attempts;
  }
  if (optional && extraCost > 0) {
    requirements[optional.resource] = (requirements[optional.resource] ?? 0) + extraCost * attempts;
  }
  return requirements;
}

export function maxFeasibleAttempts(inventory: Inventory, risk: RiskConfig, attempts: number, extraCost: number, optional?: OptionalCostConfig): number {
  const perAttempt = totalRequirements(risk, 1, extraCost, optional);
  let feasible = attempts;
  let hasCost = false;

  for (const key of Object.keys(perAttempt) as Resource[]) {
    const cost = perAttempt[key] ?? 0;
    if (cost <= 0) {
      continue;
    }

    hasCost = true;
    const available = inventory[key] ?? 0;
    feasible = Math.min(feasible, Math.floor(available / cost));
  }

  if (!hasCost) {
    return Math.max(0, attempts);
  }

  return Math.max(0, feasible);
}

function requirementMet(inventory: Inventory, delta: ResourceMap): boolean {
  for (const key of Object.keys(delta) as Resource[]) {
    const need = delta[key] ?? 0;
    if (need <= 0) continue;
    if ((inventory[key] ?? 0) < need) {
      return false;
    }
  }
  return true;
}

export function runAction(options: RunOptions): ActionRunResult {
  const { action, risk, attempts, inventory, modifier, rollMode, rollStrategy, extraCost = 0 } = options;
  const finalInventory = cloneInventory(inventory);
  const results: AttemptResult[] = [];
  const allRolls: RollDetail[] = [];
  let completed = 0;
  let stoppedReason: string | undefined;

  for (let i = 0; i < attempts; i++) {
    const requirement = totalRequirements(risk, 1, extraCost, action.optionalCost);
    if (!requirementMet(finalInventory, requirement)) {
      stoppedReason = "Insufficient resources";
      break;
    }

    // consume inputs
    for (const key of Object.keys(risk.inputs) as Resource[]) {
      finalInventory[key] -= risk.inputs[key] ?? 0;
    }
    if (action.optionalCost && extraCost > 0) {
      finalInventory[action.optionalCost.resource] -= extraCost;
    }

    const [rollA, rollB] = rollStrategy.nextCheckPair();
    const pick = pickAdvantage({ roll: rollA, other: rollB }, rollMode);
    const effectiveDc = computeEffectiveDc(risk, extraCost, action.optionalCost);
    const total = pick + modifier;
    const success = total >= effectiveDc;

    const check: RollDetail = {
      type: "check",
      tier: action.tier,
      actionId: action.id,
      riskId: risk.id,
      dc: effectiveDc,
      die: pick,
      modifier,
      total,
      success,
    };

    const delta: ResourceMap = {};
    if (success) {
      for (const key of Object.keys(risk.outputs) as Resource[]) {
        const gain = risk.outputs[key] ?? 0;
        finalInventory[key] += gain;
        delta[key] = (delta[key] ?? 0) + gain;
      }
    } else {
      for (const key of Object.keys(risk.salvage?.returns ?? {}) as Resource[]) {
        const salvageAmount = risk.salvage?.returns[key] ?? 0;
        delta[key] = (delta[key] ?? 0) + 0; // placeholder to ensure key exists
      }
    }

    const attempt: AttemptResult = {
      attempt: i + 1,
      riskId: risk.id,
      dc: risk.baseDc,
      effectiveDc,
      success,
      timeMinutes: risk.timeMinutes,
      check,
      inventoryDelta: { ...delta },
    };

    allRolls.push(check);

    if (!success && risk.salvage) {
      const salvageRoll = rollStrategy.nextSalvage();
      const salvageTotal = salvageRoll + modifier;
      const salvageSuccess = salvageTotal >= risk.salvage.dc;
      const salvage: RollDetail = {
        type: "salvage",
        tier: action.tier,
        actionId: action.id,
        riskId: risk.id,
        dc: risk.salvage.dc,
        die: salvageRoll,
        modifier,
        total: salvageTotal,
        success: salvageSuccess,
      };
      attempt.salvage = salvage;
      allRolls.push(salvage);

      if (salvageSuccess) {
        for (const key of Object.keys(risk.salvage.returns) as Resource[]) {
          const gain = risk.salvage.returns[key] ?? 0;
          finalInventory[key] += gain;
          attempt.inventoryDelta[key] = (attempt.inventoryDelta[key] ?? 0) + gain;
        }
      }
    }

    for (const key of Object.keys(risk.inputs) as Resource[]) {
      const spent = risk.inputs[key] ?? 0;
      attempt.inventoryDelta[key] = (attempt.inventoryDelta[key] ?? 0) - spent;
    }
    if (action.optionalCost && extraCost > 0) {
      attempt.inventoryDelta[action.optionalCost.resource] =
        (attempt.inventoryDelta[action.optionalCost.resource] ?? 0) - extraCost;
    }

    results.push(attempt);
    completed += 1;
  }

  const summary = {
    attemptsRequested: attempts,
    attemptsCompleted: completed,
    stoppedReason,
    totalTime: results.reduce((sum, item) => sum + item.timeMinutes, 0),
  };

  return {
    attempts: results,
    finalInventory,
    rolls: allRolls,
    summary,
    requirementMet: !stoppedReason,
  };
}

export interface OddsResult {
  success: number;
  salvage?: number;
  effectiveDc: number;
}

export function computeOdds(
  risk: RiskConfig,
  modifier: number,
  mode: AdvMode,
  extraCost: number,
  optional?: OptionalCostConfig,
): OddsResult {
  const dc = computeEffectiveDc(risk, extraCost, optional);
  return {
    success: chanceWithAdv(dc, modifier, mode),
    salvage: risk.salvage ? chanceNormal(risk.salvage.dc, modifier) : undefined,
    effectiveDc: dc,
  };
}

export function computeExpectedValue(
  risk: RiskConfig,
  odds: OddsResult,
  optional: OptionalCostConfig | undefined,
  extraCost: number,
): ResourceMap {
  const { success, salvage } = odds;
  const expectation: ResourceMap = {};

  for (const key of Object.keys(risk.inputs) as Resource[]) {
    const spent = risk.inputs[key] ?? 0;
    if (spent) expectation[key] = (expectation[key] ?? 0) - spent;
  }

  if (optional && extraCost > 0) {
    expectation[optional.resource] = (expectation[optional.resource] ?? 0) - extraCost;
  }

  for (const key of Object.keys(risk.outputs) as Resource[]) {
    const gain = risk.outputs[key] ?? 0;
    if (gain) expectation[key] = (expectation[key] ?? 0) + gain * success;
  }

  if (risk.salvage && salvage !== undefined) {
    for (const key of Object.keys(risk.salvage.returns) as Resource[]) {
      const gain = risk.salvage.returns[key] ?? 0;
      if (!gain) continue;
      const salvageChance = (1 - success) * salvage;
      expectation[key] = (expectation[key] ?? 0) + gain * salvageChance;
    }
  }

  return expectation;
}
