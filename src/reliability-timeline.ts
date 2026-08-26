import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { canonicalJson, sha256 } from "./canonical.js";
import { verifyOperationsReview } from "./operations-review.js";
import type { OperationsAssessmentStatus, OperationsReview } from "./operations-review.js";
import type { DriftStatus } from "./drift.js";
import type { RoutingSloStatus } from "./slo.js";

export type ReliabilitySignalSeverity = "info" | "warning" | "critical";
export type ReliabilitySignalKind =
  | "current-critical"
  | "current-attention"
  | "evidence-gap"
  | "slo-regression"
  | "slo-recovery"
  | "critical-streak"
  | "error-budget-exhausted"
  | "drift-regression";

export interface ReliabilityTimelineEntry {
  sequence: number;
  recorded_at: string;
  review_root_sha256: string;
  previous_entry_sha256?: string;
  entry_sha256: string;
  review: OperationsReview;
}

export interface ReliabilityTimelinePoint {
  sequence: number;
  recorded_at: string;
  review_root_sha256: string;
  assessment: OperationsAssessmentStatus;
  drift_status: DriftStatus;
  slo_status: RoutingSloStatus;
  success_rate?: number;
  p95_latency_ms?: number;
  p95_cost_usd?: number;
  p10_quality?: number;
  policy_violation_rate: number;
  error_budget_remaining?: number;
  error_budget_burn_ratio?: number;
  error_budget_exhausted?: boolean;
}

export interface ReliabilityMetricDelta {
  from_sequence: number;
  to_sequence: number;
  success_rate?: number;
  p95_latency_ms?: number;
  p95_cost_usd?: number;
  p10_quality?: number;
  policy_violation_rate: number;
  error_budget_remaining?: number;
  error_budget_burn_ratio?: number;
}

export interface ReliabilitySignal {
  id: string;
  kind: ReliabilitySignalKind;
  severity: ReliabilitySignalSeverity;
  review_root_sha256: string;
  detail: string;
}

export interface ReliabilityTimelineSummary {
  reviews: number;
  current_status: OperationsAssessmentStatus;
  status_counts: Record<OperationsAssessmentStatus, number>;
  consecutive_critical: number;
  consecutive_nonpassing_slo: number;
  error_budget_exhaustion_events: number;
  points: ReliabilityTimelinePoint[];
  latest_delta?: ReliabilityMetricDelta;
  signals: ReliabilitySignal[];
}

export interface ReliabilityTimeline {
  timeline_version: "0.1";
  created_at: string;
  updated_at: string;
  entries: ReliabilityTimelineEntry[];
  summary: ReliabilityTimelineSummary;
  manifest: {
    format: "agentroute-reliability-timeline";
    entry_count: number;
    head_sha256: string;
    summary_sha256: string;
    root_sha256: string;
  };
}

export interface ReliabilityTimelineVerification {
  valid: boolean;
  errors: string[];
  entry_count: number;
  head_sha256?: string;
  current_status?: OperationsAssessmentStatus;
}

export interface ReliabilityTimelineMutation {
  change: "appended" | "unchanged";
  timeline: ReliabilityTimeline;
  entry: ReliabilityTimelineEntry;
}

const TIMELINE_KEYS = new Set(["timeline_version", "created_at", "updated_at", "entries", "summary", "manifest"]);
const ENTRY_KEYS = new Set(["sequence", "recorded_at", "review_root_sha256", "previous_entry_sha256", "entry_sha256", "review"]);
const MANIFEST_KEYS = new Set(["format", "entry_count", "head_sha256", "summary_sha256", "root_sha256"]);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const rounded = (value: number, digits = 6): number => Number(value.toFixed(digits));
const clone = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): string[] {
  const keys = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  return keys.length ? [`${label} contains unknown keys: ${keys.join(", ")}`] : [];
}

function entryHash(sequence: number, recordedAt: string, reviewRoot: string, previous?: string): string {
  return sha256({ sequence, recorded_at: recordedAt, review_root_sha256: reviewRoot, ...(previous ? { previous_entry_sha256: previous } : {}) });
}

