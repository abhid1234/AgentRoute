# AgentRoute

AgentRoute is a portable receipt and audit layer for model-routing decisions. It records which candidates were known, why one was selected, what was later observed, and how another policy scores the same complete candidate set. It does not execute requests or choose models.

This repository is the standalone extraction of the implementation developed in the OpenTrajectory checkout on local branch `codex/agentroute`, commit `5b22b29` (`feat: add AgentRoute routing receipts and replay`). OpenTrajectory-owned capture adapters, Inspector files, benchmarks, and unrelated docs were intentionally left behind.

## Commands

```bash
npm install
npm run build
npm test
npm run conformance

node dist/cli.js route explain examples/model-routing.route.jsonl
node dist/cli.js route replay examples/model-routing.route.jsonl
node dist/cli.js route simulate examples/model-routing.route.jsonl --policy examples/fast-cheap-policy.json
node dist/cli.js report examples/can-auto-routing-prove-it.route.jsonl
node dist/cli.js audit examples/can-auto-routing-prove-it.route.jsonl
node dist/cli.js lab examples/can-auto-routing-prove-it.route.jsonl -o local/decision-lab.html
```

The `ar` package binary accepts both `ar ...` and the historical `ar route ...` form.

## Included implementation

- Draft 2020-12 receipt schema for immutable decisions and later observations.
- Append-only JSONL ledger with idempotent retries and sequence validation.
- Human-readable explanation, deterministic replay analytics, and policy simulation.
- Metadata-only OpenRouter and LiteLLM imports with conservative evidence fidelity.
- Live, non-streaming OpenRouter capture with stable router metadata and an allowlisted receipt boundary.
- Exa-backed fresh task packs plus a deterministic evaluator contract.
- Screenshot-ready receipt detail and routing reports that separate predicted from measured values.
- Audit-readiness grading that reports whether receipts can support a defensible comparison.
- A standalone, interactive Decision Lab with receipt search, candidate evidence, router traces, gaps, and a predicted policy sandbox.
- Privacy-safe OTLP/JSON export for routing decision spans.
- Examples, adversarial behavioral tests, and a conformance corpus.

The format and UX constraints are documented in [`docs/agentroute-spec.md`](docs/agentroute-spec.md). The handoff records the stable surfaces and verification boundary.

The system boundaries and the Requested → Selected → Observed → Proposed
receipt rail are documented in [`docs/architecture.md`](docs/architecture.md).

The first end-to-end demo kit is documented in
[`docs/can-auto-routing-prove-it.md`](docs/can-auto-routing-prove-it.md). Its
bundled receipts are explicitly illustrative; live task generation and model
calls require user-provided environment keys and are never run implicitly.
