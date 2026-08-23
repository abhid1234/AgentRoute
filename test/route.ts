// AgentRoute behavioral and adversarial tests.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { fromLiteLLMRoute, fromOpenRouterRoute } from "../src/route-adapters.js";
import { routeToOtel } from "../src/route-to-otel.js";
import { validateRouteLedger, validateRouteRecord } from "../src/route-validate.js";
import type { RouteDecision } from "../src/route-types.js";

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
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("source adapters");
const openrouter = fromOpenRouterRoute({ id: "gen_1", model: "model-r", provider_name: "provider-r", total_cost: 0.01, authorization: "must-not-copy" }, { routeId: "route_or" });
ok("OpenRouter defaults to selected-only", openrouter.source.fidelity === "selected-only" && openrouter.candidates.length === 1);
ok("OpenRouter adapter does not retain source envelope or credentials", !JSON.stringify(openrouter).includes("authorization"));
const partial = fromOpenRouterRoute({ model: "model-a", selected_candidate_id: "a", candidates: [{ id: "a", model: "model-a" }, { id: "b", model: "model-b" }] });
ok("candidate list without completeness attestation is partial", partial.source.fidelity === "partial");
const full = fromOpenRouterRoute({ model: "model-a", selected_candidate_id: "a", candidates: [{ id: "a", model: "model-a" }, { id: "b", model: "model-b" }] }, { completeCandidateSet: true });
ok("explicit completeness attestation permits full fidelity", full.source.fidelity === "full");
const litellm = fromLiteLLMRoute({ model: "model-l", litellm_params: { custom_llm_provider: "provider-l" }, response_cost: 0.004, api_key: "must-not-copy" });
ok("LiteLLM maps selected metadata", litellm.candidates[0].model === "model-l" && litellm.candidates[0].provider === "provider-l");
ok("LiteLLM adapter does not retain source secrets", !JSON.stringify(litellm).includes("api_key"));

console.log("OpenTelemetry and published artifacts");
const otelText = JSON.stringify(routeToOtel({ decision: valid, observations: [] }));
ok("OTel identifies select_model operation", otelText.includes("select_model") && otelText.includes("model-a"));
ok("OTel omits task descriptions and endpoints", !otelText.includes("private task text") && !otelText.includes("private.invalid"));
const example = JSON.parse(readFileSync(join(root, "examples/code-review.route.json"), "utf8"));
ok("standalone example passes runtime validation", validateRouteRecord(example).valid, validateRouteRecord(example).errors.join("; "));
const corpus = parseRouteRecords(readFileSync(join(root, "examples/model-routing.route.jsonl"), "utf8"));
ok("ledger example passes sequence validation", validateRouteLedger(corpus).valid);
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
