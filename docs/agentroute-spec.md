# AgentRoute receipt format v0.1

Status: **Draft, implementation-backed**

AgentRoute is the routing-decision layer in the OpenTrajectory family. An
OpenTrajectory document records what an agent did. An AgentRoute receipt
records why a model was selected before that work ran, which alternatives were
considered, and whether the decision met its stated policy.

The format is an audit artifact, not a router. It can describe a decision made
by LiteLLM, OpenRouter, a harness-native policy, or custom code without taking
over model execution.

## Architecture

```text
router / gateway / harness
          |
          v
   decision receipt ---------> optional .ot.json execution
          |                              |
          v                              v
 append-only .route.jsonl <------ measured observation
          |
          +---- explain / audit / replay / policy simulation
          +---- safe OTLP/JSON span export
```

The write path is deliberately separate from execution. AgentRoute can fail to
record without becoming a model gateway, and a gateway can fail without gaining
authority to rewrite an old receipt. Consumers fold the ledger by `route_id`;
they never update decision rows in place.

## Design goals

1. **Portable**: plain JSON or JSON Lines, readable without a service.
2. **Append-only**: decisions are immutable; measured outcomes are later
   observation records.
3. **Honest about evidence**: adapters label whether they captured the complete
   candidate set or only the selected model. Missing alternatives are never
   reconstructed.
4. **Policy-auditable**: the receipt carries the constraints and weights used at
   decision time, not the policy currently configured in the router.
5. **OpenTrajectory-linked**: optional trajectory and step references join a
   route decision to the execution it produced without changing the frozen
   OpenTrajectory v0.1 schema.
6. **Telemetry-compatible**: receipts map to OpenTelemetry GenAI spans, while
   retaining structured candidate data that flat span attributes cannot model.

## File forms

- `*.route.json`: one `decision` record.
- `*.route.jsonl`: an append-only ledger containing `decision` and
  `observation` records.

Every JSONL line is independently valid JSON. A conformant ledger also obeys
sequence invariants:

- exactly one decision record per `route_id`;
- the decision appears before its observations;
- `observation_id` values are unique;
- observations for one route are non-decreasing by `observed_at`;
- a writer retry with an identical record ID is an idempotent no-op and does not
  append a duplicate line; reusing an ID with different content is a conflict,
  and ledgers containing duplicate lines are invalid.

## Decision record

Required fields are deliberately small:

```json
{
  "route_version": "0.1",
  "record_type": "decision",
  "route_id": "route_...",
  "created_at": "2026-08-22T23:00:00.000Z",
  "task": { "type": "code_generation" },
  "router": { "name": "harness-native" },
  "source": { "kind": "native", "fidelity": "full" },
  "candidates": [
    {
      "id": "qwen",
      "model": "qwen/qwen3.8-max",
      "provider": "openrouter",
      "eligible": true,
      "estimates": { "quality": 0.88, "latency_ms": 840, "cost_usd": 0.008 },
      "scores": { "overall": 0.91 }
    }
  ],
  "selection": {
    "candidate_id": "qwen",
    "confidence": 0.91,
    "reason": "Highest eligible quality under the cost ceiling"
  }
}
```

`source.fidelity` is load-bearing:

- `full`: the adapter captured the complete candidate set and rationale.
- `partial`: some candidates or policy inputs are known to be missing.
- `selected-only`: the source exposed only the winning model. This remains a
  useful provenance record, but comparisons and regret estimates must not be
  inferred from it.

Candidate estimates are predictions available at routing time. They are not
later measurements. Scores are normalized router outputs where higher is
better; their meaning belongs to `router.policy_id` or `extensions`.

## Policy snapshot

`criteria` captures the constraints evaluated at selection time:

- `max_cost_usd`
- `max_latency_ms`
- `min_quality`
- `required_capabilities[]`
- normalized `weights` for quality, cost, latency, and capability
- `custom` for router-specific policy values

The reference implementation audits the selected candidate against these
fields. It does not re-run the router or silently substitute today's policy.

## Observation record

Observations append measured results without rewriting history:

