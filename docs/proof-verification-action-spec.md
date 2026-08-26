# Proof-verification GitHub Action

This milestone makes AgentRoute proof packs enforceable in GitHub Actions
without requiring publication to npm. The composite action builds the exact
checked-out AgentRoute revision, verifies a caller-workspace proof pack, and can
optionally require a detached attestation from a pinned Ed25519 public key.

## User contract

```yaml
- uses: abhid1234/AgentRoute/.github/actions/agentroute-proof@v0.2.0
  id: agentroute-proof
  with:
    proof-pack: artifacts/proof-pack
    attestation: artifacts/proof-pack.arsig
    public-key: .github/agentroute-release.pub.pem
    require-trusted-signature: "true"

- run: echo "Verified ${{ steps.agentroute-proof.outputs.root-sha256 }}"
```

The repository and tag above are examples until a public release is
independently confirmed. Local workflows can use
`./.github/actions/agentroute-proof` from the same checkout.

## Inputs

- `proof-pack` is required and points to the proof directory.
- `attestation` optionally points to a detached `.arsig` file.
- `public-key` optionally points to the trusted Ed25519 public key and is valid
  only when `attestation` is present.
- `require-trusted-signature` is exactly `"true"` or `"false"` and defaults to
  `"false"`. When true, both attestation and public key are required and the
  verification result must report `signature_trusted: true`.

Relative paths resolve against the caller's `GITHUB_WORKSPACE`; absolute paths
remain absolute. Empty optional inputs remain absent.

## Outputs

- `root-sha256` — verified proof-manifest root;
- `artifact-count` — number of manifest-bound proof artifacts;
- `signature-valid` — `true` only for a valid detached signature; and
- `signature-trusted` — `true` only when that signature matches the pinned key.

Unsigned verification emits both signature outputs as `false`.

## Execution boundary

The action has two stages:

1. run `npm ci --ignore-scripts` and `npm run build` in the AgentRoute action
   checkout, not the caller repository; and
2. invoke a fixed local Node verifier with inputs passed through environment
   variables and arguments passed as an array.

No caller-controlled path is interpolated into a shell program, evaluated, or
used as a command. The verifier invokes the built AgentRoute CLI, preserves its
JSON result on stdout, emits GitHub outputs only after validation, and exits
nonzero on any contract, proof, signature, or trust failure.

The action requires only `contents: read`. It does not upload artifacts, write
repository contents, call a model or vendor, apply a policy, publish a package,
or create a release.

## Acceptance criteria

1. Unsigned proof verification succeeds and emits the verified root and count.
2. A valid detached attestation succeeds without a pinned key but reports
   `signature-trusted: false`.
3. Required trusted verification succeeds only with the matching public key.
4. Missing required inputs, invalid boolean values, a public key without an
   attestation, a wrong key, altered proof, altered attestation, and nonexistent
   paths all exit nonzero without writing successful outputs.
5. Paths containing spaces and shell metacharacters are handled as data, never
   executed.
6. The repository CI runs the local action against a freshly generated proof
   pack.
7. The complete AgentRoute verification pipeline remains green with no new npm
   dependencies.
