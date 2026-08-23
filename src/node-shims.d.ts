// Minimal ambient declarations for the Node built-ins this SDK uses.
// Vendored so the package type-checks with ZERO external deps (no @types/node)
// on an airlocked machine. Covers only the surface we touch.

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function appendFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function renameSync(oldPath: string, newPath: string): void;
  export function unlinkSync(path: string): void;
}

declare module "node:crypto" {
  interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
  export function randomUUID(): string;
}

declare module "node:path" {
  export function dirname(p: string): string;
  export function join(...parts: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}

declare namespace NodeJS {
  interface ReadStream {
    setEncoding(enc: string): void;
    on(event: "data", cb: (chunk: string) => void): void;
    on(event: "end", cb: () => void): void;
  }
}

declare const process: {
  argv: string[];
  stdin: NodeJS.ReadStream;
  stdout: { write(s: string): void };
  env: Record<string, string | undefined>;
  exit(code?: number): never;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

interface ImportMeta {
  url: string;
}

// Minimal fetch surface (Node 18+ global) used by the judge.
interface _OTResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
declare function fetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<_OTResponse>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function setTimeout(cb: (...args: any[]) => void, ms: number): unknown;
