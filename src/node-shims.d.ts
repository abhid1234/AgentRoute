// Minimal ambient declarations for the Node built-ins this SDK uses.
// Vendored so the package type-checks with ZERO external deps (no @types/node)
// on an airlocked machine. Covers only the surface we touch.

declare module "node:fs" {
  interface FSWatcher { close(): void; }
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function appendFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isFile(): boolean; isDirectory(): boolean };
  export function renameSync(oldPath: string, newPath: string): void;
  export function unlinkSync(path: string): void;
  export function watch(path: string, listener: () => void): FSWatcher;
}

declare module "node:http" {
  interface IncomingMessage {
    url?: string;
    on(event: "close", cb: () => void): void;
  }
  interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    write(value: string): void;
    end(value?: string): void;
  }
  interface AddressInfo { port: number; }
  interface Server {
    once(event: "error", cb: (error: Error) => void): void;
    listen(port: number, host: string, cb: () => void): void;
    address(): AddressInfo | string | null;
    close(cb: (error?: Error) => void): void;
  }
  export function createServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Server;
}

declare module "node:crypto" {
  interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
  export function randomUUID(): string;
  interface KeyObject {
    asymmetricKeyType?: string;
    export(options: { type: "spki"; format: "pem" }): string;
  }
  interface CryptoBuffer {
    toString(encoding: "base64"): string;
  }
  export function createPrivateKey(key: string): KeyObject;
  export function createPublicKey(key: string | KeyObject): KeyObject;
  export function sign(algorithm: null, data: Uint8Array, key: KeyObject): CryptoBuffer;
  export function verify(algorithm: null, data: Uint8Array, key: KeyObject, signature: Uint8Array): boolean;
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
  on(event: "SIGINT" | "SIGTERM", cb: () => void): void;
  exit(code?: number): never;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

interface ImportMeta {
  url: string;
}

declare const Buffer: {
  from(value: string, encoding?: "utf8" | "base64"): Uint8Array;
};

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
