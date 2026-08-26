# Public Proof Pack specification

Status: implementation target for AgentRoute v0.2.0.

## Product claim

AgentRoute can produce a self-contained, reproducible chain of evidence from a
frozen routing corpus to a reviewable policy-promotion recommendation. The
bundled proof is an offline conformance demonstration, not a claim about live
model quality or provider performance.

## Required user experience

One command must run without credentials or network access:

```bash
ar proof run --out local/proof-pack
```

It must create a directory containing:

- the exact frozen input manifest and its SHA-256 fingerprints;
- replay receipts produced from fixture outcomes;
- a preregistered experiment decision;
- a promotion dossier and its independent verification result;
- an evidence capsule and its independent verification result;
- privacy-safe OpenTelemetry GenAI and OpenInference exports;
- `proof-manifest.json`, binding every input and output by digest; and
- `index.html`, a standalone report that explains the evidence chain and its
  limitations without loading remote assets.

The command must refuse to overwrite an existing non-empty destination unless
`--force` is supplied. Generated JSON must use canonical key ordering and a
fixed timestamp declared by the bundled proof configuration so that two clean
runs produce byte-identical machine-readable artifacts.

## Evidence boundary

The default proof pack is deterministic and offline. It contains twelve frozen
cases across code review, research, security, and summarization. Fixture scores demonstrate
the mechanics of replay, experiment analysis, gates, and promotion review. They
must be labelled `offline_conformance` and `illustrative` everywhere a reader
could confuse them with a live benchmark.

A future live runner may accept user-supplied provider credentials, but it must
write a separate provenance label and must never replace or silently modify the
bundled corpus.

## Interoperability profiles

`ar export` supports two explicit metadata-only profiles:

- `otel-genai`: OTLP/JSON spans using stable GenAI attributes where applicable
  plus the `agentroute.*` namespace for routing evidence.
- `openinference`: OTLP/JSON spans using OpenInference span-kind, model,
  provider, status, and AgentRoute metadata attributes.

Neither profile exports prompts, task descriptions, response content,
candidate endpoints, arbitrary extensions, evaluator reasoning, or credentials.
Content export is not configurable in v0.2.0.

## Connector SDK

The public library exports a minimal `ConnectorAdapter` contract and a
dependency-free conformance runner. A connector manifest declares identity,
roles, capabilities, transport, and documentation. The runner verifies:

1. the manifest is structurally valid and uses registered vocabulary;
2. imported decisions and observations satisfy the receipt schema;
3. repeated import of the same fixture is deterministic; and
4. serialized output excludes a caller-supplied forbidden marker corpus.

The built-in native receipt adapter is the reference implementation. The SDK
does not load third-party code or discover packages automatically.

## Release boundary

The repository becomes release-ready, not automatically released. The package
remains private until a human deliberately removes the guard for publication.
Release preparation includes a package allowlist, package-content verification,
Node version CI coverage, security and contribution policies, a changelog, an
OIDC publishing workflow gated by a GitHub environment, artifact attestations,
and an SBOM for release artifacts.

No workflow in this milestone may publish from a pull request, expose a token,
deploy an application, call a live model, or promote a routing policy.

## Acceptance criteria

- Two clean proof runs are byte-identical for all JSON, JSONL, and capsule
  artifacts.
- The bundled corpus contains at least ten matched cases and the quality gate
  compares baseline-candidate receipts with challenger-candidate receipts.
- Global and per-slice sample requirements are declared separately so slice
  coverage cannot accidentally inherit an impossible global threshold.
- `proof verify <directory>` recomputes every digest and every embedded
  verification result, failing closed on addition, removal, or modification of
  a bound artifact.
- The HTML report renders without JavaScript, network access, or external
  assets and includes the words `Illustrative offline conformance evidence`.
- Both telemetry profiles pass privacy fixtures containing prompt, response,
  endpoint, authorization, and arbitrary metadata canaries.
- Connector conformance rejects malformed manifests, nondeterministic imports,
  invalid receipts, and forbidden-marker leakage.
- `npm pack --dry-run` contains only the declared public package surface.
- Build, behavioral tests, conformance corpus, package verification, and diff
  hygiene pass before review.
