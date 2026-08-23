# AgentRoute conformance corpus

This corpus tests both record shape and append-only ledger behavior. An
AgentRoute producer conforms to v0.1 when its records pass the published JSON
Schema and its ledgers obey the sequence invariants enforced by `ot route
validate`.

Run from the repository root after building the capture package:

```bash
npm run build
node route-conformance/check.mjs
```

The valid cases cover full-fidelity and selected-only decisions plus progressive
observations. Invalid cases prove that an unknown selection and an observation
without a preceding decision fail closed. Adapters must not upgrade incomplete
source evidence to `full`.
