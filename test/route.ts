// AgentRoute behavioral and adversarial tests.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  appendRouteRecord,
  createRouteDecision,
  createRouteObservation,
  explainRoute,
  fingerprintTask,
  foldRouteRecords,
  parseRouteRecords,
  policyViolations,
  predictedScoreGap,
  replayRoutes,
  simulateRoutePolicy,
} from "../src/route.js";
import { formatConnectorCatalog, listConnectors } from "../src/connectors.js";
import { NATIVE_RECEIPT_ADAPTER, runConnectorConformance } from "../src/connector-sdk.js";
import {
  fromCloudflareAiGatewayRoute,
  fromLiteLLMRoute,
  fromOpenRouterRoute,
  fromPortkeyRoute,
  fromVercelAiGatewayRoute,
  importCloudflareAiGatewayRoute,
  importPortkeyRoute,
} from "../src/route-adapters.js";
import { captureOpenRouter } from "../src/openrouter-capture.js";
import { evaluationToObservation, evaluateChecklist, fromBraintrustEvaluation } from "../src/evaluation.js";
import { buildDecisionLabModel, renderDecisionLab } from "../src/decision-lab.js";
import { evaluateRoutingDrift } from "../src/drift.js";
import { analyzeRouteIncidents, renderIncidentReport } from "../src/incident.js";
import { auditRouteRecords } from "../src/route-audit.js";
import { createEvidenceCapsule, renderCapsuleLab, signEvidenceCapsule, verifyEvidenceCapsule } from "../src/capsule.js";
import { analyzeReplayExperiment } from "../src/experiment.js";
import { decideReplayExperiment, validateExperimentDecision, validateExperimentProtocol } from "../src/experiment-protocol.js";
import { startObservatory } from "../src/observatory.js";
import { createOperationsReview, renderOperationsReview, verifyOperationsReview } from "../src/operations-review.js";
import { compilePolicy, diffPolicies, validatePolicyRegistry } from "../src/policy-registry.js";
import { addPolicyToRegistry, initializePolicyRegistry, loadPolicyRegistry, transitionPolicyInRegistry } from "../src/policy-store.js";
import { createPromotionDossier, renderPromotionDossier, verifyPromotionDossier } from "../src/promotion-dossier.js";
import { buildProofPack, verifyProofPack } from "../src/proof-pack.js";
import { compareProofPacks, formatGitHubProofDiff } from "../src/proof-diff.js";
import { signProofPack, verifyProofAttestation, writeProofAttestation } from "../src/proof-attestation.js";
import { canonicalJson, sha256 } from "../src/canonical.js";
import { evaluateRouteGate, formatGitHubGate, validateRouteGateResult } from "../src/quality-gate.js";
import { appendReliabilityReview, appendReliabilityTimeline, createReliabilityTimeline, initializeReliabilityTimeline, loadReliabilityTimeline, renderReliabilityTimeline, verifyReliabilityTimeline } from "../src/reliability-timeline.js";
import { fixtureReplayExecutor, runReplayArena } from "../src/replay-arena.js";
import { runRoutingScenario, validateRoutingScenario } from "../src/scenario.js";
import { evaluateRoutingSlo, validateRoutingSloConfig } from "../src/slo.js";
import { formatReceiptDetail, formatRouteReport } from "../src/route-report.js";
import { createExaTaskPack } from "../src/task-pack.js";
import { routeToOtel, routeToTelemetry } from "../src/route-to-otel.js";
import { validateRouteLedger, validateRouteRecord } from "../src/route-validate.js";
import type { RouteDecision, RouteRecord } from "../src/route-types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail?: string): void {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function throws(name: string, action: () => unknown, includes?: string): void {
  try { action(); ok(name, false, "did not throw"); }
  catch (error) { ok(name, !includes || String((error as Error).message).includes(includes), String((error as Error).message)); }
}

ok("SHA-256 hashes bytes without UTF-8 replacement collisions", sha256(new Uint8Array([0xfe])) !== sha256(new Uint8Array([0xff])));

const decision = (): RouteDecision => createRouteDecision({
  route_id: "route_test",
  created_at: "2026-08-22T10:00:00.000Z",
  task: { type: "code_review", description: "private task text" },
  router: { name: "test-router", policy_id: "balanced" },
  source: { kind: "native", fidelity: "full" },
  candidates: [
    { id: "winner", model: "model-a", provider: "provider-a", endpoint: "https://private.invalid", capabilities: ["code"], eligible: true, estimates: { quality: 0.9, latency_ms: 100, cost_usd: 0.02 }, scores: { overall: 0.9, quality: 0.95, latency: 0.5, cost: 0.4, capability: 1 } },
    { id: "runner-up", model: "model-b", provider: "provider-b", capabilities: ["code"], eligible: true, estimates: { quality: 0.8, latency_ms: 50, cost_usd: 0.01 }, scores: { overall: 0.8, quality: 0.8, latency: 0.95, cost: 0.9, capability: 1 } },
  ],
  criteria: { max_cost_usd: 0.03, max_latency_ms: 150, min_quality: 0.85, required_capabilities: ["code"] },
  selection: { candidate_id: "winner", confidence: 0.9, reason: "best eligible score", fallback_order: ["runner-up"] },
});

console.log("agentroute record validation");
const valid = decision();
ok("accepts a complete decision", validateRouteRecord(valid).valid);
ok("generates version and record type", valid.route_version === "0.1" && valid.record_type === "decision");
ok("fingerprints canonical objects deterministically", fingerprintTask({ b: 2, a: 1 }) === fingerprintTask({ a: 1, b: 2 }));
ok("parses pretty standalone JSON", parseRouteRecords(JSON.stringify(valid, null, 2)).length === 1);
ok("parses JSON arrays", parseRouteRecords(JSON.stringify([valid])).length === 1);
ok("accepts a UTF-8 BOM", parseRouteRecords(`\uFEFF${JSON.stringify(valid)}`).length === 1);
throws("rejects a selection absent from candidates", () => createRouteDecision({ ...valid, selection: { candidate_id: "ghost", reason: "bad" } }), "does not reference");
throws("rejects duplicate candidate IDs", () => createRouteDecision({ ...valid, candidates: [valid.candidates[0], valid.candidates[0]] }), "duplicate candidate");
throws("rejects out-of-range scores", () => createRouteDecision({ ...valid, candidates: [{ id: "bad", model: "x", scores: { overall: 1.1 } }], selection: { candidate_id: "bad", reason: "bad" } }), "must be 0..1");

console.log("policy and explanations");
ok("reports no policy violations for valid selection", policyViolations(valid).length === 0);
const violating = createRouteDecision({ ...valid, route_id: "route_violation", candidates: [{ id: "bad", model: "model-x", eligible: false, capabilities: [], estimates: { quality: 0.2, latency_ms: 900, cost_usd: 2 } }], selection: { candidate_id: "bad", reason: "forced" } });
ok("audits eligibility and all declared thresholds", policyViolations(violating).length === 5, policyViolations(violating).join("; "));
ok("computes winner-vs-best predicted score gap", Math.abs(predictedScoreGap(valid)! - 0.1) < 1e-12);
ok("labels score gap as not actual regret", explainRoute({ decision: valid, observations: [] }).includes("not actual regret"));
const selectedOnly = createRouteDecision({ ...valid, route_id: "route_selected", source: { kind: "custom", fidelity: "selected-only" }, candidates: [valid.candidates[0]], selection: { candidate_id: "winner", reason: "upstream selection" } });
ok("suppresses counterfactual gap for incomplete evidence", predictedScoreGap(selectedOnly) === undefined);
ok("explains incomplete-evidence caveat", explainRoute({ decision: selectedOnly, observations: [] }).includes("alternatives are incomplete"));
const simulation = simulateRoutePolicy([valid, selectedOnly], { id: "cheap-fast", weights: { quality: 0.1, latency: 0.5, cost: 0.4 } }, "2026-08-22T11:00:00.000Z");
ok("policy simulation can select a different recorded candidate", simulation.changed === 1 && simulation.choices[0].simulated_candidate_id === "runner-up");
ok("policy simulation excludes incomplete candidate evidence", simulation.skipped_incomplete_evidence === 1 && simulation.simulated === 1);
throws("policy simulation rejects empty policy weights", () => simulateRoutePolicy([valid], { id: "invalid", weights: {} }), "positive weight");
throws("policy simulation rejects non-normalized weights", () => simulateRoutePolicy([valid], { id: "invalid", weights: { quality: 0.2, cost: 0.2 } }), "sum to 1");
const excludedOriginal = simulateRoutePolicy([valid], { id: "latency-ceiling", criteria: { max_latency_ms: 75 }, weights: { quality: 1 } });
ok("policy simulation can replace a selected candidate excluded by new criteria", excludedOriginal.changed === 1 && excludedOriginal.choices[0].simulated_candidate_id === "runner-up");

console.log("routing drift intelligence");
const baselineObservation = createRouteObservation({ route_id: valid.route_id, observation_id: "obs_drift_baseline", observed_at: "2026-08-22T10:00:01.000Z", outcome: { status: "success", latency_ms: 100, cost_usd: 0.02, quality: 0.9 } });
const driftedDecision = createRouteDecision({ ...valid, selection: { candidate_id: "runner-up", reason: "traffic shifted", fallback_order: ["winner"] } });
const driftedObservation = createRouteObservation({ route_id: valid.route_id, observation_id: "obs_drift_current", observed_at: "2026-08-22T10:00:01.000Z", outcome: { status: "failure", latency_ms: 200, cost_usd: 0.03, quality: 0.7 } });
const driftConfig = { minimum_baseline_samples: 1, minimum_current_samples: 1, minimum_observation_coverage: 1, maximum_total_variation: 0.25, maximum_selection_share_change: 0.25, maximum_failure_rate_increase: 0.1, maximum_mean_latency_increase_percent: 20, maximum_mean_cost_increase_percent: 20, minimum_mean_quality_delta: -0.05, include_task_slices: true };
const stableDrift = evaluateRoutingDrift([valid, baselineObservation], [valid, baselineObservation], driftConfig, "2026-08-25T12:00:00.000Z");
ok("identical routing evidence passes drift checks", stableDrift.status === "pass" && stableDrift.global.total_variation === 0 && stableDrift.checks.every((check) => check.status === "pass"));
const materialDrift = evaluateRoutingDrift([valid, baselineObservation], [driftedDecision, driftedObservation], driftConfig, "2026-08-25T12:00:00.000Z");
ok("routing drift detects selection and measured outcome regressions", materialDrift.status === "fail" && materialDrift.global.total_variation === 1 && materialDrift.global.newly_selected[0] === "provider-b/model-b" && materialDrift.checks.some((check) => check.metric === "mean_quality_delta" && check.status === "fail"));
ok("routing drift produces deterministic task slices", materialDrift.by_task_type.code_review.scope === "task:code_review" && JSON.stringify(materialDrift) === JSON.stringify(evaluateRoutingDrift([valid, baselineObservation], [driftedDecision, driftedObservation], driftConfig, "2026-08-25T12:00:00.000Z")));
const insufficientDrift = evaluateRoutingDrift([valid], [valid], driftConfig, "2026-08-25T12:00:00.000Z");
ok("routing drift distinguishes missing outcome evidence", insufficientDrift.status === "insufficient" && insufficientDrift.checks.some((check) => check.metric === "mean_quality_delta" && check.status === "insufficient"));
throws("routing drift rejects unknown configuration", () => evaluateRoutingDrift([valid], [valid], { surprise: 1 } as never), "unknown keys");

console.log("resilience scenario intelligence");
const scenarioDecision = createRouteDecision({ ...valid, route_id: "route_scenario", criteria: undefined });
const outageScenario = { scenario_version: "0.1", id: "provider-a-outage", unavailable_providers: ["provider-a"], cost_multipliers: [{ model: "model-b", provider: "provider-b", multiplier: 1.5 }], latency_multipliers: [{ model: "model-b", provider: "provider-b", multiplier: 1.25 }] };
const outageReport = runRoutingScenario([scenarioDecision], outageScenario, "2026-08-25T12:00:00.000Z");
ok("provider outage uses the recorded fallback order", outageReport.result === "impact" && outageReport.changed === 1 && outageReport.choices[0].scenario_candidate_id === "runner-up" && outageReport.choices[0].reasons.includes("provider-unavailable"));
ok("scenario multipliers project fallback cost and latency", outageReport.projected_cost_usd === 0.015 && outageReport.projected_mean_latency_ms === 62.5 && outageReport.choices[0].cost_delta_usd === -0.005);
const strandedReport = runRoutingScenario([valid], { scenario_version: "0.1", id: "all-providers-out", unavailable_providers: ["provider-a", "provider-b"] }, "2026-08-25T12:00:00.000Z");
ok("scenario analysis reports routes with no recorded viable fallback", strandedReport.stranded === 1 && strandedReport.choices[0].scenario_candidate_id === undefined);
const incompleteScenario = runRoutingScenario([selectedOnly], { scenario_version: "0.1", id: "partial-evidence" }, "2026-08-25T12:00:00.000Z");
ok("scenario analysis refuses incomplete candidate evidence", incompleteScenario.result === "insufficient" && incompleteScenario.skipped_incomplete_evidence === 1 && incompleteScenario.analyzed === 0);
ok("scenario output excludes endpoints and selection reasons", !JSON.stringify(outageReport).includes("private.invalid") && !JSON.stringify(outageReport).includes("best eligible score"));
throws("scenario validation rejects unknown keys", () => validateRoutingScenario({ scenario_version: "0.1", id: "bad", apply: true }), "unknown keys");
throws("scenario validation rejects invalid multipliers", () => validateRoutingScenario({ scenario_version: "0.1", id: "bad", cost_multipliers: [{ model: "x", multiplier: 0 }] }), "must be a finite number > 0");

