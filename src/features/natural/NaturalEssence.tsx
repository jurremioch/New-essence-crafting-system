import { useMemo, useRef, useState } from "react";
import { Dice4, History, Play, RefreshCw, Undo2 } from "lucide-react";
import { DiceOverlay, type OverlayEntry } from "@/components/DiceOverlay";
import { RecentRolls, type RollLogEntry } from "@/components/RecentRolls";
import { usePersistentState } from "@/lib/hooks/usePersistentState";
import {
  computeEffectiveDc,
  computeExpectedValue,
  computeOdds,
  maxFeasibleAttempts,
  runAction,
  totalRequirements,
} from "@/lib/rules/runner";
import type { ActionConfig, Inventory, Resource, ResourceMap, RollDetail } from "@/lib/rules/types";
import { NATURAL_ACTIONS } from "./naturalRules";
import type { AdvMode } from "@/lib/rules/types";
import { clampInt } from "@/lib/rules/probability";

const STORAGE_KEY = "natural-essence-state-v1";

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
};

const DEFAULT_SETTINGS: Settings = {
  craftingMod: 0,
  autoRoll: true,
  rollMode: "normal",
  animateDice: true,
  traySize: 12,
  manualChecks: "",
  manualSalvage: "",
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
  rawAE: "Raw Arcane Essence",
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

const RESOURCE_ORDER: Resource[] = ["raw", "fine", "fused", "superior", "supreme", "rawAE"];

function buildInitialUiState(): Record<string, ActionUiState> {
  const state: Record<string, ActionUiState> = {};
  for (const action of NATURAL_ACTIONS) {
    state[action.id] = {
      riskId: action.risks[0].id,
      batch: 1,
      extra: 0,
    };
  }
  return state;
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

function describeAttempt(roll: RollDetail, salvage?: RollDetail, delta?: ResourceMap): string {
  const checkLine = `d20 ${roll.die} + ${roll.modifier} = ${roll.total} vs DC ${roll.dc}`;
  const outcome = roll.success ? "SUCCESS" : "FAIL";
  let detail = `${outcome} (${checkLine})`;
  if (!roll.success && salvage) {
    const salvLine = `d20 ${salvage.die} + ${salvage.modifier} = ${salvage.total} vs DC ${salvage.dc}`;
    detail += salvage.success ? `; Salvage SUCCESS (${salvLine})` : `; Salvage FAIL (${salvLine})`;
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

function mergeResourceMap(target: ResourceMap, source: ResourceMap): ResourceMap {
  const merged: ResourceMap = { ...target };
  for (const key of Object.keys(source) as Resource[]) {
    merged[key] = (merged[key] ?? 0) + (source[key] ?? 0);
  }
  return merged;
}

const ActionChip = ({ label, value }: { label: string; value: string }) => (
  <span className="inline-flex items-center gap-1 rounded-full border border-slate-300 px-2 py-0.5 text-xs text-slate-700">
    <span className="font-medium text-slate-500">{label}</span>
    <span>{value}</span>
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

export function NaturalEssence() {
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

  const handleDevSmoke = () => {
    const now = Date.now();
    pushLogEntry({
      id: `dev-${now}`,
      title: "Dev smoke",
      details: "No-op run for quick UI verification.",
      timestamp: now,
    });
    showMessage("Logged dev smoke entry.");
  };

  const inventoryRequirements = useMemo(() => {
    const requirements: Record<string, ResourceMap> = {};
    for (const action of NATURAL_ACTIONS) {
      const ui = uiState[action.id];
      const risk = action.risks.find((item) => item.id === ui.riskId) ?? action.risks[0];
      requirements[action.id] = totalRequirements(risk, Math.max(1, ui.batch), Math.max(0, ui.extra), action.optionalCost);
    }
    return requirements;
  }, [uiState]);

  const updateUiState = (actionId: string, patch: Partial<ActionUiState>) => {
    setUiState((current) => ({
      ...current,
      [actionId]: { ...current[actionId], ...patch },
    }));
  };

  const renderRequirement = (actionId: string, batch: number) => {
    const requirement = inventoryRequirements[actionId];
    const relevantResources = RESOURCE_ORDER.filter((resource) => (requirement?.[resource] ?? 0) > 0);
    const items = relevantResources.map((resource, index) => {
      const needed = requirement?.[resource] ?? 0;
      const have = inventory[resource];
      const ok = have >= needed;
      return (
        <span key={resource} className={ok ? "text-slate-600" : "text-rose-600"}>
          {needed} {RESOURCE_LABELS[resource]} (have {have})
          {index < relevantResources.length - 1 ? ", " : ""}
        </span>
      );
    });
    return <div className="text-xs text-slate-500">Requires {items.length > 0 ? items : "nothing"}.</div>;
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Natural Essence Crafting</h1>
          <p className="text-sm text-slate-500">Track inventory, resolve crafting batches, and log your rolls.</p>
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
                    "Quick set inventory (Raw, Fine, Fused, Superior, Supreme, RawAE)",
                    "10,0,0,0,0,10",
                  );
                  if (!quick) return;
                  const values = parseInventoryPreset(quick);
                  updateInventory({
                    raw: values[0] ?? 0,
                    fine: values[1] ?? 0,
                    fused: values[2] ?? 0,
                    superior: values[3] ?? 0,
                    supreme: values[4] ?? 0,
                    rawAE: values[5] ?? 0,
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
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Check roll mode</span>
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
              <span className="text-xs text-slate-500">Advantage/Disadvantage applies to the main check only; salvage rolls remain normal.</span>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.animateDice}
                onChange={(event) => handleSettingsChange({ animateDice: event.target.checked })}
              />
              Dice overlay animation
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
            <button
              type="button"
              onClick={handleDevSmoke}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-3 py-1 text-xs text-slate-500 hover:border-slate-400"
            >
              <History className="h-4 w-4" /> Dev smoke log
            </button>
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        {NATURAL_ACTIONS.map((action) => {
          const ui = uiState[action.id];
          const risk = action.risks.find((item) => item.id === ui.riskId) ?? action.risks[0];
          const batch = Math.max(1, ui.batch);
          const extra = Math.max(0, ui.extra);
          const feasible = maxFeasibleAttempts(inventory, risk, batch, extra, action.optionalCost);
          const odds = computeOdds(risk, settings.craftingMod, settings.rollMode, extra, action.optionalCost);
          const expectation = computeExpectedValue(risk, odds, action.optionalCost, extra);
          const wastedDc =
            action.optionalCost && extra > 0 && computeEffectiveDc(risk, extra, action.optionalCost) === action.optionalCost.minDc;

          return (
            <article
              key={action.id}
              className={`rounded-2xl border border-slate-200 p-5 shadow-sm backdrop-blur ${action.gradient.from} ${action.gradient.to} bg-gradient-to-r`}
            >
              <div className="rounded-xl bg-white/80 p-4">
                <div className="flex flex-col gap-1">
                  <h3 className="text-lg font-semibold text-slate-900">{action.tier} — {action.title}</h3>
                  <p className="text-xs text-slate-500">{action.subtitle}</p>
                </div>
                <div className="mt-4 grid gap-4">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end">
                    {action.risks.length > 1 ? (
                      <label className="grid gap-1 text-sm">
                        <span className="text-xs font-medium text-slate-500">Risk profile</span>
                        <select
                          value={ui.riskId}
                          onChange={(event) => updateUiState(action.id, { riskId: event.target.value })}
                          className="h-9 rounded-lg border border-slate-200 px-2"
                        >
                          {action.risks.map((riskOption) => (
                            <option key={riskOption.id} value={riskOption.id}>
                              {riskOption.label} — {riskOption.description}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <div className="text-sm text-slate-600">{risk.description}</div>
                    )}
                    {action.optionalCost ? (
                      <NumberField
                        label={action.optionalCost.label}
                        value={ui.extra}
                        min={0}
                        onChange={(value) => updateUiState(action.id, { extra: value })}
                      />
                    ) : null}
                    <NumberField
                      label="Batch size"
                      value={ui.batch}
                      min={1}
                      onChange={(value) => updateUiState(action.id, { batch: Math.max(1, value) })}
                    />
                    <div className="flex flex-wrap justify-end gap-2 md:col-span-1 md:justify-self-end">
                      <button
                        type="button"
                        onClick={() =>
                          updateUiState(action.id, {
                            batch: Math.max(1, maxFeasibleAttempts(inventory, risk, 9999, extra, action.optionalCost)),
                          })
                        }
                        className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:border-slate-400"
                      >
                        Max feasible
                      </button>
                      <button
                        type="button"
                        onClick={() => runActionFor(action)}
                        disabled={feasible <= 0 || feasible < batch}
                        className={`inline-flex items-center gap-1 rounded-full px-4 py-1.5 text-sm font-medium transition ${
                          feasible <= 0 || feasible < batch
                            ? "cursor-not-allowed border border-slate-200 bg-slate-200 text-slate-500"
                            : "border border-slate-900 bg-slate-900 text-white hover:bg-slate-800"
                        }`}
                      >
                        <Play className="h-4 w-4" /> {feasible < batch ? "Insufficient" : "Run"}
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                    <ActionChip label="Success" value={formatPercent(odds.success)} />
                    {odds.salvage !== undefined && <ActionChip label="Salvage" value={formatPercent(odds.salvage)} />}
                    <ActionChip label="Effective DC" value={`${odds.effectiveDc}`} />
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
                  <div className="text-xs text-slate-600">
                    {risk.description}
                    {action.optionalCost && extra > 0 && (
                      <span>
                        {" "}• Effective DC after reduction: {computeEffectiveDc(risk, extra, action.optionalCost)} (min {action.optionalCost.minDc})
                      </span>
                    )}
                  </div>
                  {renderRequirement(action.id, batch)}
                </div>
              </div>
            </article>
          );
        })}
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

export default NaturalEssence;
