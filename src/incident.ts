import { createHash } from "node:crypto";
import { foldRouteRecords, policyViolations } from "./route.js";
import { ROUTE_VERSION } from "./route-types.js";
import type { RouteRecord } from "./route-types.js";

export type IncidentSeverity = "critical" | "high" | "medium" | "low";
export type IncidentCategory =
  | "outcome-failure"
  | "outcome-partial"
  | "outcome-cancelled"
  | "outcome-unknown"
  | "observation-missing"
  | "actual-model-mismatch"
  | "actual-provider-mismatch"
  | "latency-slo-breach"
  | "cost-budget-breach"
  | "quality-floor-breach"
  | "selection-policy-violation"
  | "candidate-evidence-incomplete"
  | "fallback-visibility-missing";

export interface IncidentFinding {
  finding_id: string;
  route_id: string;
  task_type: string;
  category: IncidentCategory;
  severity: IncidentSeverity;
  summary: string;
  evidence: Record<string, string | number | boolean>;
}

export interface IncidentReport {
  route_version: string;
  incident_report_version: "0.1";
  generated_at: string;
  status: "clear" | "attention" | "critical";
  decisions: number;
  observed: number;
  routes_with_findings: number;
  findings_count: number;
  by_severity: Record<IncidentSeverity, number>;
  by_category: Partial<Record<IncidentCategory, number>>;
  findings: IncidentFinding[];
  limitations: string[];
}

const SEVERITY_ORDER: Record<IncidentSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function canonical(value: Record<string, string | number | boolean>): string {
  return Object.keys(value).sort().map((key) => `${key}=${JSON.stringify(value[key])}`).join("&");
}

function makeFinding(
  routeId: string,
  taskType: string,
  category: IncidentCategory,
  severity: IncidentSeverity,
  summary: string,
  evidence: Record<string, string | number | boolean>,
): IncidentFinding {
  const digest = createHash("sha256").update(`${routeId}\u0000${category}\u0000${canonical(evidence)}`).digest("hex").slice(0, 16);
  return { finding_id: `finding_${digest}`, route_id: routeId, task_type: taskType, category, severity, summary, evidence };
}

