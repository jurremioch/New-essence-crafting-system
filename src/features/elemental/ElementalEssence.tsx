import { Fragment, useMemo, useRef, useState } from "react";
import { Dice4, Play, RefreshCw, Undo2 } from "lucide-react";
import { DiceOverlay, type OverlayEntry } from "@/components/DiceOverlay";
import { RecentRolls, type RollLogEntry } from "@/components/RecentRolls";
import { usePersistentState } from "@/lib/hooks/usePersistentState";
import {
  computeEffectiveDc,
  computeExpectedValue,
  computeOdds,
  maxFeasibleAttempts,
  runAction,
} from "@/lib/rules/runner";
import type { ActionConfig, Inventory, Resource, ResourceMap, RollDetail } from "@/lib/rules/types";
import { ELEMENTAL_ACTIONS } from "./elementalRules";
import type { AdvMode } from "@/lib/rules/types";
import { clampInt } from "@/lib/rules/probability";

const STORAGE_KEY = "elemental-essence-state-v1";

interface LogEntry {
  id: string;
  title: string;
  details: string;
  timestamp: number;
}

interface UndoSnapshot {
  inventory: Inventory;
  log: LogEntry[];
  rolls: RollLogEntry[];
  sessionMinutes: number;
}

interface Settings {
  craftingMod: number;
  autoRoll: boolean;
  rollMode: AdvMode;
  animateDice: boolean;
  traySize: number;
  manualChecks: string;
  manualSalvage: string;
  toolkit: "standard" | "greater";
}

interface PersistedState {
  inventory: Inventory;
  settings: Settings;
  log: LogEntry[];
  rolls: RollLogEntry[];
  sessionMinutes: number;
  undoSnapshot: UndoSnapshot | null;
}

const DEFAULT_INVENTORY: Inventory = {
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

const DEFAULT_SETTINGS: Settings = {
  craftingMod: 0,
  autoRoll: true,
  rollMode: "normal",
  animateDice: true,
  traySize: 12,
  manualChecks: "",
  manualSalvage: "",
  toolkit: "standard",
};

const DEFAULT_STATE: PersistedState = {
  inventory: DEFAULT_INVENTORY,
  settings: DEFAULT_SETTINGS,
  log: [],
  rolls: [],
  sessionMinutes: 0,
  undoSnapshot: null,
};

const RESOURCE_LABELS: Record<Resource, string> = {
  raw: "Raw",
  fine: "Fine",
  fused: "Fused",
  superior: "Superior",
  supreme: "Supreme",
  rawAE: "RawAE",
  rawElemental: "Raw EE",
  fineElemental: "Fine EE",
  fusedElemental: "Fused EE",
  superiorElemental: "Superior EE",
  supremeElemental: "Supreme EE",
  fineArcane: "Fine Arcane",
};

interface ActionUiState {
  riskId: string;
  batch: number;
  extra: number;
}

interface ManualQueues {
  checks: number[];
  salvage: number[];
}

interface RequirementInfo {
  static: ResourceMap;
  optional: ResourceMap;
  flex: { label: string; amount: number; options: Resource[] }[];
}

const ROLL_LIMIT = 200;
const LOG_LIMIT = 200;

const rollD20 = () => Math.floor(Math.random() * 20) + 1;

const formatPercent = (value: number) => `${Math.round(value * 100)}%`;

const formatTime = (minutes: number) => `${minutes}m`;

const parseManualQueue = (input: string): number[] => {
  if (!input.trim()) return [];
  return input
    .split(/[\s,]+/)
    .map((token) => Number.parseInt(token, 10))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => clampInt(value, 1));
};

const parseInventoryPreset = (input: string): number[] => {
  if (!input.trim()) return [];
  return input
    .split(/[\s,]+/)
    .map((token) => Number.parseInt(token, 10))
    .filter((value) => Number.isFinite(value))
    .map((value) => clampInt(value, 0));
};

const RESOURCE_ORDER: Resource[] = [
  "rawElemental",
  "fineElemental",
  "fusedElemental",
  "superiorElemental",
  "supremeElemental",
  "rawAE",
  "fineArcane",
  "raw",
  "fine",
  "fused",
];

const PROGRESSION_TIERS = ["Raw EE", "Fine EE", "Fused EE", "Superior EE", "Supreme EE"];

function buildInitialUiState(): Record<string, ActionUiState> {
  const state: Record<string, ActionUiState> = {};
  for (const action of ELEMENTAL_ACTIONS) {
    state[action.id] = {
      riskId: action.risks[0].id,
      batch: 1,
      extra: 0,
    };
  }
  return state;
}

