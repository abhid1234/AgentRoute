// `ot route` command family. Parsing stays intentionally small and dependency
// free so receipts work in the same airlocked environments as OpenTrajectory.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createEvidenceCapsule, loadEvidenceCapsule, renderCapsuleLab, signEvidenceCapsule, verifyEvidenceCapsule, writeEvidenceCapsule } from "./capsule.js";
import { formatConnectorCatalog, isConnectorCapability, isConnectorRole, isConnectorStatus, listConnectors } from "./connectors.js";
import type { ConnectorFilters } from "./connectors.js";
import { NATIVE_RECEIPT_ADAPTER, runConnectorConformance } from "./connector-sdk.js";
import { evaluationToObservation, fromBraintrustEvaluation } from "./evaluation.js";
import { analyzeReplayExperiment } from "./experiment.js";
import { decideReplayExperiment } from "./experiment-protocol.js";
import { writeDecisionLab } from "./decision-lab.js";
import { evaluateRoutingDrift } from "./drift.js";
import type { RoutingDriftConfig } from "./drift.js";
import { analyzeRouteIncidents, renderIncidentReport } from "./incident.js";
import { captureOpenRouter } from "./openrouter-capture.js";
import { startObservatory } from "./observatory.js";
import { compilePolicy, diffPolicies, validatePolicy } from "./policy-registry.js";
import type { PolicyTarget } from "./policy-registry.js";
import { addPolicyToRegistry, initializePolicyRegistry, loadPolicyRegistry, transitionPolicyInRegistry } from "./policy-store.js";
import { createPromotionDossier, loadPromotionDossier, renderPromotionDossier, verifyPromotionDossier, writePromotionDossier } from "./promotion-dossier.js";
import { buildProofPack, verifyProofPack } from "./proof-pack.js";
import type { PolicyStatus } from "./policy-registry.js";
import { evaluateRouteGate, formatGitHubGate } from "./quality-gate.js";
import type { RouteGateConfig } from "./quality-gate.js";
import { fixtureReplayExecutor, runReplayArena } from "./replay-arena.js";
import type { ReplayArenaTask, ReplayFixture } from "./replay-arena.js";
import {
  fromCloudflareAiGatewayRoute,
  fromLiteLLMRoute,
  fromOpenRouterRoute,
  fromPortkeyRoute,
  fromVercelAiGatewayRoute,
  importCloudflareAiGatewayRoute,
  importPortkeyRoute,
  importVercelAiGatewayRoute,
} from "./route-adapters.js";
import { auditRouteRecords } from "./route-audit.js";
import { formatRouteReport } from "./route-report.js";
import { routeToOtel, routeToTelemetry } from "./route-to-otel.js";
import { runRoutingScenario } from "./scenario.js";
import { evaluateRoutingSlo } from "./slo.js";
import type { TelemetryProfile } from "./route-to-otel.js";
import {
  appendRouteRecord,
  createRouteDecision,
  createRouteObservation,
  explainRoute,
  foldRouteRecords,
  loadRouteRecords,
  replayRoutes,
  simulateRoutePolicy,
  writeRouteDecision,
} from "./route.js";
import { assertRouteRecord } from "./route-validate.js";
import { createExaTaskPack } from "./task-pack.js";
import type { EvaluationDraft } from "./evaluation.js";
import type { TaskSeed } from "./task-pack.js";
import type { RouteDecision, RouteOutcomeStatus } from "./route-types.js";
import type { RouteSimulationPolicy } from "./route-types.js";

function option(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0 && args[index + 1]) return args[index + 1];
  }
  return undefined;
}

