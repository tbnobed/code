---
name: Monorepo TS builds
description: Stale .d.ts in lib/* composite packages cause phantom "no exported member" errors
---

lib packages (e.g. lib/db) are TypeScript composite projects emitting declarations to `dist/`. After adding exports to a lib's source, dependents' `typecheck` may fail with TS2305 "no exported member" because project references consume the stale `dist/*.d.ts`.

**How to apply:** run `npx tsc -b lib/<pkg>` (from repo root) before typechecking dependents.
