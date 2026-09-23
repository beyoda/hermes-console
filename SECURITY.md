# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ security fixes accepted (first public preview) |
| < 0.1.0 | — never published |

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub private security advisories:
https://github.com/beyoda/hermes-console/security/advisories/new

If that is unavailable, open a normal issue that contains **only** a description of the class of
problem and say you will share details privately — then wait for a response before posting details.

Please include, **with all secrets and personal data removed**:

* Affected version and Windows build
* Steps to reproduce
* What an attacker could achieve
* Suggested fix, if you have one

Expected response: acknowledgement within 7 days; a fix or a documented decision within 30 days.
Turnaround is best-effort — this is a small, early-stage volunteer-maintained project.

## Scope

In scope:

* Gateway start/stop authorisation and identity verification (`ownership.js`, `main.js`)
* OS process probing and instance-chain merging (`process-probe.js`)
* Log parsing, folding and secret redaction (`logsources.js`)
* IPC surface exposed through `preload.js` (renderer must stay Node-free)
* Reading and displaying configuration files
* Release packaging and the update/install surface

Out of scope:

* Vulnerabilities in Hermes itself — report those to the Hermes project.
* Vulnerabilities in the Electron runtime — report those upstream to Electron.
* Reports that require an attacker to already have arbitrary code execution as the user;
  the console is a local desktop tool and does not sandbox a local administrator.

## Security properties this project tries to hold

* The renderer has **no Node integration** and cannot reach arbitrary HTTP or shell commands.
* Dangerous operations are authorised **in the main process** (`authorizeDangerous()`), re-verified
  against live OS state. A disabled button is presentation, not a permission boundary.
* Gateway instances **not started by this console** (shared / pre-existing) are never stopped
  automatically and cannot be stopped without explicit, freshly verified ownership.
* Console logs never contain credential values; a shape-based redaction layer is applied as
  defence in depth.
* The log viewer redacts credential-shaped strings before rendering or copying — this is a
  heuristic, not a guarantee. Always scrub before sharing.

## Please never include in any report

* API keys, OAuth tokens, session tokens, JWTs
* Feishu / Lark app IDs or app secrets
* Your real `HERMES_HOME` path or other personal directory paths
* Raw logs, session transcripts or message content