function buildRequirementInfo(
  action: ActionConfig,
  risk: typeof action.risks[number],
  batch: number,
  extra: number,
): RequirementInfo {
  const staticCost: ResourceMap = {};
  for (const key of Object.keys(risk.inputs) as Resource[]) {
    const value = (risk.inputs[key] ?? 0) * batch;
    if (value) staticCost[key] = value;
  }

  const optionalCost: ResourceMap = {};
  if (action.optionalCost && extra > 0) {
    const cost = extra * batch;
    optionalCost[action.optionalCost.resource] = cost;
  }

  const flex = (risk.flexInputs ?? []).map((flexInput) => ({
    label: flexInput.label,
    amount: flexInput.amount * batch,
    options: flexInput.options,
  }));

  return { static: staticCost, optional: optionalCost, flex };
}

function inventoryToString(delta: ResourceMap): string {
  const parts: string[] = [];
  for (const key of RESOURCE_ORDER) {
    const change = delta[key];
    if (!change) continue;
    const label = RESOURCE_LABELS[key];
    const prefix = change > 0 ? "+" : "";
    parts.push(`${prefix}${change} ${label}`);
  }
  return parts.join(", ");
}

function cloneInventory(value: Inventory): Inventory {
  return { ...value };
}

function describeAttempt(roll: RollDetail, salvage?: RollDetail | RollDetail[], delta?: ResourceMap): string {
  const checkLine = `d20 ${roll.die} + ${roll.modifier} = ${roll.total} vs DC ${roll.dc}`;
  const outcome = roll.success ? "SUCCESS" : "FAIL";
  let detail = `${outcome} (${checkLine})`;
  if (!roll.success && salvage) {
    const salvageEntries = Array.isArray(salvage) ? salvage : [salvage];
    for (const entry of salvageEntries) {
      const salvLine = `d20 ${entry.die} + ${entry.modifier} = ${entry.total} vs DC ${entry.dc}`;
      const stageLabel = entry.stage ? ` stage ${entry.stage}` : "";
      detail += entry.success
        ? `; Salvage${stageLabel} SUCCESS (${salvLine})`
        : `; Salvage${stageLabel} FAIL (${salvLine})`;
    }
  }
  if (delta) {
    const diff = inventoryToString(delta);
    if (diff) {
      detail += ` → ${diff}`;
    }
  }
  return detail;
}

function makeOverlay(attempts: RollLogEntry[], animate: boolean): OverlayEntry[] {
  if (!animate) return [];
  const lastCheck = [...attempts].reverse().find((roll) => roll.type === "check");
  const lastSalvage = [...attempts].reverse().find((roll) => roll.type === "salvage");
  const entries: OverlayEntry[] = [];
  if (lastCheck) {
    entries.push({
      id: `${lastCheck.id}`,
      label: `${lastCheck.tier} check`,
      value: lastCheck.die,
      success: lastCheck.success,
    });
  }
  if (lastSalvage) {
    entries.push({
      id: `${lastSalvage.id}`,
      label: `${lastSalvage.tier} salvage`,
      value: lastSalvage.die,
      success: lastSalvage.success,
    });
  }
  return entries.slice(0, 2);
}

function stampRolls(rolls: RollDetail[]): RollLogEntry[] {
  const now = Date.now();
  return rolls.map((roll, index) => ({
    ...roll,
    id: `${roll.type}-${roll.actionId}-${roll.riskId}-${now}-${index}`,
    timestamp: now + index,
  }));
}

const ActionChip = ({ label, value }: { label: string; value: string }) => (
  <span className="inline-flex min-w-0 items-center gap-1 rounded-full border border-slate-200 bg-white/80 px-2 py-0.5 text-xs text-slate-700">
    <span className="font-medium text-slate-500">{label}</span>
    <span className="truncate">{value}</span>
  </span>
);

const NumberField = ({
  label,
  value,
  onChange,
  min = 0,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
}) => (
  <label className="grid gap-1 text-sm">
    <span className="text-xs font-medium text-slate-500">{label}</span>
    <input
      type="number"
      className="h-9 rounded-lg border border-slate-200 px-2"
      value={value}
      min={min}
      onChange={(event) => onChange(clampInt(Number(event.target.value), min))}
    />
  </label>
);

