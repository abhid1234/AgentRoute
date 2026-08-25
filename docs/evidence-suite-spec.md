# AgentRoute evidence suite specification

Status: implementation target for `codex/evidence-suite`.

## Product boundary

AgentRoute remains a vendor-neutral evidence and policy-analysis layer. The
suite may execute replay tasks only through an explicitly supplied executor,
serve local read-only views, evaluate checked-in evidence, and compile dry-run
configuration artifacts. It never owns production traffic, silently contacts a
model vendor, applies a vendor policy, or stores prompts and model responses in
portable artifacts.

## 1. Shadow Replay Arena

The Arena executes recorded candidates against caller-supplied task references
and appends measured observations to a new replay ledger. Its library contract
accepts an injected asynchronous executor. The CLI intentionally supports only
an offline fixture executor; applications can provide live executors explicitly.

Hard controls:

- positive `max_requests` and non-negative `max_cost_usd` are required;
- execution is sequential and stops before a request that would exceed the
  caller's declared cost ceiling;
- every result is validated and attributed to the original route and candidate;
- actual regret is calculated only when at least two candidates for the same
  route have measured quality;
- task payloads and model outputs are never written to the replay ledger.

## 2. Live Route Observatory

`ar serve <ledger>` starts a read-only HTTP server bound to `127.0.0.1` by
default. It exposes a self-contained dashboard at `/`, a privacy-safe snapshot
at `/api/snapshot`, and server-sent change notifications at `/api/events`.
Non-loopback binding is refused unless `--allow-remote` is explicit. The server
does not load remote assets, execute model calls, or mutate the ledger.

## 3. Routing quality gate

`ar gate <current-ledger> --baseline <baseline-ledger> --config <gate.json>`
compares measured aggregates and exits non-zero when a checked threshold fails.
The gate supports minimum observation coverage, minimum sample count, maximum
relative cost/latency increases, minimum quality delta, and maximum policy
violations. Insufficient evidence fails closed by default and can be configured
as a neutral result. JSON and GitHub-annotation output are deterministic.

## 4. Policy registry and dry-run compiler

A policy document contains a stable ID, semantic version, lifecycle status,
routing criteria, normalized weights, and optional ordered model targets.
Validation is shared by registry, diff, simulation, and compilation. Supported
dry-run targets are AgentRoute native, OpenRouter, LiteLLM, Portkey, and Vercel
AI Gateway. Compiled documents include their source policy identity and SHA-256
fingerprint, are marked `dry_run: true`, and are never transmitted.

## 5. Portable evidence capsules

An `.arcap` file is canonical JSON, not an opaque archive. It contains a
versioned manifest, conformant route records, optional validated policies, and
privacy-safe derived audit/replay summaries. Every payload has a SHA-256 digest
and the manifest has a root digest. Verification checks both hashes and runtime
contracts. Capsule creation never includes task descriptions, endpoints,
prompts, response bodies, credentials, arbitrary outcome metadata, or unknown
extensions. A verified capsule can render a standalone Decision Lab.

Capsule hashes detect accidental or unreviewed modification; they are not a
digital signature and do not establish who created the capsule. Authentic
provenance requires signing the `.arcap` file in the surrounding release or
artifact system.

## Acceptance criteria

- The package retains zero runtime dependencies and supports Node 18+.
- Existing route receipts, imports, reports, and conformance fixtures remain
  compatible.
- Each module has deterministic happy-path and adversarial tests.
- The repository CI runs build, behavioral tests, and conformance checks.
- Documentation contains an updated architecture diagram and runnable offline
  examples.
- No live model request, vendor write, deployment, or merge is part of suite
  verification.
