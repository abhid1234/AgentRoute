# Verified Proof Diff specification

Status: implementation contract for AgentRoute v0.2.0.

## Product claim

AgentRoute can compare two complete Public Proof Packs without trusting their
filenames, directory provenance, or an unverified manifest. The result tells a
reviewer whether the bound evidence root changed, which artifacts changed, and
whether the small set of verification summaries exposed by `proof verify`
changed.

This is a release-review aid, not a semantic claim that an artifact change is
safe or unsafe. It never compares unverified evidence and it never reads or
copies artifact bodies into the diff.

## Command contract

```bash
ar proof diff <baseline-pack> <current-pack> \
  [--format json|github] [--fail-on-change] [-o diff.json]
```

The default format is JSON. `--format github` emits workflow-command lines that
are suitable for a GitHub Actions step. `--fail-on-change` exits non-zero after
emitting the result when the verified roots differ. A detected change is not an
error without that flag.

`-o` is supported only for JSON because GitHub workflow commands must be
written to standard output. Unknown formats and incompatible options fail
closed.

## Verification boundary

Both directories must pass the complete `verifyProofPack` contract before any
diff is returned. Missing files, unbound additions, unsafe paths, stale embedded
verifications, digest mismatches, privacy marker failures, or malformed
manifests make the comparison fail. The API must not downgrade an invalid pack
to a list of changed files.

The comparison uses the verified manifests and verification summaries. It does
not infer trust in either pack's author. Detached signature verification remains
the separate `proof verify --attestation --public-key` contract.

## Result schema

The JSON result is deterministic and contains:

- `proof_diff_version: "0.1"`;
- `status: "unchanged" | "changed"`;
- baseline and current summaries with root, artifact count, generator version,
  claim scope, evidence label, and bounded semantic statuses;
- lexicographically sorted `added`, `removed`, and `modified` artifact entries;
- each modified entry's baseline and current SHA-256 values; and
- lexicographically sorted semantic changes for dossier verdict, operations
  status, timeline status, and connector count.

No wall-clock timestamp is included, so identical inputs produce byte-identical
JSON. Artifact paths are the already validated flat manifest paths. The diff
must not include prompts, responses, endpoints, credentials, arbitrary
metadata, artifact contents, verification errors from successful packs, or
filesystem paths supplied by the caller.

## GitHub format

The GitHub formatter emits one escaped `notice` for unchanged roots or one
escaped `warning` summary plus a warning for every artifact and semantic change.
It must escape `%`, carriage return, and line feed according to workflow-command
rules. It emits no caller path or artifact body.

## Library API

```ts
compareProofPacks(baselineDirectory, currentDirectory): ProofDiff
formatGitHubProofDiff(diff): string
```

`compareProofPacks` throws when either proof is invalid and identifies only
whether the baseline or current input failed. The thrown message may include
verification diagnostics but must not include artifact contents.

## Acceptance criteria

- Comparing two clean deterministic proof runs returns `unchanged` and empty
  change arrays.
- A valid pack with a re-bound artifact change returns `changed`, the exact
  modified artifact, and no artifact contents.
- Added and removed manifest artifacts are reported when both packs still
  satisfy the proof contract for their declared versions.
- An invalid or tampered pack is rejected before comparison.
- `--fail-on-change` emits the complete diff before exiting non-zero.
- JSON and GitHub output contain neither caller directory paths nor privacy
  canaries.
- Build, behavioral tests, conformance, package verification, and diff hygiene
  pass before review.
