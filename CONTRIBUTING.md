# Contributing to AgentRoute

AgentRoute values evidence fidelity, privacy, deterministic behavior, and small
reviewable changes.

## Development

Requirements: Node.js 20 or newer and npm.

```bash
npm ci --ignore-scripts
npm run verify
```

`npm run verify` covers the build, behavioral suite, conformance corpus,
connector example, proof and gate action harnesses, release-registry guard
tests, release-workflow contract checks, and a clean tarball install smoke test.
The proof-action harness exercises valid unsigned, untrusted, and pinned-key
runs plus missing inputs, invalid booleans, wrong keys, tampered evidence, and
shell-metacharacter paths without calling GitHub.

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
releases after required checks pass. See the
[`route-conformance` contract](route-conformance/README.md),
[`release procedure`](docs/releasing.md), and
[`community conduct`](CODE_OF_CONDUCT.md) for the corresponding contributor
boundaries.
