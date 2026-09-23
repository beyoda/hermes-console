# Contributing to Hermes Console

Thanks for considering a contribution. This is an early-stage, Windows-first project, so the
process is deliberately lightweight — but a few rules are strict because they exist to keep the
console safe with real gateways and real credentials.

## Before you start

* Open an issue first for anything larger than a typo fix. It saves everyone time.
* Read the *Design rules* below — most rejected PRs break one of them.
* Never commit real credentials, tokens, personal paths or unredacted logs.

## Design rules (these are the project's red lines)

1. **Never invent data.** If a value cannot be verified, the UI must show `未验证` / "unverified"
   or an explicit empty state. No placeholder numbers, no optimistic "connected".
2. **Never widen a safety gate.** Changes to ownership verification, the authorisation gate or the
   stop verdict must keep the existing fail-closed behaviour: if identity cannot be confirmed,
   the action is refused.
3. **Dangerous actions are authorised in the main process only.** Disabling a UI button is not a
   permission check.
4. **The renderer stays Node-free.** New IPC channels must be read-only unless there is a very
   good reason, and must never accept arbitrary paths or arbitrary commands.
5. **Pure logic goes into a pure module.** Anything that can be unit-tested without Electron
   belongs in `ownership.js` / `auth.js` / `logsources.js` / `process-probe.js`, not in `main.js`.
6. **Logs are read-only.** Nothing in the log path may write, truncate or delete log files.

## Development setup

```bash
git clone https://github.com/beyoda/hermes-console.git
cd hermes-console
npm install electron --save-dev
npm start
```

## Tests

```bash
npm test      # node --test tests/*.test.js   → 12 suites, 513 assertions
```

Rules for tests:

* Add a test for every pure-logic change.
* Tests must not require a running gateway; when a real gateway is needed, the suite must **skip
  honestly** rather than fake success.
* Some suites assert on source text (for example "the renderer must not contain process-kill
  calls"). If you change that code, update the assertion deliberately — do not delete it.

## Commit and PR conventions

* Commit messages in English or Chinese, imperative mood, one logical change per commit.
* In the PR description state: what changed, how you verified it, and whether the verification was
  real or isolated. Do not describe an isolated/sandbox run as an end-to-end verification.
* Keep the diff focused. Refactors mixed with behaviour changes are hard to review and will be
  asked for a split.

## Reporting bugs

Use the bug report template and **scrub the report first**: no tokens, no app secrets, no personal
paths, no raw logs. If the log viewer shows `[redacted]`, keep it redacted.

## Code style

* 2-space indentation, no semicolons at end of statements is *not* the convention — follow the
  existing files (semicolons omitted, single quotes, `const` by default).
* Comments in the existing code are dense and explain *why*. Keep that habit for anything
  non-obvious, especially near safety logic.
* UI strings must not contain Markdown markers — they are rendered as plain text.

## License

By contributing you agree that your contribution is licensed under the MIT License that covers
this repository.
