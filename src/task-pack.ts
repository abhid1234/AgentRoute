import type { FetchLike } from "./openrouter-capture.js";

export interface TaskSeed {
  id: string;
  type: string;
  query: string;
  instructions?: string;
  include_domains?: string[];
  result_count?: number;
  quality_bar?: string[];
}

export interface TaskEvidence {
  title: string;
  url: string;
  published_at?: string;
  highlights: string[];
}

export interface GroundedTask {
  id: string;
  type: string;
  query: string;
  instructions: string;
  quality_bar: string[];
  evidence: TaskEvidence[];
}

export interface TaskPack {
  task_pack_version: "0.1";
  generated_at: string;
  source: "exa";
  tasks: GroundedTask[];
}

export interface ExaTaskPackOptions {
  apiKey: string;
  seeds: TaskSeed[];
  endpoint?: string;
  fetcher?: FetchLike;
  generatedAt?: string;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function validateSeed(seed: TaskSeed, seen: Set<string>): void {
  if (!seed || typeof seed !== "object") throw new Error("task seeds must be objects");
  if (!seed.id || !seed.type || !seed.query) throw new Error("each task seed requires non-empty id, type, and query");
  if (seen.has(seed.id)) throw new Error(`duplicate task seed id: ${seed.id}`);
  seen.add(seed.id);
  if (seed.include_domains && (!Array.isArray(seed.include_domains) || seed.include_domains.some((domain) => typeof domain !== "string" || !domain))) {
    throw new Error(`${seed.id}: include_domains must contain non-empty strings`);
  }
  if (seed.result_count !== undefined && (!Number.isInteger(seed.result_count) || seed.result_count < 1 || seed.result_count > 10)) {
    throw new Error(`${seed.id}: result_count must be an integer from 1 to 10`);
  }
}

/** Build a fresh, source-grounded task pack without storing the Exa key or raw response. */
export async function createExaTaskPack(options: ExaTaskPackOptions): Promise<TaskPack> {
  if (!options.apiKey) throw new Error("EXA_API_KEY is required to build an Exa task pack");
  if (!Array.isArray(options.seeds) || !options.seeds.length) throw new Error("an Exa task pack requires at least one task seed");
  const seen = new Set<string>();
  options.seeds.forEach((seed) => validateSeed(seed, seen));
  const fetcher = options.fetcher || fetch;
  const tasks: GroundedTask[] = [];

  for (const seed of options.seeds) {
    const response = await fetcher(options.endpoint || "https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: seed.query,
        type: "auto",
        numResults: seed.result_count || 5,
        moderation: true,
        ...(seed.include_domains?.length ? { includeDomains: seed.include_domains } : {}),
        contents: { highlights: true },
      }),
    });
    let payload: Record<string, unknown>;
    try { payload = object(JSON.parse(await response.text())); }
    catch { throw new Error(`${seed.id}: Exa returned malformed JSON (${response.status})`); }
    if (!response.ok) {
      const message = typeof payload.error === "string" ? payload.error : "request failed";
      throw new Error(`${seed.id}: Exa request failed (${response.status}): ${message.slice(0, 500)}`);
    }
    const results = Array.isArray(payload.results) ? payload.results : [];
    const evidence = results.flatMap((item) => {
      const result = object(item);
      if (typeof result.url !== "string" || typeof result.title !== "string") return [];
      const highlights = Array.isArray(result.highlights)
        ? result.highlights.filter((highlight): highlight is string => typeof highlight === "string" && highlight.length > 0)
        : [];
      return [{
        title: result.title,
        url: result.url,
        ...(typeof result.publishedDate === "string" ? { published_at: result.publishedDate } : {}),
        highlights,
      }];
    });
    if (!evidence.length) throw new Error(`${seed.id}: Exa returned no usable source evidence`);
    tasks.push({
      id: seed.id,
      type: seed.type,
      query: seed.query,
      instructions: seed.instructions || seed.query,
      quality_bar: seed.quality_bar || ["Answer from the supplied evidence", "Cite the source URLs used"],
      evidence,
    });
  }

  return {
    task_pack_version: "0.1",
    generated_at: options.generatedAt || new Date().toISOString(),
    source: "exa",
    tasks,
  };
}
