import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "./canonical.js";
import type { AgentRoutePolicy, PolicyRegistry, PolicyRegistryEvent, PolicyStatus } from "./policy-registry.js";
import { validatePolicy, validatePolicyRegistry } from "./policy-registry.js";

export interface PolicyRegistryMutationOptions {
  actor: string;
  reason: string;
  occurred_at?: string;
  human_attested?: boolean;
}

export interface PolicyRegistryMutation {
  change: "appended" | "unchanged";
  registry: PolicyRegistry;
  event: PolicyRegistryEvent;
}

const TRANSITIONS: Record<PolicyStatus, PolicyStatus | undefined> = {
  draft: "reviewed",
  reviewed: "approved",
  approved: "deprecated",
  deprecated: undefined,
};

function mutationOptions(options: PolicyRegistryMutationOptions): Required<Pick<PolicyRegistryMutationOptions, "actor" | "reason">> & Pick<PolicyRegistryMutationOptions, "occurred_at" | "human_attested"> {
  if (!options || typeof options.actor !== "string" || !options.actor.trim()) throw new Error("policy registry mutation requires actor");
  if (typeof options.reason !== "string" || !options.reason.trim()) throw new Error("policy registry mutation requires reason");
  const occurredAt = options.occurred_at || new Date().toISOString();
  if (Number.isNaN(Date.parse(occurredAt))) throw new Error("policy registry occurred_at must be RFC3339");
  return { actor: options.actor.trim(), reason: options.reason.trim(), occurred_at: occurredAt, ...(options.human_attested ? { human_attested: true } : {}) };
}

function eventFor(policy: AgentRoutePolicy, from: PolicyStatus | undefined, options: ReturnType<typeof mutationOptions>): PolicyRegistryEvent {
  const body = { policy_id: policy.id, policy_version: policy.version, from_status: from, to_status: policy.status, actor: options.actor, reason: options.reason, occurred_at: options.occurred_at!, ...(options.human_attested ? { human_attested: true as const } : {}), policy_fingerprint: sha256(policy) };
  return { event_version: "0.1", event_id: `policy_event_${sha256(body).slice(7, 31)}`, ...body };
}

function writeAtomic(path: string, registry: PolicyRegistry): void {
  const validated = validatePolicyRegistry(registry);
  const temporary = join(dirname(path), `.${path.split("/").pop() || "registry"}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, canonicalJson(validated) + "\n");
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function createPolicyRegistry(): PolicyRegistry {
  return { registry_version: "0.1", policies: [], events: [] };
}

export function initializePolicyRegistry(path: string, force = false): PolicyRegistry {
  if (existsSync(path) && !force) throw new Error(`${path} already exists; pass force explicitly to replace it`);
  const registry = createPolicyRegistry();
  writeAtomic(path, registry);
  return registry;
}

export function loadPolicyRegistry(path: string): PolicyRegistry {
  const registry = validatePolicyRegistry(JSON.parse(readFileSync(path, "utf8")));
  for (const policy of registry.policies) {
    const events = (registry.events || []).filter((event) => event.policy_id === policy.id && event.policy_version === policy.version);
    let status: PolicyStatus | undefined;
    for (const event of events) {
      if (event.from_status !== status) throw new Error(`${policy.id}@${policy.version}: registry event status chain is broken`);
      if (status === undefined ? event.to_status !== "draft" : TRANSITIONS[status] !== event.to_status) throw new Error(`${policy.id}@${policy.version}: registry event transition is invalid`);
      if (event.to_status === "approved" && !event.human_attested) throw new Error(`${policy.id}@${policy.version}: approved event lacks human attestation`);
      if (event.policy_fingerprint !== sha256({ ...policy, status: event.to_status })) throw new Error(`${policy.id}@${policy.version}: registry event fingerprint is invalid`);
      status = event.to_status;
    }
    if (events.length && status !== policy.status) throw new Error(`${policy.id}@${policy.version}: registry policy status disagrees with history`);
  }
  return { ...registry, policies: registry.policies.map((policy) => ({ ...policy })), events: (registry.events || []).map((event) => ({ ...event })) };
}

function exactRetry(registry: PolicyRegistry, event: PolicyRegistryEvent): PolicyRegistryEvent | undefined {
  return (registry.events || []).find((existing) => existing.event_id === event.event_id);
}

export function addPolicyToRegistry(path: string, value: unknown, rawOptions: PolicyRegistryMutationOptions): PolicyRegistryMutation {
  const policy = validatePolicy(value);
  if (policy.status !== "draft") throw new Error("new registry policies must start in draft status");
  const options = mutationOptions(rawOptions);
  const registry = loadPolicyRegistry(path);
  const existing = registry.policies.find((item) => item.id === policy.id && item.version === policy.version);
  const event = eventFor(policy, undefined, options);
  if (existing) {
    if (sha256(existing) !== sha256(policy)) throw new Error(`registry already contains conflicting policy ${policy.id}@${policy.version}`);
    const retry = exactRetry(registry, event);
    if (retry) return { change: "unchanged", registry, event: retry };
    throw new Error(`registry already contains policy ${policy.id}@${policy.version} with different provenance`);
  }
  registry.policies.push(policy);
  registry.policies.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
  registry.events = [...(registry.events || []), event];
  writeAtomic(path, registry);
  return { change: "appended", registry, event };
}

export function transitionPolicyInRegistry(path: string, selector: string, toStatus: PolicyStatus, rawOptions: PolicyRegistryMutationOptions): PolicyRegistryMutation {
  const separator = selector.lastIndexOf("@");
  if (separator <= 0 || separator === selector.length - 1) throw new Error("policy selector must be id@version");
  const id = selector.slice(0, separator);
  const version = selector.slice(separator + 1);
  const options = mutationOptions(rawOptions);
  const registry = loadPolicyRegistry(path);
  const index = registry.policies.findIndex((policy) => policy.id === id && policy.version === version);
  if (index < 0) throw new Error(`policy not found: ${selector}`);
  const current = registry.policies[index];
  if (current.status === toStatus) {
    const retry = (registry.events || []).find((event) => event.policy_id === id && event.policy_version === version && event.to_status === toStatus && event.actor === options.actor && event.reason === options.reason && event.occurred_at === options.occurred_at && Boolean(event.human_attested) === Boolean(options.human_attested));
    if (retry) return { change: "unchanged", registry, event: retry };
    throw new Error(`${selector} is already ${toStatus}`);
  }
  if (TRANSITIONS[current.status] !== toStatus) throw new Error(`invalid policy transition ${current.status} -> ${toStatus}`);
  if (toStatus === "approved" && !options.human_attested) throw new Error("approved transition requires explicit human_attested=true");
  const updated = validatePolicy({ ...current, status: toStatus });
  const event = eventFor(updated, current.status, options);
  registry.policies[index] = updated;
  registry.events = [...(registry.events || []), event];
  writeAtomic(path, registry);
  return { change: "appended", registry, event };
}
