# Contributing to AgentRoute

AgentRoute values evidence fidelity, privacy, deterministic behavior, and small
reviewable changes.

## Development

Requirements: Node.js 20 or newer and npm.

```bash
npm ci --ignore-scripts
npm run verify
```

`npm run verify` includes the proof-action harness. It exercises valid unsigned,
untrusted, and pinned-key runs plus missing inputs, invalid booleans, wrong keys,
tampered evidence, and shell-metacharacter paths without calling GitHub.

Run the offline product proof after a successful build:

```bash
node dist/cli.js proof run --out local/proof-pack
node dist/cli.js proof verify local/proof-pack
```

## Pull requests

- Explain the user-visible contract and evidence boundary.
- Add behavioral and adversarial tests for new inputs or outputs.
- Keep credentials, prompts, responses, private endpoints, and copied provider
  envelopes out of fixtures.
- Label fixture-derived results as illustrative; do not present them as live
  benchmarks.
- Do not add runtime dependencies without a design discussion.
- Do not apply routing policies, publish packages, or deploy from a pull
  request.

Changes require independent review. A human maintainer performs merges and
releases after required checks pass.
