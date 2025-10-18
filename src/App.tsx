import { useEffect, useState } from "react";
import ElementalEssence from "@/features/elemental/ElementalEssence";
import NaturalEssence from "@/features/natural/NaturalEssence";

const FAMILY_STORAGE_KEY = "essence-active-family";

type Family = "natural" | "elemental";

function App() {
  const [family, setFamily] = useState<Family>(() => {
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(FAMILY_STORAGE_KEY);
      if (stored === "natural" || stored === "elemental") {
        return stored;
      }
    }
    return "natural";
  });

  useEffect(() => {
    window.localStorage.setItem(FAMILY_STORAGE_KEY, family);
  }, [family]);

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-6">
        <div className="flex justify-center gap-3">
          {(
            [
              { id: "natural", label: "Natural" },
              { id: "elemental", label: "Elemental" },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setFamily(option.id)}
              className={`rounded-full border px-5 py-2 text-sm font-medium transition ${
                family === option.id
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-600 hover:border-slate-500"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="mt-4">
          {family === "natural" ? <NaturalEssence /> : <ElementalEssence />}
        </div>
      </div>
    </div>
  );
}

export default App;
