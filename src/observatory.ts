import { watch } from "node:fs";
import { createServer } from "node:http";
import { auditRouteRecords } from "./route-audit.js";
import { buildDecisionLabModel } from "./decision-lab.js";
import { analyzeReplayExperiment } from "./experiment.js";
import { loadRouteRecords, replayRoutes } from "./route.js";

export interface ObservatoryOptions {
  host?: string;
  port?: number;
  allow_remote?: boolean;
  experiment_ledger_path?: string;
}

export interface ObservatoryAddress {
  host: string;
  port: number;
  url: string;
}

export interface ObservatoryHandle {
  address: ObservatoryAddress;
  close(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function buildObservatorySnapshot(ledgerPath: string, generatedAt = new Date().toISOString(), experimentLedgerPath?: string): unknown {
  const records = loadRouteRecords(ledgerPath);
  return {
    observatory_version: "0.1",
    generated_at: generatedAt,
    source: "local-ledger",
    replay: replayRoutes(records, generatedAt),
    audit: auditRouteRecords(records, generatedAt),
    lab: buildDecisionLabModel(records, generatedAt),
    ...(experimentLedgerPath ? { experiment: analyzeReplayExperiment(loadRouteRecords(experimentLedgerPath), { generated_at: generatedAt }) } : {}),
  };
}

export const OBSERVATORY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentRoute Observatory</title><style>
:root{color-scheme:dark;--bg:#08111f;--panel:#101d30;--line:#263a55;--ink:#e8f0fb;--muted:#91a5bf;--green:#65d7a5;--amber:#f2bf66}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#17365c 0,transparent 34%),var(--bg);color:var(--ink);font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
main{max-width:1120px;margin:auto;padding:40px 22px}header{display:flex;justify-content:space-between;align-items:end;gap:20px}.eyebrow{color:var(--green);letter-spacing:.12em;text-transform:uppercase}h1{font-size:clamp(28px,5vw,56px);margin:.15em 0}.status{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin:28px 0}.card{background:rgba(16,29,48,.92);border:1px solid var(--line);border-radius:14px;padding:18px}.metric{font-size:32px}.label{color:var(--muted)}table{width:100%;border-collapse:collapse;background:rgba(16,29,48,.9);border:1px solid var(--line)}th,td{text-align:left;padding:12px;border-bottom:1px solid var(--line)}th{color:var(--muted)}.ok{color:var(--green)}.warn{color:var(--amber)}
</style></head><body><main><header><div><div class="eyebrow">local evidence console</div><h1>Route Observatory</h1></div><div id="status" class="status">Connecting…</div></header><section id="metrics" class="grid"></section><table><thead><tr><th>Route</th><th>Task</th><th>Selected</th><th>Outcome</th><th>Policy ready</th></tr></thead><tbody id="routes"></tbody></table></main>
<script>
const text=(el,value)=>el.textContent=value;
function render(data){const r=data.replay,a=data.audit,l=data.lab;const metrics=[['Decisions',r.decisions],['Observed',r.observed],['Coverage',Math.round(r.observation_coverage*100)+'%'],['Audit grade',a.grade],['Violations',r.policy_violations]];if(data.experiment){metrics.push(['Arena runs',data.experiment.arena_runs],['Paired comparisons',data.experiment.comparisons.length])}const m=document.querySelector('#metrics');m.replaceChildren(...metrics.map(([k,v])=>{const c=document.createElement('div');c.className='card';const n=document.createElement('div');n.className='metric';text(n,String(v));const q=document.createElement('div');q.className='label';text(q,k);c.append(n,q);return c}));const body=document.querySelector('#routes');body.replaceChildren(...l.routes.map(route=>{const tr=document.createElement('tr');const values=[route.route_id,route.task_type,route.selected.provider?route.selected.provider+' / '+route.selected.model:route.selected.model,route.outcome?route.outcome.status:'pending',route.policy_ready?'yes':'no'];values.forEach((v,i)=>{const td=document.createElement('td');text(td,v);if(i===4)td.className=route.policy_ready?'ok':'warn';tr.append(td)});return tr}));text(document.querySelector('#status'),'Updated '+new Date(data.generated_at).toLocaleTimeString())}
async function refresh(){try{const response=await fetch('/api/snapshot',{cache:'no-store'});if(!response.ok)throw new Error(await response.text());render(await response.json())}catch(error){text(document.querySelector('#status'),'Read error: '+error.message)}}
refresh();setInterval(refresh,2000);const stream=new EventSource('/api/events');stream.addEventListener('change',refresh);
</script></body></html>`;

export async function startObservatory(ledgerPath: string, options: ObservatoryOptions = {}): Promise<ObservatoryHandle> {
  const host = options.host || "127.0.0.1";
  const port = options.port ?? 4319;
  if (!LOOPBACK.has(host) && !options.allow_remote) throw new Error(`refusing non-loopback Observatory host ${host}; pass allow_remote explicitly`);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Observatory port must be an integer from 0 to 65535");
  loadRouteRecords(ledgerPath);
  if (options.experiment_ledger_path) analyzeReplayExperiment(loadRouteRecords(options.experiment_ledger_path));
  const streams = new Set<{ write(value: string): void; end(): void }>();
  const server = createServer((request, response) => {
    const path = (request.url || "/").split("?", 1)[0];
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'");
    if (path === "/") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(OBSERVATORY_HTML);
      return;
    }
    if (path === "/api/snapshot") {
      try {
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify(buildObservatorySnapshot(ledgerPath, new Date().toISOString(), options.experiment_ledger_path)));
      } catch (error) {
        response.statusCode = 422;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ error: (error as Error).message }));
      }
      return;
    }
    if (path === "/api/events") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Connection", "keep-alive");
      response.write("event: ready\ndata: {}\n\n");
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    response.statusCode = 404;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "not found" }));
  });
  const notify = (): void => {
    for (const stream of streams) stream.write(`event: change\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  };
  const watchers = [watch(ledgerPath, notify), ...(options.experiment_ledger_path ? [watch(options.experiment_ledger_path, notify)] : [])];
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Observatory did not obtain a TCP address");
  return {
    address: { host, port: address.port, url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}` },
    close: () => new Promise<void>((resolve, reject) => {
      for (const watcher of watchers) watcher.close();
      for (const stream of streams) stream.end();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
