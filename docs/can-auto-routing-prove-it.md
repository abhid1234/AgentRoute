# Can Auto Routing Prove It?

This is AgentRoute's first compact demo kit. It separates two modes clearly:

- **Illustrative mode** uses sanitized, fictional receipts for screenshots and local CLI verification.
- **Live mode** uses the operator's own Exa and OpenRouter keys and may incur provider charges.

No bundled output is represented as a real benchmark.

## Illustrative mode (no keys, no network)

```bash
npm run build
node dist/cli.js report examples/can-auto-routing-prove-it.route.jsonl
node dist/cli.js audit examples/can-auto-routing-prove-it.route.jsonl
node dist/cli.js lab examples/can-auto-routing-prove-it.route.jsonl \
  -o local/can-auto-routing-prove-it.html
node dist/cli.js simulate examples/can-auto-routing-prove-it.route.jsonl \
  --policy examples/can-auto-routing-prove-it.policy.json
```

The fixture is marked `illustrative-only` in every decision and observation.
Its purpose is to exercise the receipt-detail and policy-comparison surfaces,
not to support a model-quality or savings claim.

## Live task pack

Create ten fresh, source-grounded tasks:

```bash
export EXA_API_KEY="..."
node dist/cli.js task-pack exa \
  examples/can-auto-routing-prove-it.tasks.json \
  -o local/can-auto-routing-prove-it.task-pack.json
```

The Exa key is read only from the environment. The generated task pack retains
source URLs and highlights, but never the credential or raw Exa response.

## Capture a live Auto decision

Prepare a normal, non-streaming OpenRouter Chat Completions request in a local,
gitignored file. Use `"model": "openrouter/auto"`, then run:

```bash
export OPENROUTER_API_KEY="..."
node dist/cli.js capture openrouter local/request.json \
  --task-type coding_research \
  --ledger local/live.route.jsonl
```

AgentRoute sends `X-OpenRouter-Metadata: enabled`, normalizes the endpoint
snapshot, retry path, strategy, and pipeline labels, and appends a decision plus
measured observation. It hashes task inputs for joining while omitting prompts,
response text, credentials, headers, and unknown source metadata from receipts.

OpenRouter cache hits do not include router metadata. Such responses remain
selected-only evidence and must not be used for candidate ranking.

## Evaluate and compare

An evaluator writes a checklist JSON with a route ID, evaluator identity, and
weighted checks. AgentRoute converts it into an append-only observation:

```bash
node dist/cli.js evaluate local/evaluation.json --ledger local/live.route.jsonl
node dist/cli.js replay local/live.route.jsonl
node dist/cli.js simulate local/live.route.jsonl \
  --policy examples/can-auto-routing-prove-it.policy.json
node dist/cli.js report local/live.route.jsonl
```

Simulation compares routing-time predictions only. A defensible statement that
one route was actually faster, cheaper, or equally good requires executing and
evaluating that alternative under the same task evidence. AgentRoute does not
turn a predicted score delta into an actual savings or quality claim.

`audit` grades the evidence coverage behind those claims. `lab` generates a
standalone, offline Decision Lab with no remote assets or analytics; it omits
task descriptions and unknown extension payloads from its embedded view model.
