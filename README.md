# AgentRoute

AgentRoute is a portable evidence and policy-analysis layer for model-routing decisions. It records which candidates were known, why one was selected, what was later observed, and how another policy scores the same complete candidate set. It does not proxy production traffic or silently choose models. Shadow replay is explicit, budget-bounded, and executor-injected.

![AgentRoute integration plane](diagrams/agentroute-integration-plane.png)

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
node dist/cli.js connectors
node dist/cli.js connectors --status partial --json
node dist/cli.js route import vercel-ai-gateway saved-vercel-event.json
node dist/cli.js ingest cloudflare-ai-gateway saved-cloudflare-log.json --ledger local/routes.route.jsonl
node dist/cli.js evaluate braintrust saved-braintrust-score.json --ledger local/routes.route.jsonl

# Run the complete evidence suite without accounts or network calls.
node dist/cli.js arena examples/model-routing.route.jsonl \
  --tasks examples/evidence-suite.replay-tasks.json \
  --fixtures examples/evidence-suite.replay-fixtures.json \
  --max-requests 2 --max-cost-usd 0.05 \
  --ledger local/replay.route.jsonl -o local/arena-report.json
node dist/cli.js experiment analyze local/replay.route.jsonl \
  --baseline-candidate winner --challenger runner-up \
  -o local/experiment-report.json
node dist/cli.js serve examples/model-routing.route.jsonl \
  --experiment-ledger local/replay.route.jsonl
node dist/cli.js policy registry init local/policies.registry.json
node dist/cli.js policy registry add local/policies.registry.json \
  examples/experiment-governance.policy.draft.json \
  --actor mason --reason "initial measured policy"
node dist/cli.js policy registry transition local/policies.registry.json \
  balanced-code-review@1.1.0 --to reviewed \
  --actor reviewer --reason "experiment evidence reviewed"
node dist/cli.js policy compile examples/evidence-suite.policy.json \
  --target vercel-ai-gateway -o local/vercel-policy.dry-run.json
node dist/cli.js capsule create examples/model-routing.route.jsonl \
  --policy examples/evidence-suite.policy.json -o local/demo.arcap
node dist/cli.js capsule verify local/demo.arcap
openssl genpkey -algorithm ED25519 -out local/capsule-private.pem
openssl pkey -in local/capsule-private.pem -pubout -out local/capsule-public.pem
node dist/cli.js capsule sign local/demo.arcap \
  --private-key local/capsule-private.pem -o local/signed-demo.arcap
node dist/cli.js capsule verify local/signed-demo.arcap \
  --require-signature --public-key local/capsule-public.pem
node dist/cli.js capsule open local/demo.arcap -o local/capsule-lab.html
```

Try the complete offline vendor path with the bundled fixtures:

```bash
node dist/cli.js ingest cloudflare-ai-gateway examples/imports/cloudflare-ai-gateway-log.json \
  --route-id route_demo_gateway --ledger local/vendor-demo.route.jsonl
node dist/cli.js evaluate braintrust examples/imports/braintrust-score.json \
  --ledger local/vendor-demo.route.jsonl
node dist/cli.js report local/vendor-demo.route.jsonl
```

The `ar` package binary accepts both `ar ...` and the historical `ar route ...` form.

Applications can also import the typed library surface after `npm run build`:

```ts
import { importCloudflareAiGatewayRoute, replayRoutes } from "agentroute";

const { decision, observation } = importCloudflareAiGatewayRoute(savedLog);
const report = replayRoutes(observation ? [decision, observation] : [decision]);
```

## Included implementation

- Draft 2020-12 receipt schema for immutable decisions and later observations.
- Append-only JSONL ledger with idempotent retries and sequence validation.
- Human-readable explanation, deterministic replay analytics, and policy simulation.
- Metadata-only OpenRouter, LiteLLM, Portkey, Vercel AI Gateway, and Cloudflare
  AI Gateway imports with conservative evidence fidelity.
- Offline gateway ingestion that splits allowlisted routing facts from measured
  status, latency, cost, token, retry, and cache observations.
- Braintrust numeric-score import that never retains experiment inputs, outputs,
  evaluator reasoning, or arbitrary metadata.
- Live, non-streaming OpenRouter capture with stable router metadata and an allowlisted receipt boundary.
- Exa-backed fresh task packs plus a deterministic evaluator contract.
- Screenshot-ready receipt detail and routing reports that separate predicted from measured values.
- Audit-readiness grading that reports whether receipts can support a defensible comparison.
- A standalone, interactive Decision Lab with receipt search, candidate evidence, router traces, gaps, and a predicted policy sandbox.
- Privacy-safe OTLP/JSON export for routing decision spans.
- A typed connector map with capability-level readiness, so working decision
  imports are not confused with still-planned policy exports.
- A Shadow Replay Arena with injected executors, fixture-only CLI execution,
  hard request/cost limits, candidate-level receipts, and measured regret.
- Paired replay experiment analysis with matched-task comparisons, Wilson 95%
  uncertainty, mean quality/latency/cost deltas, and task-type slices.
- A loopback-only Live Route Observatory with a safe snapshot API and live
  ledger-change events.
- A fail-closed routing quality gate with task-slice checks and a reusable
  GitHub composite action.
- A durable policy registry with atomic writes, guarded lifecycle history,
  explicit human approval, deterministic diffing, and dry-run compilers
  for native routers, OpenRouter, LiteLLM, Portkey, and Vercel AI Gateway.
- Tamper-evident `.arcap` evidence capsules that strip sensitive fields, support
  optional Ed25519 signer verification, and reopen as standalone Decision Labs.
- Examples, adversarial behavioral tests, and a conformance corpus.

The format and UX constraints are documented in [`docs/agentroute-spec.md`](docs/agentroute-spec.md). The handoff records the stable surfaces and verification boundary.

The system boundaries and the Requested → Selected → Observed → Proposed
receipt rail are documented in [`docs/architecture.md`](docs/architecture.md).
The honest capability matrix is documented in [`docs/integrations.md`](docs/integrations.md).
The full evidence-suite contracts and safety boundaries are documented in
[`docs/evidence-suite-spec.md`](docs/evidence-suite-spec.md).
Experiment statistics, policy lifecycle, signing, and slice-gate contracts are
documented in [`docs/experiment-governance-spec.md`](docs/experiment-governance-spec.md).

The first end-to-end demo kit is documented in
[`docs/can-auto-routing-prove-it.md`](docs/can-auto-routing-prove-it.md). Its
bundled receipts are explicitly illustrative; live task generation and model
calls require user-provided environment keys and are never run implicitly.
