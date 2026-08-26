# Detached proof attestation

AgentRoute proof packs already bind every artifact with SHA-256. This milestone
adds optional Ed25519 authorship without changing the deterministic proof pack,
requiring a hosted service, or treating a cryptographic key as a real-world
identity.

## User contract

```bash
ar proof sign local/proof-pack \
  --private-key release-private.pem \
  -o local/proof-pack.arsig

ar proof verify local/proof-pack \
  --attestation local/proof-pack.arsig \
  --public-key release-public.pem
```

`proof sign` first runs the complete proof-pack verifier. It refuses to sign a
pack with a missing, added, modified, stale, or invalid artifact. The output is
a detached canonical-JSON `.arsig` file, so the original 31-artifact proof pack
stays byte-identical and continues to reject unbound additions.

`proof verify` retains its existing hash-only behavior when no attestation is
provided. With `--attestation`, it verifies the proof pack, the detached
attestation contract, the Ed25519 signature, and the attestation subject against
the current proof manifest. `--public-key` pins the expected signer. Supplying a
public key without an attestation is an error.

## Attestation contract

An attestation has these exact top-level fields:

- `attestation_version: "0.1"`;
- `algorithm: "ed25519"`;
- `subject`, containing the proof format, proof version, root SHA-256, artifact
  count, generated timestamp, evidence label, claim scope, and generator;
- `public_key_pem`, the normalized SPKI public key;
- `public_key_fingerprint`, the SHA-256 of that normalized public key; and
- `signature_base64`, the Ed25519 signature.

The signature message is domain-separated from evidence-capsule signatures and
binds the canonical subject:

```text
AgentRoute proof attestation 0.1\n<canonical subject JSON>
```

Unknown fields, unsupported versions or algorithms, malformed hashes, invalid
timestamps, non-integer counts, malformed keys, and invalid signature encodings
fail closed.

## Trust semantics

A valid signature made by the embedded key proves only that the holder of the
matching private key signed the exact subject. Without `--public-key`,
verification returns `signature_valid: true`, `signature_trusted: false`, and a
warning that signer identity is untrusted.

With a pinned public key, the embedded key and fingerprint must match it and a
valid signature returns `signature_trusted: true`. A key mismatch is invalid.
AgentRoute does not claim that a key belongs to a person or organization; users
must establish that association out of band.

## Privacy and operational boundary

- The private key is read at runtime and is never copied into the attestation,
  proof pack, logs, or command output.
- Only the normalized public key and fingerprint are portable.
- No command generates keys, contacts a certificate authority, uploads an
  artifact, publishes a package, or changes a vendor account.
- The attestation contains no prompts, responses, endpoints, credentials,
  errors, route records, or arbitrary metadata.

## Acceptance criteria

1. Signing and trusted verification succeed for a valid proof pack.
2. Verification without a pinned key distinguishes cryptographic validity from
   signer trust and emits a warning.
3. A different trusted key, altered signature, changed subject, malformed or
   extended attestation, or modified proof pack fails verification.
4. Signing an invalid proof pack is refused.
5. Two signatures of the same subject with the same Ed25519 key are
   byte-identical.
6. Existing unsigned `proof run` and `proof verify` output remains compatible
   and deterministic.
7. The installed npm package exposes the library API and its CLI can sign and
   trust-verify a generated proof pack in a clean consumer directory.
