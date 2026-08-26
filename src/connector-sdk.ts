import { canonicalJson } from "./canonical.js";
import type { AgentRouteConnector, ConnectorCapability, ConnectorRole } from "./connectors.js";
import { CONNECTOR_CAPABILITIES, CONNECTOR_ROLES, CONNECTOR_STATUSES } from "./connectors.js";
import type { RouteRecord } from "./route-types.js";
import { assertRouteRecord, validateRouteLedger } from "./route-validate.js";

export interface ConnectorAdapter<TFixture = unknown> {
  manifest: AgentRouteConnector;
  importFixture(fixture: TFixture): RouteRecord | RouteRecord[] | Promise<RouteRecord | RouteRecord[]>;
}

export interface ConnectorConformanceCase<TFixture = unknown> {
  name: string;
  fixture: TFixture;
  forbidden_markers?: string[];
}

export interface ConnectorConformanceCheck {
  case: string;
  check: "manifest" | "receipt-schema" | "determinism" | "privacy";
  status: "pass" | "fail";
  message: string;
}

export interface ConnectorConformanceResult {
  conformance_version: "0.1";
  connector_id: string;
  valid: boolean;
  checks: ConnectorConformanceCheck[];
  errors: string[];
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function validateConnectorManifest(value: unknown): AgentRouteConnector {
  if (!object(value)) throw new Error("connector manifest must be an object");
  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.id)) throw new Error("connector id must be a lowercase stable identifier");
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("connector name is required");
  if (!(CONNECTOR_STATUSES as readonly unknown[]).includes(value.status)) throw new Error("connector status is invalid");
  if (!Array.isArray(value.roles) || !value.roles.length || value.roles.some((role) => !(CONNECTOR_ROLES as readonly unknown[]).includes(role))) throw new Error("connector roles are invalid");
  if (!Array.isArray(value.capabilities) || !value.capabilities.length || value.capabilities.some((capability) => !(CONNECTOR_CAPABILITIES as readonly unknown[]).includes(capability))) throw new Error("connector capabilities are invalid");
  if (new Set(value.roles).size !== value.roles.length) throw new Error("connector roles must be unique");
  if (new Set(value.capabilities).size !== value.capabilities.length) throw new Error("connector capabilities must be unique");
  if (!['inbound', 'outbound', 'bidirectional'].includes(String(value.direction))) throw new Error("connector direction is invalid");
  for (const key of ["transport", "summary", "docs_url"] as const) if (typeof value[key] !== "string" || !(value[key] as string).trim()) throw new Error(`connector ${key} is required`);
  if (value.capability_status !== undefined) {
    if (!object(value.capability_status)) throw new Error("connector capability_status must be an object");
    for (const [capability, status] of Object.entries(value.capability_status)) {
      if (!(CONNECTOR_CAPABILITIES as readonly string[]).includes(capability) || !value.capabilities.includes(capability as ConnectorCapability) || !["available", "planned"].includes(String(status))) throw new Error("connector capability_status is invalid");
    }
  }
  return value as unknown as AgentRouteConnector;
}

function recordsFrom(value: RouteRecord | RouteRecord[]): RouteRecord[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((record) => assertRouteRecord(record));
}

export async function runConnectorConformance<TFixture>(adapter: ConnectorAdapter<TFixture>, cases: ConnectorConformanceCase<TFixture>[]): Promise<ConnectorConformanceResult> {
  const checks: ConnectorConformanceCheck[] = [];
  const errors: string[] = [];
  let connectorId = "invalid-connector";
  try {
    connectorId = validateConnectorManifest(adapter.manifest).id;
    checks.push({ case: "manifest", check: "manifest", status: "pass", message: "connector manifest uses the registered vocabulary" });
  } catch (error) {
    const message = (error as Error).message;
    checks.push({ case: "manifest", check: "manifest", status: "fail", message });
    errors.push(`manifest: ${message}`);
  }
  if (!Array.isArray(cases) || !cases.length) errors.push("at least one connector conformance case is required");
  for (const testCase of cases || []) {
    if (!testCase.name || typeof testCase.name !== "string") { errors.push("connector conformance case name is required"); continue; }
    try {
      const first = recordsFrom(await adapter.importFixture(testCase.fixture));
      const ledger = validateRouteLedger(first);
      if (!ledger.valid) throw new Error(ledger.errors.join("; "));
      checks.push({ case: testCase.name, check: "receipt-schema", status: "pass", message: `${first.length} conformant record(s)` });
      const second = recordsFrom(await adapter.importFixture(testCase.fixture));
      if (canonicalJson(first) !== canonicalJson(second)) throw new Error("repeated import produced different records");
      checks.push({ case: testCase.name, check: "determinism", status: "pass", message: "repeated import is byte-stable after canonicalization" });
      const serialized = canonicalJson(first).toLowerCase();
      const leaked = (testCase.forbidden_markers || []).filter((marker) => marker && serialized.includes(marker.toLowerCase()));
      if (leaked.length) throw new Error(`serialized records contain forbidden markers: ${leaked.join(", ")}`);
      checks.push({ case: testCase.name, check: "privacy", status: "pass", message: `${testCase.forbidden_markers?.length || 0} forbidden marker(s) excluded` });
    } catch (error) {
      const message = (error as Error).message;
      const check = message.includes("different records") ? "determinism" : message.includes("forbidden markers") ? "privacy" : "receipt-schema";
      checks.push({ case: testCase.name, check, status: "fail", message });
      errors.push(`${testCase.name}: ${message}`);
    }
  }
  return { conformance_version: "0.1", connector_id: connectorId, valid: errors.length === 0, checks, errors };
}

export const NATIVE_RECEIPT_ADAPTER: ConnectorAdapter<unknown> = {
  manifest: {
    id: "native-receipt",
    name: "AgentRoute receipt API",
    status: "available",
    direction: "inbound",
    roles: ["router" as ConnectorRole, "gateway" as ConnectorRole],
    capabilities: ["decision-import"],
    transport: "JSON / JSONL",
    summary: "Reference adapter for already-normalized AgentRoute receipts.",
    docs_url: "./docs/agentroute-spec.md",
  },
  importFixture(fixture: unknown): RouteRecord[] {
    if (!Array.isArray(fixture)) return [assertRouteRecord(fixture)];
    return fixture.map((record) => assertRouteRecord(record));
  },
};
