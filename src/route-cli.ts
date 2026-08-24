// `ot route` command family. Parsing stays intentionally small and dependency
// free so receipts work in the same airlocked environments as OpenTrajectory.
import { readFileSync, writeFileSync } from "node:fs";
import { formatConnectorCatalog, isConnectorCapability, isConnectorRole, isConnectorStatus, listConnectors } from "./connectors.js";
import type { ConnectorFilters } from "./connectors.js";
import { evaluationToObservation } from "./evaluation.js";
import { writeDecisionLab } from "./decision-lab.js";
import { captureOpenRouter } from "./openrouter-capture.js";
import { fromLiteLLMRoute, fromOpenRouterRoute } from "./route-adapters.js";
import { auditRouteRecords } from "./route-audit.js";
import { formatRouteReport } from "./route-report.js";
import { routeToOtel } from "./route-to-otel.js";
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
  ot route validate <receipt.route.json|routes.route.jsonl>
  ot route explain <receipt.route.json|routes.route.jsonl> [--route-id ID]
  ot route replay <routes.route.jsonl> [-o report.json]
  ot route simulate <routes.route.jsonl> --policy policy.json [-o report.json]
  ar report <routes.route.jsonl> [--route-id ID] [-o report.txt]
  ar audit <routes.route.jsonl> [-o audit.json]
  ar lab <routes.route.jsonl> -o decision-lab.html
  ar connectors [--json] [--status available|planned] [--role ROLE] [--capability CAPABILITY]
  ar task-pack exa <seeds.json> [-o task-pack.json]
  ot route to-otel <receipt.route.json|routes.route.jsonl> [--route-id ID] [-o traces.json]
  ot route import <openrouter|litellm> <event.json> [-o receipt.route.json] [--complete-candidates]

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
    const input = rest[0];
    const ledger = option(rest, "--ledger");
    if (!input || !ledger) throw new Error("usage: ar evaluate <evaluation.json> --ledger routes.route.jsonl");
    const draft = JSON.parse(readFileSync(input, "utf8")) as EvaluationDraft;
    const state = foldRouteRecords(loadRouteRecords(ledger)).get(draft.route_id);
    if (!state) throw new Error(`route_id not found: ${draft.route_id}`);
    const observation = evaluationToObservation(draft, state.latest_observation?.outcome);
    console.error(`${appendRouteRecord(ledger, observation)} ${observation.observation_id} -> ${ledger}`);
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

  if (command === "lab") {
    const input = rest[0];
    const output = option(rest, "-o", "--out");
    if (!input || !output) throw new Error("usage: ar lab <routes.route.jsonl> -o decision-lab.html");
    writeDecisionLab(output, loadRouteRecords(input));
    console.error(`wrote AgentRoute Decision Lab -> ${output}`);
    return;
  }

  if (command === "connectors") {
    const status = option(rest, "--status");
    const role = option(rest, "--role");
    const capability = option(rest, "--capability");
    const filters: ConnectorFilters = {};
    if (status) {
      if (!isConnectorStatus(status)) throw new Error("--status must be available or planned");
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

  if (command === "task-pack") {
    const [source, input] = rest;
    if (source !== "exa" || !input) throw new Error("usage: ar task-pack exa <seeds.json> [-o task-pack.json]");
    const raw = JSON.parse(readFileSync(input, "utf8")) as unknown;
    const seeds = (Array.isArray(raw) ? raw : (raw as { seeds?: unknown }).seeds) as TaskSeed[];
    const pack = await createExaTaskPack({ apiKey: process.env.EXA_API_KEY || "", seeds });
    emit(pack, option(rest, "-o", "--out"));
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
    if (!source || !input || !["openrouter", "litellm"].includes(source)) {
      throw new Error("usage: ot route import <openrouter|litellm> <event.json> [-o receipt.route.json]");
    }
    const event = JSON.parse(readFileSync(input, "utf8"));
    const options = {
      ...(option(rest, "--route-id") ? { routeId: option(rest, "--route-id") } : {}),
      ...(option(rest, "--task-type") ? { taskType: option(rest, "--task-type") } : {}),
      ...(option(rest, "--reason") ? { reason: option(rest, "--reason") } : {}),
      completeCandidateSet: rest.includes("--complete-candidates"),
    };
    const decision = source === "openrouter" ? fromOpenRouterRoute(event, options) : fromLiteLLMRoute(event, options);
    const output = option(rest, "-o", "--out");
    if (output) console.error(`${writeRouteDecision(output, decision, rest.includes("--force"))} ${decision.route_id} -> ${output}`);
    else emit(decision);
    return;
  }

  throw new Error(HELP);
}
