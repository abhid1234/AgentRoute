// AgentRoute v0.1 types. Routing receipts are a sibling artifact to .ot.json:
// they record why a model was selected, then append measured observations.

export const ROUTE_VERSION = "0.1";

export type RouteFidelity = "full" | "partial" | "selected-only";
export type RouteSourceKind = "native" | "openrouter" | "litellm" | "custom";

export interface RouteTask {
  type: string;
  description?: string;
  fingerprint?: string;
}

export interface RouteRouter {
  name: string;
  version?: string;
  policy_id?: string;
  policy_version?: string;
}

export interface RouteSource {
  kind: RouteSourceKind | string;
  fidelity: RouteFidelity;
  event_id?: string;
}

export interface CandidateEstimates {
  quality?: number;
  latency_ms?: number;
  cost_usd?: number;
}

export interface CandidateScores {
  overall?: number;
  quality?: number;
  latency?: number;
  cost?: number;
  capability?: number;
  custom?: Record<string, number>;
}

export interface RouteCandidate {
  id: string;
  model: string;
  provider?: string;
  endpoint?: string;
  capabilities?: string[];
  eligible?: boolean;
  ineligible_reasons?: string[];
  estimates?: CandidateEstimates;
  scores?: CandidateScores;
}

export interface RouteCriteria {
  max_cost_usd?: number;
  max_latency_ms?: number;
  min_quality?: number;
  required_capabilities?: string[];
  weights?: {
    quality?: number;
    latency?: number;
    cost?: number;
    capability?: number;
  };
  custom?: Record<string, unknown>;
}

export interface RouteSelection {
  candidate_id: string;
  confidence?: number;
  reason: string;
  constraints_satisfied?: string[];
  tradeoffs?: string[];
  fallback_order?: string[];
}

export interface RouteContext {
  trajectory_id?: string;
  ot_step_ref?: string;
  session_id?: string;
  parent_route_id?: string;
  traceparent?: string;
}

export interface RouteDecision {
  route_version: string;
  record_type: "decision";
  route_id: string;
  created_at: string;
  task: RouteTask;
  router: RouteRouter;
  source: RouteSource;
  candidates: RouteCandidate[];
  criteria?: RouteCriteria;
  selection: RouteSelection;
  context?: RouteContext;
  extensions?: Record<string, unknown>;
}

export type RouteOutcomeStatus = "success" | "failure" | "partial" | "cancelled" | "unknown";

export interface RouteOutcome {
  status: RouteOutcomeStatus;
  actual_model?: string;
  actual_provider?: string;
  latency_ms?: number;
  cost_usd?: number;
  quality?: number;
  trajectory_ref?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface RouteObservation {
  route_version: string;
  record_type: "observation";
  route_id: string;
  observation_id: string;
  observed_at: string;
  outcome: RouteOutcome;
  extensions?: Record<string, unknown>;
}

export type RouteRecord = RouteDecision | RouteObservation;

export interface RouteState {
  decision: RouteDecision;
  observations: RouteObservation[];
  latest_observation?: RouteObservation;
}

export interface RouteModelStats {
  model: string;
  provider?: string;
  selections: number;
  observations: number;
  successes: number;
  success_rate?: number;
  mean_latency_ms?: number;
  mean_cost_usd?: number;
  mean_quality?: number;
}

export interface RouteReplayReport {
  route_version: string;
  generated_at: string;
  decisions: number;
  observed: number;
  observation_coverage: number;
  full_fidelity_decisions: number;
  policy_violations: number;
  predicted_score_gap_mean?: number;
  by_model: RouteModelStats[];
  by_task_type: Record<string, number>;
  warnings: string[];
}

export interface RouteSimulationPolicy {
  id: string;
  version?: string;
  criteria?: RouteCriteria;
  weights: {
    quality?: number;
    latency?: number;
    cost?: number;
    capability?: number;
  };
}

export interface RouteSimulationChoice {
  route_id: string;
  original_candidate_id: string;
  simulated_candidate_id: string;
  changed: boolean;
  predicted_score_delta: number;
}

export interface RouteSimulationReport {
  route_version: string;
  policy_id: string;
  policy_version?: string;
  generated_at: string;
  decisions: number;
  simulated: number;
  changed: number;
  skipped_incomplete_evidence: number;
  skipped_unscorable: number;
  choices: RouteSimulationChoice[];
  warnings: string[];
}
