# Connector SDK

AgentRoute connectors translate external routing evidence into the receipt
contract. They do not receive authority to call providers, apply policies, or
load arbitrary packages.

```ts
import {
  runConnectorConformance,
  type ConnectorAdapter,
} from "agentroute";

const adapter: ConnectorAdapter<MySavedEvent> = {
  manifest: {
    id: "my-gateway",
    name: "My Gateway",
    status: "available",
    direction: "inbound",
    roles: ["gateway"],
    capabilities: ["decision-import", "observation-import"],
    transport: "saved event JSON",
    summary: "Imports an allowlisted saved gateway event.",
    docs_url: "https://example.com/my-gateway-event-contract",
  },
  importFixture(event) {
    return normalizeMyGatewayEvent(event);
  },
};

const result = await runConnectorConformance(adapter, [{
  name: "successful route",
  fixture: savedEvent,
  forbidden_markers: ["private prompt canary", "Bearer secret canary"],
}]);
```

The runner validates the manifest vocabulary, receipt sequence, deterministic
re-import, and marker exclusion. It is intentionally dependency-free and does
not discover or execute third-party packages.

The CLI can verify already-normalized native receipts:

```bash
ar connector test native-receipt routes.route.jsonl --forbid "secret canary"
```

`examples/connectors/sample-gateway-adapter.mjs` is a runnable external-style
adapter with a saved event fixture. After `npm run build`, run
`npm run test:examples` to see it pass schema, determinism, and three privacy
canaries. It imports only an explicit allowlist and never copies the fixture's
prompt, response, or authorization fields.

An adapter should retain only documented routing and outcome facts. Unknown
metadata, inputs, outputs, headers, request bodies, evaluator reasoning, and
credentials must be dropped rather than copied for future use.
