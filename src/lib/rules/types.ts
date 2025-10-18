export type Resource =
  | "raw"
  | "fine"
  | "fused"
  | "superior"
  | "supreme"
  | "rawAE"
  | "rawElemental"
  | "fineElemental"
  | "fusedElemental"
  | "superiorElemental"
  | "supremeElemental"
  | "fineArcane";

export type Tier = "T1" | "T2" | "T3" | "T4" | "T5";

export type EssenceFamily = "natural" | "elemental";

export type Inventory = Record<Resource, number>;

export type RiskId = "low" | "standard" | "high" | string;

export type AdvMode = "normal" | "adv" | "dis";

export interface ResourceMap extends Partial<Record<Resource, number>> {}

export interface SalvageStage {
  dc: number;
  returns: ResourceMap;
  label?: string;
}

export type SalvageConfig = SalvageStage | { stages: SalvageStage[] };

export interface FlexInputConfig {
  id: string;
  label: string;
  amount: number;
  options: Resource[];
}

export interface ToolRequirement {
  id: "greater" | string;
  label: string;
  description?: string;
}

export interface RiskConfig {
  id: RiskId;
  label: string;
  description?: string;
  baseDc: number;
  inputs: ResourceMap;
  outputs: ResourceMap;
  salvage?: SalvageConfig;
  flexInputs?: FlexInputConfig[];
  toolRequirement?: ToolRequirement;
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
  tier: Tier;
  title: string;
  subtitle: string;
  gradient: { from: string; to: string };
  risks: RiskConfig[];
  optionalCost?: OptionalCostConfig;
  family?: EssenceFamily;
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
  stage?: number;
}

export interface AttemptResult {
  attempt: number;
  riskId: RiskId;
  dc: number;
  effectiveDc: number;
  success: boolean;
  timeMinutes: number;
  check: RollDetail;
  salvage?: RollDetail | RollDetail[];
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
