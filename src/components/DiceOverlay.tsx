import { memo } from "react";

export interface OverlayEntry {
  id: string;
  label: string;
  value: number;
  success: boolean;
}

interface DiceOverlayProps {
  entries: OverlayEntry[];
}

export const DiceOverlay = memo(function DiceOverlay({ entries }: DiceOverlayProps) {
  if (entries.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className={`flex items-center gap-3 rounded-xl border px-3 py-2 shadow-lg backdrop-blur-sm bg-white/90 ${
            entry.success ? "border-emerald-400" : "border-rose-400"
          }`}
        >
          <div className="grid h-12 w-12 place-items-center rounded-lg border text-lg font-extrabold animate-[spin_0.6s_ease-in-out]">
            {entry.value}
          </div>
          <div className="text-sm">
            <div className="font-medium leading-none">{entry.label}</div>
            <div className={entry.success ? "text-emerald-600" : "text-rose-600"}>
              {entry.success ? "Success" : "Fail"}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
});
