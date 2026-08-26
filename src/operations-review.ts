import { readFileSync, writeFileSync } from "node:fs";
import { createEvidenceCapsule, verifyEvidenceCapsule } from "./capsule.js";
import type { EvidenceCapsule } from "./capsule.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { evaluateRoutingDrift } from "./drift.js";
import type { RoutingDriftConfig, RoutingDriftReport } from "./drift.js";
import { analyzeRouteIncidents } from "./incident.js";
import type { IncidentReport } from "./incident.js";
import { runRoutingScenario, validateRoutingScenario } from "./scenario.js";
import type { RoutingScenario, RoutingScenarioReport } from "./scenario.js";
import { evaluateRoutingSlo } from "./slo.js";
import type { RoutingSloReport } from "./slo.js";
import type { RouteRecord } from "./route-types.js";

export type OperationsAssessmentStatus = "clear" | "attention" | "insufficient" | "critical";

export interface OperationsAssessment {
  status: OperationsAssessmentStatus;
  reasons: string[];
}

export interface OperationsReview {
  operations_review_version: "0.1";
  created_at: string;
  manifest: {
    format: "agentroute-operations-review";
    scenario_count: number;
    payload_sha256: string;
    root_sha256: string;
  };
  payload: {
    baseline: EvidenceCapsule;
    current: EvidenceCapsule;
    drift_config: RoutingDriftReport["config"];
    slo_config: RoutingSloReport["config"];
    scenarios: RoutingScenario[];
    drift: RoutingDriftReport;
    slo: RoutingSloReport;
    incident: IncidentReport;
    scenario_reports: RoutingScenarioReport[];
    assessment: OperationsAssessment;
  };
}

export interface CreateOperationsReviewOptions {
  baseline_records: RouteRecord[];
  current_records: RouteRecord[];
  drift_config: RoutingDriftConfig;
  slo_config: unknown;
  scenarios?: unknown[];
  created_at?: string;
}

export interface OperationsReviewVerification {
  valid: boolean;
  errors: string[];
  status?: OperationsAssessmentStatus;
  root_sha256?: string;
  baseline_records: number;
  current_records: number;
  scenario_count: number;
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function rootHash(createdAt: string, payloadHash: string, scenarioCount: number): string {
  return sha256({ operations_review_version: "0.1", created_at: createdAt, payload_sha256: payloadHash, scenario_count: scenarioCount });
}

export function assessOperationsReview(
  drift: RoutingDriftReport,
  slo: RoutingSloReport,
  incident: IncidentReport,
  scenarios: RoutingScenarioReport[],
): OperationsAssessment {
  const critical: string[] = [];
  const insufficient: string[] = [];
  const attention: string[] = [];
  if (drift.status === "fail") critical.push("routing drift thresholds failed");
  else if (drift.status === "insufficient") insufficient.push("routing drift evidence is insufficient");
  if (slo.status === "fail") critical.push("routing SLO failed");
  else if (slo.status === "insufficient") insufficient.push("routing SLO evidence is insufficient");
  if (incident.status === "critical") critical.push("incident forensics contains critical findings");
  else if (incident.findings_count) attention.push(`incident forensics contains ${incident.findings_count} finding(s)`);
  if (incident.findings.some((finding) => finding.category === "candidate-evidence-incomplete" || finding.category === "observation-missing")) insufficient.push("incident forensics found incomplete operational evidence");
  for (const report of scenarios) {
    if (report.stranded) critical.push(`scenario ${report.scenario.id} strands ${report.stranded} route(s)`);
    if (report.skipped_incomplete_evidence) insufficient.push(`scenario ${report.scenario.id} skipped ${report.skipped_incomplete_evidence} incomplete route(s)`);
    if (report.impacted && !report.stranded) attention.push(`scenario ${report.scenario.id} impacts ${report.impacted} route(s)`);
  }
  if (critical.length) return { status: "critical", reasons: [...critical, ...insufficient, ...attention] };
  if (insufficient.length) return { status: "insufficient", reasons: [...insufficient, ...attention] };
  if (attention.length) return { status: "attention", reasons: attention };
  return { status: "clear", reasons: ["drift and SLO checks pass with no incident findings or declared scenario impact"] };
}

function normalizedScenarios(values: unknown[]): RoutingScenario[] {
  const scenarios = values.map(validateRoutingScenario).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) throw new Error("operations review scenario IDs must be unique");
  return scenarios;
}