export function analyzeRouteIncidents(records: RouteRecord[], generatedAt = new Date().toISOString()): IncidentReport {
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("incident generated_at must be an ISO-8601 timestamp");
  const states = [...foldRouteRecords(records).values()];
  const findings: IncidentFinding[] = [];
  for (const state of states) {
    const decision = state.decision;
    const routeId = decision.route_id;
    const taskType = decision.task.type;
    const selected = decision.candidates.find((candidate) => candidate.id === decision.selection.candidate_id)!;
    const selectedIdentity = selected.provider ? `${selected.provider}/${selected.model}` : selected.model;
    const observation = state.latest_observation;
    if (!observation) {
      findings.push(makeFinding(routeId, taskType, "observation-missing", "high", "No outcome observation is available for this route.", { selected_identity: selectedIdentity }));
    } else {
      const outcome = observation.outcome;
      if (outcome.status === "failure") findings.push(makeFinding(routeId, taskType, "outcome-failure", "critical", "The latest recorded outcome failed.", { outcome_status: outcome.status }));
      if (outcome.status === "partial") findings.push(makeFinding(routeId, taskType, "outcome-partial", "medium", "The latest recorded outcome was partial.", { outcome_status: outcome.status }));
      if (outcome.status === "cancelled") findings.push(makeFinding(routeId, taskType, "outcome-cancelled", "medium", "The latest recorded outcome was cancelled.", { outcome_status: outcome.status }));
      if (outcome.status === "unknown") findings.push(makeFinding(routeId, taskType, "outcome-unknown", "high", "The latest recorded outcome status is unknown.", { outcome_status: outcome.status }));
      if (outcome.actual_model && outcome.actual_model !== selected.model) {
        findings.push(makeFinding(routeId, taskType, "actual-model-mismatch", "high", "The executed model differs from the selected model.", { selected_model: selected.model, actual_model: outcome.actual_model }));
      }
      if (outcome.actual_provider && outcome.actual_provider !== selected.provider) {
        findings.push(makeFinding(routeId, taskType, "actual-provider-mismatch", "high", "The executed provider differs from the selected provider.", { selected_provider: selected.provider || "unrecorded", actual_provider: outcome.actual_provider }));
      }
      if (decision.criteria?.max_latency_ms !== undefined && outcome.latency_ms !== undefined && outcome.latency_ms > decision.criteria.max_latency_ms) {
        findings.push(makeFinding(routeId, taskType, "latency-slo-breach", "high", "Measured latency exceeded the recorded route ceiling.", { measured_latency_ms: outcome.latency_ms, maximum_latency_ms: decision.criteria.max_latency_ms }));
      }
      if (decision.criteria?.max_cost_usd !== undefined && outcome.cost_usd !== undefined && outcome.cost_usd > decision.criteria.max_cost_usd) {
        findings.push(makeFinding(routeId, taskType, "cost-budget-breach", "high", "Measured cost exceeded the recorded route ceiling.", { measured_cost_usd: outcome.cost_usd, maximum_cost_usd: decision.criteria.max_cost_usd }));
      }
      if (decision.criteria?.min_quality !== undefined && outcome.quality !== undefined && outcome.quality < decision.criteria.min_quality) {
        findings.push(makeFinding(routeId, taskType, "quality-floor-breach", "high", "Measured quality fell below the recorded route floor.", { measured_quality: outcome.quality, minimum_quality: decision.criteria.min_quality }));
      }
    }
    for (const violation of policyViolations(decision).sort()) {
      findings.push(makeFinding(routeId, taskType, "selection-policy-violation", "high", "The selected candidate violated a recorded routing constraint.", { violation }));
    }
    if (decision.source.fidelity !== "full") {
      findings.push(makeFinding(routeId, taskType, "candidate-evidence-incomplete", "medium", "The recorded candidate set is incomplete, limiting fallback and counterfactual review.", { fidelity: decision.source.fidelity }));
    }
    if (decision.source.fidelity === "full" && decision.candidates.length > 1 && !decision.selection.fallback_order?.length) {
      findings.push(makeFinding(routeId, taskType, "fallback-visibility-missing", "low", "Multiple candidates were recorded but no fallback order was declared.", { candidate_count: decision.candidates.length }));
    }
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || a.route_id.localeCompare(b.route_id)
    || a.category.localeCompare(b.category)
    || a.finding_id.localeCompare(b.finding_id));
  const bySeverity: Record<IncidentSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const categoryCounts = new Map<IncidentCategory, number>();
  for (const finding of findings) {
    bySeverity[finding.severity]++;
    categoryCounts.set(finding.category, (categoryCounts.get(finding.category) || 0) + 1);
  }
  return {
    route_version: ROUTE_VERSION,
    incident_report_version: "0.1",
    generated_at: generatedAt,
    status: bySeverity.critical ? "critical" : findings.length ? "attention" : "clear",
    decisions: states.length,
    observed: states.filter((state) => state.latest_observation).length,
    routes_with_findings: new Set(findings.map((finding) => finding.route_id)).size,
    findings_count: findings.length,
    by_severity: bySeverity,
    by_category: Object.fromEntries([...categoryCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
    findings,
    limitations: [
      "Findings are deterministic operational leads, not automatic root-cause determinations.",
      "Only allowlisted receipt facts are analyzed; prompts, outputs, errors, endpoints, credentials, and arbitrary extensions are excluded.",
      "Missing measurements remain unknown and are not treated as zero or as a threshold pass.",
    ],
  };
}

const escapeHtml = (value: unknown): string => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

export function renderIncidentReport(report: IncidentReport): string {
  const cards = report.findings.map((finding) => {
    const evidence = Object.entries(finding.evidence).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `<dt>${escapeHtml(key.replace(/_/g, " "))}</dt><dd>${escapeHtml(value)}</dd>`).join("");
    return `<article class="finding ${escapeHtml(finding.severity)}"><header><span>${escapeHtml(finding.severity)}</span><code>${escapeHtml(finding.category)}</code></header><h2>${escapeHtml(finding.summary)}</h2><p><strong>${escapeHtml(finding.route_id)}</strong> · ${escapeHtml(finding.task_type)}</p><dl>${evidence}</dl><small>${escapeHtml(finding.finding_id)}</small></article>`;
  }).join("");
  const empty = report.findings.length ? "" : `<section class="empty"><h2>No incident findings</h2><p>No supported finding category was detected in the supplied receipts.</p></section>`;
  const limitations = report.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentRoute Incident Review</title>
<style>:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#0b1020;color:#e9edf7}*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:48px 24px 72px}h1{font-size:clamp(2rem,6vw,4.5rem);margin:.15em 0}.eyebrow{color:#7dd3fc;text-transform:uppercase;letter-spacing:.14em;font-weight:700}.lede{color:#aab4ca;max-width:760px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:28px 0}.metric,.finding,.empty,.limits{border:1px solid #29324a;background:#121a2f;border-radius:16px;padding:20px}.metric b{display:block;font-size:2rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}.finding{border-top:4px solid #64748b}.finding.critical{border-top-color:#fb7185}.finding.high{border-top-color:#fbbf24}.finding.medium{border-top-color:#60a5fa}.finding.low{border-top-color:#94a3b8}.finding header{display:flex;justify-content:space-between;gap:12px;text-transform:uppercase;letter-spacing:.08em;font-size:.75rem}.finding h2{font-size:1.05rem}.finding p,.finding small,.limits{color:#aab4ca}.finding dl{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:18px 0}.finding dt{color:#7f8ba4}.finding dd{margin:0;text-align:right;overflow-wrap:anywhere}.limits{margin-top:28px}code{color:#c4b5fd}</style></head>
<body><main><p class="eyebrow">AgentRoute operations intelligence</p><h1>Incident review</h1><p class="lede">Allowlisted routing evidence, organized as operational leads. Status: <strong>${escapeHtml(report.status)}</strong>. Generated ${escapeHtml(report.generated_at)}.</p>
<section class="metrics"><div class="metric"><b>${report.decisions}</b>decisions</div><div class="metric"><b>${report.observed}</b>observed</div><div class="metric"><b>${report.routes_with_findings}</b>routes flagged</div><div class="metric"><b>${report.findings_count}</b>findings</div></section>
${empty}<section class="grid">${cards}</section><section class="limits"><h2>Interpretation limits</h2><ul>${limitations}</ul></section></main></body></html>\n`;
}
