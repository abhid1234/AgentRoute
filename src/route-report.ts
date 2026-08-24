import { foldRouteRecords, policyViolations, replayRoutes } from "./route.js";
import type { RouteCandidate, RouteRecord, RouteState } from "./route-types.js";

const metric = (value: number | undefined, suffix = ""): string => value === undefined ? "not measured" : `${value}${suffix}`;
const money = (value: number | undefined): string => value === undefined ? "not measured" : `$${value.toFixed(6)}`;

function candidateLine(candidate: RouteCandidate, selected: boolean): string {
  const estimates = candidate.estimates;
  return `${selected ? "→" : " "} ${candidate.model}${candidate.provider ? ` via ${candidate.provider}` : ""}` +
    ` | predicted quality ${metric(estimates?.quality)}` +
    ` | latency ${metric(estimates?.latency_ms, "ms")}` +
    ` | cost ${money(estimates?.cost_usd)}`;
}

export function formatReceiptDetail(state: RouteState): string {
  const decision = state.decision;
  const selected = decision.candidates.find((candidate) => candidate.id === decision.selection.candidate_id)!;
  const outcome = state.latest_observation?.outcome;
  const violations = policyViolations(decision);
  const lines = [
    `AGENTROUTE RECEIPT ${decision.route_id}`,
    `Decision     ${selected.model}${selected.provider ? ` via ${selected.provider}` : ""}`,
    `Router       ${decision.router.name}${decision.router.policy_id ? ` / ${decision.router.policy_id}` : ""}`,
    `Task         ${decision.task.type}`,
    `Why          ${decision.selection.reason}`,
    `Evidence     ${decision.source.fidelity}`,
    `Outcome      ${outcome ? `${outcome.status} · quality ${metric(outcome.quality)} · ${metric(outcome.latency_ms, "ms")} · ${money(outcome.cost_usd)}` : "pending"}`,
    `Policy       ${violations.length ? violations.join("; ") : "no recorded violation"}`,
    "",
    "CANDIDATES (predicted at routing time)",
    ...decision.candidates.map((candidate) => candidateLine(candidate, candidate.id === selected.id)),
  ];
  if (decision.source.fidelity !== "full") {
    lines.push("", "Caveat: candidate evidence is incomplete; no missing route was ranked or inferred.");
  }
  return lines.join("\n");
}

export function formatRouteReport(records: RouteRecord[], routeId?: string): string {
  const states = foldRouteRecords(records);
  if (routeId && !states.has(routeId)) throw new Error(`route_id not found: ${routeId}`);
  const selected = routeId ? [states.get(routeId)!] : [...states.values()];
  const replay = replayRoutes(records);
  const header = [
    "AGENTROUTE ROUTING REPORT",
    `Decisions ${replay.decisions} · observed ${replay.observed} · coverage ${(replay.observation_coverage * 100).toFixed(1)}%`,
    `Full evidence ${replay.full_fidelity_decisions} · policy violations ${replay.policy_violations}`,
  ].join("\n");
  return `${header}\n\n${selected.map(formatReceiptDetail).join("\n\n")}`;
}
