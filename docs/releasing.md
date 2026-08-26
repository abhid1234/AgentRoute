# Release procedure

Releases are human-gated. Pull requests never publish packages or apply routing
policies.

## Before the first public release

1. Complete independent review and merge the full stacked PR chain into `main`.
2. Make the GitHub repository public only after reviewing every tracked file,
   issue, action log, and branch for private material.
3. Create an npm package and configure AgentRoute's GitHub Actions workflow as
   an npm trusted publisher for `agentroute-evidence`. The unscoped
   `agentroute` package is owned by an unrelated project and must not be used.
4. Create a protected GitHub environment named `npm-publish` with required
   reviewers and restrict it to the release workflow.
5. Enable private vulnerability reporting, branch protection, secret scanning,
   CodeQL, and required CI checks.
6. Review `npm pack --dry-run --json --ignore-scripts` and the generated Public
   Proof Pack as release artifacts.
7. Run the bundled drift, routing-SLO, provider-outage scenario, incident-review,
   and `.arops` operations-review examples. Verify the portable artifacts and
   standalone HTML retain no prompt, response, endpoint, error, or credential.
8. In the reviewed release commit only, remove `private: true` or set it to
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
