# Roadmap

This roadmap is deliberately modest. Everything listed here is something the maintainer
genuinely intends to work on; nothing is listed to make the project look bigger than it is.

Status legend: **planned** (intended) / **exploring** (not committed) / **done**.

---

## v0.1.x — make the first public preview solid

| Item | Status | Notes |
| --- | --- | --- |
| Installer / one-click packaging | exploring | v0.1.0 ships a portable ZIP only; an installer needs signing decisions first |
| First-run diagnostics | planned | A single "why is nothing showing?" check: Hermes found? backend up? profile readable? |
| Error UX | planned | Replace raw failure codes with an explanation plus the next concrete action |
| Safer secret redaction | planned | Broaden the shape rules in `logsources.js`, add a self-check test for each new shape |
| Better log filtering | planned | Saved filters, per-source level defaults, jump-to-error |
| Fresh-install acceptance on a clean machine | planned | **Not done for v0.1.0** — this is the top priority for v0.1.1 |
| CI | exploring | Windows runner for `npm test`; release artifact build |
| Auto-update | exploring | Only after an installer exists and the update channel is trustworthy |

## v0.2 — beyond the maintainer's own machine

| Item | Status | Notes |
| --- | --- | --- |
| Linux / macOS feasibility | exploring | `process-probe.js` already has a POSIX branch; UI and paths are Windows-shaped today |
| Remote gateway support | exploring | Would require rethinking the ownership model end to end |
| Improved plugin / extension management | exploring | Today the extensions page is read-only by design |
| Per-profile gateway restart | exploring | Blocked on `ALLOW_DANGEROUS_EXEC=false`; needs a safe, verified path first |

## Explicit non-goals

* Becoming an official Hermes product, or bundling/embedding Hermes.
* Replacing the Hermes CLI.
* Adding telemetry.
* Promising "production ready" before a clean-machine acceptance run exists.