export function ElementalEssence() {
  const [state, setState] = usePersistentState<PersistedState>(STORAGE_KEY, DEFAULT_STATE);
  const [uiState, setUiState] = useState<Record<string, ActionUiState>>(buildInitialUiState);
  const [message, setMessage] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<OverlayEntry[]>([]);
  const manualQueues = useRef<ManualQueues>({ checks: [], salvage: [] });

  const inventory = state.inventory;
  const settings = state.settings;

  const showMessage = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 3500);
  };

  const updateInventory = (patch: Partial<Inventory>) => {
    setState((current) => ({
      ...current,
      inventory: { ...current.inventory, ...patch },
    }));
  };

  const handleInventoryChange = (resource: Resource, value: number) => {
    updateInventory({ [resource]: Math.max(0, value) });
  };

  const enqueueManualRolls = () => {
    if (!settings.autoRoll) {
      manualQueues.current.checks = parseManualQueue(settings.manualChecks);
      manualQueues.current.salvage = parseManualQueue(settings.manualSalvage);
    }
  };

  const rollStrategy = {
    nextCheckPair: (): [number, number] => {
      if (settings.autoRoll) {
        return [rollD20(), rollD20()];
      }
      if (manualQueues.current.checks.length < 2) {
        manualQueues.current.checks.push(...parseManualQueue(settings.manualChecks));
      }
      const a = manualQueues.current.checks.shift() ?? rollD20();
      const b = manualQueues.current.checks.shift() ?? rollD20();
      return [a, b];
    },
    nextSalvage: (): number => {
      if (settings.autoRoll) {
        return rollD20();
      }
      if (manualQueues.current.salvage.length === 0) {
        manualQueues.current.salvage.push(...parseManualQueue(settings.manualSalvage));
      }
      return manualQueues.current.salvage.shift() ?? rollD20();
    },
  };

  const pushLogEntry = (entry: LogEntry) => {
    setState((current) => ({
      ...current,
      log: [entry, ...current.log].slice(0, LOG_LIMIT),
    }));
  };

  const pushRolls = (entries: RollLogEntry[]) => {
    setState((current) => ({
      ...current,
      rolls: [...entries, ...current.rolls].slice(0, ROLL_LIMIT),
    }));
  };

  const applyOverlay = (rolls: RollLogEntry[]) => {
    setOverlay(makeOverlay(rolls, settings.animateDice));
  };

  const storeUndoSnapshot = () => {
    setState((current) => ({
      ...current,
      undoSnapshot: {
        inventory: cloneInventory(current.inventory),
        log: [...current.log],
        rolls: [...current.rolls],
        sessionMinutes: current.sessionMinutes,
      },
    }));
  };

  const runActionFor = (action: ActionConfig) => {
    const ui = uiState[action.id];
    const risk = action.risks.find((item) => item.id === ui.riskId) ?? action.risks[0];
    const batch = Math.max(1, ui.batch);
    const extra = Math.max(0, ui.extra);

    if (risk.toolRequirement && risk.toolRequirement.id === "greater" && settings.toolkit !== "greater") {
      showMessage("Greater-grade tools are required for this refinement.");
      return;
    }

    const feasible = maxFeasibleAttempts(inventory, risk, batch, extra, action.optionalCost);
    if (feasible <= 0) {
      showMessage("Insufficient resources for this action.");
      return;
    }
    if (feasible < batch) {
      showMessage("Not enough resources for the requested batch size.");
      return;
    }

    enqueueManualRolls();
    storeUndoSnapshot();

    const result = runAction({
      action,
      risk,
      attempts: batch,
      inventory,
      modifier: settings.craftingMod,
      rollMode: settings.rollMode,
      rollStrategy,
      extraCost: extra,
    });

    const stampedRolls = stampRolls(result.rolls);
    const attempts = result.attempts;
    const summaryLines = attempts.map((attempt) =>
      `Attempt ${attempt.attempt}: ${describeAttempt(attempt.check, attempt.salvage, attempt.inventoryDelta)}`,
    );
    if (result.summary.stoppedReason) {
      summaryLines.push(`Stopped: ${result.summary.stoppedReason}`);
    }

    setState((current) => ({
      ...current,
      inventory: result.finalInventory,
      sessionMinutes: current.sessionMinutes + result.summary.totalTime,
      log: [
        {
          id: `${action.id}-${Date.now()}`,
          title: `${action.tier} ${risk.label} (x${attempts.length})`,
          details: summaryLines.join("\n"),
          timestamp: Date.now(),
        },
        ...current.log,
      ].slice(0, LOG_LIMIT),
      rolls: [...stampedRolls, ...current.rolls].slice(0, ROLL_LIMIT),
    }));

    applyOverlay(stampedRolls);
    showMessage(`${action.tier} run complete: ${attempts.length}/${batch} attempts resolved.`);
  };

  const handleUndo = () => {
    if (!state.undoSnapshot) {
      showMessage("Nothing to undo yet.");
      return;
    }
    const snapshot = state.undoSnapshot;
    setState((current) => ({
      ...current,
      inventory: snapshot.inventory,
      log: snapshot.log,
      rolls: snapshot.rolls,
      sessionMinutes: snapshot.sessionMinutes,
      undoSnapshot: null,
    }));
    setOverlay([]);
    showMessage("Reverted last action.");
  };

  const handleSettingsChange = (patch: Partial<Settings>) => {
    setState((current) => ({
      ...current,
      settings: { ...current.settings, ...patch },
    }));
  };

  const inventoryRequirements = useMemo(() => {
    const requirements: Record<string, RequirementInfo> = {};
    for (const action of ELEMENTAL_ACTIONS) {
      const ui = uiState[action.id];
      const risk = action.risks.find((item) => item.id === ui.riskId) ?? action.risks[0];
      const batch = Math.max(1, ui.batch);
      const extra = Math.max(0, ui.extra);
      requirements[action.id] = buildRequirementInfo(action, risk, batch, extra);
    }
    return requirements;
  }, [uiState]);

  const updateUiState = (actionId: string, patch: Partial<ActionUiState>) => {
    setUiState((current) => ({
      ...current,
      [actionId]: { ...current[actionId], ...patch },
    }));
  };

  const relevantRequirementResources = (requirement?: RequirementInfo) => {
    if (!requirement) return [] as Resource[];
    const keys = new Set<Resource>();
    for (const resource of Object.keys(requirement.static) as Resource[]) {
      if ((requirement.static[resource] ?? 0) > 0) keys.add(resource);
    }
    for (const resource of Object.keys(requirement.optional) as Resource[]) {
      if ((requirement.optional[resource] ?? 0) > 0) keys.add(resource);
    }
    return RESOURCE_ORDER.filter((resource) => keys.has(resource));
  };

  const formatRequirementText = (requirement: RequirementInfo | undefined, risk: RiskConfig) => {
    if (!requirement) return "Requires: nothing.";

    const parts: string[] = [];
    const staticResources = Object.keys(requirement.static) as Resource[];
    if (staticResources.length > 0) {
      const needLine = staticResources
        .map((resource) => `${requirement.static[resource]} ${RESOURCE_LABELS[resource]}`)
        .join(" & ");
      const haveLine = staticResources.map((resource) => inventory[resource] ?? 0).join(" / ");
      parts.push(`Requires: ${needLine} (have ${haveLine}).`);
    }

    const optionalResources = Object.keys(requirement.optional) as Resource[];
    if (optionalResources.length > 0) {
      const optionalLine = optionalResources
        .map((resource) => `${requirement.optional[resource]} ${RESOURCE_LABELS[resource]}`)
        .join(" & ");
      const haveLine = optionalResources.map((resource) => inventory[resource] ?? 0).join(" / ");
      parts.push(`Optional: ${optionalLine} (have ${haveLine}).`);
    }

    for (const flex of requirement.flex) {
      const optionsLine = flex.options
        .map((resource) => `${RESOURCE_LABELS[resource]} ${inventory[resource] ?? 0}`)
        .join(" / ");
      parts.push(`Flex: ${flex.amount} ${flex.label} [${optionsLine}]`);
    }

    if (risk.toolRequirement) {
      parts.push(`Tools: ${risk.toolRequirement.label}`);
    }

    if (parts.length === 0) {
      return "Requires: nothing.";
    }

    return parts.join(" ");
  };

  const missingResources = (
    requirement: RequirementInfo | undefined,
    action: ActionConfig,
    risk: RiskConfig,
    batch: number,
    extra: number,
  ) => {
    if (!requirement) return [] as string[];
    const missing: string[] = [];

    for (const resource of Object.keys(requirement.static) as Resource[]) {
      const need = requirement.static[resource] ?? 0;
      const have = inventory[resource] ?? 0;
      if (have < need) {
        missing.push(`${need} ${RESOURCE_LABELS[resource]} (have ${have})`);
      }
    }

    for (const resource of Object.keys(requirement.optional) as Resource[]) {
      const need = requirement.optional[resource] ?? 0;
      const have = inventory[resource] ?? 0;
      if (have < need) {
        missing.push(`${need} ${RESOURCE_LABELS[resource]} (have ${have})`);
      }
    }

    if (missing.length === 0) {
      const feasible = maxFeasibleAttempts(inventory, risk, batch, extra, action.optionalCost);
      if (feasible < batch) {
        if ((risk.flexInputs?.length ?? 0) > 0) {
          missing.push(
            `Flex supply: ${risk.flexInputs
              ?.map((flex) => flex.label)
              .join(", ") ?? "flexible inputs"} insufficient (need ${batch} attempts)`,
          );
        } else {
          missing.push("Insufficient resources for requested batch.");
        }
      }
    }

    return missing;
  };

  const renderRequirement = (action: ActionConfig, risk: RiskConfig, info: RequirementInfo | undefined, batch: number, extra: number) => {
    return (
      <div className="text-xs text-slate-600">
        {formatRequirementText(info, risk)}
        {risk.flexInputs && risk.flexInputs.length > 0 && (
          <div className="mt-1 text-[11px] text-slate-500">
            Flex inputs consume from listed resources in any combination per attempt.
          </div>
        )}
        {risk.toolRequirement && settings.toolkit !== "greater" && risk.toolRequirement.id === "greater" && (
          <div className="mt-1 text-[11px] text-amber-600">Requires greater tools before rolling.</div>
        )}
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Elemental Essence Elevation</h1>
          <p className="text-sm text-slate-500">
            Track planar inventory, resolve elemental recipes, and document cross-family infusions with full RawAE auditing.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <span className="rounded-full border border-slate-300 px-3 py-1">Session time: {formatTime(state.sessionMinutes)}</span>
          <span className="rounded-full border border-slate-300 px-3 py-1">Log entries: {state.log.length}</span>
          <button
            type="button"
            onClick={handleUndo}
            className="inline-flex items-center gap-1 rounded-full border border-slate-300 px-3 py-1 text-sm text-slate-600 transition hover:border-slate-400 hover:text-slate-900"
          >
            <Undo2 className="h-4 w-4" /> Undo
          </button>
        </div>
      </header>

      {message && <div className="rounded-lg border border-slate-200 bg-white/80 p-3 text-sm text-slate-700">{message}</div>}

      <DiceOverlay entries={overlay} />

      <section className="rounded-2xl border border-slate-200 bg-gradient-to-r from-sky-50 to-indigo-50 p-5 shadow-sm backdrop-blur">
        <h2 className="mb-3 text-lg font-semibold text-slate-800">Elemental progression map</h2>
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-700">
          {PROGRESSION_TIERS.map((tier, index) => (
            <Fragment key={tier}>
              <span className="rounded-full border border-slate-300 bg-white/70 px-4 py-1 shadow-sm">{tier}</span>
              {index < PROGRESSION_TIERS.length - 1 && <span className="text-slate-400">→</span>}
            </Fragment>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-600">
          Raw wells feed catalytic refinement into Fine EE, infuse with Fine Arcane to reach Fused, temper through Greater tools for
          Superior, and finish the weave into Supreme. Salvage cascades on Supreme failures return Superior first, then Fused.
        </p>
      </section>

      <section className="grid gap-6 md:grid-cols-[1.6fr_1fr]">
        <div className="rounded-2xl border border-slate-200 bg-white/80 p-5 shadow-sm backdrop-blur">
          <h2 className="mb-4 text-lg font-semibold text-slate-800">Inventory</h2>
          <div className="grid gap-3">
            {RESOURCE_ORDER.map((resource) => (
              <div key={resource} className="grid grid-cols-5 items-center gap-3 text-sm">
                <div className="col-span-2 text-slate-600">{RESOURCE_LABELS[resource]}</div>
                <div className="col-span-3 flex items-center gap-2">
                  <input
                    type="number"
                    className="h-9 w-full rounded-lg border border-slate-200 px-2"
                    value={inventory[resource]}
                    onChange={(event) => handleInventoryChange(resource, Math.max(0, Number(event.target.value)))}
                  />
                  <button
                    type="button"
                    className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 text-slate-600 hover:border-slate-400"
                    onClick={() => handleInventoryChange(resource, Math.max(0, inventory[resource] - 1))}
                  >
                    –
                  </button>
                  <button
                    type="button"
                    className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 text-slate-600 hover:border-slate-400"
                    onClick={() => handleInventoryChange(resource, inventory[resource] + 1)}
                  >
                    +
                  </button>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap gap-2 pt-2">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:border-slate-400"
                onClick={() => {
                  updateInventory(DEFAULT_INVENTORY);
                  showMessage("Inventory cleared.");
                }}
              >
                <RefreshCw className="h-4 w-4" /> Reset inventory
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:border-slate-400"
                onClick={() => {
                  const quick = window.prompt(
                    "Quick set inventory (Raw EE, Fine EE, Fused EE, Superior EE, Supreme EE, RawAE, Fine Arcane, Raw, Fine, Fused)",
                    "10,0,0,0,0,4,2,10,0,0",
                  );
                  if (!quick) return;
                  const values = parseInventoryPreset(quick);
                  updateInventory({
                    rawElemental: values[0] ?? 0,
                    fineElemental: values[1] ?? 0,
                    fusedElemental: values[2] ?? 0,
                    superiorElemental: values[3] ?? 0,
                    supremeElemental: values[4] ?? 0,
                    rawAE: values[5] ?? 0,
                    fineArcane: values[6] ?? 0,
                    raw: values[7] ?? 0,
                    fine: values[8] ?? 0,
                    fused: values[9] ?? 0,
                  });
                }}
              >
                <Dice4 className="h-4 w-4" /> Quick set…
              </button>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white/80 p-5 shadow-sm backdrop-blur">
          <h2 className="mb-4 text-lg font-semibold text-slate-800">Settings</h2>
          <div className="grid gap-4 text-sm text-slate-600">
            <NumberField
              label="Crafting modifier"
              value={settings.craftingMod}
              onChange={(value) => handleSettingsChange({ craftingMod: value })}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.autoRoll}
                onChange={(event) => handleSettingsChange({ autoRoll: event.target.checked })}
              />
              Auto-roll d20
            </label>
            <div className="grid gap-2">
              <span className="text-xs font-medium text-slate-500">
                Check: Normal / Advantage / Disadvantage (Salvage is always normal)
              </span>
              <div className="flex gap-2">
                {([
                  { id: "normal", label: "Normal" },
                  { id: "adv", label: "Advantage" },
                  { id: "dis", label: "Disadvantage" },
                ] as const).map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => handleSettingsChange({ rollMode: mode.id })}
                    className={`h-8 rounded-full border px-3 text-xs font-medium transition ${
                      settings.rollMode === mode.id
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-200 text-slate-600 hover:border-slate-400"
                    }`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-2">
              <span className="text-xs font-medium text-slate-500">Tool harness</span>
              <div className="flex gap-2">
                {(
                  [
                    { id: "standard", label: "Standard" },
                    { id: "greater", label: "Greater" },
                  ] as const
                ).map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => handleSettingsChange({ toolkit: tool.id })}
                    className={`h-8 rounded-full border px-3 text-xs font-medium transition ${
                      settings.toolkit === tool.id
                        ? "border-amber-600 bg-amber-600 text-white"
                        : "border-slate-200 text-slate-600 hover:border-slate-400"
                    }`}
                  >
                    {tool.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.animateDice}
                onChange={(event) => handleSettingsChange({ animateDice: event.target.checked })}
              />
              Show dice animation
            </label>
            {!settings.autoRoll && (
              <>
                <label className="grid gap-1 text-sm">
                  <span className="text-xs font-medium text-slate-500">Manual check rolls (comma or space separated)</span>
                  <input
                    type="text"
                    className="h-9 rounded-lg border border-slate-200 px-2"
                    value={settings.manualChecks}
                    onChange={(event) => handleSettingsChange({ manualChecks: event.target.value })}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="text-xs font-medium text-slate-500">Manual salvage rolls</span>
                  <input
                    type="text"
                    className="h-9 rounded-lg border border-slate-200 px-2"
                    value={settings.manualSalvage}
                    onChange={(event) => handleSettingsChange({ manualSalvage: event.target.value })}
                  />
                </label>
              </>
            )}
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              <NumberField
                label="Recent rolls tray size"
                value={settings.traySize}
                min={1}
                onChange={(value) => handleSettingsChange({ traySize: Math.max(1, value) })}
              />
              <button
                type="button"
                onClick={() => setState((current) => ({ ...current, rolls: [] }))}
                className="h-9 rounded-full border border-slate-200 px-3 text-sm text-slate-600 hover:border-slate-400"
              >
                Clear tray
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        {ELEMENTAL_ACTIONS.map((action) => {
          const ui = uiState[action.id];
          const risk = action.risks.find((item) => item.id === ui.riskId) ?? action.risks[0];
          const batch = Math.max(1, ui.batch);
          const extra = Math.max(0, ui.extra);
          const requirement = inventoryRequirements[action.id];
          const missing = missingResources(requirement, action, risk, batch, extra);
          const feasibleCount = maxFeasibleAttempts(inventory, risk, 9999, extra, action.optionalCost);
          const needsGreater = risk.toolRequirement?.id === "greater" && settings.toolkit !== "greater";
          const canRun = batch > 0 && batch <= feasibleCount && missing.length === 0 && !needsGreater;
          const odds = computeOdds(risk, settings.craftingMod, settings.rollMode, extra, action.optionalCost);
          const expectation = computeExpectedValue(risk, odds, action.optionalCost, extra);
          const wastedDc =
            action.optionalCost && extra > 0 && computeEffectiveDc(risk, extra, action.optionalCost) === action.optionalCost.minDc;
          const missingTooltip = needsGreater
            ? "Greater tool harness required."
            : missing.length > 0
              ? `Needs ${missing.join(", ")}`
              : "Run action";

          return (
            <article
              key={action.id}
              className={`overflow-hidden rounded-2xl border border-slate-200 p-5 shadow-sm backdrop-blur ${action.gradient.from} ${action.gradient.to} bg-gradient-to-r`}
            >
              <div className="rounded-xl bg-white/70 p-4 backdrop-blur">
                <div className="flex flex-col gap-1 overflow-hidden">
                  <h3 className="truncate text-lg font-semibold text-slate-900">{action.tier} — {action.title}</h3>
                  <p className="text-xs text-slate-500">{action.subtitle}</p>
                </div>
                <div className="mt-4 grid gap-4">
                  <div className="flex flex-wrap gap-3">
                    <div className="flex min-w-[220px] flex-1">
                      <div className="flex w-full flex-col gap-3 rounded-xl border border-slate-200 bg-white/80 p-3">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Risk</span>
                        {action.risks.length > 1 ? (
                          <div className="flex flex-col gap-2">
                            <div className="flex flex-wrap gap-2">
                              {action.risks.map((riskOption) => {
                                const isSelected = riskOption.id === ui.riskId;
                                return (
                                  <button
                                    key={riskOption.id}
                                    type="button"
                                    onClick={() => updateUiState(action.id, { riskId: riskOption.id })}
                                    aria-pressed={isSelected}
                                    className={`flex-1 min-w-[96px] rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                                      isSelected
                                        ? "border-slate-900 bg-slate-900 text-white shadow"
                                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-400 hover:text-slate-900"
                                    }`}
                                  >
                                    {riskOption.label}
                                  </button>
                                );
                              })}
                            </div>
                            <div className="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-600">
                              {risk.description}
                            </div>
                          </div>
                        ) : (
                          <div className="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-600">
                            {risk.description}
                          </div>
                        )}
                      </div>
                    </div>
                    {action.optionalCost ? (
                      <div className="flex min-w-[220px] flex-1">
                        <div className="flex w-full flex-col gap-2 rounded-xl border border-slate-200 bg-white/80 p-3">
                          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Optional</span>
                          <NumberField
                            label={action.optionalCost.label}
                            value={ui.extra}
                            min={0}
                            onChange={(value) => updateUiState(action.id, { extra: value })}
                          />
                        </div>
                      </div>
                    ) : null}
                    <div className="flex min-w-[220px] flex-1">
                      <div className="flex w-full flex-col gap-3 rounded-xl border border-slate-200 bg-white/80 p-3">
                        <div className="flex flex-col gap-2">
                          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Batch</span>
                          <NumberField
                            label="Batch size"
                            value={ui.batch}
                            min={1}
                            onChange={(value) => updateUiState(action.id, { batch: Math.max(1, value) })}
                          />
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs">
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-700">
                            Feasible: ×{feasibleCount}
                          </span>
                          {needsGreater && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-700">
                              Need: Greater tools
                            </span>
                          )}
                          {missing.length > 0 && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-rose-700">
                              Need: {missing.join(", ")}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex min-w-[220px] flex-1">
                      <div className="flex w-full flex-col gap-3 rounded-xl border border-slate-200 bg-white/80 p-3">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Actions</span>
                        <div className="flex flex-col gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              updateUiState(action.id, {
                                batch: Math.max(1, maxFeasibleAttempts(inventory, risk, 9999, extra, action.optionalCost)),
                              })
                            }
                            className="inline-flex w-full items-center justify-center gap-1 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-slate-400"
                            title={feasibleCount > 0 ? `Set batch to ×${feasibleCount}` : missingTooltip}
                          >
                            Max feasible
                          </button>
                          <button
                            type="button"
                            onClick={() => runActionFor(action)}
                            disabled={!canRun}
                            aria-disabled={!canRun}
                            title={missingTooltip}
                            className={`inline-flex w-full items-center justify-center gap-1 rounded-full px-4 py-1.5 text-sm font-medium transition ${
                              canRun
                                ? "border border-slate-900 bg-slate-900 text-white hover:bg-slate-800"
                                : "cursor-not-allowed border border-slate-200 bg-slate-200 text-slate-500 opacity-80"
                            }`}
                          >
                            <Play className="h-4 w-4" /> Run
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                    <ActionChip label="Check success" value={formatPercent(odds.success)} />
                    {odds.salvage !== undefined && <ActionChip label="Salvage success" value={formatPercent(odds.salvage)} />}
                    <ActionChip label="DC" value={`${odds.effectiveDc}`} />
                    <ActionChip label="Time" value={`${risk.timeMinutes} min / attempt`} />
                    {wastedDc && action.optionalCost && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[11px] text-amber-700">
                        Extra {RESOURCE_LABELS[action.optionalCost.resource]} beyond this point no longer reduces DC.
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {Object.entries(expectation)
                      .filter(([, value]) => Math.abs(value) > 0.001)
                      .map(([resource, value]) => (
                        <span
                          key={resource}
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                            value >= 0 ? "border-emerald-300 text-emerald-700" : "border-rose-300 text-rose-700"
                          }`}
                        >
                          {value >= 0 ? "+" : ""}
                          {value.toFixed(2)} {RESOURCE_LABELS[resource as Resource]}
                        </span>
                      ))}
                  </div>
                  {action.optionalCost && extra > 0 && (
                    <div className="text-xs text-slate-600">
                      DC after reduction: {computeEffectiveDc(risk, extra, action.optionalCost)} (min {action.optionalCost.minDc})
                    </div>
                  )}
                  {renderRequirement(action, risk, requirement, batch, extra)}
                </div>
              </div>
            </article>
          );
        })}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white/85 p-5 shadow-sm backdrop-blur">
        <h2 className="mb-3 text-lg font-semibold text-slate-800">Elemental codex</h2>
        <p className="text-sm text-slate-600">
          Elemental essence is siphoned from fault lines between planes, saturated with static arcana. Refiners must balance the
          primal charge with borrowed essences to keep the lattice intact—RawAE only eases the T4 tempering, and Supreme elevation
          backfeeds salvage in cascading steps.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] table-fixed border-collapse text-left text-xs text-slate-600">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="px-3 py-2 font-semibold">Tier</th>
                <th className="px-3 py-2 font-semibold">Recipe</th>
                <th className="px-3 py-2 font-semibold">Check DCs</th>
                <th className="px-3 py-2 font-semibold">Salvage</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-slate-100">
                <td className="px-3 py-2 font-semibold text-slate-700">T1</td>
                <td className="px-3 py-2">Vent extraction → +1 or +2 Raw EE and +1 RawAE</td>
                <td className="px-3 py-2">10 (steady) / 16 (surge)</td>
                <td className="px-3 py-2">DC 12/14 → +1 Raw EE</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="px-3 py-2 font-semibold text-slate-700">T2</td>
                <td className="px-3 py-2">1 Raw EE + 1 Raw (any family) → 1 Fine EE</td>
                <td className="px-3 py-2">14</td>
                <td className="px-3 py-2">DC 12 → +1 Raw EE</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="px-3 py-2 font-semibold text-slate-700">T3</td>
                <td className="px-3 py-2">1 Fine EE + 1 Fine Arcane → 1 Fused EE</td>
                <td className="px-3 py-2">18</td>
                <td className="px-3 py-2">DC 14 → +1 Fine EE</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="px-3 py-2 font-semibold text-slate-700">T4</td>
                <td className="px-3 py-2">1 Fused EE + 1 Fused (any family) → 1 Superior EE</td>
                <td className="px-3 py-2">20 / 26 (−2 DC per RawAE, min 12)</td>
                <td className="px-3 py-2">DC 16 → +2 Fine EE / DC 18 → +1 Fine EE</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-semibold text-slate-700">T5</td>
                <td className="px-3 py-2">1 Superior EE + 1 Fused EE → 1 Supreme EE</td>
                <td className="px-3 py-2">24</td>
                <td className="px-3 py-2">DC 22 → +1 Superior EE → else DC 18 → +1 Fused EE</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="mt-3 text-xs text-slate-600">
          RawAE boosters may only be spent on T4, granting −2 DC each (to a minimum of 12) and are logged per attempt. Supreme
          salvage rolls resolve in sequence—success on the first recovers Superior EE and aborts the second roll; only a double
          failure loses the batch entirely.
        </div>
        <div className="mt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Cross-essence constraints</h3>
          <ul className="mt-2 list-disc space-y-1 pl-6 text-xs text-slate-600">
            <li>T2 consumes one Raw essence from any family in addition to Raw EE.</li>
            <li>T3 requires stocked Fine Arcane catalysts; no substitutes allowed.</li>
            <li>T4 accepts any fused essence as the second input but demands a greater tool harness.</li>
            <li>T5 binds Superior EE with Fused EE (elemental) before rolling salvage in two stages.</li>
          </ul>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white/80 p-5 shadow-sm backdrop-blur">
        <h2 className="mb-4 text-lg font-semibold text-slate-800">Recent rolls</h2>
        <RecentRolls rolls={state.rolls} traySize={settings.traySize} />
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white/80 p-5 shadow-sm backdrop-blur">
        <h2 className="mb-4 text-lg font-semibold text-slate-800">Action log</h2>
        {state.log.length === 0 ? (
          <p className="text-sm text-slate-500">No actions logged yet. Run an action to populate the log.</p>
        ) : (
          <div className="space-y-4">
            {state.log.map((entry) => (
              <article key={entry.id} className="rounded-xl border border-slate-200 bg-white/90 p-4 text-sm text-slate-700">
                <header className="mb-2 flex items-center justify-between text-sm text-slate-500">
                  <span className="font-semibold text-slate-800">{entry.title}</span>
                  <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                </header>
                <pre className="whitespace-pre-wrap text-xs leading-relaxed text-slate-600">{entry.details}</pre>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default ElementalEssence;
