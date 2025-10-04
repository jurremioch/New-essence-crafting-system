# Natural Essence Crafting

A lightweight single-page React application for running the "Natural Essence" crafting system at the table. Track inventory, configure crafting settings, batch craft across tiers, and keep a persistent roll history with dice overlay animations.

## Getting Started

```bash
npm install
npm run dev
```

The development server runs on Vite. Open the printed URL in your browser to use the tool.

## Available Scripts

- `npm run dev` – start the Vite development server.
- `npm run build` – create a production build.
- `npm run preview` – preview the production build locally.
- `npm run test` – execute unit tests with Vitest.

## Project Structure

```
src/
├─ components/         # Reusable UI building blocks (dice overlay, roll tray)
├─ features/
│  └─ natural/         # Natural essence feature module + rules config
├─ lib/
│  ├─ hooks/           # Local storage helpers
│  └─ rules/           # Rules engine, runner, and probability helpers
└─ App.tsx             # Root entry point rendering the Natural Essence module
```

The rules engine is data-driven. Natural essence actions are defined as configuration in `src/features/natural/naturalRules.ts`, and the generic runner in `src/lib/rules/runner.ts` executes batches, applies salvage, and records rolls. Future essence families can register their own action configs and reuse the same UI and engine.

## Notes

- Inventory, settings, recent rolls, and action logs persist in `localStorage` under the key `natural-essence-state-v1`.
- Manual roll queues support comma or whitespace separated integers. When exhausted, the app automatically refills from the configured inputs.
- Dice overlay animations can be toggled off in Settings for minimal mode.