export function createOperationsReview(options: CreateOperationsReviewOptions): OperationsReview {
  const createdAt = options.created_at || new Date().toISOString();
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("operations review created_at must be an ISO-8601 timestamp");
  const baseline = createEvidenceCapsule(options.baseline_records, [], createdAt);
  const current = createEvidenceCapsule(options.current_records, [], createdAt);
  const scenarios = normalizedScenarios(options.scenarios || []);
  const drift = evaluateRoutingDrift(baseline.payload.records, current.payload.records, options.drift_config, createdAt);
  const slo = evaluateRoutingSlo(current.payload.records, options.slo_config, createdAt);
  const incident = analyzeRouteIncidents(current.payload.records, createdAt);
  const scenarioReports = scenarios.map((scenario) => runRoutingScenario(current.payload.records, scenario, createdAt));
  const payload: OperationsReview["payload"] = {
    baseline,
    current,
    drift_config: drift.config,
    slo_config: slo.config,
    scenarios,
    drift,
    slo,
    incident,
    scenario_reports: scenarioReports,
    assessment: assessOperationsReview(drift, slo, incident, scenarioReports),
  };
  const payloadHash = sha256(payload);
  return {
    operations_review_version: "0.1",
    created_at: createdAt,
    manifest: {
      format: "agentroute-operations-review",
      scenario_count: scenarios.length,
      payload_sha256: payloadHash,
      root_sha256: rootHash(createdAt, payloadHash, scenarios.length),
    },
    payload,
  };
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function verifyOperationsReview(value: unknown): OperationsReviewVerification {
  const errors: string[] = [];
  if (!object(value)) return { valid: false, errors: ["operations review must be an object"], baseline_records: 0, current_records: 0, scenario_count: 0 };
  const review = value as unknown as Partial<OperationsReview>;
  if (review.operations_review_version !== "0.1") errors.push("operations_review_version must equal 0.1");
  if (!review.created_at || Number.isNaN(Date.parse(review.created_at))) errors.push("created_at must be an ISO-8601 timestamp");
  if (!review.manifest || review.manifest.format !== "agentroute-operations-review") errors.push("manifest format is invalid");
  if (!object(review.payload)) errors.push("payload must be an object");
  const payload = review.payload as OperationsReview["payload"] | undefined;
  const baselineVerification = verifyEvidenceCapsule(payload?.baseline);
  const currentVerification = verifyEvidenceCapsule(payload?.current);
  errors.push(...baselineVerification.errors.map((error) => `payload.baseline: ${error}`));
  errors.push(...currentVerification.errors.map((error) => `payload.current: ${error}`));
  if (review.created_at && payload?.baseline?.created_at !== review.created_at) errors.push("baseline capsule created_at must match operations review");
  if (review.created_at && payload?.current?.created_at !== review.created_at) errors.push("current capsule created_at must match operations review");
  let scenarios: RoutingScenario[] = [];
  if (!Array.isArray(payload?.scenarios)) errors.push("payload.scenarios must be an array");
  else {
    try {
      scenarios = normalizedScenarios(payload.scenarios);
      if (!same(scenarios, payload.scenarios)) errors.push("payload scenarios must be normalized and sorted by ID");
    } catch (error) { errors.push(`payload.scenarios: ${(error as Error).message}`); }
  }
  if (payload && review.created_at && !Number.isNaN(Date.parse(review.created_at)) && baselineVerification.valid && currentVerification.valid && scenarios.length === (payload.scenarios?.length || 0)) {
    try {
      const drift = evaluateRoutingDrift(payload.baseline.payload.records, payload.current.payload.records, payload.drift_config, review.created_at);
      const slo = evaluateRoutingSlo(payload.current.payload.records, payload.slo_config, review.created_at);
      const incident = analyzeRouteIncidents(payload.current.payload.records, review.created_at);
      const scenarioReports = scenarios.map((scenario) => runRoutingScenario(payload.current.payload.records, scenario, review.created_at!));
      const assessment = assessOperationsReview(drift, slo, incident, scenarioReports);
      if (!same(payload.drift_config, drift.config)) errors.push("payload drift config is not normalized");
      if (!same(payload.slo_config, slo.config)) errors.push("payload SLO config is not normalized");
      if (!same(payload.drift, drift)) errors.push("payload drift report does not match embedded evidence");
      if (!same(payload.slo, slo)) errors.push("payload SLO report does not match embedded evidence");
      if (!same(payload.incident, incident)) errors.push("payload incident report does not match embedded evidence");
      if (!same(payload.scenario_reports, scenarioReports)) errors.push("payload scenario reports do not match embedded evidence");
      if (!same(payload.assessment, assessment)) errors.push("payload assessment does not match derived reports");
    } catch (error) { errors.push(`payload derivation failed: ${(error as Error).message}`); }
  }
  if (review.manifest) {
    if (review.manifest.scenario_count !== scenarios.length) errors.push("manifest scenario_count does not match payload");
    if (payload) {
      const payloadHash = sha256(payload);
      if (review.manifest.payload_sha256 !== payloadHash) errors.push("payload SHA-256 mismatch");
      if (review.created_at) {
        const expectedRoot = rootHash(review.created_at, payloadHash, scenarios.length);
        if (review.manifest.root_sha256 !== expectedRoot) errors.push("root SHA-256 mismatch");
      }
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    ...(payload?.assessment?.status ? { status: payload.assessment.status } : {}),
    ...(review.manifest?.root_sha256 ? { root_sha256: review.manifest.root_sha256 } : {}),
    baseline_records: baselineVerification.record_count,
    current_records: currentVerification.record_count,
    scenario_count: scenarios.length,
  };
}

export function writeOperationsReview(path: string, review: OperationsReview): void {
  writeFileSync(path, canonicalJson(review) + "\n");
}

export function loadOperationsReview(path: string): OperationsReview {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const verification = verifyOperationsReview(value);
  if (!verification.valid) throw new Error(`invalid AgentRoute operations review:\n  - ${verification.errors.join("\n  - ")}`);
  return value as OperationsReview;
}

const escapeHtml = (value: unknown): string => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

export function renderOperationsReview(review: OperationsReview): string {
  const verification = verifyOperationsReview(review);
  if (!verification.valid) throw new Error(`cannot render invalid AgentRoute operations review:\n  - ${verification.errors.join("\n  - ")}`);
  const payload = review.payload;
  const reasons = payload.assessment.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
  const nonPassing = [...payload.drift.checks, ...payload.slo.checks].filter((check) => check.status !== "pass").map((check) => `<tr><td>${escapeHtml(check.scope)}</td><td>${escapeHtml(check.metric)}</td><td>${escapeHtml(check.status)}</td><td>${escapeHtml(check.actual ?? "missing")}</td><td>${escapeHtml(check.threshold ?? "")}</td></tr>`).join("");
  const scenarioCards = payload.scenario_reports.map((report) => `<article><h3>${escapeHtml(report.scenario.id)}</h3><p>${escapeHtml(report.result)} · ${report.impacted} impacted · ${report.stranded} stranded · ${report.skipped_incomplete_evidence} skipped</p></article>`).join("");
  const incidentCards = payload.incident.findings.map((finding) => `<article><h3>${escapeHtml(finding.severity)} · ${escapeHtml(finding.category)}</h3><p>${escapeHtml(finding.route_id)} · ${escapeHtml(finding.summary)}</p></article>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentRoute Operations Review</title><style>:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#090f1f;color:#edf2ff}*{box-sizing:border-box}body{margin:0}main{max-width:1120px;margin:auto;padding:52px 24px 80px}.eyebrow{color:#67e8f9;text-transform:uppercase;letter-spacing:.14em;font-weight:750}h1{font-size:clamp(2.2rem,7vw,5rem);margin:.1em 0}.lede{max-width:800px;color:#aeb9d2}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:30px 0}.metric,section,article{border:1px solid #28324d;background:#111a31;border-radius:16px;padding:20px}.metric b{display:block;font-size:2rem}.critical{color:#fb7185}.insufficient{color:#fbbf24}.attention{color:#93c5fd}.clear{color:#86efac}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}section{margin-top:18px}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #28324d;padding:10px 6px}code{color:#c4b5fd;overflow-wrap:anywhere}.muted{color:#8f9bb5}</style></head><body><main><p class="eyebrow">AgentRoute evidence plane</p><h1>Operations review</h1><p class="lede">Verified, read-only operational evidence. Created ${escapeHtml(review.created_at)}. Assessment: <strong class="${escapeHtml(payload.assessment.status)}">${escapeHtml(payload.assessment.status)}</strong>.</p><div class="metrics"><div class="metric"><b>${escapeHtml(payload.drift.status)}</b>drift</div><div class="metric"><b>${escapeHtml(payload.slo.status)}</b>SLO</div><div class="metric"><b>${payload.incident.findings_count}</b>findings</div><div class="metric"><b>${payload.scenario_reports.length}</b>scenarios</div></div><section><h2>Assessment</h2><ul>${reasons}</ul><p class="muted">Root <code>${escapeHtml(review.manifest.root_sha256)}</code></p></section><section><h2>Non-passing checks</h2>${nonPassing ? `<table><thead><tr><th>Scope</th><th>Metric</th><th>Status</th><th>Actual</th><th>Threshold</th></tr></thead><tbody>${nonPassing}</tbody></table>` : "<p>All configured drift and SLO checks pass.</p>"}</section><section><h2>Resilience scenarios</h2><div class="grid">${scenarioCards || "<p>No scenarios were included.</p>"}</div></section><section><h2>Incident findings</h2><div class="grid">${incidentCards || "<p>No incident findings.</p>"}</div></section><section><h2>Interpretation limits</h2><p>This artifact recomputes reports from sanitized receipts. Hash integrity does not authenticate a signer, scenarios are predictions over recorded evidence, and findings are not automatic root-cause determinations.</p></section></main></body></html>\n`;
}