function timelineRoot(timeline: Pick<ReliabilityTimeline, "created_at" | "updated_at">, entryCount: number, head: string, summaryHash: string): string {
  return sha256({
    timeline_version: "0.1",
    created_at: timeline.created_at,
    updated_at: timeline.updated_at,
    entry_count: entryCount,
    head_sha256: head,
    summary_sha256: summaryHash,
  });
}

function pointFor(entry: ReliabilityTimelineEntry): ReliabilityTimelinePoint {
  const review = entry.review;
  const global = review.payload.slo.global;
  const budget = global.error_budget;
  return {
    sequence: entry.sequence,
    recorded_at: entry.recorded_at,
    review_root_sha256: entry.review_root_sha256,
    assessment: review.payload.assessment.status,
    drift_status: review.payload.drift.status,
    slo_status: review.payload.slo.status,
    ...(global.success_rate !== undefined ? { success_rate: global.success_rate } : {}),
    ...(global.p95_latency_ms !== undefined ? { p95_latency_ms: global.p95_latency_ms } : {}),
    ...(global.p95_cost_usd !== undefined ? { p95_cost_usd: global.p95_cost_usd } : {}),
    ...(global.p10_quality !== undefined ? { p10_quality: global.p10_quality } : {}),
    policy_violation_rate: global.policy_violation_rate,
    ...(budget ? {
      error_budget_remaining: budget.remaining,
      ...(budget.burn_ratio !== undefined ? { error_budget_burn_ratio: budget.burn_ratio } : {}),
      error_budget_exhausted: budget.exhausted,
    } : {}),
  };
}

function delta(current: number | undefined, previous: number | undefined): number | undefined {
  return current === undefined || previous === undefined ? undefined : rounded(current - previous);
}

function latestDelta(points: ReliabilityTimelinePoint[]): ReliabilityMetricDelta | undefined {
  if (points.length < 2) return undefined;
  const previous = points[points.length - 2];
  const current = points[points.length - 1];
  return {
    from_sequence: previous.sequence,
    to_sequence: current.sequence,
    ...(delta(current.success_rate, previous.success_rate) !== undefined ? { success_rate: delta(current.success_rate, previous.success_rate)! } : {}),
    ...(delta(current.p95_latency_ms, previous.p95_latency_ms) !== undefined ? { p95_latency_ms: delta(current.p95_latency_ms, previous.p95_latency_ms)! } : {}),
    ...(delta(current.p95_cost_usd, previous.p95_cost_usd) !== undefined ? { p95_cost_usd: delta(current.p95_cost_usd, previous.p95_cost_usd)! } : {}),
    ...(delta(current.p10_quality, previous.p10_quality) !== undefined ? { p10_quality: delta(current.p10_quality, previous.p10_quality)! } : {}),
    policy_violation_rate: rounded(current.policy_violation_rate - previous.policy_violation_rate),
    ...(delta(current.error_budget_remaining, previous.error_budget_remaining) !== undefined ? { error_budget_remaining: delta(current.error_budget_remaining, previous.error_budget_remaining)! } : {}),
    ...(delta(current.error_budget_burn_ratio, previous.error_budget_burn_ratio) !== undefined ? { error_budget_burn_ratio: delta(current.error_budget_burn_ratio, previous.error_budget_burn_ratio)! } : {}),
  };
}

function signal(kind: ReliabilitySignalKind, severity: ReliabilitySignalSeverity, point: ReliabilityTimelinePoint, detail: string): ReliabilitySignal {
  return { id: `signal_${sha256({ kind, review_root_sha256: point.review_root_sha256 }).slice(7, 23)}`, kind, severity, review_root_sha256: point.review_root_sha256, detail };
}

