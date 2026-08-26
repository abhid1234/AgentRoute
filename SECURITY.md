# Security policy

## Supported versions

AgentRoute has not made its first public release. Security fixes are developed
against the latest commit on `main`; no older line currently receives fixes.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting or a private security advisory for
this repository. Do not open a public issue containing exploit details,
credentials, private prompts, model outputs, customer routes, or provider logs.

Please include the affected version or commit, the smallest safe reproduction,
the expected impact, and any suggested mitigation. Remove secrets and personal
data before submission. Maintainers will acknowledge a usable report, assess
severity, and coordinate disclosure after a fix is available.

## Security boundary

AgentRoute is an evidence and policy-analysis layer. It does not proxy model
traffic, apply compiled policies, or make deployment changes. Portable exports
are metadata-only by design, but users must still inspect source logs before
importing them and protect local ledgers as potentially sensitive operational
records.

Detached proof attestations embed only a public key. A valid signature proves
possession of the matching private key, not the signer's identity; pin and
distribute trusted public keys through a separate authenticated channel. Never
store release private keys in this repository or pass them through logs.
