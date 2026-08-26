# Reliability timeline

This milestone adds longitudinal review to AgentRoute's read-only evidence
plane. A reliability timeline is an append-only, hash-chained history of
verified `.arops` operations reviews. It answers whether routing reliability is
improving, regressing, or repeatedly exhausting its error budget without
probing a provider, applying a policy, or retaining request and response text.

## Artifact contract

The `.arhistory` format contains:

- `timeline_version: "0.1"`;
- an ordered array of entries, each embedding one verified operations review;
- a deterministic longitudinal summary; and
- a manifest binding the entry count, chain head, summary hash, and root hash.

Every entry binds its one-based sequence, review timestamp, operations-review
root SHA-256, and previous entry SHA-256. The first entry has no predecessor.
Later reviews must have strictly increasing timestamps. Re-appending the exact
chain head is idempotent; duplicate older reviews and timestamp collisions fail
closed.

Creation and append verify the `.arops` input before writing. Persistence uses
an atomic same-directory temporary file and rename. Verification independently
checks every embedded operations review, chronological order, the complete
entry chain, the recomputed summary, and the manifest.

## Longitudinal summary

Each timeline point exposes only already-sanitized operational facts:

- operations assessment, drift status, and SLO status;
- global success rate, p95 latency, p95 cost, p10 quality, and policy-violation
  rate when measured;
- error-budget remaining, burn ratio, and exhaustion; and
- operations-review root SHA-256.

The summary includes status counts, the current status, consecutive critical
and non-passing-SLO streaks, error-budget exhaustion events, and latest-versus-
previous metric deltas. It also emits stable signals for current critical or
insufficient evidence, SLO regressions and recoveries, repeated critical
reviews, and exhausted error budgets. Signals are derived observations, not
alerts sent to an external service and not root-cause claims.

## CLI workflow

```bash
ar history create first.arops -o reliability.arhistory
ar history append reliability.arhistory next.arops
ar history verify reliability.arhistory
ar history open reliability.arhistory -o reliability.html
```

`history open` verifies before rendering a standalone, script-free HTML report.
The report includes the current state, trend deltas, signal cards, and a review
timeline. It does not load fonts, analytics, scripts, or other remote assets.

## Security and interpretation boundaries

- Only verified, sanitized operations reviews enter the timeline.
- The artifact retains no prompts, responses, endpoints, credentials, raw
  errors, arbitrary metadata, or user-supplied labels.
- Hash chaining detects modification and reordering; it does not authenticate a
  signer or prove that a review represents all production traffic.
- Missing measurements remain missing. Trend deltas are omitted rather than
  treating absent values as zero.
- A scenario remains a projection over recorded candidate evidence.
- No command calls a vendor, sends an alert, changes a routing policy, or
  publishes an artifact.

## Acceptance criteria

1. Create and append accept only verified operations reviews and preserve
   strictly increasing chronology.
2. Exact head retries are idempotent; duplicates, timestamp collisions, and
   out-of-order reviews fail closed without changing the file.
3. Verification rejects embedded-review, entry-chain, derived-summary,
   manifest, and root-hash tampering.
4. Trend deltas omit unavailable metrics and correctly classify SLO regression,
   recovery, critical streak, evidence-gap, and error-budget signals.
5. Atomic persistence leaves the prior valid timeline intact after a rejected
   mutation.
6. HTML is verified, standalone, script-free, and contains no private receipt
   fields.
7. The installed npm tarball exposes the typed API and the complete CLI help.
