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
import { formatConnectorCatalog, listConnectors } from "../src/connectors.js";
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
import { auditRouteRecords } from "../src/route-audit.js";
import { formatReceiptDetail, formatRouteReport } from "../src/route-report.js";
import { createExaTaskPack } from "../src/task-pack.js";
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
  const labOutput = join(scratch, "decision-lab.html");
  execFileSync(process.execPath, ["--import", "tsx", cli, "lab", ledger, "-o", labOutput], { encoding: "utf8" });
  const labText = readFileSync(labOutput, "utf8");
  ok("CLI writes a standalone Decision Lab", labText.includes("AgentRoute Decision Lab") && labText.includes("route_test"));
  const connectorText = execFileSync(process.execPath, ["--import", "tsx", cli, "connectors", "--status", "partial"], { encoding: "utf8" });
  ok("CLI filters the connector catalog", connectorText.includes("Portkey AI Gateway") && !connectorText.includes("OpenRouter"));
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
ok("connector catalog distinguishes complete from capability-partial work", readyConnectors.some((item) => item.id === "cloudflare-ai-gateway") && !readyConnectors.some((item) => item.id === "portkey"));
ok("connector catalog marks vendor imports ready while policy export remains planned", partialPolicyTargets.map((item) => item.id).join(",") === "portkey,vercel-ai-gateway" && partialPolicyTargets.every((item) => item.capability_status?.["policy-export"] === "planned"));
ok("connector catalog exposes measured gateway observation import", listConnectors({ capability: "observation-import" }).map((item) => item.id).join(",") === "portkey,vercel-ai-gateway,cloudflare-ai-gateway");
ok("connector catalog renders an honest capability status legend", formatConnectorCatalog().includes("decision-import:ready") && formatConnectorCatalog().includes("policy-export:planned"));

console.log("OpenTelemetry and published artifacts");
const otelText = JSON.stringify(routeToOtel({ decision: valid, observations: [] }));
ok("OTel identifies select_model operation", otelText.includes("select_model") && otelText.includes("model-a"));
ok("OTel omits task descriptions and endpoints", !otelText.includes("private task text") && !otelText.includes("private.invalid"));
const example = JSON.parse(readFileSync(join(root, "examples/code-review.route.json"), "utf8"));
ok("standalone example passes runtime validation", validateRouteRecord(example).valid, validateRouteRecord(example).errors.join("; "));
const corpus = parseRouteRecords(readFileSync(join(root, "examples/model-routing.route.jsonl"), "utf8"));
ok("ledger example passes sequence validation", validateRouteLedger(corpus).valid);
const demoCorpus = parseRouteRecords(readFileSync(join(root, "examples/can-auto-routing-prove-it.route.jsonl"), "utf8"));
ok("Auto Routing demo fixture is conformant and explicitly illustrative", validateRouteLedger(demoCorpus).valid && demoCorpus.every((record) => record.extensions?.demo_fixture === "illustrative-only"));
const demoSeeds = JSON.parse(readFileSync(join(root, "examples/can-auto-routing-prove-it.tasks.json"), "utf8"));
ok("Auto Routing demo defines ten grounded task seeds", Array.isArray(demoSeeds.seeds) && demoSeeds.seeds.length === 10);
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
