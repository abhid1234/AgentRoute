import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProofArtifact, ProofManifest, ProofVerification } from "./proof-pack.js";
import { verifyProofPack } from "./proof-pack.js";

export interface ProofDiffSummary {
  root_sha256: string;
  artifact_count: number;
  generator_version: string;
  claim_scope: string;
  evidence_label: string;
  dossier_verdict: string | null;
  operations_status: string | null;
  timeline_status: string | null;
  connector_count: number | null;
}

export interface ProofArtifactRef {
  path: string;
  sha256: string;
}

export interface ProofArtifactModification {
  path: string;
  baseline_sha256: string;
  current_sha256: string;
}

export interface ProofSemanticChange {
  field: "connector_count" | "dossier_verdict" | "operations_status" | "timeline_status";
  baseline: string | number | null;
  current: string | number | null;
}

export interface ProofDiff {
  proof_diff_version: "0.1";
  status: "unchanged" | "changed";
  baseline: ProofDiffSummary;
  current: ProofDiffSummary;
  artifacts: {
    added: ProofArtifactRef[];
    removed: ProofArtifactRef[];
    modified: ProofArtifactModification[];
  };
  semantics: ProofSemanticChange[];
}

interface VerifiedProof {
  manifest: ProofManifest;
  verification: ProofVerification & { root_sha256: string };
}

function readVerifiedProof(directory: string, label: "baseline" | "current"): VerifiedProof {
  const verification = verifyProofPack(directory);
  if (!verification.valid || !verification.root_sha256) {
    throw new Error(`${label} proof pack is invalid: ${verification.errors.join("; ") || "missing verified root"}`);
  }
  const manifest = JSON.parse(readFileSync(join(directory, "proof-manifest.json"), "utf8")) as ProofManifest;
  const afterRead = verifyProofPack(directory);
  if (!afterRead.valid || afterRead.root_sha256 !== verification.root_sha256 || manifest.root_sha256 !== verification.root_sha256) {
    throw new Error(`${label} proof pack changed while it was being compared`);
  }
  return { manifest, verification: verification as ProofVerification & { root_sha256: string } };
}

function summarize(proof: VerifiedProof): ProofDiffSummary {
  return {
    root_sha256: proof.verification.root_sha256,
    artifact_count: proof.verification.artifact_count,
    generator_version: proof.manifest.generator.version,
    claim_scope: proof.manifest.claim_scope,
    evidence_label: proof.manifest.evidence_label,
    dossier_verdict: proof.verification.dossier_verdict ?? null,
    operations_status: proof.verification.operations_status ?? null,
    timeline_status: proof.verification.timeline_status ?? null,
    connector_count: proof.verification.connector_count ?? null,
  };
}

function artifactMap(artifacts: ProofArtifact[]): Map<string, ProofArtifact> {
  return new Map(artifacts.map((artifact) => [artifact.path, artifact]));
}

export function compareProofPacks(baselineDirectory: string, currentDirectory: string): ProofDiff {
  const baselineProof = readVerifiedProof(baselineDirectory, "baseline");
  const currentProof = readVerifiedProof(currentDirectory, "current");
  const baselineArtifacts = artifactMap(baselineProof.manifest.artifacts);
  const currentArtifacts = artifactMap(currentProof.manifest.artifacts);
  const paths = [...new Set([...baselineArtifacts.keys(), ...currentArtifacts.keys()])].sort();
  const added: ProofArtifactRef[] = [];
  const removed: ProofArtifactRef[] = [];
  const modified: ProofArtifactModification[] = [];
  for (const path of paths) {
    const baseline = baselineArtifacts.get(path);
    const current = currentArtifacts.get(path);
    if (!baseline && current) added.push({ path, sha256: current.sha256 });
    else if (baseline && !current) removed.push({ path, sha256: baseline.sha256 });
    else if (baseline && current && baseline.sha256 !== current.sha256) modified.push({ path, baseline_sha256: baseline.sha256, current_sha256: current.sha256 });
  }

  const baseline = summarize(baselineProof);
  const current = summarize(currentProof);
  const semanticFields = ["connector_count", "dossier_verdict", "operations_status", "timeline_status"] as const;
  const semantics: ProofSemanticChange[] = semanticFields.flatMap((field) => baseline[field] === current[field] ? [] : [{ field, baseline: baseline[field], current: current[field] }]);
  const changed = baseline.root_sha256 !== current.root_sha256 || added.length > 0 || removed.length > 0 || modified.length > 0 || semantics.length > 0;
  return {
    proof_diff_version: "0.1",
    status: changed ? "changed" : "unchanged",
    baseline,
    current,
    artifacts: { added, removed, modified },
    semantics,
  };
}

function escapeWorkflowData(value: unknown): string {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function annotation(level: "notice" | "warning", message: string): string {
  return `::${level}::${escapeWorkflowData(message)}`;
}

export function formatGitHubProofDiff(diff: ProofDiff): string {
  if (diff.status === "unchanged") {
    return annotation("notice", `AgentRoute proof unchanged: ${diff.current.root_sha256}; ${diff.current.artifact_count} artifacts`);
  }
  const lines = [annotation("warning", `AgentRoute proof changed: ${diff.baseline.root_sha256} -> ${diff.current.root_sha256}`)];
  for (const artifact of diff.artifacts.added) lines.push(annotation("warning", `Added proof artifact: ${artifact.path} (${artifact.sha256})`));
  for (const artifact of diff.artifacts.removed) lines.push(annotation("warning", `Removed proof artifact: ${artifact.path} (${artifact.sha256})`));
  for (const artifact of diff.artifacts.modified) lines.push(annotation("warning", `Modified proof artifact: ${artifact.path} (${artifact.baseline_sha256} -> ${artifact.current_sha256})`));
  for (const change of diff.semantics) lines.push(annotation("warning", `Proof summary changed: ${change.field} (${change.baseline ?? "none"} -> ${change.current ?? "none"})`));
  return lines.join("\n");
}
