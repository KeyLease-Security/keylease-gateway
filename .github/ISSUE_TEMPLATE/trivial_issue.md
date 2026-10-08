---
name: "Trivial (100 pts)"
about: A small, well-scoped task that one contributor can finish in a single sitting.
title: "[trivial] "
labels: ["size/trivial", "points/100"]
---

## Summary

<!-- One or two sentences describing the change. -->

## Motivation

<!-- Why does the repo need this? Link screenshots/logs if relevant. -->

## Scope

Keep this tight — a trivial issue should be reviewable in minutes.

- Files likely touched:
- Explicitly out of scope:

## Acceptance criteria

- [ ] The change is implemented behind the existing public API
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` (`tsc --noEmit`) passes
- [ ] `pnpm test` passes, with at least one new/updated assertion where behaviour changed
- [ ] Docs updated if user-facing behaviour changed

## Points

**100 points**
