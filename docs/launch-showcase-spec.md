# Launch showcase

AgentRoute's launch-day experience is the existing one-command Public Proof
Pack, expanded into a complete offline showcase. A new developer should be able
to run one command, open one local page, and inspect the product's experiment,
promotion, operations, resilience, connector, and longitudinal evidence planes
without configuring an account or trusting an unverified claim.

## Product contract

```bash
npm ci --ignore-scripts
npm run build
node dist/cli.js proof run --out local/proof-pack
node dist/cli.js proof verify local/proof-pack
```

`proof run` remains deterministic, fixture-only, and network-free. It produces
a flat, manifest-bound directory so every artifact can be opened directly from
the filesystem and every unexpected addition is rejected.

The showcase must contain four connected stories:

1. **Measured policy evidence** — twelve frozen cases across four task slices,
   replayed for two candidates and judged by a preregistered experiment and
   quality gate.
2. **Review-only promotion** — a tamper-evident dossier with dry-run outputs for
   native routing, OpenRouter, LiteLLM, Portkey, and Vercel AI Gateway.
3. **Operational confidence** — full-fidelity baseline and proposed-route
   ledgers, a routing SLO, expected-rollout drift limits, and a provider-outage
   resilience scenario combined into a verified `.arops` review.
4. **Longitudinal review** — a verified `.arhistory` timeline showing the
   original baseline and proposed rollout as two chronological, hash-chained
   operations reviews.

The landing page links the evidence capsule, promotion dossier, operations
review, reliability timeline, telemetry exports, connector catalog, and their
verification results. It explains why an experiment may be eligible while an
outage scenario still deserves operational attention.

After verification, a maintainer may create a detached Ed25519 attestation for
the exact proof-manifest root. Signing is optional and never changes the proof
directory; its contract and trust boundary are defined in
[`proof-attestation-spec.md`](proof-attestation-spec.md).

## Frozen operational evidence

Operational ledgers are derived only from `public-proof.cases.json`:

- the baseline ledger selects `deep-review` and records the baseline outcome;
- the proposed ledger selects `fast-review` and records the challenger outcome;
- both retain the complete two-candidate set and a declared fallback order;
- timestamps, route IDs, observation IDs, and source provenance are fixed; and
- every record is labelled illustrative offline evidence.

The proof-specific drift contract permits the expected selection shift while
still checking failures, latency, cost, quality, coverage, and all four task
slices. The SLO independently checks success rate, tail latency and cost, tail
quality, and policy violations. The provider-B outage scenario must fall back
only to the recorded provider-A candidate. Scenario impact yields `attention`,
not a claim of live provider risk or measured production failure.

## Verification contract

`proof verify` must continue to validate exact file membership and every
artifact digest. It also independently:

- verifies the operations review and byte-compares its stored verification;
- verifies the reliability timeline and byte-compares its stored verification;
- binds the final timeline entry to the packaged operations-review root;
- checks the connector catalog is the deterministic built-in registry;
- rejects scripts, remote assets, and private-content markers in every HTML
  review; and
- retains the existing promotion, capsule, telemetry, and evidence-labelling
  checks.

## Truth and privacy boundaries

- Every visible result is labelled `illustrative offline conformance evidence`.
- Fixture outcomes are not current model benchmarks, provider comparisons,
  production telemetry, or availability claims.
- Scenario outputs are predictions over recorded candidates, not live probes.
- Dry-run vendor configurations are never applied.
- Prompts, responses, endpoints, credentials, raw errors, arbitrary metadata,
  and private labels are excluded.
- No command sends network requests, writes vendor state, publishes a package,
  deploys a site, or changes a policy registry.

## Acceptance criteria

1. One command creates the complete showcase and a second command verifies it.
2. Two clean runs are byte-identical and contain the exact manifest file set.
3. The experiment and quality gate pass; the promotion dossier is eligible;
   the SLO and rollout drift checks pass; the outage scenario produces a
   non-stranded `attention` assessment.
4. The reliability timeline contains exactly two verified reviews and binds its
   head to the packaged operations review.
5. Tampering with the operations review, timeline, connector catalog, manifest,
   or any existing proof artifact fails verification.
6. The landing page and linked review pages are standalone, script-free,
   limitation-labelled, and usable from a local filesystem.
7. The npm tarball includes every new frozen input and the installed CLI runs
   the same proof workflow.
