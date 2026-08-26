# Live benchmarking with a user-supplied executor

AgentRoute's CLI ships only an offline fixture executor. Applications may inject
their own `ReplayExecutor` into `runReplayArena` when they deliberately want to
call live models:

```ts
import { runReplayArena, type ReplayExecutor } from "agentroute";

const executor: ReplayExecutor = {
  id: "my-reviewed-live-runner",
  estimateCostUsd(request) {
    return priceEstimateFor(request.candidate);
  },
  async execute(request) {
    const measured = await callMyExistingGateway(request);
    return {
      status: measured.ok ? "success" : "failure",
      quality: measured.quality,
      latency_ms: measured.latencyMs,
      cost_usd: measured.costUsd,
    };
  },
};

const report = await runReplayArena(receipts, {
  tasks,
  limits: { max_requests: 20, max_cost_usd: 2 },
  executor,
});
```

Non-fixture executors are labelled `user_supplied_execution` and their reports
are labelled `user_generated`. AgentRoute does not claim they are independently
reproducible or bundle them as project benchmarks.

The runner requires a non-negative cost estimate before every request, stops
before the request or estimated-cost limit, and fails if actual accumulated
cost exceeds the hard limit. The executor should obtain credentials from the
application's runtime secret store and must return only allowlisted outcome
metrics. Do not place prompts, responses, errors, provider envelopes, or API
keys in `RouteOutcome`; AgentRoute strips unknown executor fields, but the
calling application remains responsible for its own logs.

For a credible published benchmark, preserve the task manifest, model and
provider versions, evaluator contract, pricing timestamp, environment details,
raw private evidence location, and generated AgentRoute receipts. Publish only
sanitized receipts and clearly distinguish a one-time result from a reproducible
claim.
