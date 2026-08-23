// `ot route` command family. Parsing stays intentionally small and dependency
// free so receipts work in the same airlocked environments as OpenTrajectory.
import { readFileSync, writeFileSync } from "node:fs";
import { fromLiteLLMRoute, fromOpenRouterRoute } from "./route-adapters.js";
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

const HELP = `AgentRoute — auditable model-routing receipts
  ot route record <decision.json> [-o receipt.route.json | --ledger routes.route.jsonl] [--force]
  ot route observe <routes.route.jsonl> --route-id ID --status STATUS [--latency-ms N] [--cost-usd N] [--quality N]
  ot route validate <receipt.route.json|routes.route.jsonl>
  ot route explain <receipt.route.json|routes.route.jsonl> [--route-id ID]
  ot route replay <routes.route.jsonl> [-o report.json]
  ot route simulate <routes.route.jsonl> --policy policy.json [-o report.json]
  ot route to-otel <receipt.route.json|routes.route.jsonl> [--route-id ID] [-o traces.json]
  ot route import <openrouter|litellm> <event.json> [-o receipt.route.json] [--complete-candidates]

STATUS: success | failure | partial | cancelled | unknown`;

export function runRouteCli(args: string[]): void {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP + "\n");
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