function numeric(args: string[], ...names: string[]): number | undefined {
  const raw = option(args, ...names);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${names[0]} must be a finite number`);
  return value;
}

function emit(value: unknown, output?: string): void {
  const json = JSON.stringify(value, null, 2) + "\n";
  if (output) writeFileSync(output, json);
  else process.stdout.write(json);
}

function emitText(value: string, output?: string): void {
  const text = value.endsWith("\n") ? value : value + "\n";
  if (output) writeFileSync(output, text);
  else process.stdout.write(text);
}

const HELP = `AgentRoute — auditable model-routing receipts
  ar capture openrouter <request.json> [--ledger routes.route.jsonl | -o capture.json]
  ot route record <decision.json> [-o receipt.route.json | --ledger routes.route.jsonl] [--force]
  ot route observe <routes.route.jsonl> --route-id ID --status STATUS [--latency-ms N] [--cost-usd N] [--quality N]
  ar evaluate <evaluation.json> --ledger routes.route.jsonl
  ar evaluate braintrust <event.json> --ledger routes.route.jsonl [--route-id ID]
  ar ingest <portkey|vercel-ai-gateway|cloudflare-ai-gateway> <event.json> --ledger routes.route.jsonl [--portkey-cost-unit usd|cents]
  ot route validate <receipt.route.json|routes.route.jsonl>
  ot route explain <receipt.route.json|routes.route.jsonl> [--route-id ID]
  ot route replay <routes.route.jsonl> [-o report.json]
  ot route simulate <routes.route.jsonl> --policy policy.json [-o report.json]
  ar report <routes.route.jsonl> [--route-id ID] [-o report.txt]
  ar audit <routes.route.jsonl> [-o audit.json]
  ar drift <baseline.route.jsonl> <current.route.jsonl> --config drift.json [-o report.json]
  ar scenario <routes.route.jsonl> --scenario scenario.json [-o report.json]
  ar incident analyze <routes.route.jsonl> [-o report.json]
  ar incident open <routes.route.jsonl> -o incident-review.html [--force]
  ar slo evaluate <routes.route.jsonl> --config slo.json [-o report.json]
  ar lab <routes.route.jsonl> -o decision-lab.html
  ar arena <routes.route.jsonl> --tasks tasks.json --fixtures outcomes.json --max-requests N --max-cost-usd N [--ledger replay.route.jsonl] [-o report.json]
  ar serve <routes.route.jsonl> [--experiment-ledger replay.route.jsonl] [--host 127.0.0.1] [--port 4319] [--allow-remote]
  ar experiment analyze <replay.route.jsonl> [--baseline-candidate ID] [--challenger ID] [--quality-tie-tolerance N]
  ar experiment decide <replay.route.jsonl> --protocol protocol.json [-o decision.json]
  ar gate <current.route.jsonl> --baseline baseline.route.jsonl --config gate.json [--format json|github]
  ar policy validate <policy.json>
  ar policy diff <old-policy.json> <new-policy.json>
  ar policy compile <policy.json> --target <native|openrouter|litellm|portkey|vercel-ai-gateway> [-o config.json]
  ar policy registry init <registry.json> [--force]
  ar policy registry add <registry.json> <policy.json> --actor ID --reason TEXT
  ar policy registry list <registry.json>
  ar policy registry transition <registry.json> <id@version> --to STATUS --actor ID --reason TEXT [--human-approved]
  ar promotion create <replay.route.jsonl> --protocol protocol.json --policy policy.json --baseline baseline.route.jsonl --current current.route.jsonl --gate gate.json --target TARGET -o review.arpromote
  ar promotion verify <review.arpromote>
  ar promotion open <review.arpromote> -o review.html
  ar proof run --out proof-pack [--force]
  ar proof verify <proof-pack>
  ar capsule create <routes.route.jsonl> -o evidence.arcap [--policy policy.json]
  ar capsule verify <evidence.arcap> [--require-signature] [--public-key public.pem]
  ar capsule sign <evidence.arcap> --private-key private.pem -o signed.arcap
  ar capsule open <evidence.arcap> -o decision-lab.html
  ar connectors [--json] [--status available|partial|planned] [--role ROLE] [--capability CAPABILITY]
  ar connector test native-receipt <receipt.route.json|routes.route.jsonl> [--forbid MARKER]
  ar task-pack exa <seeds.json> [-o task-pack.json]
  ar export <otel-genai|openinference> <receipt.route.json|routes.route.jsonl> [--route-id ID] [-o traces.json]
  ot route to-otel <receipt.route.json|routes.route.jsonl> [--route-id ID] [-o traces.json]
  ot route import <openrouter|litellm|portkey|vercel-ai-gateway|cloudflare-ai-gateway> <event.json> [-o receipt.route.json] [--complete-candidates]

STATUS: success | failure | partial | cancelled | unknown`;

export async function runRouteCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP + "\n");
    return;
  }

  if (command === "capture") {
    const [source, input] = rest;
    if (source !== "openrouter" || !input) {
      throw new Error("usage: ar capture openrouter <request.json> [--ledger routes.route.jsonl | -o capture.json]");
    }
    const ledger = option(rest, "--ledger");
    const output = option(rest, "-o", "--out");
    if (ledger && output) throw new Error("choose either --ledger or --out, not both");
    const request = JSON.parse(readFileSync(input, "utf8")) as Record<string, unknown>;
    const result = await captureOpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY || "",
      request,
      ...(option(rest, "--route-id") ? { routeId: option(rest, "--route-id") } : {}),
      ...(option(rest, "--task-type") ? { taskType: option(rest, "--task-type") } : {}),
      ...(option(rest, "--task-fingerprint") ? { taskFingerprint: option(rest, "--task-fingerprint") } : {}),
    });
    if (ledger) {
      console.error(`${appendRouteRecord(ledger, result.decision)} ${result.decision.route_id} -> ${ledger}`);
      console.error(`${appendRouteRecord(ledger, result.observation)} ${result.observation.observation_id} -> ${ledger}`);
    } else emit([result.decision, result.observation], output);
    return;
  }

  if (command === "record") {
    const input = rest[0];
    if (!input) throw new Error("usage: ot route record <decision.json> [-o receipt.route.json | --ledger routes.route.jsonl]");
    const raw = JSON.parse(readFileSync(input, "utf8")) as Record<string, unknown>;
    const decision = raw.route_version
      ? assertRouteRecord(raw) as RouteDecision
      : createRouteDecision(raw as unknown as Parameters<typeof createRouteDecision>[0]);
    if (decision.record_type !== "decision") throw new Error("route record accepts a decision, not an observation");
    const ledger = option(rest, "--ledger");
    const output = option(rest, "-o", "--out");
    if (ledger && output) throw new Error("choose either --ledger or --out, not both");
    if (ledger) console.error(`${appendRouteRecord(ledger, decision)} ${decision.route_id} -> ${ledger}`);
    else if (output) console.error(`${writeRouteDecision(output, decision, rest.includes("--force"))} ${decision.route_id} -> ${output}`);
    else emit(decision);
    return;
  }

  if (command === "observe") {
    const ledger = rest[0];
    const routeId = option(rest, "--route-id");
    const status = option(rest, "--status") as RouteOutcomeStatus | undefined;
    if (!ledger || !routeId || !status) throw new Error("usage: ot route observe <routes.route.jsonl> --route-id ID --status STATUS");
    const observation = createRouteObservation({
      route_id: routeId,
      ...(option(rest, "--observation-id") ? { observation_id: option(rest, "--observation-id") } : {}),
      ...(option(rest, "--observed-at") ? { observed_at: option(rest, "--observed-at") } : {}),
      outcome: {
        status,
        ...(option(rest, "--actual-model") ? { actual_model: option(rest, "--actual-model") } : {}),
        ...(option(rest, "--actual-provider") ? { actual_provider: option(rest, "--actual-provider") } : {}),
        ...(numeric(rest, "--latency-ms") !== undefined ? { latency_ms: numeric(rest, "--latency-ms") } : {}),
        ...(numeric(rest, "--cost-usd") !== undefined ? { cost_usd: numeric(rest, "--cost-usd") } : {}),
        ...(numeric(rest, "--quality") !== undefined ? { quality: numeric(rest, "--quality") } : {}),
        ...(option(rest, "--trajectory-ref") ? { trajectory_ref: option(rest, "--trajectory-ref") } : {}),
        ...(option(rest, "--error") ? { error: option(rest, "--error") } : {}),
      },
    });
    console.error(`${appendRouteRecord(ledger, observation)} ${observation.observation_id} -> ${ledger}`);
    return;
  }

  if (command === "evaluate") {
    const source = rest[0] === "braintrust" ? "braintrust" : undefined;
    const input = source ? rest[1] : rest[0];
    const ledger = option(rest, "--ledger");
    if (!input || !ledger) throw new Error("usage: ar evaluate <evaluation.json> --ledger routes.route.jsonl");
    const event = JSON.parse(readFileSync(input, "utf8")) as unknown;
    const draft = source === "braintrust" ? fromBraintrustEvaluation(event, {
      ...(option(rest, "--route-id") ? { routeId: option(rest, "--route-id") } : {}),
      ...(option(rest, "--evaluator-id") ? { evaluatorId: option(rest, "--evaluator-id") } : {}),
      ...(option(rest, "--evaluator-version") ? { evaluatorVersion: option(rest, "--evaluator-version") } : {}),
      ...(numeric(rest, "--pass-threshold") !== undefined ? { passThreshold: numeric(rest, "--pass-threshold") } : {}),
    }) : event as EvaluationDraft;
    const state = foldRouteRecords(loadRouteRecords(ledger)).get(draft.route_id);
    if (!state) throw new Error(`route_id not found: ${draft.route_id}`);
    const observation = evaluationToObservation(draft, state.latest_observation?.outcome);
    console.error(`${appendRouteRecord(ledger, observation)} ${observation.observation_id} -> ${ledger}`);
    return;
  }

  if (command === "ingest") {
    const [source, input] = rest;
    const ledger = option(rest, "--ledger");
    if (!source || !input || !ledger || !["portkey", "vercel-ai-gateway", "cloudflare-ai-gateway"].includes(source)) {
      throw new Error("usage: ar ingest <portkey|vercel-ai-gateway|cloudflare-ai-gateway> <event.json> --ledger routes.route.jsonl");
    }
    const event = JSON.parse(readFileSync(input, "utf8"));
    const portkeyCostUnit = option(rest, "--portkey-cost-unit");
    if (portkeyCostUnit && !["usd", "cents"].includes(portkeyCostUnit)) throw new Error("--portkey-cost-unit must be usd or cents");
    const options = {
      ...(option(rest, "--route-id") ? { routeId: option(rest, "--route-id") } : {}),
      ...(option(rest, "--task-type") ? { taskType: option(rest, "--task-type") } : {}),
      ...(option(rest, "--reason") ? { reason: option(rest, "--reason") } : {}),
      completeCandidateSet: rest.includes("--complete-candidates"),
      ...(portkeyCostUnit ? { portkeyCostUnit: portkeyCostUnit as "usd" | "cents" } : {}),
    };
    const imported = source === "portkey" ? importPortkeyRoute(event, options)
      : source === "vercel-ai-gateway" ? importVercelAiGatewayRoute(event, options)
        : importCloudflareAiGatewayRoute(event, options);
    console.error(`${appendRouteRecord(ledger, imported.decision)} ${imported.decision.route_id} -> ${ledger}`);
    if (imported.observation) console.error(`${appendRouteRecord(ledger, imported.observation)} ${imported.observation.observation_id} -> ${ledger}`);
    return;
  }

  if (command === "validate") {
    const input = rest[0];
    if (!input) throw new Error("usage: ot route validate <receipt.route.json|routes.route.jsonl>");
    const records = loadRouteRecords(input);
    console.error(`✓ ${records.length} AgentRoute record${records.length === 1 ? "" : "s"} conformant`);
    return;
  }

  if (command === "explain") {
    const input = rest[0];
    if (!input) throw new Error("usage: ot route explain <receipt.route.json|routes.route.jsonl> [--route-id ID]");
    const states = foldRouteRecords(loadRouteRecords(input));
    const requested = option(rest, "--route-id");
    if (requested && !states.has(requested)) throw new Error(`route_id not found: ${requested}`);
    const selected = requested ? [states.get(requested)!] : [...states.values()];
    process.stdout.write(selected.map(explainRoute).join("\n\n") + "\n");
    return;
  }

  if (command === "replay") {
    const input = rest[0];
    if (!input) throw new Error("usage: ot route replay <routes.route.jsonl> [-o report.json]");
    emit(replayRoutes(loadRouteRecords(input)), option(rest, "-o", "--out"));
    return;
  }

  if (command === "simulate") {
    const input = rest[0];
    const policyPath = option(rest, "--policy");
    if (!input || !policyPath) throw new Error("usage: ot route simulate <routes.route.jsonl> --policy policy.json [-o report.json]");
    const policy = JSON.parse(readFileSync(policyPath, "utf8")) as RouteSimulationPolicy;
    emit(simulateRoutePolicy(loadRouteRecords(input), policy), option(rest, "-o", "--out"));
    return;
  }

  if (command === "report") {
    const input = rest[0];
    if (!input) throw new Error("usage: ar report <routes.route.jsonl> [--route-id ID] [-o report.txt]");
    emitText(formatRouteReport(loadRouteRecords(input), option(rest, "--route-id")), option(rest, "-o", "--out"));
    return;
  }

  if (command === "audit") {
    const input = rest[0];
    if (!input) throw new Error("usage: ar audit <routes.route.jsonl> [-o audit.json]");
    emit(auditRouteRecords(loadRouteRecords(input)), option(rest, "-o", "--out"));
    return;
  }

  if (command === "drift") {
    const [baseline, current] = rest;
    const configPath = option(rest, "--config");
    if (!baseline || !current || !configPath) throw new Error("usage: ar drift <baseline.route.jsonl> <current.route.jsonl> --config drift.json [-o report.json]");
    const result = evaluateRoutingDrift(
      loadRouteRecords(baseline),
      loadRouteRecords(current),
      JSON.parse(readFileSync(configPath, "utf8")) as RoutingDriftConfig,
    );
    emit(result, option(rest, "-o", "--out"));
    if (result.status === "fail") throw new Error("AgentRoute routing drift check failed");
    return;
  }

  if (command === "scenario") {
    const input = rest[0];
    const scenarioPath = option(rest, "--scenario");
    if (!input || !scenarioPath) throw new Error("usage: ar scenario <routes.route.jsonl> --scenario scenario.json [-o report.json]");
    emit(runRoutingScenario(loadRouteRecords(input), JSON.parse(readFileSync(scenarioPath, "utf8"))), option(rest, "-o", "--out"));
    return;
  }

  if (command === "incident") {
    const [action, input] = rest;
    if (action === "analyze" && input) {
      emit(analyzeRouteIncidents(loadRouteRecords(input)), option(rest, "-o", "--out"));
      return;
    }
    if (action === "open" && input) {
      const output = option(rest, "-o", "--out");
      if (!output) throw new Error("incident open requires -o <incident-review.html>");
      if (existsSync(output) && !rest.includes("--force")) throw new Error(`${output} already exists; pass --force to replace it`);
      writeFileSync(output, renderIncidentReport(analyzeRouteIncidents(loadRouteRecords(input))));
      console.error(`wrote AgentRoute incident review -> ${output}`);
      return;
    }
    throw new Error("usage: ar incident <analyze|open> <routes.route.jsonl> ...");
  }

  if (command === "slo") {
    const [action, input] = rest;
    const configPath = option(rest, "--config");
    if (action !== "evaluate" || !input || !configPath) throw new Error("usage: ar slo evaluate <routes.route.jsonl> --config slo.json [-o report.json]");
    const result = evaluateRoutingSlo(loadRouteRecords(input), JSON.parse(readFileSync(configPath, "utf8")));
    emit(result, option(rest, "-o", "--out"));
    if (result.status === "fail") throw new Error("AgentRoute routing SLO failed");
    return;
  }

  if (command === "lab") {
    const input = rest[0];
    const output = option(rest, "-o", "--out");
    if (!input || !output) throw new Error("usage: ar lab <routes.route.jsonl> -o decision-lab.html");
    writeDecisionLab(output, loadRouteRecords(input));
    console.error(`wrote AgentRoute Decision Lab -> ${output}`);
    return;
  }

  if (command === "arena") {
    const input = rest[0];
    const tasksPath = option(rest, "--tasks");
    const fixturesPath = option(rest, "--fixtures");
    const maxRequests = numeric(rest, "--max-requests");
    const maxCost = numeric(rest, "--max-cost-usd");
    if (!input || !tasksPath || !fixturesPath || maxRequests === undefined || maxCost === undefined) throw new Error("usage: ar arena <routes.route.jsonl> --tasks tasks.json --fixtures outcomes.json --max-requests N --max-cost-usd N");
    const taskValue = JSON.parse(readFileSync(tasksPath, "utf8")) as { tasks?: ReplayArenaTask[] } | ReplayArenaTask[];
    const fixtureValue = JSON.parse(readFileSync(fixturesPath, "utf8")) as { fixtures?: ReplayFixture[] } | ReplayFixture[];
    const tasks = Array.isArray(taskValue) ? taskValue : taskValue.tasks;
    const fixtures = Array.isArray(fixtureValue) ? fixtureValue : fixtureValue.fixtures;
    if (!tasks || !fixtures) throw new Error("arena task and fixture files must contain arrays or {tasks}/{fixtures}");
    const report = await runReplayArena(loadRouteRecords(input), { tasks, limits: { max_requests: maxRequests, max_cost_usd: maxCost }, executor: fixtureReplayExecutor(fixtures) });
    const ledger = option(rest, "--ledger");
    if (ledger) {
      if (existsSync(ledger) && !rest.includes("--force")) throw new Error(`${ledger} already exists; pass --force to replace it`);
      writeFileSync(ledger, report.records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    }
    emit(report, option(rest, "-o", "--out"));
    return;
  }

  if (command === "serve") {
    const input = rest[0];
    if (!input) throw new Error("usage: ar serve <routes.route.jsonl> [--host 127.0.0.1] [--port 4319]");
    const handle = await startObservatory(input, { host: option(rest, "--host"), port: numeric(rest, "--port"), allow_remote: rest.includes("--allow-remote"), experiment_ledger_path: option(rest, "--experiment-ledger") });
    console.error(`AgentRoute Observatory listening at ${handle.address.url}`);
    await new Promise<void>((resolve) => {
      const stop = async (): Promise<void> => { await handle.close(); resolve(); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    return;
  }

  if (command === "experiment") {
    const [action, input] = rest;
    if (action === "analyze" && input) {
      const challengers: string[] = [];
      for (let index = 0; index < rest.length; index++) if (rest[index] === "--challenger" && rest[index + 1]) challengers.push(rest[index + 1]);
      emit(analyzeReplayExperiment(loadRouteRecords(input), {
        ...(option(rest, "--baseline-candidate") ? { baseline_candidate_id: option(rest, "--baseline-candidate") } : {}),
        ...(challengers.length ? { challenger_candidate_ids: challengers } : {}),
        ...(numeric(rest, "--quality-tie-tolerance") !== undefined ? { quality_tie_tolerance: numeric(rest, "--quality-tie-tolerance") } : {}),
      }), option(rest, "-o", "--out"));
      return;
    }
    if (action === "decide" && input) {
      const protocolPath = option(rest, "--protocol");
      if (!protocolPath) throw new Error("experiment decide requires --protocol <protocol.json>");
      const result = decideReplayExperiment(loadRouteRecords(input), JSON.parse(readFileSync(protocolPath, "utf8")));
      emit(result, option(rest, "-o", "--out"));
      if (result.status !== "pass") throw new Error(`AgentRoute experiment decision is ${result.status}`);
      return;
    }
    throw new Error("usage: ar experiment <analyze|decide> ...");
  }

  if (command === "gate") {
    const current = rest[0];
    const baseline = option(rest, "--baseline");
    const configPath = option(rest, "--config");
    if (!current || !baseline || !configPath) throw new Error("usage: ar gate <current.route.jsonl> --baseline baseline.route.jsonl --config gate.json");
    const format = option(rest, "--format") || "json";
    if (!["json", "github"].includes(format)) throw new Error("--format must be json or github");
    const result = evaluateRouteGate(loadRouteRecords(baseline), loadRouteRecords(current), JSON.parse(readFileSync(configPath, "utf8")) as RouteGateConfig);
    if (format === "github") emitText(formatGitHubGate(result), option(rest, "-o", "--out"));
    else emit(result, option(rest, "-o", "--out"));
    if (result.status === "fail") throw new Error("AgentRoute quality gate failed");
    return;
  }

  if (command === "policy") {
    const [action, first, second] = rest;
    if (action === "registry") {
      const registryAction = first;
      const registryPath = second;
      if (registryAction === "init" && registryPath) {
        emit(initializePolicyRegistry(registryPath, rest.includes("--force")));
        return;
      }
      if (registryAction === "add" && registryPath && rest[3]) {
        const actor = option(rest, "--actor");
        const reason = option(rest, "--reason");
        if (!actor || !reason) throw new Error("policy registry add requires --actor and --reason");
        emit(addPolicyToRegistry(registryPath, JSON.parse(readFileSync(rest[3], "utf8")), { actor, reason, ...(option(rest, "--occurred-at") ? { occurred_at: option(rest, "--occurred-at") } : {}) }));
        return;
      }
      if (registryAction === "list" && registryPath) {
        emit(loadPolicyRegistry(registryPath));
        return;
      }
      if (registryAction === "transition" && registryPath && rest[3]) {
        const toStatus = option(rest, "--to") as PolicyStatus | undefined;
        const actor = option(rest, "--actor");
        const reason = option(rest, "--reason");
        if (!toStatus || !actor || !reason) throw new Error("policy registry transition requires --to, --actor, and --reason");
        emit(transitionPolicyInRegistry(registryPath, rest[3], toStatus, { actor, reason, human_attested: rest.includes("--human-approved"), ...(option(rest, "--occurred-at") ? { occurred_at: option(rest, "--occurred-at") } : {}) }));
        return;
      }
      throw new Error("usage: ar policy registry <init|add|list|transition> ...");
    }
    if (action === "validate" && first) {
      const policy = validatePolicy(JSON.parse(readFileSync(first, "utf8")));
      emit({ valid: true, policy_id: policy.id, policy_version: policy.version, status: policy.status }, option(rest, "-o", "--out"));
      return;
    }
    if (action === "diff" && first && second) {
      emit(diffPolicies(JSON.parse(readFileSync(first, "utf8")), JSON.parse(readFileSync(second, "utf8"))), option(rest, "-o", "--out"));
      return;
    }
    if (action === "compile" && first) {
      const target = option(rest, "--target") as PolicyTarget | undefined;
      if (!target) throw new Error("policy compile requires --target");
      emit(compilePolicy(JSON.parse(readFileSync(first, "utf8")), target), option(rest, "-o", "--out"));
      return;
    }
    throw new Error("usage: ar policy <validate|diff|compile> ...");
  }

  if (command === "promotion") {
    const [action, input] = rest;
    if (action === "create" && input) {
      const protocolPath = option(rest, "--protocol");
      const policyPath = option(rest, "--policy");
      const previousPolicyPath = option(rest, "--previous-policy");
      const baselinePath = option(rest, "--baseline");
      const currentPath = option(rest, "--current");
      const gatePath = option(rest, "--gate");
      const output = option(rest, "-o", "--out");
      if (!protocolPath || !policyPath || !baselinePath || !currentPath || !gatePath || !output) throw new Error("promotion create requires --protocol, --policy, --baseline, --current, --gate, and -o");
      if (existsSync(output) && !rest.includes("--force")) throw new Error(`${output} already exists; pass --force to replace it`);
      const targets: PolicyTarget[] = [];
      for (let index = 0; index < rest.length; index++) if (rest[index] === "--target" && rest[index + 1]) targets.push(rest[index + 1] as PolicyTarget);
      const protocol = JSON.parse(readFileSync(protocolPath, "utf8"));
      const decision = decideReplayExperiment(loadRouteRecords(input), protocol);
      const gate = evaluateRouteGate(loadRouteRecords(baselinePath), loadRouteRecords(currentPath), JSON.parse(readFileSync(gatePath, "utf8")) as RouteGateConfig);
      const dossier = createPromotionDossier({
        protocol,
        decision,
        candidate_policy: JSON.parse(readFileSync(policyPath, "utf8")),
        ...(previousPolicyPath ? { previous_policy: JSON.parse(readFileSync(previousPolicyPath, "utf8")) } : {}),
        gate,
        targets,
      });
      writePromotionDossier(output, dossier);
      console.error(`wrote AgentRoute promotion dossier (${dossier.payload.promotion.verdict}) -> ${output}`);
      return;
    }
    if (action === "verify" && input) {
      const result = verifyPromotionDossier(JSON.parse(readFileSync(input, "utf8")));
      emit(result, option(rest, "-o", "--out"));
      if (!result.valid) throw new Error("AgentRoute promotion dossier verification failed");
      return;
    }
    if (action === "open" && input) {
      const output = option(rest, "-o", "--out");
      if (!output) throw new Error("promotion open requires -o <review.html>");
      if (existsSync(output) && !rest.includes("--force")) throw new Error(`${output} already exists; pass --force to replace it`);
      writeFileSync(output, renderPromotionDossier(loadPromotionDossier(input)));
      console.error(`wrote verified AgentRoute promotion review -> ${output}`);
      return;
    }
    throw new Error("usage: ar promotion <create|verify|open> ...");
  }

  if (command === "capsule") {
    const [action, input] = rest;
    if (action === "create" && input) {
      const output = option(rest, "-o", "--out");
      if (!output) throw new Error("capsule create requires -o <evidence.arcap>");
      if (existsSync(output) && !rest.includes("--force")) throw new Error(`${output} already exists; pass --force to replace it`);
      const policyPath = option(rest, "--policy");
      const capsule = createEvidenceCapsule(loadRouteRecords(input), policyPath ? [JSON.parse(readFileSync(policyPath, "utf8"))] : []);
      writeEvidenceCapsule(output, capsule);
      console.error(`wrote AgentRoute evidence capsule -> ${output}`);
      return;
    }
    if (action === "verify" && input) {
      const value = JSON.parse(readFileSync(input, "utf8"));
      const publicKeyPath = option(rest, "--public-key");
      const result = verifyEvidenceCapsule(value, { require_signature: rest.includes("--require-signature"), ...(publicKeyPath ? { public_key_pem: readFileSync(publicKeyPath, "utf8") } : {}) });
      emit(result, option(rest, "-o", "--out"));
      if (!result.valid) throw new Error("AgentRoute evidence capsule verification failed");
      return;
    }
    if (action === "sign" && input) {
      const privateKeyPath = option(rest, "--private-key");
      const output = option(rest, "-o", "--out");
      if (!privateKeyPath || !output) throw new Error("capsule sign requires --private-key and -o <signed.arcap>");
      if (existsSync(output) && !rest.includes("--force")) throw new Error(`${output} already exists; pass --force to replace it`);
      const signed = signEvidenceCapsule(loadEvidenceCapsule(input), readFileSync(privateKeyPath, "utf8"));
      writeEvidenceCapsule(output, signed);
      console.error(`wrote signed AgentRoute evidence capsule -> ${output}`);
      return;
    }
    if (action === "open" && input) {
      const output = option(rest, "-o", "--out");
      if (!output) throw new Error("capsule open requires -o <decision-lab.html>");
      if (existsSync(output) && !rest.includes("--force")) throw new Error(`${output} already exists; pass --force to replace it`);
      writeFileSync(output, renderCapsuleLab(loadEvidenceCapsule(input)));
      console.error(`wrote verified capsule Decision Lab -> ${output}`);
      return;
    }
    throw new Error("usage: ar capsule <create|verify|sign|open> ...");
  }

  if (command === "proof") {
    const [action, input] = rest;
    if (action === "run") {
      const output = option(rest, "--out", "-o");
      if (!output) throw new Error("proof run requires --out <proof-pack-directory>");
      const manifest = await buildProofPack({ output, force: rest.includes("--force") });
      const verification = verifyProofPack(output);
      if (!verification.valid) throw new Error(`generated proof pack failed verification:\n  - ${verification.errors.join("\n  - ")}`);
      emit({ output, root_sha256: manifest.root_sha256, artifact_count: manifest.artifacts.length, dossier_verdict: verification.dossier_verdict });
      return;
    }
    if (action === "verify" && input) {
      const verification = verifyProofPack(input);
      emit(verification, option(rest, "--out", "-o"));
      if (!verification.valid) throw new Error("AgentRoute proof pack verification failed");
      return;
    }
    throw new Error("usage: ar proof <run --out DIRECTORY|verify DIRECTORY>");
  }

  if (command === "connectors") {
    const status = option(rest, "--status");
    const role = option(rest, "--role");
    const capability = option(rest, "--capability");
    const filters: ConnectorFilters = {};
    if (status) {
      if (!isConnectorStatus(status)) throw new Error("--status must be available, partial, or planned");
      filters.status = status;
    }
    if (role) {
      if (!isConnectorRole(role)) throw new Error(`unknown connector role: ${role}`);
      filters.role = role;
    }
    if (capability) {
      if (!isConnectorCapability(capability)) throw new Error(`unknown connector capability: ${capability}`);
      filters.capability = capability;
    }
    const connectors = listConnectors(filters);
    if (rest.includes("--json")) emit(connectors, option(rest, "-o", "--out"));
    else emitText(formatConnectorCatalog(connectors), option(rest, "-o", "--out"));
    return;
  }

  if (command === "connector") {
    const [action, adapterId, input] = rest;
    if (action !== "test" || adapterId !== "native-receipt" || !input) throw new Error("usage: ar connector test native-receipt <receipt.route.json|routes.route.jsonl> [--forbid MARKER]");
    const forbidden: string[] = [];
    for (let index = 0; index < rest.length; index++) if (rest[index] === "--forbid" && rest[index + 1]) forbidden.push(rest[index + 1]);
    const result = await runConnectorConformance(NATIVE_RECEIPT_ADAPTER, [{ name: input, fixture: loadRouteRecords(input), forbidden_markers: forbidden }]);
    emit(result, option(rest, "-o", "--out"));
    if (!result.valid) throw new Error("AgentRoute connector conformance failed");
    return;
  }

  if (command === "task-pack") {
    const [source, input] = rest;
    if (source !== "exa" || !input) throw new Error("usage: ar task-pack exa <seeds.json> [-o task-pack.json]");
    const raw = JSON.parse(readFileSync(input, "utf8")) as unknown;
    const seeds = (Array.isArray(raw) ? raw : (raw as { seeds?: unknown }).seeds) as TaskSeed[];
    const pack = await createExaTaskPack({ apiKey: process.env.EXA_API_KEY || "", seeds });
    emit(pack, option(rest, "-o", "--out"));
    return;
  }

  if (command === "export") {
    const [profileValue, input] = rest;
    if (!input || !["otel-genai", "openinference"].includes(profileValue)) throw new Error("usage: ar export <otel-genai|openinference> <receipt.route.json|routes.route.jsonl> [--route-id ID] [-o traces.json]");
    const states = foldRouteRecords(loadRouteRecords(input));
    const requested = option(rest, "--route-id");
    if (requested && !states.has(requested)) throw new Error(`route_id not found: ${requested}`);
    const selected = requested ? [states.get(requested)!] : [...states.values()];
    const traces = selected.map((state) => routeToTelemetry(state, profileValue as TelemetryProfile));
    emit(traces.length === 1 ? traces[0] : traces, option(rest, "-o", "--out"));
    return;
  }

  if (command === "to-otel") {
    const input = rest[0];
    if (!input) throw new Error("usage: ot route to-otel <receipt.route.json|routes.route.jsonl> [--route-id ID] [-o traces.json]");
    const states = foldRouteRecords(loadRouteRecords(input));
    const requested = option(rest, "--route-id");
    if (requested && !states.has(requested)) throw new Error(`route_id not found: ${requested}`);
    const selected = requested ? [states.get(requested)!] : [...states.values()];
    const traces = selected.map(routeToOtel);
    emit(traces.length === 1 ? traces[0] : traces, option(rest, "-o", "--out"));
    return;
  }

  if (command === "import") {
    const [source, input] = rest;
    const sources = ["openrouter", "litellm", "portkey", "vercel-ai-gateway", "cloudflare-ai-gateway"];
    if (!source || !input || !sources.includes(source)) {
      throw new Error("usage: ot route import <openrouter|litellm|portkey|vercel-ai-gateway|cloudflare-ai-gateway> <event.json> [-o receipt.route.json]");
    }
    const event = JSON.parse(readFileSync(input, "utf8"));
    const options = {
      ...(option(rest, "--route-id") ? { routeId: option(rest, "--route-id") } : {}),
      ...(option(rest, "--task-type") ? { taskType: option(rest, "--task-type") } : {}),
      ...(option(rest, "--reason") ? { reason: option(rest, "--reason") } : {}),
      completeCandidateSet: rest.includes("--complete-candidates"),
    };
    const decision = source === "openrouter" ? fromOpenRouterRoute(event, options)
      : source === "litellm" ? fromLiteLLMRoute(event, options)
        : source === "portkey" ? fromPortkeyRoute(event, options)
          : source === "vercel-ai-gateway" ? fromVercelAiGatewayRoute(event, options)
            : fromCloudflareAiGatewayRoute(event, options);
    const output = option(rest, "-o", "--out");
    if (output) console.error(`${writeRouteDecision(output, decision, rest.includes("--force"))} ${decision.route_id} -> ${output}`);
    else emit(decision);
    return;
  }

  throw new Error(HELP);
}
