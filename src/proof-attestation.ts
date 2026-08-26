import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256 } from "./canonical.js";
import { verifyProofPack } from "./proof-pack.js";
import type { ProofManifest } from "./proof-pack.js";

export interface ProofAttestationSubject {
  format: "agentroute-proof-pack";
  proof_version: "0.1";
  root_sha256: string;
  artifact_count: number;
  generated_at: string;
  evidence_label: "illustrative";
  claim_scope: "offline_conformance";
  generator: { name: "agentroute"; version: string };
}

export interface ProofAttestation {
  attestation_version: "0.1";
  algorithm: "ed25519";
  subject: ProofAttestationSubject;
  public_key_pem: string;
  public_key_fingerprint: string;
  signature_base64: string;
}

export interface ProofAttestationVerificationOptions {
  public_key_pem?: string;
}

export interface ProofAttestationVerification {
  valid: boolean;
  errors: string[];
  warnings: string[];
  proof_valid: boolean;
  root_sha256?: string;
  artifact_count: number;
  signature_valid?: boolean;
  signature_trusted?: boolean;
  public_key_fingerprint?: string;
}

const TOP_LEVEL_KEYS = new Set(["attestation_version", "algorithm", "subject", "public_key_pem", "public_key_fingerprint", "signature_base64"]);
const SUBJECT_KEYS = new Set(["format", "proof_version", "root_sha256", "artifact_count", "generated_at", "evidence_label", "claim_scope", "generator"]);
const GENERATOR_KEYS = new Set(["name", "version"]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ED25519_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, label: string, errors: string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) errors.push(`${label} contains unknown keys: ${unknown.sort().join(", ")}`);
}

function normalizedPublicKey(value: string | ReturnType<typeof createPrivateKey>): string {
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("proof attestation key must be Ed25519");
  return key.export({ type: "spki", format: "pem" });
}

function signingMessage(subject: ProofAttestationSubject): Uint8Array {
  return Buffer.from(`AgentRoute proof attestation 0.1\n${canonicalJson(subject)}`, "utf8");
}

function loadManifest(path: string): ProofManifest {
  return JSON.parse(readFileSync(join(path, "proof-manifest.json"), "utf8")) as ProofManifest;
}

function subjectFromManifest(manifest: ProofManifest): ProofAttestationSubject {
  return {
    format: "agentroute-proof-pack",
    proof_version: manifest.proof_version,
    root_sha256: manifest.root_sha256,
    artifact_count: manifest.artifacts.length,
    generated_at: manifest.generated_at,
    evidence_label: manifest.evidence_label,
    claim_scope: manifest.claim_scope,
    generator: { ...manifest.generator },
  };
}

function validateAttestationShape(value: unknown, errors: string[]): value is ProofAttestation {
  const initialErrorCount = errors.length;
  if (!object(value)) {
    errors.push("proof attestation must be an object");
    return false;
  }
  rejectUnknown(value, TOP_LEVEL_KEYS, "proof attestation", errors);
  if (value.attestation_version !== "0.1") errors.push("proof attestation_version must equal 0.1");
  if (value.algorithm !== "ed25519") errors.push("proof attestation algorithm must equal ed25519");
  if (!object(value.subject)) {
    errors.push("proof attestation subject must be an object");
  } else {
    rejectUnknown(value.subject, SUBJECT_KEYS, "proof attestation subject", errors);
    if (value.subject.format !== "agentroute-proof-pack") errors.push("proof attestation subject format is invalid");
    if (value.subject.proof_version !== "0.1") errors.push("proof attestation subject proof_version must equal 0.1");
    if (typeof value.subject.root_sha256 !== "string" || !SHA256.test(value.subject.root_sha256)) errors.push("proof attestation subject root_sha256 is invalid");
    if (!Number.isSafeInteger(value.subject.artifact_count) || (value.subject.artifact_count as number) < 1) errors.push("proof attestation subject artifact_count must be a positive safe integer");
    if (typeof value.subject.generated_at !== "string" || Number.isNaN(Date.parse(value.subject.generated_at))) errors.push("proof attestation subject generated_at must be an RFC3339 timestamp");
    if (value.subject.evidence_label !== "illustrative") errors.push("proof attestation subject evidence_label must equal illustrative");
    if (value.subject.claim_scope !== "offline_conformance") errors.push("proof attestation subject claim_scope must equal offline_conformance");
    if (!object(value.subject.generator)) {
      errors.push("proof attestation subject generator must be an object");
    } else {
      rejectUnknown(value.subject.generator, GENERATOR_KEYS, "proof attestation subject generator", errors);
      if (value.subject.generator.name !== "agentroute" || typeof value.subject.generator.version !== "string" || !value.subject.generator.version) errors.push("proof attestation subject generator is invalid");
    }
  }
  if (typeof value.public_key_pem !== "string" || !value.public_key_pem) errors.push("proof attestation public key is missing");
  if (typeof value.public_key_fingerprint !== "string" || !SHA256.test(value.public_key_fingerprint)) errors.push("proof attestation public key fingerprint is invalid");
  if (typeof value.signature_base64 !== "string" || !ED25519_SIGNATURE.test(value.signature_base64)) errors.push("proof attestation Ed25519 signature encoding is invalid");
  return errors.length === initialErrorCount;
}

