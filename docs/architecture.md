# AgentRoute architecture

AgentRoute is a vendor-neutral routing evidence and policy-analysis layer. It
does not proxy inference, own provider keys, or silently rewrite production
routing. Gateways keep executing requests; AgentRoute makes their decisions
auditable.

```mermaid
flowchart LR
  subgraph execution[Execution plane — owned by the application]
    A[Agent request] --> R[Router or gateway]
    R --> M[Model response]
    R --> X[Routing metadata]
  end

  subgraph evidence[Evidence plane — append only]
    X --> N[Normalizer]
    N --> D[Decision receipt]
    M --> O[Measured observation]
    D --> L[(Receipt ledger)]
    O --> L
  end

  subgraph evaluation[Evaluation plane]
    T[Fresh task pack] --> E[Outcome evaluator]
    M --> E
    E --> O
  end

  subgraph analysis[Analysis plane]
    L --> Q[Audit readiness]
    L --> P[Replay and policy simulation]
    P --> C[Predicted comparisons]
  end

  subgraph experience[Experience plane]
    Q --> LAB[Decision Lab]
    C --> LAB
    LAB --> REC[Proposed policy change]
  end

  REC -. human review and router-specific rollout .-> R
```

## The receipt rail

Decision Lab organizes each route into four stages:

1. **Requested** — what the application asked the router to execute.
2. **Selected** — the actual model/provider choice and upstream reason.
3. **Observed** — measured status, latency, cost, quality, and evaluator.
4. **Proposed** — a predicted winner under an explicitly adjusted policy.

The fourth stage is deliberately not called “better.” It is a policy
simulation over recorded routing-time scores until that alternative is actually
executed and evaluated.

## Audit readiness

Before comparing routes, AgentRoute grades the evidence needed to support a
comparison. The grade combines:

- outcome coverage;
- quality-evaluation coverage;
- complete candidate evidence;
- policy-lab score coverage;
- measured latency and cost;
- fallback visibility.

This is an instrumentation grade, not a model-quality score. Per-route gaps
explain exactly what evidence is missing and which analysis is disabled.

## Trust boundaries

- The live OpenRouter adapter copies an allowlist of routing evidence only.
- Prompts, response text, credentials, headers, endpoints, and unknown extension
  objects are not included in the Decision Lab model.
- The generated Decision Lab is a standalone local HTML file with no remote
  scripts, fonts, analytics, or network requests.
- Embedded receipt data escapes HTML-significant characters, and dynamic
  content is rendered with text nodes rather than HTML injection.
- Policy controls re-rank only full candidate sets with complete quality,
  latency, and cost scores.

## Next durable layers

The architecture intentionally leaves room for three later modules without
turning AgentRoute into a gateway:

1. **Replay runner** — execute permitted alternatives and append real outcomes.
2. **Evaluator plugins** — deterministic, human, and model-judge adapters behind
   one versioned result contract.
3. **Policy registry** — reviewed, versioned recommendations with export adapters
   for OpenRouter, LiteLLM, Portkey, or application-native routers.