export function summarizeReliabilityTimeline(entries: ReliabilityTimelineEntry[]): ReliabilityTimelineSummary {
  if (!entries.length) throw new Error("reliability timeline requires at least one entry");
  const points = entries.map(pointFor);
  const latest = points[points.length - 1];
  const previous = points.length > 1 ? points[points.length - 2] : undefined;
  const statusCounts: Record<OperationsAssessmentStatus, number> = { clear: 0, attention: 0, insufficient: 0, critical: 0 };
  for (const point of points) statusCounts[point.assessment]++;
  let consecutiveCritical = 0;
  let consecutiveNonpassingSlo = 0;
  for (let index = points.length - 1; index >= 0 && points[index].assessment === "critical"; index--) consecutiveCritical++;
  for (let index = points.length - 1; index >= 0 && points[index].slo_status !== "pass"; index--) consecutiveNonpassingSlo++;
  const signals: ReliabilitySignal[] = [];
  if (latest.assessment === "critical") signals.push(signal("current-critical", "critical", latest, "the latest operations review is critical"));
  else if (latest.assessment === "attention") signals.push(signal("current-attention", "warning", latest, "the latest operations review requires attention"));
  else if (latest.assessment === "insufficient") signals.push(signal("evidence-gap", "warning", latest, "the latest operations review has insufficient evidence"));
  if (previous && latest.slo_status === "fail" && previous.slo_status !== "fail") signals.push(signal("slo-regression", "critical", latest, `routing SLO regressed from ${previous.slo_status} to fail`));
  if (previous && latest.slo_status === "pass" && previous.slo_status !== "pass") signals.push(signal("slo-recovery", "info", latest, `routing SLO recovered from ${previous.slo_status} to pass`));
  if (consecutiveCritical >= 2) signals.push(signal("critical-streak", "critical", latest, `${consecutiveCritical} consecutive operations reviews are critical`));
  if (latest.error_budget_exhausted) signals.push(signal("error-budget-exhausted", "critical", latest, "the latest successful-outcome error budget is exhausted"));
  if (latest.drift_status === "fail") signals.push(signal("drift-regression", "critical", latest, "the latest routing drift check failed"));
  return {
    reviews: points.length,
    current_status: latest.assessment,
    status_counts: statusCounts,
    consecutive_critical: consecutiveCritical,
    consecutive_nonpassing_slo: consecutiveNonpassingSlo,
    error_budget_exhaustion_events: points.filter((point) => point.error_budget_exhausted).length,
    points,
    ...(latestDelta(points) ? { latest_delta: latestDelta(points) } : {}),
    signals,
  };
}

function buildTimeline(entries: ReliabilityTimelineEntry[]): ReliabilityTimeline {
  const summary = summarizeReliabilityTimeline(entries);
  const createdAt = entries[0].recorded_at;
  const updatedAt = entries[entries.length - 1].recorded_at;
  const head = entries[entries.length - 1].entry_sha256;
  const summaryHash = sha256(summary);
  const base = { created_at: createdAt, updated_at: updatedAt };
  return {
    timeline_version: "0.1",
    ...base,
    entries,
    summary,
    manifest: {
      format: "agentroute-reliability-timeline",
      entry_count: entries.length,
      head_sha256: head,
      summary_sha256: summaryHash,
      root_sha256: timelineRoot(base, entries.length, head, summaryHash),
    },
  };
}

function checkedReview(value: unknown): OperationsReview {
  const verification = verifyOperationsReview(value);
  if (!verification.valid) throw new Error(`invalid AgentRoute operations review:\n  - ${verification.errors.join("\n  - ")}`);
  return clone(value as OperationsReview);
}

function nextEntry(reviewValue: unknown, sequence: number, previous?: ReliabilityTimelineEntry): ReliabilityTimelineEntry {
  const review = checkedReview(reviewValue);
  const reviewRoot = review.manifest.root_sha256;
  const previousHash = previous?.entry_sha256;
  return {
    sequence,
    recorded_at: review.created_at,
    review_root_sha256: reviewRoot,
    ...(previousHash ? { previous_entry_sha256: previousHash } : {}),
    entry_sha256: entryHash(sequence, review.created_at, reviewRoot, previousHash),
    review,
  };
}

export function createReliabilityTimeline(review: unknown): ReliabilityTimeline {
  return buildTimeline([nextEntry(review, 1)]);
}