console.log("incident forensics");
const incidentObservation = createRouteObservation({ route_id: violating.route_id, observation_id: "obs_incident", observed_at: "2026-08-25T12:00:00.000Z", outcome: { status: "failure", actual_model: "fallback-model", actual_provider: "provider-y", latency_ms: 1200, cost_usd: 3, quality: 0.1, error: "secret stack trace", metadata: { response: "private output" } } });
const incidentReport = analyzeRouteIncidents([violating, incidentObservation, selectedOnly], "2026-08-25T13:00:00.000Z");
ok("incident forensics detects failures, execution mismatches, and measured breaches", incidentReport.status === "critical" && incidentReport.findings.some((finding) => finding.category === "outcome-failure") && incidentReport.findings.some((finding) => finding.category === "actual-model-mismatch") && incidentReport.findings.some((finding) => finding.category === "cost-budget-breach") && incidentReport.findings.some((finding) => finding.category === "quality-floor-breach"));
ok("incident forensics exposes incomplete and missing evidence", incidentReport.findings.some((finding) => finding.category === "candidate-evidence-incomplete" && finding.route_id === selectedOnly.route_id) && incidentReport.findings.some((finding) => finding.category === "observation-missing" && finding.route_id === selectedOnly.route_id));
ok("incident finding IDs and ordering are deterministic", JSON.stringify(incidentReport) === JSON.stringify(analyzeRouteIncidents([violating, incidentObservation, selectedOnly], "2026-08-25T13:00:00.000Z")) && incidentReport.findings[0].severity === "critical");
const incidentJson = JSON.stringify(incidentReport);
ok("incident reports exclude error text, metadata, endpoints, and selection reasons", !incidentJson.includes("secret stack trace") && !incidentJson.includes("private output") && !incidentJson.includes("private.invalid") && !incidentJson.includes("forced"));
const incidentHtml = renderIncidentReport(incidentReport);
ok("incident review HTML is standalone and script-free", incidentHtml.includes("Incident review") && incidentHtml.includes("outcome-failure") && !incidentHtml.includes("<script") && !incidentHtml.includes("https://") && !incidentHtml.includes("secret stack trace"));
throws("incident forensics rejects invalid timestamps", () => analyzeRouteIncidents([valid], "not-a-time"), "generated_at");

console.log("routing SLO and error budgets");
const sloSecond = createRouteDecision({ ...valid, route_id: "route_slo_second", task: { type: "research" } });
const sloFirstObservation = createRouteObservation({ route_id: valid.route_id, observation_id: "obs_slo_first", observed_at: "2026-08-25T12:00:00.000Z", outcome: { status: "success", latency_ms: 100, cost_usd: 0.02, quality: 0.9 } });
const sloSecondObservation = createRouteObservation({ route_id: sloSecond.route_id, observation_id: "obs_slo_second", observed_at: "2026-08-25T12:00:00.000Z", outcome: { status: "success", latency_ms: 200, cost_usd: 0.03, quality: 0.8 } });
const sloConfig = { slo_version: "0.1", id: "test-routing-slo", minimum_samples: 2, minimum_slice_samples: 1, minimum_observation_coverage: 1, minimum_measurement_coverage: 1, include_task_slices: true, objectives: { minimum_success_rate: 0.9, maximum_p95_latency_ms: 250, maximum_p95_cost_usd: 0.05, minimum_p10_quality: 0.75, maximum_policy_violation_rate: 0 } };
const passingSlo = evaluateRoutingSlo([valid, sloFirstObservation, sloSecond, sloSecondObservation], sloConfig, "2026-08-25T13:00:00.000Z");
ok("routing SLO passes complete global and task-slice evidence", passingSlo.status === "pass" && passingSlo.global.p95_latency_ms === 200 && passingSlo.global.p10_quality === 0.8 && Object.values(passingSlo.by_task_type).every((slice) => slice.samples === 1));
ok("routing SLO reports deterministic error-budget math", passingSlo.global.error_budget?.allowed_unsuccessful_outcomes === 0.2 && passingSlo.global.error_budget.remaining === 0.2 && passingSlo.global.error_budget.burn_ratio === 0);
const failedSloObservation = createRouteObservation({ route_id: sloSecond.route_id, observation_id: "obs_slo_failed", observed_at: "2026-08-25T12:00:00.000Z", outcome: { status: "failure", latency_ms: 400, cost_usd: 0.2, quality: 0.5 } });
const failedSlo = evaluateRoutingSlo([valid, sloFirstObservation, sloSecond, failedSloObservation], sloConfig, "2026-08-25T13:00:00.000Z");
ok("routing SLO fails measured reliability and percentile regressions", failedSlo.status === "fail" && failedSlo.global.error_budget?.exhausted === true && failedSlo.checks.some((check) => check.metric === "success_rate" && check.status === "fail") && failedSlo.checks.some((check) => check.metric === "p95_cost_usd" && check.status === "fail"));
const insufficientSlo = evaluateRoutingSlo([valid, sloSecond], sloConfig, "2026-08-25T13:00:00.000Z");
ok("routing SLO keeps absent measurements insufficient rather than zero", insufficientSlo.status === "insufficient" && insufficientSlo.global.success_rate === undefined && insufficientSlo.checks.some((check) => check.metric === "p95_latency_ms" && check.status === "insufficient"));
const missingCostObservation = createRouteObservation({ route_id: sloSecond.route_id, observation_id: "obs_slo_missing_cost", observed_at: "2026-08-25T12:00:00.000Z", outcome: { status: "success", latency_ms: 200, quality: 0.8 } });
const metricGapSlo = evaluateRoutingSlo([valid, sloFirstObservation, sloSecond, missingCostObservation], sloConfig, "2026-08-25T13:00:00.000Z");
ok("routing SLO tracks metric-specific coverage", metricGapSlo.status === "insufficient" && metricGapSlo.global.cost_coverage === 0.5 && metricGapSlo.checks.some((check) => check.metric === "p95_cost_usd" && check.status === "insufficient"));
ok("routing SLO output is deterministic", JSON.stringify(passingSlo) === JSON.stringify(evaluateRoutingSlo([valid, sloFirstObservation, sloSecond, sloSecondObservation], sloConfig, "2026-08-25T13:00:00.000Z")));
throws("routing SLO rejects unknown objectives", () => validateRoutingSloConfig({ ...sloConfig, objectives: { surprise: 1 } }), "unknown keys");

console.log("tamper-evident operations review");
const operationsSecondObservation = createRouteObservation({ route_id: sloSecond.route_id, observation_id: "obs_operations_second", observed_at: "2026-08-25T12:00:00.000Z", outcome: { status: "success", latency_ms: 140, cost_usd: 0.03, quality: 0.86 } });
const operationsRecords = [valid, sloFirstObservation, sloSecond, operationsSecondObservation];
const clearOperationsReview = createOperationsReview({ baseline_records: operationsRecords, current_records: operationsRecords, drift_config: driftConfig, slo_config: sloConfig, scenarios: [], created_at: "2026-08-25T14:00:00.000Z" });
ok("operations review binds passing drift, SLO, incidents, and evidence", clearOperationsReview.payload.assessment.status === "clear" && clearOperationsReview.payload.drift.status === "pass" && clearOperationsReview.payload.slo.status === "pass" && clearOperationsReview.payload.incident.status === "clear" && verifyOperationsReview(clearOperationsReview).valid);
const criticalOperationsReview = createOperationsReview({ baseline_records: operationsRecords, current_records: operationsRecords, drift_config: driftConfig, slo_config: sloConfig, scenarios: [{ scenario_version: "0.1", id: "provider-a-outage", unavailable_providers: ["provider-a"] }], created_at: "2026-08-25T14:00:00.000Z" });
ok("operations review makes stranded resilience scenarios critical", criticalOperationsReview.payload.assessment.status === "critical" && criticalOperationsReview.payload.scenario_reports[0].stranded === 2 && criticalOperationsReview.payload.assessment.reasons.some((reason) => reason.includes("strands 2")));
const operationsText = JSON.stringify(clearOperationsReview);
ok("operations review reuses capsule privacy boundaries", !operationsText.includes("private task text") && !operationsText.includes("private.invalid") && operationsText.includes("selection reason omitted from portable capsule"));
const operationsHtml = renderOperationsReview(criticalOperationsReview);
ok("operations review HTML is verified, standalone, and limitation-labelled", operationsHtml.includes("Operations review") && operationsHtml.includes("Hash integrity does not authenticate") && !operationsHtml.includes("<script") && !operationsHtml.includes("https://") && !operationsHtml.includes("private task text"));
const tamperedOperationsCapsule = JSON.parse(JSON.stringify(clearOperationsReview));
tamperedOperationsCapsule.payload.current.payload.records[0].candidates[0].model = "tampered";
ok("operations review verification rejects embedded capsule tampering", verifyOperationsReview(tamperedOperationsCapsule).errors.some((error) => error.includes("payload.current")));
const tamperedOperationsReport = JSON.parse(JSON.stringify(clearOperationsReview));
tamperedOperationsReport.payload.drift.status = "fail";
ok("operations review verification recomputes drift reports", verifyOperationsReview(tamperedOperationsReport).errors.some((error) => error.includes("drift report")));
const tamperedOperationsAssessment = JSON.parse(JSON.stringify(clearOperationsReview));
tamperedOperationsAssessment.payload.assessment.status = "critical";
ok("operations review verification recomputes its assessment", verifyOperationsReview(tamperedOperationsAssessment).errors.some((error) => error.includes("assessment")));
const tamperedOperationsPayloadHash = JSON.parse(JSON.stringify(clearOperationsReview));
tamperedOperationsPayloadHash.manifest.payload_sha256 = `sha256:${"0".repeat(64)}`;
ok("operations review verification rejects payload hash drift", verifyOperationsReview(tamperedOperationsPayloadHash).errors.some((error) => error.includes("payload SHA-256")));
const tamperedOperationsRootHash = JSON.parse(JSON.stringify(clearOperationsReview));
tamperedOperationsRootHash.manifest.root_sha256 = `sha256:${"0".repeat(64)}`;
ok("operations review verification rejects root hash drift", verifyOperationsReview(tamperedOperationsRootHash).errors.some((error) => error.includes("root SHA-256")));
throws("operations review rejects duplicate scenario IDs", () => createOperationsReview({ baseline_records: operationsRecords, current_records: operationsRecords, drift_config: driftConfig, slo_config: sloConfig, scenarios: [{ scenario_version: "0.1", id: "duplicate" }, { scenario_version: "0.1", id: "duplicate" }] }), "must be unique");

console.log("hash-chained reliability timeline");
const timelineCriticalReview = createOperationsReview({ baseline_records: operationsRecords, current_records: [valid, sloFirstObservation, sloSecond, failedSloObservation], drift_config: driftConfig, slo_config: sloConfig, scenarios: [], created_at: "2026-08-25T15:00:00.000Z" });
const timelineRecoveryReview = createOperationsReview({ baseline_records: operationsRecords, current_records: operationsRecords, drift_config: driftConfig, slo_config: sloConfig, scenarios: [], created_at: "2026-08-25T16:00:00.000Z" });
const timelineFirst = createReliabilityTimeline(clearOperationsReview);
const timelineCritical = appendReliabilityReview(timelineFirst, timelineCriticalReview).timeline;
const reliabilityTimeline = appendReliabilityReview(timelineCritical, timelineRecoveryReview).timeline;
ok("reliability timeline chains verified operations reviews", reliabilityTimeline.entries.length === 3 && reliabilityTimeline.entries[1].previous_entry_sha256 === reliabilityTimeline.entries[0].entry_sha256 && verifyReliabilityTimeline(reliabilityTimeline).valid);
ok("reliability timeline summarizes regression and recovery", reliabilityTimeline.summary.status_counts.clear === 2 && reliabilityTimeline.summary.status_counts.critical === 1 && reliabilityTimeline.summary.current_status === "clear" && reliabilityTimeline.summary.signals.some((item) => item.kind === "slo-recovery"));
ok("reliability timeline computes only comparable metric deltas", reliabilityTimeline.summary.latest_delta?.success_rate === 0.5 && reliabilityTimeline.summary.latest_delta.p95_latency_ms === -260 && reliabilityTimeline.summary.latest_delta.error_budget_remaining === 1);
const repeatedCriticalReview = createOperationsReview({ baseline_records: operationsRecords, current_records: [valid, sloFirstObservation, sloSecond, failedSloObservation], drift_config: driftConfig, slo_config: sloConfig, scenarios: [], created_at: "2026-08-25T16:00:00.000Z" });
const criticalStreak = appendReliabilityReview(createReliabilityTimeline(timelineCriticalReview), repeatedCriticalReview).timeline;
ok("reliability timeline identifies repeated critical reviews", criticalStreak.summary.consecutive_critical === 2 && criticalStreak.summary.signals.some((item) => item.kind === "critical-streak") && criticalStreak.summary.signals.some((item) => item.kind === "error-budget-exhausted"));
const insufficientOperationsReview = createOperationsReview({ baseline_records: [valid], current_records: [valid], drift_config: driftConfig, slo_config: sloConfig, scenarios: [], created_at: "2026-08-25T17:00:00.000Z" });
const missingMetricTimeline = appendReliabilityReview(reliabilityTimeline, insufficientOperationsReview).timeline;
ok("reliability timeline does not turn missing metrics into zero deltas", missingMetricTimeline.summary.current_status === "insufficient" && missingMetricTimeline.summary.latest_delta?.success_rate === undefined && missingMetricTimeline.summary.signals.some((item) => item.kind === "evidence-gap"));
ok("reliability timeline makes exact head retries idempotent", appendReliabilityReview(reliabilityTimeline, timelineRecoveryReview).change === "unchanged");
throws("reliability timeline rejects duplicate older reviews", () => appendReliabilityReview(reliabilityTimeline, timelineCriticalReview), "already exists earlier");
throws("reliability timeline rejects timestamp collisions", () => appendReliabilityReview(timelineFirst, criticalOperationsReview), "strictly later");
const tamperedTimelineReview = JSON.parse(JSON.stringify(reliabilityTimeline));
tamperedTimelineReview.entries[1].review.payload.current.payload.records[0].candidates[0].model = "tampered";
ok("reliability timeline rejects embedded review tampering", verifyReliabilityTimeline(tamperedTimelineReview).errors.some((error) => error.includes("entries[1].review")));
const tamperedTimelineChain = JSON.parse(JSON.stringify(reliabilityTimeline));
tamperedTimelineChain.entries[1].previous_entry_sha256 = `sha256:${"0".repeat(64)}`;
ok("reliability timeline rejects entry-chain tampering", verifyReliabilityTimeline(tamperedTimelineChain).errors.some((error) => error.includes("previous_entry_sha256")));
const tamperedTimelineSummary = JSON.parse(JSON.stringify(reliabilityTimeline));
tamperedTimelineSummary.summary.current_status = "critical";
ok("reliability timeline recomputes its longitudinal summary", verifyReliabilityTimeline(tamperedTimelineSummary).errors.some((error) => error.includes("summary does not match")));
const tamperedTimelineManifest = JSON.parse(JSON.stringify(reliabilityTimeline));
tamperedTimelineManifest.manifest.root_sha256 = `sha256:${"0".repeat(64)}`;
ok("reliability timeline rejects manifest tampering", verifyReliabilityTimeline(tamperedTimelineManifest).errors.some((error) => error.includes("root_sha256")));
const extendedTimeline = { ...reliabilityTimeline, private_note: "must not be accepted" };
ok("reliability timeline rejects unknown top-level fields", verifyReliabilityTimeline(extendedTimeline).errors.some((error) => error.includes("unknown keys")));
const reliabilityHtml = renderReliabilityTimeline(reliabilityTimeline);
ok("reliability timeline HTML is standalone and privacy-safe", reliabilityHtml.includes("Reliability timeline") && reliabilityHtml.includes("slo-recovery") && !reliabilityHtml.includes("<script") && !reliabilityHtml.includes("https://") && !reliabilityHtml.includes("private task text"));
const timelineScratch = mkdtempSync(join(tmpdir(), "agentroute-timeline-"));
try {
  const timelinePath = join(timelineScratch, "reliability.arhistory");
  initializeReliabilityTimeline(timelinePath, clearOperationsReview);
  const beforeRejectedAppend = readFileSync(timelinePath, "utf8");
  throws("reliability timeline preserves its file after a rejected append", () => appendReliabilityTimeline(timelinePath, criticalOperationsReview), "strictly later");
  ok("rejected reliability append leaves the prior timeline byte-identical", readFileSync(timelinePath, "utf8") === beforeRejectedAppend);
  const appendedTimeline = appendReliabilityTimeline(timelinePath, timelineCriticalReview);
  const retryTimeline = appendReliabilityTimeline(timelinePath, timelineCriticalReview);
  ok("reliability timeline persists atomically with idempotent retries", appendedTimeline.change === "appended" && retryTimeline.change === "unchanged" && loadReliabilityTimeline(timelinePath).entries.length === 2);
} finally { rmSync(timelineScratch, { recursive: true, force: true }); }

