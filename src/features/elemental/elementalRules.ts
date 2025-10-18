import type { ActionConfig } from "@/lib/rules/types";

export const ELEMENTAL_ACTIONS: ActionConfig[] = [
  {
    id: "t1",
    tier: "T1",
    family: "elemental",
    title: "Extract Elemental Wells",
    subtitle: "Tap planar vents to gather raw elemental essence alongside volatile arcane residue.",
    gradient: { from: "from-cyan-500", to: "to-blue-600" },
    risks: [
      {
        id: "steady",
        label: "Steady channel",
        description: "DC 10 • Outputs: +1 Raw EE & +1 RawAE • Salvage: DC 12 → +1 Raw EE",
        baseDc: 10,
        inputs: {},
        outputs: { rawElemental: 1, rawAE: 1 },
        salvage: { dc: 12, returns: { rawElemental: 1 } },
        timeMinutes: 45,
      },
      {
        id: "surge",
        label: "Surge tapping",
        description: "DC 16 • Outputs: +2 Raw EE & +1 RawAE • Salvage: DC 14 → +1 Raw EE",
        baseDc: 16,
        inputs: {},
        outputs: { rawElemental: 2, rawAE: 1 },
        salvage: { dc: 14, returns: { rawElemental: 1 } },
        timeMinutes: 60,
      },
    ],
  },
  {
    id: "t2",
    tier: "T2",
    family: "elemental",
    title: "Catalyze Raw → Fine",
    subtitle: "Fuse elemental motes with any raw essence to stabilize fine elemental essence.",
    gradient: { from: "from-teal-500", to: "to-emerald-600" },
    risks: [
      {
        id: "standard",
        label: "Catalytic mix",
        description: "DC 14 • 1 Raw EE + 1 Raw (any family) → 1 Fine EE • Salvage: DC 12 → +1 Raw EE",
        baseDc: 14,
        inputs: { rawElemental: 1 },
        flexInputs: [
          {
            id: "raw-any",
            label: "Raw essence (any family)",
            amount: 1,
            options: ["raw", "rawElemental"],
          },
        ],
        outputs: { fineElemental: 1 },
        salvage: { dc: 12, returns: { rawElemental: 1 } },
        timeMinutes: 90,
      },
    ],
  },
  {
    id: "t3",
    tier: "T3",
    family: "elemental",
    title: "Infuse Fine + Arcane",
    subtitle: "Blend elemental essence with fine arcane catalysts to create fused essence.",
    gradient: { from: "from-indigo-500", to: "to-purple-600" },
    risks: [
      {
        id: "infuse",
        label: "Arcane infusion",
        description: "DC 18 • 1 Fine EE + 1 Fine Arcane → 1 Fused EE • Salvage: DC 14 → +1 Fine EE",
        baseDc: 18,
        inputs: { fineElemental: 1, fineArcane: 1 },
        outputs: { fusedElemental: 1 },
        salvage: { dc: 14, returns: { fineElemental: 1 } },
        timeMinutes: 120,
      },
    ],
  },
  {
    id: "t4",
    tier: "T4",
    family: "elemental",
    title: "Refine Fused → Superior",
    subtitle: "Channel fused essence through greater tools; spend RawAE to ease the DC.",
    gradient: { from: "from-rose-500", to: "to-orange-600" },
    optionalCost: {
      resource: "rawAE",
      label: "RawAE boosters (−2 DC each)",
      perUnitDcReduction: 2,
      minDc: 12,
    },
    risks: [
      {
        id: "steady",
        label: "Careful tempering",
        description: "Base DC 20 • 1 Fused EE + 1 Fused (any family) → 1 Superior EE • Salvage: DC 16 → +2 Fine EE",
        baseDc: 20,
        inputs: { fusedElemental: 1 },
        flexInputs: [
          {
            id: "fused-any",
            label: "Fused essence (any family)",
            amount: 1,
            options: ["fused", "fusedElemental"],
          },
        ],
        outputs: { superiorElemental: 1 },
        salvage: { dc: 16, returns: { fineElemental: 2 } },
        toolRequirement: {
          id: "greater",
          label: "Requires greater elemental condenser",
          description: "Superior refinement needs a greater-grade tool set.",
        },
        timeMinutes: 150,
      },
      {
        id: "surge",
        label: "Aggressive channel",
        description: "Base DC 26 • 1 Fused EE + 1 Fused (any family) → 1 Superior EE • Salvage: DC 18 → +1 Fine EE",
        baseDc: 26,
        inputs: { fusedElemental: 1 },
        flexInputs: [
          {
            id: "fused-any",
            label: "Fused essence (any family)",
            amount: 1,
            options: ["fused", "fusedElemental"],
          },
        ],
        outputs: { superiorElemental: 1 },
        salvage: { dc: 18, returns: { fineElemental: 1 } },
        toolRequirement: {
          id: "greater",
          label: "Requires greater elemental condenser",
        },
        timeMinutes: 210,
      },
    ],
  },
  {
    id: "t5",
    tier: "T5",
    family: "elemental",
    title: "Elevate Superior → Supreme",
    subtitle: "Complete the cycle by marrying superior and fused elemental essence.",
    gradient: { from: "from-amber-500", to: "to-red-600" },
    risks: [
      {
        id: "ascend",
        label: "Ascension weave",
        description:
          "DC 24 • 1 Superior EE + 1 Fused EE → 1 Supreme EE • Salvage: DC 22 → +1 Superior EE / DC 18 → +1 Fused EE",
        baseDc: 24,
        inputs: { superiorElemental: 1, fusedElemental: 1 },
        outputs: { supremeElemental: 1 },
        salvage: {
          stages: [
            { dc: 22, returns: { superiorElemental: 1 } },
            { dc: 18, returns: { fusedElemental: 1 } },
          ],
        },
        timeMinutes: 240,
      },
    ],
  },
];