export function appendReliabilityReview(timelineValue: unknown, reviewValue: unknown): ReliabilityTimelineMutation {
  const timeline = validateReliabilityTimeline(timelineValue);
  const review = checkedReview(reviewValue);
  const head = timeline.entries[timeline.entries.length - 1];
  if (review.manifest.root_sha256 === head.review_root_sha256) return { change: "unchanged", timeline, entry: head };
  if (timeline.entries.some((entry) => entry.review_root_sha256 === review.manifest.root_sha256)) throw new Error("operations review already exists earlier in reliability timeline");
  if (Date.parse(review.created_at) <= Date.parse(head.recorded_at)) throw new Error("operations review timestamp must be strictly later than the timeline head");
  const entry = nextEntry(review, head.sequence + 1, head);
  return { change: "appended", timeline: buildTimeline([...timeline.entries, entry]), entry };
}

export function verifyReliabilityTimeline(value: unknown): ReliabilityTimelineVerification {
  const errors: string[] = [];
  if (!object(value)) return { valid: false, errors: ["reliability timeline must be an object"], entry_count: 0 };
  errors.push(...unknownKeys(value, TIMELINE_KEYS, "reliability timeline"));
  const timeline = value as unknown as Partial<ReliabilityTimeline>;
  if (timeline.timeline_version !== "0.1") errors.push("timeline_version must equal 0.1");
  if (!timeline.created_at || Number.isNaN(Date.parse(timeline.created_at))) errors.push("created_at must be an ISO-8601 timestamp");
  if (!timeline.updated_at || Number.isNaN(Date.parse(timeline.updated_at))) errors.push("updated_at must be an ISO-8601 timestamp");
  if (!Array.isArray(timeline.entries) || !timeline.entries.length) errors.push("entries must be a non-empty array");
  const entries = Array.isArray(timeline.entries) ? timeline.entries : [];
  let chainValid = entries.length > 0;
  let previous: ReliabilityTimelineEntry | undefined;
  const roots = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] as unknown;
    const label = `entries[${index}]`;
    if (!object(entry)) { errors.push(`${label} must be an object`); chainValid = false; continue; }
    errors.push(...unknownKeys(entry, ENTRY_KEYS, label));
    const candidate = entry as unknown as ReliabilityTimelineEntry;
    if (candidate.sequence !== index + 1) { errors.push(`${label}.sequence must equal ${index + 1}`); chainValid = false; }
    if (!candidate.recorded_at || Number.isNaN(Date.parse(candidate.recorded_at))) { errors.push(`${label}.recorded_at must be an ISO-8601 timestamp`); chainValid = false; }
    const reviewVerification = verifyOperationsReview(candidate.review);
    errors.push(...reviewVerification.errors.map((error) => `${label}.review: ${error}`));
    if (!reviewVerification.valid) chainValid = false;
    if (reviewVerification.valid && candidate.recorded_at !== candidate.review.created_at) { errors.push(`${label}.recorded_at must match its operations review`); chainValid = false; }
    if (reviewVerification.valid && candidate.review_root_sha256 !== candidate.review.manifest.root_sha256) { errors.push(`${label}.review_root_sha256 does not match its operations review`); chainValid = false; }
    if (roots.has(candidate.review_root_sha256)) { errors.push(`${label} duplicates an operations review`); chainValid = false; }
    roots.add(candidate.review_root_sha256);
    const expectedPrevious = previous?.entry_sha256;
    if (candidate.previous_entry_sha256 !== expectedPrevious) { errors.push(`${label}.previous_entry_sha256 does not match the chain`); chainValid = false; }
    if (previous && Date.parse(candidate.recorded_at) <= Date.parse(previous.recorded_at)) { errors.push(`${label}.recorded_at must be strictly increasing`); chainValid = false; }
    const expectedHash = entryHash(candidate.sequence, candidate.recorded_at, candidate.review_root_sha256, expectedPrevious);
    if (candidate.entry_sha256 !== expectedHash) { errors.push(`${label}.entry_sha256 does not match the entry`); chainValid = false; }
    previous = candidate;
  }
  if (entries.length && timeline.created_at !== entries[0].recorded_at) errors.push("created_at must match the first entry");
  if (entries.length && timeline.updated_at !== entries[entries.length - 1].recorded_at) errors.push("updated_at must match the final entry");
  if (!object(timeline.summary)) errors.push("summary must be an object");
  if (!object(timeline.manifest)) errors.push("manifest must be an object");
  else errors.push(...unknownKeys(timeline.manifest, MANIFEST_KEYS, "manifest"));
  if (chainValid) {
    const expectedSummary = summarizeReliabilityTimeline(entries as ReliabilityTimelineEntry[]);
    if (canonicalJson(timeline.summary) !== canonicalJson(expectedSummary)) errors.push("summary does not match timeline entries");
    if (timeline.manifest) {
      const head = entries[entries.length - 1].entry_sha256;
      const summaryHash = sha256(expectedSummary);
      if (timeline.manifest.format !== "agentroute-reliability-timeline") errors.push("manifest format is invalid");
      if (timeline.manifest.entry_count !== entries.length) errors.push("manifest entry_count does not match entries");
      if (timeline.manifest.head_sha256 !== head) errors.push("manifest head_sha256 does not match the chain");
      if (timeline.manifest.summary_sha256 !== summaryHash) errors.push("manifest summary_sha256 does not match the derived summary");
      if (timeline.created_at && timeline.updated_at) {
        const root = timelineRoot({ created_at: timeline.created_at, updated_at: timeline.updated_at }, entries.length, head, summaryHash);
        if (timeline.manifest.root_sha256 !== root) errors.push("manifest root_sha256 does not match the timeline");
      }
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    entry_count: entries.length,
    ...(timeline.manifest?.head_sha256 ? { head_sha256: timeline.manifest.head_sha256 } : {}),
    ...(object(timeline.summary) && ["clear", "attention", "insufficient", "critical"].includes(String(timeline.summary.current_status)) ? { current_status: timeline.summary.current_status as OperationsAssessmentStatus } : {}),
  };
}

