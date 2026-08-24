import { foldRouteRecords } from "./route.js";
import { ROUTE_VERSION } from "./route-types.js";
import type { RouteCandidate, RouteRecord, RouteState } from "./route-types.js";

export type AuditGapSeverity = "warning" | "info";

export interface AuditReadinessMetric {
  id: string;
  label: string;
  covered: number;
  total: number;
  ratio: number;
  weight: number;
}

export interface AuditGap {
  route_id: string;
  severity: AuditGapSeverity;
  code: string;
  message: string;
}

export interface RouteAuditReport {
  route_version: string;
  generated_at: string;
  decisions: number;
  readiness_score: number;
  readiness_grade: "A" | "B" | "C" | "D";
  metrics: AuditReadinessMetric[];
  gaps: AuditGap[];
}

const rounded = (value: number): number => Number(value.toFixed(6));

function openRouterMetadata(state: RouteState): Record<string, unknown> {
  const extension = state.decision.extensions?.openrouter;
  return extension && typeof extension === "object" && !Array.isArray(extension)
    ? extension as Record<string, unknown>
    : {};
}

function policyScorable(candidate: RouteCandidate): boolean {
  return candidate.scores?.quality !== undefined &&
    candidate.scores.latency !== undefined &&
    candidate.scores.cost !== undefined;
}

function policyReady(state: RouteState): boolean {
  const eligible = state.decision.candidates.filter((candidate) => candidate.eligible !== false);
  return state.decision.source.fidelity === "full" && eligible.length > 1 && eligible.every(policyScorable);
}

function hasFallbackEvidence(state: RouteState): boolean {
  if (state.decision.selection.fallback_order?.length) return true;
  const metadata = openRouterMetadata(state);
  if (Array.isArray(metadata.attempts) && metadata.attempts.length > 0) return true;
  return typeof metadata.attempt === "number";
}

function metric(id: string, label: string, states: RouteState[], weight: number, covered: (state: RouteState) => boolean): AuditReadinessMetric {
  const count = states.filter(covered).length;
  return {
    id,
    label,
    covered: count,
    total: states.length,
    ratio: rounded(states.length ? count / states.length : 0),
    weight,
  };
}

function gapsFor(state: RouteState): AuditGap[] {
  const routeId = state.decision.route_id;
  const outcome = state.latest_observation?.outcome;
  const result: AuditGap[] = [];
  const add = (severity: AuditGapSeverity, code: string, message: string): void => {
    result.push({ route_id: routeId, severity, code, message });
  };
  if (!outcome) add("warning", "outcome_missing", "No measured outcome has been appended.");
  if (state.decision.source.fidelity !== "full") add("warning", "candidate_evidence_incomplete", `Candidate evidence is ${state.decision.source.fidelity}; counterfactual ranking is disabled.`);
  if (outcome && outcome.quality === undefined) add("warning", "quality_missing", "Outcome quality has not been evaluated.");
  if (outcome && outcome.cost_usd === undefined) add("info", "cost_missing", "Measured cost is unavailable.");
  if (outcome && outcome.latency_ms === undefined) add("info", "latency_missing", "Measured latency is unavailable.");
  if (state.decision.source.fidelity === "full" && !policyReady(state)) add("warning", "policy_scores_missing", "At least two eligible candidates with complete quality, latency, and cost scores are required by the policy lab.");
  if (!hasFallbackEvidence(state)) add("info", "fallback_evidence_missing", "No fallback order or router attempt path was recorded.");
  return result;
}

/** Measure instrumentation quality, never model quality or routing success. */
export function auditRouteRecords(records: RouteRecord[], generatedAt = new Date().toISOString()): RouteAuditReport {
  const states = [...foldRouteRecords(records).values()];
  const metrics = [
    metric("outcome", "Outcome coverage", states, 0.2, (state) => Boolean(state.latest_observation)),
    metric("quality", "Quality evaluation", states, 0.2, (state) => state.latest_observation?.outcome.quality !== undefined),
    metric("fidelity", "Complete candidate evidence", states, 0.2, (state) => state.decision.source.fidelity === "full"),
    metric("policy", "Policy-lab ready", states, 0.15, policyReady),
    metric("latency", "Measured latency", states, 0.1, (state) => state.latest_observation?.outcome.latency_ms !== undefined),
    metric("cost", "Measured cost", states, 0.1, (state) => state.latest_observation?.outcome.cost_usd !== undefined),
    metric("fallback", "Fallback visibility", states, 0.05, hasFallbackEvidence),
  ];
  const score = rounded(metrics.reduce((sum, item) => sum + item.ratio * item.weight, 0));
  const grade = score >= 0.9 ? "A" : score >= 0.75 ? "B" : score >= 0.5 ? "C" : "D";
  return {
    route_version: ROUTE_VERSION,
    generated_at: generatedAt,
    decisions: states.length,
    readiness_score: score,
    readiness_grade: grade,
    metrics,
    gaps: states.flatMap(gapsFor),
  };
}
