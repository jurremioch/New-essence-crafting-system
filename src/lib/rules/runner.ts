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
  SalvageConfig,
  SalvageStage,
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

export const RESOURCE_ORDER: Resource[] = [
  "raw",
  "fine",
  "fused",
  "superior",
  "supreme",
  "rawAE",
  "rawElemental",
  "fineElemental",
  "fusedElemental",
  "superiorElemental",
  "supremeElemental",
  "fineArcane",
];

export function cloneInventory(source: Inventory): Inventory {
  const clone: Inventory = {
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
  };
  for (const key of RESOURCE_ORDER) {
    clone[key] = source[key] ?? 0;
  }
  return clone;
}

function resolveAttemptRequirement(
  inventory: Inventory,
  risk: RiskConfig,
  extraCost: number,
  optional?: OptionalCostConfig,
): ResourceMap | null {
  const available = cloneInventory(inventory);
  const requirement: ResourceMap = {};

  for (const key of Object.keys(risk.inputs) as Resource[]) {
    const need = risk.inputs[key] ?? 0;
    if (need <= 0) continue;
    if ((available[key] ?? 0) < need) {
      return null;
    }
    available[key] -= need;
    requirement[key] = (requirement[key] ?? 0) + need;
  }

  if (optional && extraCost > 0) {
    const resource = optional.resource;
    if ((available[resource] ?? 0) < extraCost) {
      return null;
    }
    available[resource] -= extraCost;
    requirement[resource] = (requirement[resource] ?? 0) + extraCost;
  }

  for (const flex of risk.flexInputs ?? []) {
    let remaining = flex.amount;
    for (const option of flex.options) {
      const usable = Math.min(remaining, available[option] ?? 0);
      if (usable > 0) {
        available[option] -= usable;
        requirement[option] = (requirement[option] ?? 0) + usable;
        remaining -= usable;
      }
      if (remaining <= 0) break;
    }
    if (remaining > 0) {
      return null;
    }
  }

  return requirement;
}

function applyRequirement(target: Inventory, requirement: ResourceMap) {
  for (const key of Object.keys(requirement) as Resource[]) {
    target[key] -= requirement[key] ?? 0;
  }
}

function resolveSalvageStages(config?: SalvageConfig): SalvageStage[] {
  if (!config) return [];
  if ("stages" in config) {
    return config.stages;
  }
  return [config];
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

export function maxFeasibleAttempts(
  inventory: Inventory,
  risk: RiskConfig,
  attempts: number,
  extraCost: number,
  optional?: OptionalCostConfig,
): number {
  const working = cloneInventory(inventory);
  let feasible = 0;

  for (let i = 0; i < attempts; i++) {
    const requirement = resolveAttemptRequirement(working, risk, extraCost, optional);
    if (!requirement) {
      break;
    }
    applyRequirement(working, requirement);
    feasible += 1;
  }

  return feasible;
}

export function runAction(options: RunOptions): ActionRunResult {
  const { action, risk, attempts, inventory, modifier, rollMode, rollStrategy, extraCost = 0 } = options;
  const finalInventory = cloneInventory(inventory);
  const results: AttemptResult[] = [];
  const allRolls: RollDetail[] = [];
  let completed = 0;
  let stoppedReason: string | undefined;

  for (let i = 0; i < attempts; i++) {
    const requirement = resolveAttemptRequirement(finalInventory, risk, extraCost, action.optionalCost);
    if (!requirement) {
      stoppedReason = "Insufficient resources";
      break;
    }

    applyRequirement(finalInventory, requirement);

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
    for (const key of Object.keys(requirement) as Resource[]) {
      delta[key] = (delta[key] ?? 0) - (requirement[key] ?? 0);
    }
    if (success) {
      for (const key of Object.keys(risk.outputs) as Resource[]) {
        const gain = risk.outputs[key] ?? 0;
        finalInventory[key] += gain;
        delta[key] = (delta[key] ?? 0) + gain;
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
      const stages = resolveSalvageStages(risk.salvage);
      const salvageRolls: RollDetail[] = [];

      for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
        const stage = stages[stageIndex];
        const salvageRoll = rollStrategy.nextSalvage();
        const salvageTotal = salvageRoll + modifier;
        const salvageSuccess = salvageTotal >= stage.dc;
        const salvage: RollDetail = {
          type: "salvage",
          tier: action.tier,
          actionId: action.id,
          riskId: risk.id,
          dc: stage.dc,
          die: salvageRoll,
          modifier,
          total: salvageTotal,
          success: salvageSuccess,
          stage: stageIndex + 1,
        };
        salvageRolls.push(salvage);
        allRolls.push(salvage);

        if (salvageSuccess) {
          for (const key of Object.keys(stage.returns) as Resource[]) {
            const gain = stage.returns[key] ?? 0;
            if (!gain) continue;
            finalInventory[key] += gain;
            attempt.inventoryDelta[key] = (attempt.inventoryDelta[key] ?? 0) + gain;
          }
          break;
        }
      }

      if (salvageRolls.length > 0) {
        attempt.salvage = salvageRolls;
      }
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
  salvageStages?: number[];
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
  const successChance = chanceWithAdv(dc, modifier, mode);
  let salvageChance: number | undefined;
  let stageChances: number[] | undefined;
  if (risk.salvage) {
    const stages = resolveSalvageStages(risk.salvage);
    stageChances = stages.map((stage) => chanceNormal(stage.dc, modifier));
    let failProduct = 1;
    for (const chance of stageChances) {
      failProduct *= 1 - chance;
    }
    salvageChance = (1 - successChance) * (1 - failProduct);
  }
  return {
    success: successChance,
    salvage: salvageChance,
    salvageStages: stageChances,
    effectiveDc: dc,
  };
}

export function computeExpectedValue(
  risk: RiskConfig,
  odds: OddsResult,
  optional: OptionalCostConfig | undefined,
  extraCost: number,
): ResourceMap {
  const { success } = odds;
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

  if (risk.salvage && (odds.salvageStages?.length ?? 0) > 0) {
    const stages = resolveSalvageStages(risk.salvage);
    let remainingFailure = 1 - success;
    stages.forEach((stage, index) => {
      const stageChance = odds.salvageStages?.[index] ?? 0;
      if (stageChance <= 0) {
        remainingFailure *= 1;
        return;
      }
      const actualChance = remainingFailure * stageChance;
      for (const key of Object.keys(stage.returns) as Resource[]) {
        const gain = stage.returns[key] ?? 0;
        if (!gain) continue;
        expectation[key] = (expectation[key] ?? 0) + gain * actualChance;
      }
      remainingFailure *= 1 - stageChance;
    });
  }

  return expectation;
}