export function validateReliabilityTimeline(value: unknown): ReliabilityTimeline {
  const verification = verifyReliabilityTimeline(value);
  if (!verification.valid) throw new Error(`invalid AgentRoute reliability timeline:\n  - ${verification.errors.join("\n  - ")}`);
  return clone(value as ReliabilityTimeline);
}

function writeAtomic(path: string, timeline: ReliabilityTimeline): void {
  const validated = validateReliabilityTimeline(timeline);
  const temporary = join(dirname(path), `.${path.split("/").pop() || "reliability"}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, canonicalJson(validated) + "\n");
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function initializeReliabilityTimeline(path: string, review: unknown, force = false): ReliabilityTimeline {
  if (existsSync(path) && !force) throw new Error(`${path} already exists; pass force explicitly to replace it`);
  const timeline = createReliabilityTimeline(review);
  writeAtomic(path, timeline);
  return timeline;
}

export function loadReliabilityTimeline(path: string): ReliabilityTimeline {
  return validateReliabilityTimeline(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function appendReliabilityTimeline(path: string, review: unknown): ReliabilityTimelineMutation {
  const mutation = appendReliabilityReview(loadReliabilityTimeline(path), review);
  if (mutation.change === "appended") writeAtomic(path, mutation.timeline);
  return mutation;
}

const escapeHtml = (value: unknown): string => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const display = (value: number | undefined, suffix = ""): string => value === undefined ? "missing" : `${value}${suffix}`;
const signed = (value: number | undefined, suffix = ""): string => value === undefined ? "missing" : `${value > 0 ? "+" : ""}${value}${suffix}`;

export function renderReliabilityTimeline(value: unknown): string {
  const timeline = validateReliabilityTimeline(value);
  const summary = timeline.summary;
  const latest = summary.points[summary.points.length - 1];
  const deltaRow = summary.latest_delta ? `<div class="delta"><span>Success ${signed(summary.latest_delta.success_rate)}</span><span>p95 latency ${signed(summary.latest_delta.p95_latency_ms, " ms")}</span><span>p95 cost ${signed(summary.latest_delta.p95_cost_usd, " USD")}</span><span>p10 quality ${signed(summary.latest_delta.p10_quality)}</span></div>` : `<p class="muted">A second review is required before metric deltas are available.</p>`;
  const signalCards = summary.signals.map((item) => `<article class="signal ${escapeHtml(item.severity)}"><p>${escapeHtml(item.severity)}</p><h3>${escapeHtml(item.kind)}</h3><span>${escapeHtml(item.detail)}</span></article>`).join("");
  const rows = [...summary.points].reverse().map((point) => `<tr><td>#${point.sequence}</td><td>${escapeHtml(point.recorded_at)}</td><td><span class="pill ${escapeHtml(point.assessment)}">${escapeHtml(point.assessment)}</span></td><td>${escapeHtml(point.slo_status)}</td><td>${display(point.success_rate)}</td><td>${display(point.p95_latency_ms, " ms")}</td><td>${display(point.error_budget_burn_ratio)}</td><td><code>${escapeHtml(point.review_root_sha256.slice(0, 19))}…</code></td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentRoute Reliability Timeline</title><style>:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#07111b;color:#ecf7ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#163152 0,transparent 36%),#07111b}main{max-width:1180px;margin:auto;padding:56px 24px 84px}.eyebrow{text-transform:uppercase;letter-spacing:.16em;color:#67e8f9;font-weight:800}h1{font-size:clamp(2.4rem,7vw,5.4rem);line-height:.95;margin:.14em 0}.lede,.muted{color:#9fb4c7;max-width:820px}.hero{display:grid;grid-template-columns:1.4fr .8fr;gap:18px;align-items:end}.state{border:1px solid #31516d;background:#0c2031;border-radius:24px;padding:24px}.state b{font-size:3rem;display:block}.metrics,.signals{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:26px 0}.metric,.signal,section{border:1px solid #243e54;background:#0b1a28;border-radius:18px;padding:20px}.metric b{display:block;font-size:2rem}.signal p{margin:0;text-transform:uppercase;font-size:.75rem;letter-spacing:.12em}.signal h3{margin:.4rem 0}.critical{color:#fb7185}.warning,.attention,.insufficient{color:#fbbf24}.info,.clear{color:#86efac}.delta{display:flex;flex-wrap:wrap;gap:10px}.delta span,.pill{border:1px solid #31516d;border-radius:999px;padding:7px 11px}section{margin-top:18px;overflow:auto}table{width:100%;border-collapse:collapse;min-width:820px}th,td{text-align:left;border-bottom:1px solid #243e54;padding:12px 8px}code{color:#c4b5fd}@media(max-width:700px){.hero{grid-template-columns:1fr}}</style></head><body><main><div class="hero"><div><p class="eyebrow">AgentRoute evidence plane</p><h1>Reliability timeline</h1><p class="lede">A verified, append-only operational history. Trend signals are derived from sanitized evidence and never apply routing changes or contact a provider.</p></div><div class="state"><span>Current assessment</span><b class="${escapeHtml(summary.current_status)}">${escapeHtml(summary.current_status)}</b><small>${summary.reviews} verified review${summary.reviews === 1 ? "" : "s"}</small></div></div><div class="metrics"><div class="metric"><span>Success rate</span><b>${display(latest.success_rate)}</b></div><div class="metric"><span>p95 latency</span><b>${display(latest.p95_latency_ms, " ms")}</b></div><div class="metric"><span>Error budget burn</span><b>${display(latest.error_budget_burn_ratio)}</b></div><div class="metric"><span>Critical streak</span><b>${summary.consecutive_critical}</b></div></div><section><h2>Latest movement</h2>${deltaRow}</section><section><h2>Signals</h2><div class="signals">${signalCards || `<p class="muted">No current regression, evidence-gap, or exhaustion signals.</p>`}</div></section><section><h2>Verified review history</h2><table><thead><tr><th>Review</th><th>Recorded</th><th>Assessment</th><th>SLO</th><th>Success</th><th>Latency</th><th>Burn</th><th>Evidence root</th></tr></thead><tbody>${rows}</tbody></table></section><section><h2>Interpretation limits</h2><p class="muted">Hash chaining detects modification and reordering but does not authenticate a signer or prove traffic completeness. Missing metrics remain missing. Scenarios remain projections over recorded candidates. This report sends no alerts and changes no policy.</p><p><code>${escapeHtml(timeline.manifest.root_sha256)}</code></p></section></main></body></html>\n`;
}
