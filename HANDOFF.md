# Location Tracking Service - Claude Handoff

## Instructions

- Read `plan.md` and `claude.md` before starting each phase. Both are user-owned, untracked files; do not modify or add them to commits.
- Work phases in order. Complete only the approved phase, then stop and request approval.
- Keep the architecture in `plan.md`; ask before changing it and record approved changes as an ADR.
- Identifiers and commit messages are English. At each phase boundary run `npm run lint && npm test` and commit the completed phase.

## Phase Status

This is a clean re-implementation of the case. The design docs (`plan.md`, `README.md`, `docs/adr/`)
carry over from the original `marti-case` attempt and are considered final; no source code carries
over. Phase 0 is effectively already satisfied by the existing README outline and five ADRs — start
implementation at Phase 1.

- Phase 0: complete (README outline and five ADRs already present in this folder).
- Phase 1 and later: not started.

## Current Architecture

Architecture is defined in `plan.md` (Bölüm 4) and the ADRs under `docs/adr/`. No code exists yet in
this folder, so nothing here should be treated as implemented until a phase commit says so.

## Next Work: Phase 1

Implement Phase 1 exactly as specified in `plan.md`: NestJS skeleton with two entry points
(`main.api.ts`, `main.worker.ts`), validated config module, Docker Compose, multi-stage Dockerfile,
ESLint/Prettier/TypeScript strict mode, GitHub Actions CI, and `nestjs-pino` logging with a request id.
Stop and request approval once its acceptance criteria are met; do not start Phase 2 until then.

## Useful Commands

```sh
npm run format:check
npm run lint
npm test
npm run build
docker compose up --build -d
docker compose ps
```
