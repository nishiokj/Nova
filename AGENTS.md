# Repository Guidelines

## Project Structure & Module Organization

This repository is a Bun-based TypeScript monorepo. Code lives under `packages/`:

- `packages/core/*`: reusable runtime primitives, agent logic, tools, and shared types
- `packages/infra/*`: daemon, GraphD, transport, and service wiring
- `packages/apps/*`: user-facing entry points such as `launcher`, `tui`, and dashboards
- `packages/plugins/*`: optional subsystems such as memory and semantic compiler features
- `packages/external/*`: vendored external packages

Supporting material lives in `tests/`, `docs/`, and `config/`. Prefer package-name imports like `types` or `graphd` over deep filesystem paths.

## Build, Test, and Development Commands

Run these from the repository root:

- `bun install`: install workspace dependencies
- `bun run start`: start the default app flow (daemon + TUI)
- `bun run start:split`: run the daemon only
- `bun run start:tui`: attach the TUI to an already running daemon
- `bun run build`: build core packages and apps
- `bun run build:plugins`: build optional plugin packages
- `bun run lint`: run workspace lint/type checks for `core` and `infra`
- `bun test` or `bun run test`: run the Vitest suite
- `bun run test:coverage`: generate local coverage for critical changes

Some apps expose local scripts, for example `bun run --cwd packages/apps/dashboard dev`.

## Coding Style & Naming Conventions

Use TypeScript with ESM modules and follow the local file style. Most files use 2-space indentation and camelCase identifiers; React components use PascalCase. Keep package boundaries intact: app concerns stay in `apps/*`, transport/runtime code in `infra/*`, and generic logic in `core/*`.

Root ESLint enforces strict rules in `packages/core/*/src` and `packages/infra/*/src`: no `any`, no floating promises, prefer `import type`, and use exhaustive/safe control flow. Apps and plugins may have package-local lint configs.

## Testing Guidelines

Vitest is the primary test runner. New behavioral coverage should live in `tests/behavioral/<subsystem>/` and use the `.behavior.test.ts` suffix. Shared helpers belong in `tests/_infra/`; reusable payloads go in `tests/_fixtures/`.

Legacy tests in older locations are still valid, but new boundary-level tests should prefer the behavioral layout. No repo-wide coverage threshold is configured, so add targeted assertions for changed behavior.

## Commit & Pull Request Guidelines

Recent history uses short, plain commit subjects such as `tests`, `Adding autoexperiment`, and `testing harness stuff`. Keep titles brief, imperative, and scoped to one change.

Pull requests should include a concise summary, affected packages, test commands run, and screenshots or terminal captures for TUI/dashboard changes. Link related issues or design docs when the change touches architecture or plugin boundaries.

## Agent Working Principles

- The user’s requested outcome is the goal state. Builds, passing compiles, green tests, or small diffs are validation signals only, not substitutes for intent.
- Do not add shims, monkeypatches, compatibility layers, workaround branches, or dead code unless the user explicitly wants that tradeoff.
- Do not preserve legacy behavior by default. If a path is obsolete, misleading, or harmful to the architecture, prefer removing or redesigning it.
- Treat workaround-driven design as a red flag. Fix the underlying boundary, contract, or ownership problem when practical.
- Favor maintainable, extensible, and scalable solutions over expedient patches. Optimize for long-term clarity and changeability.
- Think through second-order effects before editing. Understand package boundaries, runtime consequences, and future maintenance cost.
- If the clean solution conflicts with local precedent, name the conflict directly instead of copying a bad pattern.

## Assumptions & Ambiguity

- Do not treat the existing codebase as unquestioned source of truth. The repository may contain bad assumptions, misaligned architecture, or entrenched poor practices.
- Surface ambiguous requirements, conflicting patterns, and suspicious design early. Do not silently choose the path of least resistance when the tradeoff is meaningful.
- Be proactive about resolving uncertainty with the user when it affects architecture, correctness, maintainability, or scope.
- State important assumptions plainly. If an assumption is carrying the implementation, make it visible and easy to challenge.
- When the code and the user’s intent disagree, treat the user’s intent as authoritative and bring the mismatch into the conversation.
- Act like a long-term engineering partner: challenge weak designs, explain the risk, and help steer toward the cleaner model instead of patching around drift.
