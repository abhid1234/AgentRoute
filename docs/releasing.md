# Release procedure

Releases are human-gated. Pull requests never publish packages or apply routing
policies.

## Before the first public release

1. Complete independent review and merge the full stacked PR chain into `main`.
2. Make the GitHub repository public only after reviewing every tracked file,
   issue, action log, and branch for private material.
3. For a brand-new scoped package, publish only a minimal prerelease reservation
   such as `0.0.0-bootstrap.0` interactively. Then configure AgentRoute's GitHub
   Actions workflow as the npm trusted publisher for `@avee1234/agentroute`.
   Publish the real release through OIDC, verify its registry integrity, and
   remove the bootstrap version. Never bootstrap with a real release version,
   because that immutable version would not carry workflow provenance. The
   unscoped `agentroute` package is owned by an unrelated project and must not
   be used.
4. Create a protected GitHub environment named `npm-publish` with required
   reviewers and restrict it to the release workflow.
5. Enable private vulnerability reporting, branch protection, secret scanning,
   CodeQL, and required CI checks.
6. Review `npm pack --dry-run --json --ignore-scripts` and the generated Public
   Proof Pack as release artifacts.
   Confirm `proof verify` reports 31 artifacts, an `eligible` dossier,
   `attention` operations and timeline statuses, and the complete built-in
   connector count. Those statuses are expected for the illustrative outage
   story and are not live provider claims.
   If a prior release proof exists, run `ar proof diff <prior> <candidate>` and
   review every modified artifact and semantic summary. Use
   `--fail-on-change` in automation only when the workflow is intentionally
   enforcing an unchanged root.
7. Run the bundled drift, routing-SLO, provider-outage scenario, incident-review,
   `.arops` operations-review, and `.arhistory` reliability-timeline workflows.
   Verify the portable artifacts and standalone HTML retain no prompt, response,
   endpoint, error, or credential.
8. If a release signing key is already governed outside the repository, create
   a detached `.arsig` for the verified proof pack and trust-verify it with the
   separately distributed public key. Never commit or upload the private key.
9. Exercise `.github/actions/agentroute-proof` with
   `require-trusted-signature: "true"` against the release proof, attestation,
   and public key. Record the verified root rather than the private key or raw
   evidence.
10. In the reviewed release commit only, remove `private: true` or set it to
   `false`. This is an explicit publication gate, not routine development.

## Prepare without publishing

Run the `Prepare and optionally publish release` workflow with the exact version
and leave `publish_npm` false. Download and inspect the tarball, CycloneDX SBOM,
build-provenance attestation, and SBOM attestation.

## Publish

After approval, rerun the workflow from the exact reviewed commit with
`publish_npm` true. The protected environment must approve the job. npm uses
GitHub OIDC; no long-lived `NPM_TOKEN` is stored in the repository.

Publication does not create a GitHub release automatically. A maintainer should
verify the registry package and provenance first, then create release notes and
attach the same reviewed artifacts.