console.log("append-only ledger");
const scratch = mkdtempSync(join(tmpdir(), "agentroute-"));
const ledger = join(scratch, "routes.route.jsonl");
try {
  ok("appends decision", appendRouteRecord(ledger, valid) === "appended");
  ok("identical append is idempotent", appendRouteRecord(ledger, valid) === "unchanged");
  throws("conflicting reuse of route ID fails closed", () => appendRouteRecord(ledger, { ...valid, selection: { ...valid.selection, reason: "changed" } }), "different content");
  const observation = createRouteObservation({ route_id: valid.route_id, observation_id: "obs_1", observed_at: "2026-08-22T10:00:01.000Z", outcome: { status: "success", latency_ms: 110, cost_usd: 0.019, quality: 0.92 } });
  ok("appends an observation", appendRouteRecord(ledger, observation) === "appended");
  ok("observation retry is idempotent", appendRouteRecord(ledger, observation) === "unchanged");
  throws("rejects non-monotonic observations", () => appendRouteRecord(ledger, createRouteObservation({ route_id: valid.route_id, observation_id: "obs_old", observed_at: "2026-08-22T10:00:00.500Z", outcome: { status: "unknown" } })), "not monotonic");
  throws("rejects observation before its decision", () => appendRouteRecord(ledger, createRouteObservation({ route_id: "missing", observation_id: "obs_missing", observed_at: "2026-08-22T10:01:00.000Z", outcome: { status: "failure" } })), "precedes decision");
  const records = parseRouteRecords(readFileSync(ledger, "utf8"));
  ok("ledger remains two records after rejected writes", records.length === 2);
  throws("refuses append semantics on standalone JSON", () => appendRouteRecord(join(scratch, "wrong.route.json"), valid), ".jsonl");
  ok("fold selects latest observation", foldRouteRecords(records).get(valid.route_id)?.latest_observation?.observation_id === "obs_1");
  const report = replayRoutes(records, "2026-08-22T11:00:00.000Z");
  ok("replay computes coverage", report.decisions === 1 && report.observed === 1 && report.observation_coverage === 1);
  ok("replay computes measured model stats", report.by_model[0].success_rate === 1 && report.by_model[0].mean_quality === 0.92);
  ok("replay keeps deterministic caller timestamp", report.generated_at === "2026-08-22T11:00:00.000Z");

  console.log("CLI end-to-end");
  const cli = join(here, "../src/cli.ts");
  const explain = execFileSync(process.execPath, ["--import", "tsx", cli, "route", "explain", ledger], { encoding: "utf8" });
  ok("CLI explains a ledger", explain.includes("selected model-a") && explain.includes("observed: success"));
  const replay = execFileSync(process.execPath, ["--import", "tsx", cli, "route", "replay", ledger], { encoding: "utf8" });
  ok("CLI emits replay JSON", JSON.parse(replay).decisions === 1);
  const cliDriftConfig = join(scratch, "drift.json");
  writeFileSync(cliDriftConfig, JSON.stringify(driftConfig));
  const cliDrift = execFileSync(process.execPath, ["--import", "tsx", cli, "drift", ledger, ledger, "--config", cliDriftConfig], { encoding: "utf8" });
  ok("CLI evaluates routing drift", JSON.parse(cliDrift).status === "pass");
  const cliScenarioConfig = join(scratch, "scenario.json");
  writeFileSync(cliScenarioConfig, JSON.stringify({ scenario_version: "0.1", id: "cli-outage", unavailable_providers: ["provider-a"] }));
  const cliScenario = execFileSync(process.execPath, ["--import", "tsx", cli, "scenario", ledger, "--scenario", cliScenarioConfig], { encoding: "utf8" });
  ok("CLI runs an offline resilience scenario", JSON.parse(cliScenario).stranded === 1);
  const cliIncident = execFileSync(process.execPath, ["--import", "tsx", cli, "incident", "analyze", ledger], { encoding: "utf8" });
  const cliIncidentHtml = join(scratch, "incident-review.html");
  execFileSync(process.execPath, ["--import", "tsx", cli, "incident", "open", ledger, "-o", cliIncidentHtml], { encoding: "utf8" });
  ok("CLI analyzes and renders incident evidence", JSON.parse(cliIncident).status === "clear" && readFileSync(cliIncidentHtml, "utf8").includes("No incident findings"));
  const cliSloConfig = join(scratch, "slo.json");
  writeFileSync(cliSloConfig, JSON.stringify({ ...sloConfig, minimum_samples: 1, minimum_slice_samples: 1, objectives: { minimum_success_rate: 1, maximum_p95_latency_ms: 150, maximum_p95_cost_usd: 0.05, minimum_p10_quality: 0.9, maximum_policy_violation_rate: 0 } }));
  const cliSlo = execFileSync(process.execPath, ["--import", "tsx", cli, "slo", "evaluate", ledger, "--config", cliSloConfig], { encoding: "utf8" });
  ok("CLI evaluates routing SLOs", JSON.parse(cliSlo).status === "pass");
  const cliOperations = join(scratch, "review.arops");
  const cliOperationsHtml = join(scratch, "operations-review.html");
  execFileSync(process.execPath, ["--import", "tsx", cli, "ops", "create", ledger, "--baseline", ledger, "--drift", cliDriftConfig, "--slo", cliSloConfig, "--created-at", "2026-08-25T18:00:00.000Z", "-o", cliOperations], { encoding: "utf8" });
  const cliOperationsVerification = execFileSync(process.execPath, ["--import", "tsx", cli, "ops", "verify", cliOperations], { encoding: "utf8" });
  execFileSync(process.execPath, ["--import", "tsx", cli, "ops", "open", cliOperations, "-o", cliOperationsHtml], { encoding: "utf8" });
  ok("CLI creates, verifies, and opens an operations review", JSON.parse(cliOperationsVerification).valid && JSON.parse(cliOperationsVerification).status === "clear" && readFileSync(cliOperationsHtml, "utf8").includes("Operations review"));
  const cliOperationsSecond = join(scratch, "review-second.arops");
  const cliTimeline = join(scratch, "reliability.arhistory");
  const cliTimelineHtml = join(scratch, "reliability.html");
  execFileSync(process.execPath, ["--import", "tsx", cli, "ops", "create", ledger, "--baseline", ledger, "--drift", cliDriftConfig, "--slo", cliSloConfig, "--created-at", "2026-08-25T19:00:00.000Z", "-o", cliOperationsSecond], { encoding: "utf8" });
  execFileSync(process.execPath, ["--import", "tsx", cli, "history", "create", cliOperations, "-o", cliTimeline], { encoding: "utf8" });
  execFileSync(process.execPath, ["--import", "tsx", cli, "history", "append", cliTimeline, cliOperationsSecond], { encoding: "utf8" });
  const cliTimelineVerification = execFileSync(process.execPath, ["--import", "tsx", cli, "history", "verify", cliTimeline], { encoding: "utf8" });
  execFileSync(process.execPath, ["--import", "tsx", cli, "history", "open", cliTimeline, "-o", cliTimelineHtml], { encoding: "utf8" });
  ok("CLI creates, appends, verifies, and opens a reliability timeline", JSON.parse(cliTimelineVerification).valid && JSON.parse(cliTimelineVerification).entry_count === 2 && readFileSync(cliTimelineHtml, "utf8").includes("Reliability timeline"));
  execFileSync(process.execPath, ["--import", "tsx", cli, "route", "validate", ledger], { encoding: "utf8" });
  ok("CLI validates a ledger", true);
  const cliDecision = join(scratch, "decision.json");
  const cliLedger = join(scratch, "cli.route.jsonl");
  writeFileSync(cliDecision, JSON.stringify(valid));
  execFileSync(process.execPath, ["--import", "tsx", cli, "route", "record", cliDecision, "--ledger", cliLedger], { encoding: "utf8" });
  execFileSync(process.execPath, ["--import", "tsx", cli, "route", "observe", cliLedger, "--route-id", valid.route_id, "--status", "success", "--observation-id", "obs_cli", "--observed-at", "2026-08-22T10:00:02.000Z", "--latency-ms", "123", "--cost-usd", "0.02"], { encoding: "utf8" });
  ok("CLI records and observes append-only receipts", parseRouteRecords(readFileSync(cliLedger, "utf8")).length === 2);
  const otel = execFileSync(process.execPath, ["--import", "tsx", cli, "route", "to-otel", cliLedger], { encoding: "utf8" });
  ok("CLI emits safe OTLP JSON", JSON.parse(otel).resourceSpans[0].scopeSpans[0].spans[0].name.includes("model-a"));
  const importEvent = join(scratch, "openrouter.json");
  const importOutput = join(scratch, "imported.route.json");
  writeFileSync(importEvent, JSON.stringify({ id: "gen_cli", model: "model-imported", provider_name: "provider-imported", authorization: "secret-never-copy" }));
  execFileSync(process.execPath, ["--import", "tsx", cli, "route", "import", "openrouter", importEvent, "--route-id", "route_imported", "-o", importOutput], { encoding: "utf8" });
  const importedText = readFileSync(importOutput, "utf8");
  ok("CLI imports allowlisted router metadata", JSON.parse(importedText).source.fidelity === "selected-only");
  ok("CLI import does not copy unknown credentials", !importedText.includes("secret-never-copy") && !importedText.includes("authorization"));
  const labOutput = join(scratch, "decision-lab.html");
  execFileSync(process.execPath, ["--import", "tsx", cli, "lab", ledger, "-o", labOutput], { encoding: "utf8" });
  const labText = readFileSync(labOutput, "utf8");
  ok("CLI writes a standalone Decision Lab", labText.includes("AgentRoute Decision Lab") && labText.includes("route_test"));
  const connectorText = execFileSync(process.execPath, ["--import", "tsx", cli, "connectors", "--role", "policy-target"], { encoding: "utf8" });
  ok("CLI filters the connector catalog", connectorText.includes("Portkey AI Gateway") && connectorText.includes("OpenRouter") && !connectorText.includes("Cloudflare"));
  const cloudflareEvent = join(scratch, "cloudflare.json");
  const gatewayLedger = join(scratch, "gateway.route.jsonl");
  writeFileSync(cloudflareEvent, JSON.stringify({ id: "cf_cli", created_at: "2026-08-23T12:00:00.000Z", model: "workers-ai/model", provider: "workers-ai", success: true, status_code: 200, duration: 41, cost: 0.004, tokens_in: 12, tokens_out: 8, metadata: "private prompt", request: { body: "secret" } }));
  execFileSync(process.execPath, ["--import", "tsx", cli, "ingest", "cloudflare-ai-gateway", cloudflareEvent, "--ledger", gatewayLedger], { encoding: "utf8" });
  const gatewayText = readFileSync(gatewayLedger, "utf8");
  ok("CLI ingests gateway decisions and observations", parseRouteRecords(gatewayText).length === 2 && gatewayText.includes("41"));
  ok("CLI gateway ingest excludes source content and unknown metadata", !gatewayText.includes("private prompt") && !gatewayText.includes("secret"));
  const braintrustEvent = join(scratch, "braintrust.json");
  writeFileSync(braintrustEvent, JSON.stringify({ route_id: JSON.parse(gatewayText.split("\n")[0]).route_id, experiment_name: "quality-gate", created_at: "2026-08-23T12:00:01.000Z", scores: { correctness: 0.9, style: { score: 0.7 } }, input: "private input", output: "private output" }));
  execFileSync(process.execPath, ["--import", "tsx", cli, "evaluate", "braintrust", braintrustEvent, "--ledger", gatewayLedger], { encoding: "utf8" });
  const evaluatedGatewayText = readFileSync(gatewayLedger, "utf8");
  ok("CLI imports Braintrust numeric scores as an evaluation observation", parseRouteRecords(evaluatedGatewayText).length === 3 && evaluatedGatewayText.includes('"quality":0.8'));
  ok("CLI Braintrust import excludes inputs and outputs", !evaluatedGatewayText.includes("private input") && !evaluatedGatewayText.includes("private output"));
  execFileSync(process.execPath, ["--import", "tsx", cli, "evaluate", "braintrust", braintrustEvent, "--ledger", gatewayLedger], { encoding: "utf8" });
  ok("CLI Braintrust retries are idempotent", parseRouteRecords(readFileSync(gatewayLedger, "utf8")).length === 3);

  const cliPolicy = join(scratch, "policy.json");
  writeFileSync(cliPolicy, JSON.stringify({ policy_version: "0.1", id: "cli-policy", version: "1.0.0", status: "reviewed", weights: { quality: 0.6, latency: 0.2, cost: 0.2 }, models: [{ model: "model-a", provider: "provider-a" }, { model: "model-b", provider: "provider-b" }] }));
  const compiledPolicy = execFileSync(process.execPath, ["--import", "tsx", cli, "policy", "compile", cliPolicy, "--target", "openrouter"], { encoding: "utf8" });
  ok("CLI compiles review-only vendor policy artifacts", JSON.parse(compiledPolicy).dry_run === true && JSON.parse(compiledPolicy).config.models.length === 2);
  const registryPath = join(scratch, "policies.registry.json");
  const draftPolicyPath = join(scratch, "draft-policy.json");
  writeFileSync(draftPolicyPath, JSON.stringify({ ...JSON.parse(readFileSync(cliPolicy, "utf8")), status: "draft" }));
  execFileSync(process.execPath, ["--import", "tsx", cli, "policy", "registry", "init", registryPath], { encoding: "utf8" });
  execFileSync(process.execPath, ["--import", "tsx", cli, "policy", "registry", "add", registryPath, draftPolicyPath, "--actor", "cli-test", "--reason", "initial proposal", "--occurred-at", "2026-08-24T12:00:00.000Z"], { encoding: "utf8" });
  execFileSync(process.execPath, ["--import", "tsx", cli, "policy", "registry", "transition", registryPath, "cli-policy@1.0.0", "--to", "reviewed", "--actor", "cli-test", "--reason", "review complete", "--occurred-at", "2026-08-24T12:01:00.000Z"], { encoding: "utf8" });
  const registryOutput = execFileSync(process.execPath, ["--import", "tsx", cli, "policy", "registry", "list", registryPath], { encoding: "utf8" });
  ok("CLI persists policy lifecycle history", JSON.parse(registryOutput).policies[0].status === "reviewed" && JSON.parse(registryOutput).events.length === 2);
  const arenaTasks = join(scratch, "arena-tasks.json");
  const arenaFixtures = join(scratch, "arena-fixtures.json");
  const arenaLedger = join(scratch, "arena.route.jsonl");
  writeFileSync(arenaTasks, JSON.stringify({ tasks: [{ route_id: valid.route_id, task_ref: "task-pack://cli/1" }] }));
  writeFileSync(arenaFixtures, JSON.stringify({ fixtures: [
    { route_id: valid.route_id, candidate_id: "winner", estimated_cost_usd: 0.02, outcome: { status: "success", quality: 0.9, cost_usd: 0.02 } },
    { route_id: valid.route_id, candidate_id: "runner-up", estimated_cost_usd: 0.01, outcome: { status: "success", quality: 0.8, cost_usd: 0.01 } },
  ] }));
  const arenaCliReport = execFileSync(process.execPath, ["--import", "tsx", cli, "arena", ledger, "--tasks", arenaTasks, "--fixtures", arenaFixtures, "--max-requests", "2", "--max-cost-usd", "0.05", "--ledger", arenaLedger], { encoding: "utf8" });
  ok("CLI runs a budgeted offline replay and writes conformant receipts", JSON.parse(arenaCliReport).requests_executed === 2 && validateRouteLedger(parseRouteRecords(readFileSync(arenaLedger, "utf8"))).valid);
  const experimentOutput = execFileSync(process.execPath, ["--import", "tsx", cli, "experiment", "analyze", arenaLedger, "--baseline-candidate", "winner", "--challenger", "runner-up"], { encoding: "utf8" });
  ok("CLI analyzes paired replay experiments", JSON.parse(experimentOutput).comparisons[0].matched_pairs === 1);
  const experimentProtocolPath = join(scratch, "experiment-protocol.json");
  writeFileSync(experimentProtocolPath, JSON.stringify({ protocol_version: "0.1", id: "cli-promotion", baseline_candidate_id: "winner", challenger_candidate_id: "runner-up", minimum_matched_pairs: 1, thresholds: { minimum_mean_quality_delta: -0.2, minimum_quality_win_rate_95ci_low: 0 } }));
  const decisionOutput = execFileSync(process.execPath, ["--import", "tsx", cli, "experiment", "decide", arenaLedger, "--protocol", experimentProtocolPath], { encoding: "utf8" });
  ok("CLI evaluates a preregistered experiment protocol", JSON.parse(decisionOutput).status === "pass");
  const gateConfig = join(scratch, "gate.json");
  writeFileSync(gateConfig, JSON.stringify({ minimum_samples: 1, minimum_observation_coverage: 1, maximum_cost_increase_percent: 0 }));
  const gateOutput = execFileSync(process.execPath, ["--import", "tsx", cli, "gate", ledger, "--baseline", ledger, "--config", gateConfig], { encoding: "utf8" });
  ok("CLI quality gate passes identical measured evidence", JSON.parse(gateOutput).status === "pass");
  const promotionPath = join(scratch, "review.arpromote");
  const promotionHtml = join(scratch, "promotion-review.html");
  execFileSync(process.execPath, ["--import", "tsx", cli, "promotion", "create", arenaLedger, "--protocol", experimentProtocolPath, "--policy", cliPolicy, "--baseline", ledger, "--current", ledger, "--gate", gateConfig, "--target", "openrouter", "--target", "vercel-ai-gateway", "-o", promotionPath], { encoding: "utf8" });
  const promotionVerification = execFileSync(process.execPath, ["--import", "tsx", cli, "promotion", "verify", promotionPath], { encoding: "utf8" });
  execFileSync(process.execPath, ["--import", "tsx", cli, "promotion", "open", promotionPath, "-o", promotionHtml], { encoding: "utf8" });
  ok("CLI creates, verifies, and opens an eligible promotion dossier", JSON.parse(promotionVerification).valid && JSON.parse(promotionVerification).verdict === "eligible" && readFileSync(promotionHtml, "utf8").includes("Promotion dossier"));
  const capsulePath = join(scratch, "evidence.arcap");
  const capsuleLab = join(scratch, "capsule-lab.html");
  execFileSync(process.execPath, ["--import", "tsx", cli, "capsule", "create", ledger, "--policy", cliPolicy, "-o", capsulePath], { encoding: "utf8" });
  const capsuleVerification = execFileSync(process.execPath, ["--import", "tsx", cli, "capsule", "verify", capsulePath], { encoding: "utf8" });
  execFileSync(process.execPath, ["--import", "tsx", cli, "capsule", "open", capsulePath, "-o", capsuleLab], { encoding: "utf8" });
  ok("CLI creates, verifies, and reopens portable evidence capsules", JSON.parse(capsuleVerification).valid && readFileSync(capsuleLab, "utf8").includes("Decision Lab"));
  const cliKeys = generateKeyPairSync("ed25519");
  const privateKeyPath = join(scratch, "capsule-private.pem");
  const publicKeyPath = join(scratch, "capsule-public.pem");
  const signedCapsulePath = join(scratch, "signed-evidence.arcap");
  writeFileSync(privateKeyPath, cliKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  writeFileSync(publicKeyPath, cliKeys.publicKey.export({ type: "spki", format: "pem" }).toString());
  execFileSync(process.execPath, ["--import", "tsx", cli, "capsule", "sign", capsulePath, "--private-key", privateKeyPath, "-o", signedCapsulePath], { encoding: "utf8" });
  const trustedVerification = execFileSync(process.execPath, ["--import", "tsx", cli, "capsule", "verify", signedCapsulePath, "--require-signature", "--public-key", publicKeyPath], { encoding: "utf8" });
  ok("CLI signs capsules and verifies a pinned signer", JSON.parse(trustedVerification).signature_trusted === true);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("evidence suite");
const arena = await runReplayArena([valid], {
  run_id: "arena_test",
  generated_at: "2026-08-24T12:00:00.000Z",
  tasks: [{ route_id: valid.route_id, task_ref: "task-pack://code-review/1" }],
  limits: { max_requests: 2, max_cost_usd: 0.05 },
  executor: fixtureReplayExecutor([
    { route_id: valid.route_id, candidate_id: "winner", estimated_cost_usd: 0.02, outcome: { status: "success", quality: 0.7, latency_ms: 100, cost_usd: 0.02, error: "private executor detail", metadata: { response: "private model output" } } },
    { route_id: valid.route_id, candidate_id: "runner-up", estimated_cost_usd: 0.01, outcome: { status: "success", quality: 0.9, latency_ms: 60, cost_usd: 0.01 } },
  ]),
});
ok("Shadow Replay Arena creates conformant candidate receipts", arena.requests_executed === 2 && validateRouteLedger(arena.records).valid);
ok("Shadow Replay Arena labels bundled fixture evidence as illustrative", arena.evidence_mode === "offline_conformance" && arena.result_label === "illustrative");
const injectedArena = await runReplayArena([valid], {
  run_id: "arena_injected",
  generated_at: "2026-08-24T12:00:00.000Z",
  tasks: [{ route_id: valid.route_id, task_ref: "task-pack://injected/1", candidate_ids: ["winner"] }],
  limits: { max_requests: 1, max_cost_usd: 0.05 },
  executor: { id: "user-reviewed-runner", estimateCostUsd: () => 0.02, execute: async () => ({ status: "success", quality: 0.9, cost_usd: 0.02 }) },
});
ok("Shadow Replay Arena labels injected executor results as user generated", injectedArena.evidence_mode === "user_supplied_execution" && injectedArena.result_label === "user_generated");
ok("Shadow Replay Arena calculates actual quality regret only from measured alternatives", arena.comparisons[0].winner_candidate_id === "runner-up" && arena.comparisons[0].actual_quality_regret === 0.2);
ok("Shadow Replay Arena strips executor errors, metadata, and model output", !JSON.stringify(arena).includes("private executor") && !JSON.stringify(arena).includes("private model output"));
const researchDecision = createRouteDecision({ ...valid, route_id: "route_experiment_research", task: { type: "research" } });
const researchArena = await runReplayArena([researchDecision], {
  run_id: "arena_research",
  generated_at: "2026-08-24T12:01:00.000Z",
  tasks: [{ route_id: researchDecision.route_id, task_ref: "task-pack://research/1" }],
  limits: { max_requests: 2, max_cost_usd: 0.05 },
  executor: fixtureReplayExecutor([
    { route_id: researchDecision.route_id, candidate_id: "winner", estimated_cost_usd: 0.02, outcome: { status: "success", quality: 0.95, latency_ms: 110, cost_usd: 0.02 } },
    { route_id: researchDecision.route_id, candidate_id: "runner-up", estimated_cost_usd: 0.01, outcome: { status: "success", quality: 0.85, latency_ms: 50, cost_usd: 0.01 } },
  ]),
});
const experiment = analyzeReplayExperiment([...arena.records, ...researchArena.records], { baseline_candidate_id: "winner", challenger_candidate_ids: ["runner-up"], generated_at: "2026-08-24T12:02:00.000Z" });
const experimentComparison = experiment.comparisons[0];
ok("paired experiment analysis counts wins and losses on matched tasks", experimentComparison.matched_pairs === 2 && experimentComparison.challenger_quality_wins === 1 && experimentComparison.challenger_quality_losses === 1);
ok("paired experiment analysis reports bounded Wilson uncertainty", experimentComparison.challenger_quality_win_rate === 0.5 && experimentComparison.challenger_quality_win_rate_95ci!.low > 0 && experimentComparison.challenger_quality_win_rate_95ci!.high < 1);
ok("paired experiment analysis preserves task-type slices", experiment.by_task_type.code_review.comparisons[0].challenger_quality_wins === 1 && experiment.by_task_type.research.comparisons[0].challenger_quality_losses === 1);
const incompleteExperiment = analyzeReplayExperiment([...arena.records.slice(0, 3), ...researchArena.records]);
ok("paired experiment analysis warns about unobserved replay candidates", incompleteExperiment.warnings.some((warning) => warning.includes("has no observation")));
ok("paired experiment analysis identifies slice-specific pairing gaps", incompleteExperiment.warnings.some((warning) => warning.includes("task_type:code_review") && warning.includes("no paired tasks")));
const malformedArena = JSON.parse(JSON.stringify(arena.records)) as RouteRecord[];
(malformedArena[0] as RouteDecision).extensions = { arena_run_id: "arena_test" };
throws("paired experiment analysis rejects malformed attribution", () => analyzeReplayExperiment(malformedArena), "malformed Replay Arena attribution");
throws("paired experiment analysis rejects invalid report timestamps", () => analyzeReplayExperiment(arena.records, { generated_at: "not-a-time" }), "generated_at");
const experimentRecords = [...arena.records, ...researchArena.records];
const experimentProtocol = {
  protocol_version: "0.1" as const,
  id: "runner-up-promotion",
  description: "Preregistered challenger promotion criteria.",
  baseline_candidate_id: "winner",
  challenger_candidate_id: "runner-up",
  minimum_matched_pairs: 1,
  thresholds: {
    minimum_mean_quality_delta: -0.11,
    minimum_quality_win_rate_95ci_low: 0,
    maximum_mean_latency_delta_ms: 0,
    maximum_mean_cost_delta_usd: 0,
    minimum_success_rate_delta: -0.01,
  },
  required_task_types: ["code_review", "research"],
};
const experimentDecision = decideReplayExperiment(experimentRecords, experimentProtocol, "2026-08-24T12:03:00.000Z");
ok("preregistered experiment passes only when global and required slices pass", experimentDecision.status === "pass" && experimentDecision.checks.every((check) => check.status === "pass"));
ok("experiment decisions bind protocol and exact evidence fingerprints", experimentDecision.protocol_sha256.startsWith("sha256:") && experimentDecision.evidence_sha256 !== decideReplayExperiment([...experimentRecords, valid], experimentProtocol, "2026-08-24T12:03:00.000Z").evidence_sha256);
const failedExperimentProtocol = { ...experimentProtocol, thresholds: { ...experimentProtocol.thresholds, minimum_mean_quality_delta: 0.1 } };
const failedExperimentDecision = decideReplayExperiment(experimentRecords, failedExperimentProtocol, "2026-08-24T12:03:00.000Z");
ok("preregistered experiment reports measured threshold failures", failedExperimentDecision.status === "fail" && failedExperimentDecision.checks.some((check) => check.metric === "mean_quality_delta" && check.status === "fail"));
const insufficientExperimentProtocol = { ...experimentProtocol, minimum_matched_pairs: 3, thresholds: { minimum_mean_quality_delta: -1 }, required_task_types: ["security"] };
const insufficientExperimentDecision = decideReplayExperiment(experimentRecords, insufficientExperimentProtocol, "2026-08-24T12:03:00.000Z");
ok("preregistered experiment distinguishes missing evidence from failure", insufficientExperimentDecision.status === "insufficient" && insufficientExperimentDecision.checks.some((check) => check.metric === "slice_present"));
const failurePrecedence = decideReplayExperiment(experimentRecords, { ...experimentProtocol, minimum_matched_pairs: 3, thresholds: { minimum_mean_quality_delta: 0.1 }, required_task_types: [] }, "2026-08-24T12:03:00.000Z");
ok("measured experiment failures outrank insufficient coverage", failurePrecedence.status === "fail" && failurePrecedence.checks.some((check) => check.status === "insufficient"));
throws("experiment protocols require a declared quality threshold", () => validateExperimentProtocol({ ...experimentProtocol, thresholds: {} }), "quality success threshold");
throws("experiment protocols reject identical candidates", () => validateExperimentProtocol({ ...experimentProtocol, challenger_candidate_id: "winner" }), "must differ");
const inconsistentDecision = JSON.parse(JSON.stringify(experimentDecision));
inconsistentDecision.checks[0].status = "fail";
throws("experiment decision validation rejects inconsistent derived status", () => validateExperimentDecision(inconsistentDecision, experimentProtocol), "status is inconsistent");
const inconsistentAnalysis = JSON.parse(JSON.stringify(experimentDecision));
inconsistentAnalysis.analysis.comparisons[0].mean_quality_delta = 0.75;
throws("experiment decision validation recomputes checks from stored analysis", () => validateExperimentDecision(inconsistentAnalysis, experimentProtocol), "inconsistent with analysis");
const inconsistentAnalysisTimestamp = JSON.parse(JSON.stringify(experimentDecision));
inconsistentAnalysisTimestamp.analysis.generated_at = "2026-08-24T12:04:00.000Z";
throws("experiment decision validation binds its analysis timestamp", () => validateExperimentDecision(inconsistentAnalysisTimestamp, experimentProtocol), "timestamp is inconsistent");
const inconsistentCandidates = JSON.parse(JSON.stringify(experimentDecision));
inconsistentCandidates.analysis.comparisons[0].challenger_candidate_id = "unregistered-challenger";
throws("experiment decision validation binds comparison identities", () => validateExperimentDecision(inconsistentCandidates, experimentProtocol), "does not match protocol candidates");
const inconsistentAnalysisCounts = JSON.parse(JSON.stringify(experimentDecision));
inconsistentAnalysisCounts.analysis.comparisons[0].quality_ties += 1;
throws("experiment decision validation rejects inconsistent aggregate counts", () => validateExperimentDecision(inconsistentAnalysisCounts, experimentProtocol), "comparison counts are inconsistent");
const budgetStop = await runReplayArena([valid], {
  run_id: "arena_budget",
  generated_at: "2026-08-24T12:00:00.000Z",
  tasks: [{ route_id: valid.route_id, task_ref: "task-pack://code-review/1", candidate_ids: ["winner"] }],
  limits: { max_requests: 1, max_cost_usd: 0.01 },
  executor: fixtureReplayExecutor([{ route_id: valid.route_id, candidate_id: "winner", estimated_cost_usd: 0.02, outcome: { status: "success", cost_usd: 0.02 } }]),
});
ok("Shadow Replay Arena stops before exceeding declared cost", budgetStop.requests_executed === 0 && budgetStop.stopped_reason === "cost_limit");

const observedValid = createRouteObservation({ route_id: valid.route_id, observation_id: "obs_gate_base", observed_at: "2026-08-22T10:00:03.000Z", outcome: { status: "success", quality: 0.9, latency_ms: 100, cost_usd: 0.01 } });
const observedCurrent = createRouteObservation({ route_id: valid.route_id, observation_id: "obs_gate_current", observed_at: "2026-08-22T10:00:03.000Z", outcome: { status: "success", quality: 0.8, latency_ms: 125, cost_usd: 0.012 } });
const gate = evaluateRouteGate([valid, observedValid], [valid, observedCurrent], { minimum_samples: 1, minimum_observation_coverage: 1, maximum_cost_increase_percent: 10, maximum_latency_increase_percent: 30, minimum_quality_delta: -0.05 });
ok("quality gate fails measured regressions while retaining passing metrics", gate.status === "fail" && gate.metrics.some((metric) => metric.id === "mean_latency" && metric.status === "pass"));
ok("quality gate renders GitHub annotations", formatGitHubGate(gate).startsWith("::error title=AgentRoute quality gate::FAIL"));
const neutralGate = evaluateRouteGate([valid], [valid], { minimum_samples: 1, insufficient_evidence: "neutral" });
ok("quality gate can mark insufficient evidence neutral", neutralGate.status === "neutral");
const passingGate = evaluateRouteGate([valid, observedValid], [valid, observedValid], { minimum_samples: 1, minimum_observation_coverage: 1, maximum_cost_increase_percent: 0, maximum_latency_increase_percent: 0, minimum_quality_delta: 0 });
ok("quality gate results have a reusable validation contract", validateRouteGateResult(passingGate).status === "pass");
const inconsistentGate = JSON.parse(JSON.stringify(passingGate));
inconsistentGate.status = "fail";
throws("quality gate result validation rejects status drift", () => validateRouteGateResult(inconsistentGate), "inconsistent with metrics");
const sliceCode = createRouteDecision({ ...valid, route_id: "route_slice_code", task: { type: "code_review" } });
const sliceResearch = createRouteDecision({ ...valid, route_id: "route_slice_research", task: { type: "research" } });
const sliceBaseline = [
  sliceCode,
  createRouteObservation({ route_id: sliceCode.route_id, observation_id: "obs_slice_code_base", observed_at: "2026-08-22T10:03:00.000Z", outcome: { status: "success", quality: 0.9 } }),
  sliceResearch,
  createRouteObservation({ route_id: sliceResearch.route_id, observation_id: "obs_slice_research_base", observed_at: "2026-08-22T10:03:00.000Z", outcome: { status: "success", quality: 0.5 } }),
];
const sliceCurrent = [
  sliceCode,
  createRouteObservation({ route_id: sliceCode.route_id, observation_id: "obs_slice_code_current", observed_at: "2026-08-22T10:03:00.000Z", outcome: { status: "success", quality: 0.7 } }),
  sliceResearch,
  createRouteObservation({ route_id: sliceResearch.route_id, observation_id: "obs_slice_research_current", observed_at: "2026-08-22T10:03:00.000Z", outcome: { status: "success", quality: 0.7 } }),
];
const aggregateOnlyGate = evaluateRouteGate(sliceBaseline, sliceCurrent, { minimum_samples: 1, minimum_quality_delta: -0.1 });
const slicedGate = evaluateRouteGate(sliceBaseline, sliceCurrent, { minimum_samples: 1, minimum_quality_delta: -0.1, task_type_slices: true });
ok("task slices reveal regressions hidden by aggregate averages", aggregateOnlyGate.status === "pass" && slicedGate.status === "fail" && slicedGate.slices?.code_review.status === "fail");
ok("quality gate validation binds slice summaries to metric scopes", validateRouteGateResult(slicedGate).slices?.research.current_samples === 1);
const missingGateSlice = JSON.parse(JSON.stringify(slicedGate));
delete missingGateSlice.slices.code_review;
throws("quality gate validation rejects missing slice summaries", () => validateRouteGateResult(missingGateSlice), "inconsistent with metric scopes");
const missingSliceGate = evaluateRouteGate(sliceBaseline, sliceCurrent.slice(0, 2), { minimum_samples: 1, task_type_slices: true });
ok("task slices fail closed when a baseline segment disappears", missingSliceGate.status === "fail" && missingSliceGate.slices?.research.current_samples === 0);

const policy = {
  policy_version: "0.1" as const,
  id: "balanced-code",
  version: "1.0.0",
  status: "reviewed" as const,
  description: "private policy note",
  weights: { quality: 0.6, latency: 0.2, cost: 0.2 },
  criteria: { max_latency_ms: 2000, max_cost_usd: 0.05 },
  models: [
    { model: "anthropic/claude-sonnet", provider: "anthropic" },
    { model: "openai/gpt-5", provider: "openai" },
  ],
};
ok("policy registry validates versioned unique policy identities", validatePolicyRegistry({ registry_version: "0.1", policies: [policy] }).policies.length === 1);
ok("policy diff flags routing-target changes as breaking", diffPolicies(policy, { ...policy, version: "2.0.0", models: policy.models.slice(0, 1) }).breaking);
const compiled = (["native", "openrouter", "litellm", "portkey", "vercel-ai-gateway"] as const).map((target) => compilePolicy(policy, target));
ok("policy compiler emits all five review-only targets with source fingerprints", compiled.every((artifact) => artifact.dry_run && artifact.source.fingerprint.startsWith("sha256:")));
ok("Vercel compiler maps fallback models and provider ordering", JSON.stringify(compiled[4].config).includes("providerOptions") && JSON.stringify(compiled[4].config).includes("models"));

const previousPolicy = { ...policy, version: "0.9.0", description: "older private policy note", criteria: { max_latency_ms: 2500, max_cost_usd: 0.06 } };
const promotionDossier = createPromotionDossier({
  protocol: experimentProtocol,
  decision: experimentDecision,
  candidate_policy: policy,
  previous_policy: previousPolicy,
  gate: passingGate,
  targets: ["vercel-ai-gateway", "openrouter"],
  created_at: "2026-08-24T13:00:00.000Z",
});
const promotionText = JSON.stringify(promotionDossier);
ok("promotion dossiers bind experiment, gate, diff, and sorted dry-run targets", promotionDossier.payload.promotion.verdict === "eligible" && promotionDossier.payload.policy_diff?.from.endsWith("@0.9.0") && promotionDossier.payload.compilations.map((artifact) => artifact.target).join(",") === "openrouter,vercel-ai-gateway");
ok("promotion dossiers strip policy descriptions and retain no route records", !promotionText.includes("private policy note") && !promotionText.includes("private task text") && !promotionText.includes('"record_type"'));
ok("promotion dossier verification recomputes all derived artifacts", verifyPromotionDossier(promotionDossier).valid);
const payloadHashDrift = JSON.parse(JSON.stringify(promotionDossier));
payloadHashDrift.manifest.payload_sha256 = `sha256:${"0".repeat(64)}`;
ok("promotion dossier verification rejects payload hash drift", verifyPromotionDossier(payloadHashDrift).errors.some((error) => error.includes("payload SHA-256")));
const rootHashDrift = JSON.parse(JSON.stringify(promotionDossier));
rootHashDrift.manifest.root_sha256 = `sha256:${"0".repeat(64)}`;
ok("promotion dossier verification rejects root hash drift", verifyPromotionDossier(rootHashDrift).errors.some((error) => error.includes("root SHA-256")));
const compilerDrift = JSON.parse(JSON.stringify(promotionDossier));
compilerDrift.payload.compilations[0].config.models = ["tampered/model"];
ok("promotion dossier verification rejects compiler drift", verifyPromotionDossier(compilerDrift).errors.some((error) => error.includes("compiler outputs")));
const diffDrift = JSON.parse(JSON.stringify(promotionDossier));
diffDrift.payload.policy_diff.breaking = !diffDrift.payload.policy_diff.breaking;
ok("promotion dossier verification rejects policy-diff drift", verifyPromotionDossier(diffDrift).errors.some((error) => error.includes("policy diff")));
const verdictDrift = JSON.parse(JSON.stringify(promotionDossier));
verdictDrift.payload.promotion.verdict = "blocked";
ok("promotion dossier verification rejects verdict drift", verifyPromotionDossier(verdictDrift).errors.some((error) => error.includes("verdict")));
const blockedDossier = createPromotionDossier({ protocol: failedExperimentProtocol, decision: failedExperimentDecision, candidate_policy: policy, gate: passingGate, targets: ["native"] });
const insufficientDossier = createPromotionDossier({ protocol: insufficientExperimentProtocol, decision: insufficientExperimentDecision, candidate_policy: policy, gate: neutralGate, targets: ["native"] });
ok("promotion dossiers distinguish blocked from insufficient changes", blockedDossier.payload.promotion.verdict === "blocked" && insufficientDossier.payload.promotion.verdict === "insufficient");
const draftDossier = createPromotionDossier({ protocol: experimentProtocol, decision: experimentDecision, candidate_policy: { ...policy, status: "draft" }, gate: passingGate, targets: ["native"] });
ok("promotion dossiers block policies that have not reached review", draftDossier.payload.promotion.verdict === "blocked" && draftDossier.payload.promotion.reasons.some((reason) => reason.includes("must be reviewed")));
const hostileProtocol = { ...experimentProtocol, description: "<img src=x onerror=alert(1)>" };
const hostileDecision = decideReplayExperiment(experimentRecords, hostileProtocol, "2026-08-24T12:03:00.000Z");
const hostileDossier = createPromotionDossier({ protocol: hostileProtocol, decision: hostileDecision, candidate_policy: policy, gate: passingGate, targets: ["native"] });
const promotionHtmlText = renderPromotionDossier(hostileDossier);
ok("promotion review HTML is standalone and escapes protocol text", promotionHtmlText.includes("Promotion dossier") && !promotionHtmlText.includes("https://") && !promotionHtmlText.includes("<img src=x"));

const policyScratch = mkdtempSync(join(tmpdir(), "agentroute-policy-"));
try {
  const policyRegistryPath = join(policyScratch, "registry.json");
  initializePolicyRegistry(policyRegistryPath);
  const draftPolicy = { ...policy, status: "draft" as const };
  const addedPolicy = addPolicyToRegistry(policyRegistryPath, draftPolicy, { actor: "mason", reason: "propose measured routing policy", occurred_at: "2026-08-24T13:00:00.000Z" });
  const retryPolicy = addPolicyToRegistry(policyRegistryPath, draftPolicy, { actor: "mason", reason: "propose measured routing policy", occurred_at: "2026-08-24T13:00:00.000Z" });
  ok("policy registry appends an auditable draft and makes exact retries idempotent", addedPolicy.change === "appended" && retryPolicy.change === "unchanged");
  transitionPolicyInRegistry(policyRegistryPath, "balanced-code@1.0.0", "reviewed", { actor: "reviewer", reason: "evidence reviewed", occurred_at: "2026-08-24T13:01:00.000Z" });
  throws("policy registry requires human attestation for approval", () => transitionPolicyInRegistry(policyRegistryPath, "balanced-code@1.0.0", "approved", { actor: "release-manager", reason: "approve policy", occurred_at: "2026-08-24T13:02:00.000Z" }), "human_attested");
  transitionPolicyInRegistry(policyRegistryPath, "balanced-code@1.0.0", "approved", { actor: "abhi", reason: "explicit approval", occurred_at: "2026-08-24T13:02:00.000Z", human_attested: true });
  transitionPolicyInRegistry(policyRegistryPath, "balanced-code@1.0.0", "deprecated", { actor: "abhi", reason: "superseded", occurred_at: "2026-08-24T13:03:00.000Z" });
  const durableRegistry = loadPolicyRegistry(policyRegistryPath);
  ok("policy registry persists the full guarded lifecycle", durableRegistry.policies[0].status === "deprecated" && durableRegistry.events?.length === 4);
  throws("policy registry prevents transitions out of deprecated", () => transitionPolicyInRegistry(policyRegistryPath, "balanced-code@1.0.0", "approved", { actor: "abhi", reason: "try to restore", occurred_at: "2026-08-24T13:04:00.000Z", human_attested: true }), "invalid policy transition");
  const tamperedRegistry = JSON.parse(readFileSync(policyRegistryPath, "utf8"));
  tamperedRegistry.events[1].policy_fingerprint = `sha256:${"0".repeat(64)}`;
  writeFileSync(policyRegistryPath, JSON.stringify(tamperedRegistry));
  throws("policy registry rejects tampered lifecycle history", () => loadPolicyRegistry(policyRegistryPath), "fingerprint is invalid");
} finally { rmSync(policyScratch, { recursive: true, force: true }); }

const capsuleSensitive = createRouteDecision({ ...valid, route_id: "route_capsule", task: { type: "security", description: "private prompt" }, extensions: { unknown_secret: "never-render-this" } });
const capsule = createEvidenceCapsule([capsuleSensitive, createRouteObservation({ route_id: capsuleSensitive.route_id, observation_id: "obs_capsule", observed_at: "2026-08-22T10:02:00.000Z", outcome: { status: "failure", error: "private response body", metadata: { api_key: "secret" } } })], [policy], "2026-08-24T12:00:00.000Z");
const capsuleText = JSON.stringify(capsule);
ok("evidence capsules strip private descriptions, endpoints, errors, metadata, and extensions", !capsuleText.includes("private prompt") && !capsuleText.includes("private policy note") && !capsuleText.includes("private.invalid") && !capsuleText.includes("private response") && !capsuleText.includes("secret") && !capsuleText.includes("never-render-this"));
ok("evidence capsules verify payload and root hashes", verifyEvidenceCapsule(capsule).valid);
const tamperedCapsule = JSON.parse(JSON.stringify(capsule));
tamperedCapsule.payload.records[0].candidates[0].model = "tampered";
ok("evidence capsules detect tampering", !verifyEvidenceCapsule(tamperedCapsule).valid);
const inconsistentCapsule = JSON.parse(JSON.stringify(capsule));
inconsistentCapsule.payload.replay.decisions = 999;
inconsistentCapsule.manifest.payload_sha256 = "sha256:forged";
ok("evidence capsules reject derived summaries that disagree with receipts", verifyEvidenceCapsule(inconsistentCapsule).errors.some((error) => error.includes("replay summary")));
ok("verified capsules render a standalone Decision Lab", renderCapsuleLab(capsule).includes("AgentRoute Decision Lab"));
const capsuleKeys = generateKeyPairSync("ed25519");
const capsulePrivateKey = capsuleKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const capsulePublicKey = capsuleKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
const signedCapsule = signEvidenceCapsule(capsule, capsulePrivateKey);
const embeddedSignature = verifyEvidenceCapsule(signedCapsule);
const pinnedSignature = verifyEvidenceCapsule(signedCapsule, { require_signature: true, public_key_pem: capsulePublicKey });
ok("signed capsules distinguish cryptographic validity from signer trust", embeddedSignature.signature_valid === true && embeddedSignature.signature_trusted === false && embeddedSignature.warnings.length === 1 && pinnedSignature.signature_trusted === true);
const wrongCapsuleKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
ok("signed capsules reject an unrecognized signer", !verifyEvidenceCapsule(signedCapsule, { public_key_pem: wrongCapsuleKey }).valid);
const damagedSignature = JSON.parse(JSON.stringify(signedCapsule));
damagedSignature.signature.signature_base64 = `${damagedSignature.signature.signature_base64.slice(0, -4)}AAAA`;
ok("signed capsules reject signature tampering", !verifyEvidenceCapsule(damagedSignature).valid);
ok("signature-required verification rejects unsigned legacy capsules", !verifyEvidenceCapsule(capsule, { require_signature: true }).valid);

const observatoryScratch = mkdtempSync(join(tmpdir(), "agentroute-observatory-"));
try {
  const observatoryLedger = join(observatoryScratch, "routes.route.jsonl");
  const observatoryExperimentLedger = join(observatoryScratch, "experiment.route.jsonl");
  writeFileSync(observatoryLedger, `${JSON.stringify(valid)}\n${JSON.stringify(observedValid)}\n`);
  writeFileSync(observatoryExperimentLedger, `${arena.records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const observatory = await startObservatory(observatoryLedger, { port: 0, experiment_ledger_path: observatoryExperimentLedger });
  try {
    const response = await fetch(`${observatory.address.url}/api/snapshot`);
    const snapshot = await response.json() as { replay: { decisions: number }; lab: { routes: Array<{ task_type: string }> }; experiment: { comparisons: Array<{ matched_pairs: number }> } };
    ok("Live Route Observatory serves a privacy-safe local snapshot", response.ok && snapshot.replay.decisions === 1 && snapshot.lab.routes[0].task_type === "code_review" && snapshot.experiment.comparisons[0].matched_pairs === 1);
    const html = await (await fetch(observatory.address.url)).text();
    ok("Live Route Observatory serves a self-contained dashboard", html.includes("Route Observatory") && !html.includes("https://"));
    const reboundStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: observatory.address.port, path: "/api/snapshot", headers: { Host: "attacker.example" } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode || 0));
      });
      request.on("error", reject);
      request.end();
    });
    ok("Live Route Observatory rejects DNS-rebinding Host headers", reboundStatus === 403);
  } finally { await observatory.close(); }
  let remoteRefused = false;
  try { await startObservatory(observatoryLedger, { host: "0.0.0.0", port: 0 }); } catch (error) { remoteRefused = String((error as Error).message).includes("refusing non-loopback"); }
  ok("Live Route Observatory refuses remote binding by default", remoteRefused);
} finally { rmSync(observatoryScratch, { recursive: true, force: true }); }

console.log("source adapters");
const openrouter = fromOpenRouterRoute({ id: "gen_1", model: "model-r", provider_name: "provider-r", total_cost: 0.01, authorization: "must-not-copy" }, { routeId: "route_or" });
ok("OpenRouter defaults to selected-only", openrouter.source.fidelity === "selected-only" && openrouter.candidates.length === 1);
ok("OpenRouter adapter does not retain source envelope or credentials", !JSON.stringify(openrouter).includes("authorization"));
const partial = fromOpenRouterRoute({ model: "model-a", selected_candidate_id: "a", candidates: [{ id: "a", model: "model-a" }, { id: "b", model: "model-b" }] });
ok("candidate list without completeness attestation is partial", partial.source.fidelity === "partial");
const full = fromOpenRouterRoute({ model: "model-a", selected_candidate_id: "a", candidates: [{ id: "a", model: "model-a" }, { id: "b", model: "model-b" }] }, { completeCandidateSet: true });
ok("explicit completeness attestation permits full fidelity", full.source.fidelity === "full");
const routed = fromOpenRouterRoute({
  id: "gen_metadata",
  model: "model-auto",
  secret: "must-not-copy",
  openrouter_metadata: {
    requested: "openrouter/auto",
    strategy: "auto",
    summary: "available=2, selected=Provider B",
    attempt: 2,
    endpoints: { total: 2, available: [
      { provider: "Provider A", model: "model-auto", selected: false },
      { provider: "Provider B", model: "model-auto", selected: true },
    ] },
    attempts: [
      { provider: "Provider A", model: "model-auto", status: 529, raw_error: "private" },
      { provider: "Provider B", model: "model-auto", status: 200 },
    ],
    pipeline: [{ type: "context_compression", name: "context-compression", summary: "compressed", data: { prompt: "private" } }],
    unknown: { api_key: "private" },
  },
});
ok("OpenRouter metadata identifies selected provider", routed.candidates.find((candidate) => candidate.id === routed.selection.candidate_id)?.provider === "Provider B");
ok("OpenRouter endpoint snapshot is full fidelity when totals match", routed.source.fidelity === "full" && routed.router.policy_id === "auto");
const routedText = JSON.stringify(routed);
ok("OpenRouter metadata allowlist drops unknown and nested sensitive fields", !routedText.includes("must-not-copy") && !routedText.includes("raw_error") && !routedText.includes("api_key") && !routedText.includes("prompt"));
const litellm = fromLiteLLMRoute({ model: "model-l", litellm_params: { custom_llm_provider: "provider-l" }, response_cost: 0.004, api_key: "must-not-copy" });
ok("LiteLLM maps selected metadata", litellm.candidates[0].model === "model-l" && litellm.candidates[0].provider === "provider-l");
ok("LiteLLM adapter does not retain source secrets", !JSON.stringify(litellm).includes("api_key"));
const hostileGatewayFields = { authorization: "Bearer secret", api_key: "sk-secret", prompt: "private prompt", response_body: "private answer", metadata: { user: "private@example.com" } };
const portkeyEvent = {
  trace_id: "pk_trace_1",
  created_at: "2026-08-23T10:00:00.000Z",
  ai_model: "claude-sonnet",
  provider: "anthropic",
  fallback_models: ["gpt-5", "gemini-pro"],
  retry_success_count: 1,
  cache_status: "MISS",
  response_time: 215,
  cost: 2.5,
  status_code: 200,
  ...hostileGatewayFields,
};
const portkey = fromPortkeyRoute(portkeyEvent);
const portkeyBundle = importPortkeyRoute(portkeyEvent, { portkeyCostUnit: "cents" });
const portkeyWithoutUnit = importPortkeyRoute(portkeyEvent);
ok("Portkey imports selected model plus fallback evidence", portkey.candidates.length === 3 && portkey.selection.fallback_order?.length === 2 && portkey.source.fidelity === "partial");
ok("Portkey produces stable IDs and measured observations", portkey.route_id === fromPortkeyRoute(portkeyEvent).route_id && portkeyBundle.observation?.outcome.latency_ms === 215 && portkeyBundle.observation?.outcome.cost_usd === 0.025);
ok("Portkey generic cost is omitted without an explicit unit", portkeyWithoutUnit.observation?.outcome.cost_usd === undefined);
ok("Portkey allowlist rejects credentials, content, and arbitrary metadata", !JSON.stringify(portkeyBundle).includes("sk-secret") && !JSON.stringify(portkeyBundle).includes("private prompt") && !JSON.stringify(portkeyBundle).includes("private@example.com"));
const vercel = fromVercelAiGatewayRoute({
  id: "vercel_req_1",
  created_at: "2026-08-23T10:01:00.000Z",
  model: "anthropic/claude-sonnet-4",
  providerMetadata: { gateway: { provider: "anthropic", requestId: "vercel_req_1", secret: "drop-me" } },
  providerOptions: { order: ["anthropic", "vertex"], only: ["anthropic", "vertex"], models: ["openai/gpt-5"] },
  user: "private-user",
  ...hostileGatewayFields,
});
ok("Vercel AI Gateway imports provider routing controls conservatively", vercel.extensions?.vercel_ai_gateway !== undefined && vercel.candidates.length === 2 && vercel.source.fidelity === "partial");
ok("Vercel AI Gateway allowlist rejects users, secrets, prompts, and bodies", !JSON.stringify(vercel).includes("private-user") && !JSON.stringify(vercel).includes("drop-me") && !JSON.stringify(vercel).includes("private prompt"));
const cloudflareEvent = {
  id: "cf_log_1",
  created_at: "2026-08-23T10:02:00.000Z",
  model: "@cf/meta/llama",
  provider: "workers-ai",
  success: true,
  status_code: 200,
  duration: 88,
  cost: 0.004,
  tokens_in: 20,
  tokens_out: 10,
  cached: true,
  ...hostileGatewayFields,
};
const cloudflare = fromCloudflareAiGatewayRoute(cloudflareEvent);
const cloudflareBundle = importCloudflareAiGatewayRoute(cloudflareEvent);
ok("Cloudflare AI Gateway imports documented decision and operational fields", cloudflare.source.event_id === "cf_log_1" && cloudflareBundle.observation?.outcome.latency_ms === 88 && cloudflareBundle.observation?.outcome.metadata?.cached === true);
ok("Cloudflare ambiguous cost is not misreported as USD", cloudflareBundle.observation?.outcome.cost_usd === undefined);
ok("Cloudflare allowlist rejects payloads, credentials, and metadata", !JSON.stringify(cloudflareBundle).includes("private answer") && !JSON.stringify(cloudflareBundle).includes("Bearer secret") && !JSON.stringify(cloudflareBundle).includes("private@example.com"));

console.log("live capture, grounding, evaluation, and reports");
let captureRequest: { url?: string; headers?: Record<string, string>; body?: string } = {};
const ticks = [1_700_000_000_000, 1_700_000_000_125];
const captured = await captureOpenRouter({
  apiKey: "test-openrouter-key",
  request: { model: "openrouter/auto", messages: [{ role: "user", content: "private prompt" }] },
  routeId: "route_live_capture",
  taskType: "research",
  clock: () => ticks.shift()!,
  fetcher: async (url, init) => {
    captureRequest = { url, headers: init.headers, body: init.body };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: "gen_live",
        model: "model-live",
        choices: [{ message: { content: "private answer" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.002 },
        openrouter_metadata: {
          requested: "openrouter/auto",
          strategy: "auto",
          summary: "available=1, selected=Provider Live",
          endpoints: { total: 1, available: [{ provider: "Provider Live", model: "model-live", selected: true }] },
        },
      }),
    };
  },
});
ok("live capture opts into stable OpenRouter metadata", captureRequest.headers?.["X-OpenRouter-Metadata"] === "enabled");
ok("live capture records measured latency and cost", captured.observation.outcome.latency_ms === 125 && captured.observation.outcome.cost_usd === 0.002);
const captureLedgerText = JSON.stringify([captured.decision, captured.observation]);
ok("live capture receipts omit prompts, response text, and API keys", !captureLedgerText.includes("private prompt") && !captureLedgerText.includes("private answer") && !captureLedgerText.includes("test-openrouter-key"));

let exaRequest: { headers?: Record<string, string>; body?: string } = {};
const taskPack = await createExaTaskPack({
  apiKey: "test-exa-key",
  generatedAt: "2026-08-23T12:00:00.000Z",
  seeds: [{ id: "current-docs", type: "research", query: "Find the current official migration guide", include_domains: ["example.com"] }],
  fetcher: async (_url, init) => {
    exaRequest = { headers: init.headers, body: init.body };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ results: [{ title: "Official guide", url: "https://example.com/guide", publishedDate: "2026-08-20", highlights: ["Use the new API."] }], secret: "drop-me" }),
    };
  },
});
ok("Exa task packs request nested highlights and domain filters", JSON.parse(exaRequest.body!).contents.highlights === true && JSON.parse(exaRequest.body!).includeDomains[0] === "example.com");
ok("Exa task packs retain grounded evidence without credentials", taskPack.tasks[0].evidence[0].highlights[0] === "Use the new API." && !JSON.stringify(taskPack).includes("test-exa-key") && !JSON.stringify(taskPack).includes("drop-me"));

const evaluated = evaluateChecklist({
  route_id: valid.route_id,
  evaluator: { id: "demo-checklist", version: "1" },
  evaluated_at: "2026-08-22T10:00:02.000Z",
  checks: [
    { id: "correct", passed: true, weight: 3, required: true },
    { id: "cited", passed: false, weight: 1 },
  ],
});
ok("evaluator contract produces weighted outcome quality", evaluated.status === "partial" && evaluated.quality === 0.75);
const braintrustDraft = fromBraintrustEvaluation({
  route_id: valid.route_id,
  experiment_name: "answer-quality",
  evaluator_version: "2026-08-23",
  created_at: "2026-08-22T10:00:02.000Z",
  span_id: "span_1",
  scores: { correctness: 0.9, citations: { score: 0.7 }, ignored: "not numeric" },
  input: "private input",
  output: "private output",
  metadata: { route_id: valid.route_id, api_key: "secret" },
});
const braintrustText = JSON.stringify(braintrustDraft);
ok("Braintrust preserves numeric scores instead of flattening them to booleans", evaluateChecklist(braintrustDraft).quality === 0.8);
ok("Braintrust derives a stable observation ID from the external span", braintrustDraft.observation_id === fromBraintrustEvaluation({ route_id: valid.route_id, span_id: "span_1", scores: { correctness: 1 } }).observation_id);
ok("Braintrust allowlist excludes inputs, outputs, reasoning, and arbitrary metadata", !braintrustText.includes("private input") && !braintrustText.includes("private output") && !braintrustText.includes("api_key"));
const evaluationObservation = evaluationToObservation({
  route_id: valid.route_id,
  evaluator: { id: "demo-checklist" },
  evaluated_at: "2026-08-22T10:00:02.000Z",
  checks: [{ id: "correct", passed: false, required: true }],
}, { status: "success", latency_ms: 321, cost_usd: 0.004, metadata: { tool_calls: "none" } });
ok("required evaluator failures fail closed", evaluationObservation.outcome.status === "failure" && evaluationObservation.outcome.quality === 0);
ok("evaluation observations retain prior measured metrics", evaluationObservation.outcome.latency_ms === 321 && evaluationObservation.outcome.cost_usd === 0.004 && evaluationObservation.outcome.metadata?.tool_calls === "none");
const detail = formatReceiptDetail({ decision: valid, observations: [], latest_observation: evaluationToObservation({
  route_id: valid.route_id,
  evaluator: { id: "demo" },
  evaluated_at: "2026-08-22T10:00:02.000Z",
  checks: [{ id: "correct", passed: true }],
}) });
ok("receipt detail separates predicted candidates from measured outcome", detail.includes("CANDIDATES (predicted at routing time)") && detail.includes("Outcome      success"));
ok("routing report summarizes decisions and receipt detail", formatRouteReport([valid]).includes("Decisions 1 · observed 0") && formatRouteReport([valid]).includes("AGENTROUTE RECEIPT route_test"));

console.log("audit readiness and Decision Lab");
const audit = auditRouteRecords([captured.decision, captured.observation, selectedOnly], "2026-08-23T12:00:00.000Z");
ok("audit readiness measures instrumentation rather than outcomes", audit.decisions === 2 && audit.metrics.find((item) => item.id === "outcome")?.covered === 1);
ok("audit readiness identifies incomplete and unevaluated receipts", audit.gaps.some((gap) => gap.code === "candidate_evidence_incomplete") && audit.gaps.some((gap) => gap.code === "quality_missing"));
const labModel = buildDecisionLabModel([captured.decision, captured.observation], "2026-08-23T12:00:00.000Z");
ok("Decision Lab model exposes the four-stage routing evidence", labModel.routes[0].requested_model === "openrouter/auto" && labModel.routes[0].selected.provider === "Provider Live" && labModel.routes[0].outcome?.status === "success");
const incompleteLabModel = buildDecisionLabModel([selectedOnly], "2026-08-23T12:00:00.000Z");
ok("Decision Lab blocks policy proposals for incomplete evidence", incompleteLabModel.routes[0].policy_ready === false);
const hostile = createRouteDecision({
  ...valid,
  route_id: "route_hostile",
  task: { type: "security", description: "private prompt must stay hidden" },
  selection: { ...valid.selection, reason: "</script><img src=x onerror=alert(1)>" },
  extensions: { unknown_secret: "never-render-this" },
});
const hostileHtml = renderDecisionLab([hostile], "2026-08-23T12:00:00.000Z");
ok("Decision Lab omits task descriptions and unknown extensions", !hostileHtml.includes("private prompt must stay hidden") && !hostileHtml.includes("never-render-this"));
ok("Decision Lab escapes receipt text before embedding", !hostileHtml.includes("</script><img") && hostileHtml.includes("\\u003c/script\\u003e"));

console.log("connector catalog");
const readyConnectors = listConnectors({ status: "available" });
const partialPolicyTargets = listConnectors({ status: "partial", role: "policy-target" });
ok("connector catalog marks tested imports and dry-run compilers available", readyConnectors.some((item) => item.id === "cloudflare-ai-gateway") && readyConnectors.some((item) => item.id === "portkey") && readyConnectors.some((item) => item.id === "vercel-ai-gateway"));
ok("connector catalog has no capability-partial policy targets after compiler delivery", partialPolicyTargets.length === 0);
ok("connector catalog exposes measured gateway observation import", listConnectors({ capability: "observation-import" }).map((item) => item.id).join(",") === "portkey,vercel-ai-gateway,cloudflare-ai-gateway");
ok("connector catalog renders tested policy-export capabilities", formatConnectorCatalog().includes("policy-export") && !formatConnectorCatalog().includes("policy-export:planned"));
ok("connector catalog advertises both standards export profiles", listConnectors({ capability: "trace-export" }).map((item) => item.id).join(",") === "opentelemetry,openinference");

console.log("OpenTelemetry and published artifacts");
const otelText = JSON.stringify(routeToOtel({ decision: valid, observations: [] }));
ok("OTel identifies select_model operation", otelText.includes("select_model") && otelText.includes("model-a"));
ok("OTel omits task descriptions and endpoints", !otelText.includes("private task text") && !otelText.includes("private.invalid"));
const openInferenceText = JSON.stringify(routeToTelemetry({ decision: hostile, observations: [] }, "openinference"));
ok("OpenInference exports a metadata-only LLM span", openInferenceText.includes("openinference.span.kind") && openInferenceText.includes("llm.model_name"));
ok("OpenInference omits task content, endpoints, selection reasons, and extensions", !openInferenceText.includes("private prompt") && !openInferenceText.includes("private.invalid") && !openInferenceText.includes("never-render-this") && !openInferenceText.includes("onerror"));
const example = JSON.parse(readFileSync(join(root, "examples/code-review.route.json"), "utf8"));
ok("standalone example passes runtime validation", validateRouteRecord(example).valid, validateRouteRecord(example).errors.join("; "));
const corpus = parseRouteRecords(readFileSync(join(root, "examples/model-routing.route.jsonl"), "utf8"));
ok("ledger example passes sequence validation", validateRouteLedger(corpus).valid);
const demoCorpus = parseRouteRecords(readFileSync(join(root, "examples/can-auto-routing-prove-it.route.jsonl"), "utf8"));
ok("Auto Routing demo fixture is conformant and explicitly illustrative", validateRouteLedger(demoCorpus).valid && demoCorpus.every((record) => record.extensions?.demo_fixture === "illustrative-only"));
const demoSeeds = JSON.parse(readFileSync(join(root, "examples/can-auto-routing-prove-it.tasks.json"), "utf8"));
ok("Auto Routing demo defines ten grounded task seeds", Array.isArray(demoSeeds.seeds) && demoSeeds.seeds.length === 10);
const governancePolicy = JSON.parse(readFileSync(join(root, "examples/experiment-governance.policy.draft.json"), "utf8"));
ok("experiment governance policy example is compilable and starts in draft", compilePolicy(governancePolicy, "native").source.policy_version === "1.1.0" && governancePolicy.status === "draft");
const governanceGateConfig = JSON.parse(readFileSync(join(root, "examples/experiment-governance.gate.json"), "utf8"));
ok("experiment governance gate example enables fail-closed task slices", governanceGateConfig.task_type_slices === true && evaluateRouteGate(sliceBaseline, sliceCurrent, governanceGateConfig).slices?.code_review.status === "fail");
const promotionProtocolExample = JSON.parse(readFileSync(join(root, "examples/promotion-dossier.protocol.json"), "utf8"));
ok("promotion dossier protocol example is preregistered and valid", validateExperimentProtocol(promotionProtocolExample).challenger_candidate_id === "fast-review");
throws("experiment protocols reject non-positive per-slice coverage", () => validateExperimentProtocol({ ...promotionProtocolExample, minimum_slice_matched_pairs: 0 }), "minimum_slice_matched_pairs");
throws("quality gates reject fractional per-slice sample requirements", () => evaluateRouteGate([valid], [valid], { minimum_slice_samples: 1.5 }), "minimum_slice_samples must be an integer");
const importFixtures = {
  portkey: importPortkeyRoute(JSON.parse(readFileSync(join(root, "examples/imports/portkey-log.json"), "utf8")), { routeId: "route_fixture_portkey" }),
  vercel: fromVercelAiGatewayRoute(JSON.parse(readFileSync(join(root, "examples/imports/vercel-ai-gateway-event.json"), "utf8")), { routeId: "route_fixture_vercel" }),
  cloudflare: importCloudflareAiGatewayRoute(JSON.parse(readFileSync(join(root, "examples/imports/cloudflare-ai-gateway-log.json"), "utf8")), { routeId: "route_fixture_cloudflare" }),
  braintrust: fromBraintrustEvaluation(JSON.parse(readFileSync(join(root, "examples/imports/braintrust-score.json"), "utf8")), { routeId: "route_fixture_braintrust" }),
};
ok("bundled vendor fixtures remain importable", validateRouteLedger([importFixtures.portkey.decision, importFixtures.portkey.observation!]).valid && validateRouteRecord(importFixtures.vercel).valid && validateRouteLedger([importFixtures.cloudflare.decision, importFixtures.cloudflare.observation!]).valid && importFixtures.braintrust.checks.length === 3);
const schema = JSON.parse(readFileSync(join(root, "schema/routedecision-0.1.schema.json"), "utf8"));
ok("schema publishes draft 2020-12 and both record forms", schema.$schema.includes("2020-12") && schema.$defs.decision && schema.$defs.observation);
const requiredStayAligned = (record: Record<string, unknown>, required: string[]): boolean => required.every((field) => {
  const mutated = { ...record };
  delete mutated[field];
  return !validateRouteRecord(mutated).valid;
});
ok("runtime rejects every schema-required decision field", requiredStayAligned(valid as unknown as Record<string, unknown>, schema.$defs.decision.required));
const alignmentObservation = createRouteObservation({ route_id: valid.route_id, observation_id: "obs_alignment", observed_at: "2026-08-22T10:01:00.000Z", outcome: { status: "unknown" } });
ok("runtime rejects every schema-required observation field", requiredStayAligned(alignmentObservation as unknown as Record<string, unknown>, schema.$defs.observation.required));

// Invalid JSONL must report the physical line and never partially validate.
throws("malformed JSONL reports line number", () => parseRouteRecords(`${JSON.stringify(valid)}\n{bad`, "broken.route.jsonl"), "broken.route.jsonl:2");
throws("malformed JSONL keeps physical line numbers across blanks", () => parseRouteRecords(`${JSON.stringify(valid)}\n\n{bad`, "blank.route.jsonl"), "blank.route.jsonl:3");
throws("ledger validator rejects duplicate decisions", () => {
  const result = validateRouteLedger([valid, valid]);
  if (!result.valid) throw new Error(result.errors.join("; "));
}, "duplicate decision");

console.log("connector SDK conformance");
const nativeConformance = await runConnectorConformance(NATIVE_RECEIPT_ADAPTER, [{ name: "native-ledger", fixture: [valid] }]);
ok("native connector reference adapter passes schema, determinism, and privacy checks", nativeConformance.valid && nativeConformance.checks.every((check) => check.status === "pass"));
const leakingConnector = await runConnectorConformance(NATIVE_RECEIPT_ADAPTER, [{ name: "privacy-canary", fixture: [hostile], forbidden_markers: ["never-render-this"] }]);
ok("connector conformance fails closed on forbidden marker leakage", !leakingConnector.valid && leakingConnector.checks.some((check) => check.check === "privacy" && check.status === "fail"));
let nondeterministicCalls = 0;
const nondeterministicConnector = await runConnectorConformance({
  manifest: { ...NATIVE_RECEIPT_ADAPTER.manifest, id: "nondeterministic-test" },
  importFixture: () => createRouteDecision({ ...valid, route_id: `route_nondeterministic_${++nondeterministicCalls}` }),
}, [{ name: "nondeterminism", fixture: {} }]);
ok("connector conformance rejects nondeterministic imports", !nondeterministicConnector.valid && nondeterministicConnector.checks.some((check) => check.check === "determinism" && check.status === "fail"));

console.log("Public Proof Pack");
const proofScratch = mkdtempSync(join(tmpdir(), "agentroute-proof-"));
try {
  const first = join(proofScratch, "first");
  const second = join(proofScratch, "second");
  const changed = join(proofScratch, "changed");
  const membership = join(proofScratch, "membership");
  const malicious = join(proofScratch, "malicious");
  const linked = join(proofScratch, "linked");
  const firstManifest = await buildProofPack({ output: first });
  const secondManifest = await buildProofPack({ output: second });
  await buildProofPack({ output: changed });
  await buildProofPack({ output: membership });
  await buildProofPack({ output: malicious });
  await buildProofPack({ output: linked });
  const firstVerification = verifyProofPack(first);
  ok("proof pack binds an eligible offline evidence chain", firstVerification.valid && firstVerification.dossier_verdict === "eligible" && firstManifest.claim_scope === "offline_conformance");
  ok("proof pack exposes the operational caution without invalidating the evidence", firstVerification.operations_status === "attention" && firstVerification.timeline_status === "attention");
  ok("proof pack snapshots the complete built-in connector registry", firstVerification.connector_count === listConnectors().length);
  const proofDecision = JSON.parse(readFileSync(join(first, "experiment-decision.json"), "utf8"));
  const proofArena = JSON.parse(readFileSync(join(first, "arena-report.json"), "utf8"));
  const proofGate = JSON.parse(readFileSync(join(first, "quality-gate.json"), "utf8"));
  const proofOperations = JSON.parse(readFileSync(join(first, "operations.arops"), "utf8"));
  const proofTimeline = JSON.parse(readFileSync(join(first, "reliability.arhistory"), "utf8"));
  ok("proof pack evaluates twelve matched cases across four required slices", proofDecision.analysis.comparisons[0].matched_pairs === 12 && Object.keys(proofDecision.analysis.by_task_type).length === 4);
  ok("proof pack labels fixture results as offline and illustrative", proofArena.evidence_mode === "offline_conformance" && proofArena.result_label === "illustrative");
  ok("proof quality gate compares complete candidate ledgers by task slice", proofGate.baseline_samples === 12 && proofGate.current_samples === 12 && Object.keys(proofGate.slices).length === 4 && Object.values(proofGate.slices).every((slice) => (slice as { status: string }).status === "pass"));
  ok("proof operations review passes drift and SLO checks while preserving outage impact", proofOperations.payload.drift.status === "pass" && proofOperations.payload.slo.status === "pass" && proofOperations.payload.assessment.status === "attention" && proofOperations.payload.scenario_reports[0].impacted === 12 && proofOperations.payload.scenario_reports[0].stranded === 0);
  ok("proof reliability timeline binds baseline and proposed reviews to the packaged operations head", proofTimeline.summary.reviews === 2 && proofTimeline.summary.current_status === "attention" && proofTimeline.entries[1].review_root_sha256 === proofOperations.manifest.root_sha256);
  const firstFiles = readdirSync(first).sort();
  const secondFiles = readdirSync(second).sort();
  ok("clean proof runs emit the same file set", JSON.stringify(firstFiles) === JSON.stringify(secondFiles));
  ok("clean proof runs are byte-identical", firstFiles.every((file) => {
    const left = readFileSync(join(first, file));
    const right = readFileSync(join(second, file));
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
  }));
  const linkedVictim = join(proofScratch, "must-not-overwrite.txt");
  writeFileSync(linkedVictim, "preserve me\n");
  rmSync(join(linked, "index.html"));
  symlinkSync(linkedVictim, join(linked, "index.html"));
  let linkedRefused = false;
  try { await buildProofPack({ output: linked, force: true }); } catch (error) { linkedRefused = String((error as Error).message).includes("non-file entries"); }
  ok("proof force mode refuses symlink overwrite targets", linkedRefused && readFileSync(linkedVictim, "utf8") === "preserve me\n");
  ok("proof verification refuses symlink artifacts", verifyProofPack(linked).errors.some((error) => error.includes("missing artifact: index.html")));
  const unchangedDiff = compareProofPacks(first, second);
  ok("proof diff recognizes byte-identical verified packs", unchangedDiff.status === "unchanged" && unchangedDiff.artifacts.added.length === 0 && unchangedDiff.artifacts.removed.length === 0 && unchangedDiff.artifacts.modified.length === 0 && unchangedDiff.semantics.length === 0);
  const changedReport = readFileSync(join(changed, "index.html"), "utf8").replace("</body>", "<!-- reviewer-copy-change --></body>");
  writeFileSync(join(changed, "index.html"), changedReport);
  const changedManifest = JSON.parse(readFileSync(join(changed, "proof-manifest.json"), "utf8"));
  changedManifest.artifacts.find((artifact: { path: string }) => artifact.path === "index.html").sha256 = sha256(changedReport);
  const { root_sha256: ignoredChangedRoot, ...changedManifestBody } = changedManifest;
  void ignoredChangedRoot;
  changedManifest.root_sha256 = sha256(changedManifestBody);
  writeFileSync(join(changed, "proof-manifest.json"), canonicalJson(changedManifest) + "\n");
  const changedDiff = compareProofPacks(first, changed);
  const serializedChangedDiff = JSON.stringify(changedDiff);
  ok("proof diff reports the exact re-bound artifact change", changedDiff.status === "changed" && changedDiff.artifacts.modified.length === 1 && changedDiff.artifacts.modified[0].path === "index.html");
  ok("proof diff excludes artifact bodies and caller paths", !serializedChangedDiff.includes("reviewer-copy-change") && !serializedChangedDiff.includes(proofScratch));
  const unchangedGitHub = formatGitHubProofDiff(unchangedDiff);
  const changedGitHub = formatGitHubProofDiff(changedDiff);
  ok("proof diff emits bounded GitHub annotations", unchangedGitHub.startsWith("::notice::") && changedGitHub.startsWith("::warning::") && changedGitHub.includes("Modified proof artifact: index.html") && !changedGitHub.includes("reviewer-copy-change") && !changedGitHub.includes(proofScratch));
  const membershipNote = "{\"scope\":\"unexpected\"}\n";
  writeFileSync(join(membership, "review-note.json"), membershipNote);
  const membershipManifest = JSON.parse(readFileSync(join(membership, "proof-manifest.json"), "utf8"));
  membershipManifest.artifacts.push({ path: "review-note.json", media_type: "application/json", sha256: sha256(membershipNote) });
  const { root_sha256: ignoredMembershipRoot, ...membershipManifestBody } = membershipManifest;
  void ignoredMembershipRoot;
  membershipManifest.root_sha256 = sha256(membershipManifestBody);
  writeFileSync(join(membership, "proof-manifest.json"), canonicalJson(membershipManifest) + "\n");
  const membershipVerification = verifyProofPack(membership);
  ok("proof verification rejects a re-bound v0.1 membership expansion", !membershipVerification.valid && membershipVerification.errors.some((error) => error.includes("required v0.1 artifact set")));
  throws("proof diff rejects an invalid pack before comparison", () => compareProofPacks(first, membership), "current proof pack is invalid");
  const proofKeys = generateKeyPairSync("ed25519");
  const proofPrivateKey = proofKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const proofPublicKey = proofKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const proofAttestation = signProofPack(first, proofPrivateKey);
  const repeatedAttestation = signProofPack(first, proofPrivateKey);
  const embeddedProofSignature = verifyProofAttestation(first, proofAttestation);
  const trustedProofSignature = verifyProofAttestation(first, proofAttestation, { public_key_pem: proofPublicKey });
  ok("proof attestations are deterministic for the same pack and Ed25519 key", JSON.stringify(proofAttestation) === JSON.stringify(repeatedAttestation));
  ok("proof attestations distinguish signature validity from signer trust", embeddedProofSignature.valid && embeddedProofSignature.signature_valid === true && embeddedProofSignature.signature_trusted === false && embeddedProofSignature.warnings.length === 1 && trustedProofSignature.valid && trustedProofSignature.signature_trusted === true);
  ok("proof attestations expose only the public key and exact proof subject", !JSON.stringify(proofAttestation).includes(proofPrivateKey) && proofAttestation.subject.root_sha256 === firstManifest.root_sha256 && proofAttestation.subject.artifact_count === firstManifest.artifacts.length);
  const wrongProofKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  ok("proof attestations reject a different trusted signer", !verifyProofAttestation(first, proofAttestation, { public_key_pem: wrongProofKey }).valid);
  const rsaProofKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  throws("proof signing rejects non-Ed25519 private keys", () => signProofPack(first, rsaProofKey), "Ed25519");
  const changedProofSubject = JSON.parse(JSON.stringify(proofAttestation));
  changedProofSubject.subject.root_sha256 = `sha256:${"0".repeat(64)}`;
  ok("proof attestations reject subject tampering", !verifyProofAttestation(first, changedProofSubject).valid);
  const damagedProofSignature = JSON.parse(JSON.stringify(proofAttestation));
  damagedProofSignature.signature_base64 = `${damagedProofSignature.signature_base64[0] === "A" ? "B" : "A"}${damagedProofSignature.signature_base64.slice(1)}`;
  ok("proof attestations reject signature tampering", !verifyProofAttestation(first, damagedProofSignature).valid);
  const malformedProofKey = { ...proofAttestation, public_key_pem: "not a public key" };
  ok("proof attestations reject malformed public keys", !verifyProofAttestation(first, malformedProofKey).valid);
  const extendedProofAttestation = { ...proofAttestation, private_note: "must fail closed" };
  ok("proof attestations reject unknown fields", verifyProofAttestation(first, extendedProofAttestation).errors.some((error) => error.includes("unknown keys")));
  const reportText = readFileSync(join(first, "index.html"), "utf8");
  const operationsReport = readFileSync(join(first, "operations-review.html"), "utf8");
  const reliabilityReport = readFileSync(join(first, "reliability.html"), "utf8");
  ok("proof report tells the complete launch story", reportText.includes("Prove every route.") && reportText.includes("operations-review.html") && reportText.includes("reliability.html"));
  ok("all proof reports are standalone and carry the evidence limitation", [reportText, operationsReport, reliabilityReport].every((report) => report.includes("Illustrative offline conformance evidence") && !report.includes("<script") && !report.includes("https://") && !report.includes("http://")));
  const operationsOriginal = readFileSync(join(first, "operations.arops"), "utf8");
  writeFileSync(join(first, "operations.arops"), "{}\n");
  const operationsTamper = verifyProofPack(first);
  ok("proof verification detects operations-review tampering", !operationsTamper.valid && operationsTamper.errors.some((error) => error.includes("operations review") || error.includes("operations.arops")));
  ok("proof attestation verification rejects a changed proof pack", !verifyProofAttestation(first, proofAttestation).proof_valid);
  throws("proof signing refuses an invalid proof pack", () => signProofPack(first, proofPrivateKey), "cannot sign invalid");
  writeFileSync(join(first, "operations.arops"), operationsOriginal);
  const timelineOriginal = readFileSync(join(first, "reliability.arhistory"), "utf8");
  writeFileSync(join(first, "reliability.arhistory"), "{}\n");
  const timelineTamper = verifyProofPack(first);
  ok("proof verification detects reliability-timeline tampering", !timelineTamper.valid && timelineTamper.errors.some((error) => error.includes("reliability timeline") || error.includes("reliability.arhistory")));
  writeFileSync(join(first, "reliability.arhistory"), timelineOriginal);
  const connectorOriginal = readFileSync(join(first, "connector-catalog.json"), "utf8");
  writeFileSync(join(first, "connector-catalog.json"), "[]\n");
  const connectorTamper = verifyProofPack(first);
  ok("proof verification detects connector-catalog tampering", !connectorTamper.valid && connectorTamper.errors.some((error) => error.includes("connector catalog") || error.includes("connector-catalog.json")));
  writeFileSync(join(first, "connector-catalog.json"), connectorOriginal);
  writeFileSync(join(first, "experiment-decision.json"), "{}\n");
  ok("proof verification detects bound artifact tampering", !verifyProofPack(first).valid && verifyProofPack(first).errors.some((error) => error.includes("SHA-256 mismatch")));
  writeFileSync(join(second, "unexpected.txt"), "unbound");
  ok("proof verification rejects unbound additions", !verifyProofPack(second).valid && verifyProofPack(second).errors.some((error) => error.includes("exactly match")));
  const maliciousManifest = JSON.parse(readFileSync(join(malicious, "proof-manifest.json"), "utf8"));
  maliciousManifest.artifacts[0].path = "../outside.json";
  maliciousManifest.artifacts.push(null);
  const malformedArtifactIndex = maliciousManifest.artifacts.length - 1;
  writeFileSync(join(malicious, "proof-manifest.json"), JSON.stringify(maliciousManifest));
  const maliciousVerification = verifyProofPack(malicious);
  ok("proof verification rejects unsafe and malformed artifact entries before reading them", !maliciousVerification.valid && maliciousVerification.errors.some((error) => error.includes("flat safe filenames")) && maliciousVerification.errors.some((error) => error.includes(`artifact ${malformedArtifactIndex} is invalid`)));
  const cliProof = join(proofScratch, "cli");
  const cli = join(root, "src/cli.ts");
  const cliResult = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", cli, "proof", "run", "--out", cliProof], { encoding: "utf8" }));
  ok("CLI builds and verifies the complete proof pack in one command", cliResult.artifact_count === firstManifest.artifacts.length && verifyProofPack(cliProof).valid);
  const cliUnchangedDiff = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", cli, "proof", "diff", cliProof, cliProof], { encoding: "utf8" }));
  const cliChangedGitHub = execFileSync(process.execPath, ["--import", "tsx", cli, "proof", "diff", cliProof, changed, "--format", "github"], { encoding: "utf8" });
  ok("CLI compares verified proof packs in JSON and GitHub formats", cliUnchangedDiff.status === "unchanged" && cliChangedGitHub.includes("::warning::AgentRoute proof changed") && cliChangedGitHub.includes("index.html"));
  let failOnChangeOutput = "";
  try {
    execFileSync(process.execPath, ["--import", "tsx", cli, "proof", "diff", cliProof, changed, "--fail-on-change"], { encoding: "utf8" });
  } catch (error) {
    failOnChangeOutput = String((error as { stdout?: string }).stdout ?? "");
  }
  ok("CLI fail-on-change emits the complete diff before exiting non-zero", JSON.parse(failOnChangeOutput).status === "changed" && JSON.parse(failOnChangeOutput).artifacts.modified[0].path === "index.html");
  throws("CLI rejects incompatible proof diff output options", () => execFileSync(process.execPath, ["--import", "tsx", cli, "proof", "diff", cliProof, changed, "--format", "github", "-o", join(proofScratch, "diff.txt")], { encoding: "utf8" }), "does not support -o");
  throws("CLI rejects unknown proof diff formats", () => execFileSync(process.execPath, ["--import", "tsx", cli, "proof", "diff", cliProof, changed, "--format", "html"], { encoding: "utf8" }), "must be json or github");
  const proofPrivateKeyPath = join(proofScratch, "proof-private.pem");
  const proofPublicKeyPath = join(proofScratch, "proof-public.pem");
  const proofAttestationPath = join(proofScratch, "proof.arsig");
  writeFileSync(proofPrivateKeyPath, proofPrivateKey);
  writeFileSync(proofPublicKeyPath, proofPublicKey);
  execFileSync(process.execPath, ["--import", "tsx", cli, "proof", "sign", cliProof, "--private-key", proofPrivateKeyPath, "-o", proofAttestationPath], { encoding: "utf8" });
  const cliTrustedProof = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", cli, "proof", "verify", cliProof, "--attestation", proofAttestationPath, "--public-key", proofPublicKeyPath], { encoding: "utf8" }));
  ok("CLI signs and trust-verifies a detached proof attestation", cliTrustedProof.valid && cliTrustedProof.signature_valid && cliTrustedProof.signature_trusted);
  throws("CLI refuses a trusted key without a detached attestation", () => execFileSync(process.execPath, ["--import", "tsx", cli, "proof", "verify", cliProof, "--public-key", proofPublicKeyPath], { encoding: "utf8" }), "--attestation");
  const libraryAttestationPath = join(proofScratch, "library.arsig");
  writeProofAttestation(libraryAttestationPath, proofAttestation);
  ok("proof attestation writer emits canonical newline-terminated JSON", readFileSync(libraryAttestationPath, "utf8").endsWith("\n") && JSON.parse(readFileSync(libraryAttestationPath, "utf8")).subject.root_sha256 === firstManifest.root_sha256);
} finally {
  rmSync(proofScratch, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
