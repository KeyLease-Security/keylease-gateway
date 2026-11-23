## Summary

<!-- The PR title must follow Conventional Commits, e.g. "feat(proxy): add request validation". CI validates it; see CONTRIBUTING.md. -->

<!-- What does this PR change, and why? -->

## Linked issue

<!-- "Fixes #123" -->

Fixes #

## Changes

-
-

## How was this verified?

<!-- e.g. pnpm lint, pnpm typecheck, pnpm test, manual smoke test -->

## Security review

Security-relevant changes (contract, auth, quota, escrow, proxy headers, CI or
release tooling) must be reviewed against the
[security review checklist](.github/security-review.md). Tick the items that
apply and note any that do not in the PR description.

## Checklist

- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` (`tsc --noEmit`) passes
- [ ] `pnpm test` passes (new behaviour is covered by tests)
- [ ] `README.md` / `CONTRIBUTING.md` updated when behaviour or config changed
- [ ] Security review checklist completed when this change touches auth, escrow, quota, headers, secrets or CI ([.github/security-review.md](.github/security-review.md))
- [ ] No secrets, private keys or `.env` files committed
