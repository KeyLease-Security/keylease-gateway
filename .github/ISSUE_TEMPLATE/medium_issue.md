---
name: "Medium (150 pts)"
about: A feature or refactor that spans a package but stays within one clear boundary.
title: "[medium] "
labels: ["size/medium", "points/150"]
---

## Summary

<!-- What are we building or changing? -->

## Motivation

<!-- Problem statement: what is broken or missing today? -->

## Proposed approach

<!-- Optional: sketch the API, data flow or file layout you have in mind. -->

## Scope

- Packages likely touched: `@keylease/cli`, `@keylease/proxy` (pick what applies)
- Out of scope:

## Acceptance criteria

- [ ] Behaviour implemented and covered by Vitest tests
- [ ] No new runtime dependencies without discussion in this issue
- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` all pass
- [ ] Public interfaces (CLI flags, exported types, env vars) documented in `README.md`
- [ ] Errors are surfaced with actionable messages (no silent failures)

## Points

**150 points**
