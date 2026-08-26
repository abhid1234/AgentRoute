# Telemetry interoperability

AgentRoute exports metadata-only OTLP/JSON through two explicit profiles:

```bash
ar export otel-genai routes.route.jsonl -o otel.json
ar export openinference routes.route.jsonl -o openinference.json
```

`otel-genai` uses GenAI model and provider attributes where they match the
routing record, with routing-specific evidence under `agentroute.*`.
`openinference` emits an `LLM` span kind plus model and provider identity, while
retaining the same `agentroute.*` evidence.

Both profiles omit:

- task descriptions and prompts;
- model response content;
- candidate endpoints;
- authorization and provider request envelopes;
- arbitrary extensions and evaluator reasoning.

There is no content-export switch. Semantic conventions continue to evolve, so
the profile name is part of the public contract and future mapping changes must
be versioned and covered by privacy fixtures.