```json
{
  "route_version": "0.1",
  "record_type": "observation",
  "route_id": "route_...",
  "observation_id": "obs_...",
  "observed_at": "2026-08-22T23:00:03.000Z",
  "outcome": {
    "status": "success",
    "actual_model": "qwen/qwen3.8-max",
    "latency_ms": 911,
    "cost_usd": 0.0076,
    "quality": 0.94,
    "trajectory_ref": "run.ot.json#trajectory-123"
  }
}
```

More than one observation may be appended when measurement is progressive. The
latest observation is the current measured state; earlier observations remain
audit history.

## Replay analytics

`ot route replay` folds receipts into deterministic descriptive statistics:

- decision and observation coverage;
- selections by model/provider/task type;
- measured success rate, mean latency, cost, and quality;
- policy violations present at decision time;
- predicted score gap between the winner and the best eligible alternative.

The last value is explicitly labeled **predicted**, never actual regret. An
unselected candidate did not run, so its counterfactual outcome is unknown.

`ot route simulate` accepts a versioned policy containing normalized score
weights and optional hard criteria. It operates only on `full` candidate sets,
requires every positively weighted score to be present, and reports a
`predicted_score_delta`. Partial and selected-only receipts are skipped with a
warning. A simulation is a policy comparison over routing-time predictions; it
is not evidence that an unselected model would have produced a better outcome.

## Source adapters

The OpenRouter and LiteLLM adapters are metadata allowlists, not raw-event
serializers. They copy the selected model, provider, source event identifier,
and explicitly supplied candidate metadata. Authorization fields, API keys,
prompts, and unknown payloads are discarded. Post-run response cost and latency
are not copied into candidate `estimates`, because measurements taken after a
request are not routing-time predictions. Record those values in an
`observation` instead.

Adapters default to `selected-only`. A supplied multi-candidate list is
`partial` until the caller explicitly attests it was complete; only then may it
be labeled `full`.

The live OpenRouter capture path opts into the stable
`X-OpenRouter-Metadata: enabled` contract. When the returned endpoint total
matches the complete `endpoints.available` snapshot, that candidate evidence is
`full`; a missing metadata object (including an OpenRouter cache hit) remains
`selected-only`. AgentRoute allowlists the requested model, strategy, region,
attempt count, endpoint candidates, attempt provider/model/status, and pipeline
type/name/summary. It never copies the request prompt, response text, headers,
credentials, raw pipeline data, or unknown metadata into a receipt.

Exa task packs are separate input artifacts rather than route receipts. They
retain source URLs and highlights to make fast-changing tasks reproducible, but
do not grant Exa any routing authority. Evaluation is a later append-only
observation; when a checklist score is added, the CLI carries forward the
already measured model, provider, latency, cost, and safe tool-call metadata.

## Audit readiness and Decision Lab

`ar audit` measures whether a ledger has enough instrumentation to support its
analysis. It reports outcome, quality, fidelity, policy-score, latency, cost,
and fallback coverage plus per-route evidence gaps. The resulting A–D grade is
explicitly an instrumentation grade, not a model-quality score.

`ar lab` renders a standalone local HTML investigation surface. Its view model
omits task descriptions, candidate endpoints, context, unknown extensions, and
arbitrary outcome metadata. The in-browser policy sandbox re-ranks only the
recorded full candidate set and labels its result predicted until the proposed
route has a measured observation.

## OpenTrajectory references

The optional `context` object can carry:

- `trajectory_id`
- `ot_step_ref`
- `session_id`
- `parent_route_id`
- W3C `traceparent`

AgentRoute does not duplicate trajectory steps or outcomes. Observation
`trajectory_ref` points to the resulting `.ot.json` artifact.

## Security and privacy

Receipts must not contain provider credentials, authorization headers, or raw
prompts by default. `task.fingerprint` supports joining equivalent tasks without
storing prompt text. Adapters copy only routing metadata. Unknown source payloads
belong outside the receipt, not in `raw` by default.

The reference CLI refuses invalid records before writing them, writes standalone
receipts atomically, detects duplicate/conflicting ledger records, and limits
human-readable explanations to receipt fields.

## Compatibility

The authoritative schema is
`schema/routedecision-0.1.schema.json` (JSON Schema draft 2020-12). The runtime
validator is zero-dependency and tested against the same required fields and
enums. Additive optional fields may be introduced within `0.1`; breaking changes
require a new `route_version`.