export function signProofPack(path: string, privateKeyPem: string): ProofAttestation {
  const proof = verifyProofPack(path);
  if (!proof.valid) throw new Error(`cannot sign invalid AgentRoute proof pack:\n  - ${proof.errors.join("\n  - ")}`);
  const manifest = loadManifest(path);
  const subject = subjectFromManifest(manifest);
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("proof attestation private key must be Ed25519");
  const publicKeyPem = normalizedPublicKey(privateKey);
  return {
    attestation_version: "0.1",
    algorithm: "ed25519",
    subject,
    public_key_pem: publicKeyPem,
    public_key_fingerprint: sha256(publicKeyPem),
    signature_base64: cryptoSign(null, signingMessage(subject), privateKey).toString("base64"),
  };
}

export function verifyProofAttestation(path: string, value: unknown, options: ProofAttestationVerificationOptions = {}): ProofAttestationVerification {
  const proof = verifyProofPack(path);
  const errors = proof.errors.map((error) => `proof pack: ${error}`);
  const warnings: string[] = [];
  const shaped = validateAttestationShape(value, errors);
  let signatureValid: boolean | undefined;
  let signatureTrusted: boolean | undefined;
  let fingerprint: string | undefined;
  if (shaped && proof.valid) {
    const manifest = loadManifest(path);
    const expectedSubject = subjectFromManifest(manifest);
    if (canonicalJson(value.subject) !== canonicalJson(expectedSubject)) errors.push("proof attestation subject does not match the proof manifest");
    try {
      const embeddedPublicKey = normalizedPublicKey(value.public_key_pem);
      fingerprint = sha256(embeddedPublicKey);
      if (fingerprint !== value.public_key_fingerprint) errors.push("proof attestation public key fingerprint mismatch");
      let trustedPublicKey: string | undefined;
      if (options.public_key_pem) {
        trustedPublicKey = normalizedPublicKey(options.public_key_pem);
        if (sha256(trustedPublicKey) !== fingerprint) errors.push("proof attestation signer does not match the trusted public key");
      }
      signatureValid = cryptoVerify(null, signingMessage(value.subject), createPublicKey(trustedPublicKey || embeddedPublicKey), Buffer.from(value.signature_base64, "base64"));
      if (!signatureValid) errors.push("proof attestation Ed25519 signature verification failed");
      signatureTrusted = Boolean(trustedPublicKey && signatureValid && sha256(trustedPublicKey) === fingerprint);
      if (!options.public_key_pem && signatureValid) warnings.push("signature is valid but signer identity is untrusted; provide a trusted public key");
    } catch (error) {
      errors.push(`proof attestation signature verification error: ${(error as Error).message}`);
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    proof_valid: proof.valid,
    ...(proof.root_sha256 ? { root_sha256: proof.root_sha256 } : {}),
    artifact_count: proof.artifact_count,
    ...(signatureValid !== undefined ? { signature_valid: signatureValid } : {}),
    ...(signatureTrusted !== undefined ? { signature_trusted: signatureTrusted } : {}),
    ...(fingerprint ? { public_key_fingerprint: fingerprint } : {}),
  };
}

export function writeProofAttestation(path: string, attestation: ProofAttestation): void {
  writeFileSync(path, canonicalJson(attestation) + "\n");
}
