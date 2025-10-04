export type Resource = "raw" | "fine" | "fused" | "superior" | "supreme" | "rawAE";

export type Inventory = Record<Resource, number>;

export type RiskId = "low" | "standard" | "high" | string;

export type AdvMode = "normal" | "adv" | "dis";

export interface ResourceMap extends Partial<Record<Resource, number>> {}

export interface SalvageConfig {
  dc: number;
  returns: ResourceMap;
}

export interface RiskConfig {
  id: RiskId;
  label: string;
  description?: string;
  baseDc: number;
  inputs: ResourceMap;
  outputs: ResourceMap;
  salvage?: SalvageConfig;
  timeMinutes: number;
}

export interface OptionalCostConfig {
  resource: Resource;
  label: string;
  perUnitDcReduction: number;
  minDc: number;
}

export interface ActionConfig {
  id: string;
  tier: string;
  title: string;
  subtitle: string;
  gradient: { from: string; to: string };
  risks: RiskConfig[];
  optionalCost?: OptionalCostConfig;
}

export interface RollDetail {
  type: "check" | "salvage";
  tier: string;
  actionId: string;
  riskId: RiskId;
  dc: number;
  die: number;
  modifier: number;
  total: number;
  success: boolean;
}

export interface AttemptResult {
  attempt: number;
  riskId: RiskId;
  dc: number;
  effectiveDc: number;
  success: boolean;
  timeMinutes: number;
  check: RollDetail;
  salvage?: RollDetail;
  inventoryDelta: ResourceMap;
  stopped?: boolean;
}

export interface RunSummary {
  attemptsRequested: number;
  attemptsCompleted: number;
  stoppedReason?: string;
  totalTime: number;
}

export interface ActionRunResult {
  attempts: AttemptResult[];
  finalInventory: Inventory;
  rolls: RollDetail[];
  summary: RunSummary;
  requirementMet: boolean;
}
