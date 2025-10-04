import { memo } from "react";
import type { RollDetail } from "@/lib/rules/types";

export interface RollLogEntry extends RollDetail {
  id: string;
  timestamp: number;
}

interface RecentRollsProps {
  rolls: RollLogEntry[];
  traySize: number;
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString();
}

export const RecentRolls = memo(function RecentRolls({ rolls, traySize }: RecentRollsProps) {
  const checks = rolls.filter((roll) => roll.type === "check").slice(0, traySize);
  const salvages = rolls.filter((roll) => roll.type === "salvage").slice(0, traySize);
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="max-h-56 overflow-auto rounded-lg border bg-white/70 p-3 text-xs">
        <div className="mb-2 font-semibold">Checks</div>
        {checks.length === 0 && <div className="text-slate-500">No check rolls yet.</div>}
        {checks.map((roll) => (
          <div key={roll.id} className={`flex justify-between ${roll.success ? "text-emerald-600" : "text-rose-600"}`}>
            <span>
              {formatTime(roll.timestamp)} · {roll.tier}
              {roll.riskId ? ` (${roll.riskId})` : ""}
            </span>
            <span>
              DC {roll.dc} · d20={roll.die} + {roll.modifier} = <strong>{roll.total}</strong>{" "}
              {roll.success ? "✓" : "✗"}
            </span>
          </div>
        ))}
      </div>
      <div className="max-h-56 overflow-auto rounded-lg border bg-white/70 p-3 text-xs">
        <div className="mb-2 font-semibold">Salvage</div>
        {salvages.length === 0 && <div className="text-slate-500">No salvage rolls yet.</div>}
        {salvages.map((roll) => (
          <div key={roll.id} className={`flex justify-between ${roll.success ? "text-emerald-600" : "text-rose-600"}`}>
            <span>
              {formatTime(roll.timestamp)} · {roll.tier}
              {roll.riskId ? ` (${roll.riskId})` : ""}
            </span>
            <span>
              DC {roll.dc} · d20={roll.die} + {roll.modifier} = <strong>{roll.total}</strong>{" "}
              {roll.success ? "✓" : "✗"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});
