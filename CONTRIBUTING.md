# Contributing to JKJ

Thanks for taking a look.

## Getting set up

See [Setup](README.md#setup) in the README. Short version:

```bash
npm install
npm run dev      # server on :4317, web on :5317
```

## Before you open a pull request

```bash
npm run typecheck
npm run build
```

Both must pass.

## What makes a change easy to merge

- **One thing per PR.** A bug fix or a feature, not both.
- **Respect the boundaries.** `shared` imports nothing; services hold the
  logic; SDK code stays in `runtime/`; colours come from `tokens.css`.
- **Keep the signature, change the body.** Most of this codebase is
  deliberately stubbed with real function signatures and `TODO` comments.
  Filling one in should not require touching its callers. If it does, say so
  in the PR — that is a design conversation worth having.
- **Say what you tried.** A screenshot for UI changes; the command you ran
  for anything else.

## Filing an issue

Include your OS, `node -v`, what you expected, and what happened. For UI
issues, a screenshot saves a round trip.
