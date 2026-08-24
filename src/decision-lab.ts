import { writeFileSync } from "node:fs";
import { auditRouteRecords } from "./route-audit.js";
import { foldRouteRecords } from "./route.js";
import type { RouteCandidate, RouteRecord, RouteState } from "./route-types.js";

export interface DecisionLabCandidate {
  id: string;
  model: string;
  provider?: string;
  selected: boolean;
  eligible: boolean;
  ineligible_reasons: string[];
  estimates: { quality?: number; latency_ms?: number; cost_usd?: number };
  scores: { quality?: number; latency?: number; cost?: number };
}

export interface DecisionLabRoute {
  route_id: string;
  created_at: string;
  task_type: string;
  task_fingerprint?: string;
  router: string;
  strategy?: string;
  fidelity: string;
  requested_model?: string;
  selected: { model: string; provider?: string };
  selection_reason: string;
  outcome?: {
    status: string;
    quality?: number;
    latency_ms?: number;
    cost_usd?: number;
    evaluator?: string;
  };
  attempts: Array<{ provider?: string; model?: string; status?: number }>;
  pipeline: Array<{ type?: string; name?: string; summary?: string }>;
  candidates: DecisionLabCandidate[];
  policy_ready: boolean;
  gaps: Array<{ severity: string; code: string; message: string }>;
}

export interface DecisionLabModel {
  lab_version: "0.1";
  generated_at: string;
  audit: ReturnType<typeof auditRouteRecords>;
  routes: DecisionLabRoute[];
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

function openRouterMetadata(state: RouteState): Record<string, unknown> {
  return object(state.decision.extensions?.openrouter);
}

function safeAttempts(metadata: Record<string, unknown>): DecisionLabRoute["attempts"] {
  if (!Array.isArray(metadata.attempts)) return [];
  return metadata.attempts.flatMap((item) => {
    const attempt = object(item);
    const provider = string(attempt.provider);
    const model = string(attempt.model);
    const status = number(attempt.status);
    if (!provider && !model && status === undefined) return [];
    return [{ ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(status !== undefined ? { status } : {}) }];
  });
}

function safePipeline(metadata: Record<string, unknown>): DecisionLabRoute["pipeline"] {
  if (!Array.isArray(metadata.pipeline)) return [];
  return metadata.pipeline.flatMap((item) => {
    const stage = object(item);
    const type = string(stage.type);
    const name = string(stage.name);
    const summary = string(stage.summary);
    if (!type && !name && !summary) return [];
    return [{ ...(type ? { type } : {}), ...(name ? { name } : {}), ...(summary ? { summary } : {}) }];
  });
}

function labCandidate(candidate: RouteCandidate, selectedId: string): DecisionLabCandidate {
  return {
    id: candidate.id,
    model: candidate.model,
    ...(candidate.provider ? { provider: candidate.provider } : {}),
    selected: candidate.id === selectedId,
    eligible: candidate.eligible !== false,
    ineligible_reasons: candidate.ineligible_reasons || [],
    estimates: {
      ...(candidate.estimates?.quality !== undefined ? { quality: candidate.estimates.quality } : {}),
      ...(candidate.estimates?.latency_ms !== undefined ? { latency_ms: candidate.estimates.latency_ms } : {}),
      ...(candidate.estimates?.cost_usd !== undefined ? { cost_usd: candidate.estimates.cost_usd } : {}),
    },
    scores: {
      ...(candidate.scores?.quality !== undefined ? { quality: candidate.scores.quality } : {}),
      ...(candidate.scores?.latency !== undefined ? { latency: candidate.scores.latency } : {}),
      ...(candidate.scores?.cost !== undefined ? { cost: candidate.scores.cost } : {}),
    },
  };
}

function policyReady(fidelity: string, candidates: DecisionLabCandidate[]): boolean {
  const eligible = candidates.filter((candidate) => candidate.eligible);
  return fidelity === "full" && eligible.length > 1 && eligible.every((candidate) =>
    candidate.scores.quality !== undefined && candidate.scores.latency !== undefined && candidate.scores.cost !== undefined
  );
}

export function buildDecisionLabModel(records: RouteRecord[], generatedAt = new Date().toISOString()): DecisionLabModel {
  const audit = auditRouteRecords(records, generatedAt);
  const routes = [...foldRouteRecords(records).values()].map((state): DecisionLabRoute => {
    const decision = state.decision;
    const metadata = openRouterMetadata(state);
    const selected = decision.candidates.find((candidate) => candidate.id === decision.selection.candidate_id)!;
    const outcome = state.latest_observation?.outcome;
    const evaluator = object(outcome?.metadata?.evaluator);
    const candidates = decision.candidates.map((candidate) => labCandidate(candidate, decision.selection.candidate_id));
    return {
      route_id: decision.route_id,
      created_at: decision.created_at,
      task_type: decision.task.type,
      ...(decision.task.fingerprint ? { task_fingerprint: decision.task.fingerprint } : {}),
      router: decision.router.name,
      ...(decision.router.policy_id ? { strategy: decision.router.policy_id } : string(metadata.strategy) ? { strategy: string(metadata.strategy) } : {}),
      fidelity: decision.source.fidelity,
      ...(string(metadata.requested) ? { requested_model: string(metadata.requested) } : {}),
      selected: { model: selected.model, ...(selected.provider ? { provider: selected.provider } : {}) },
      selection_reason: decision.selection.reason,
      ...(outcome ? {
        outcome: {
          status: outcome.status,
          ...(outcome.quality !== undefined ? { quality: outcome.quality } : {}),
          ...(outcome.latency_ms !== undefined ? { latency_ms: outcome.latency_ms } : {}),
          ...(outcome.cost_usd !== undefined ? { cost_usd: outcome.cost_usd } : {}),
          ...(string(evaluator.id) ? { evaluator: string(evaluator.id) } : {}),
        },
      } : {}),
      attempts: safeAttempts(metadata),
      pipeline: safePipeline(metadata),
      candidates,
      policy_ready: policyReady(decision.source.fidelity, candidates),
      gaps: audit.gaps.filter((gap) => gap.route_id === decision.route_id).map(({ severity, code, message }) => ({ severity, code, message })),
    };
  });
  return { lab_version: "0.1", generated_at: generatedAt, audit, routes };
}

function embeddedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function renderDecisionLab(records: RouteRecord[], generatedAt = new Date().toISOString()): string {
  const data = embeddedJson(buildDecisionLabModel(records, generatedAt));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentRoute Decision Lab</title>
<style>
:root{--paper:#f4f6f8;--panel:#ffffff;--ink:#182126;--muted:#68747b;--line:#d8dfe3;--cobalt:#3157d5;--oxide:#d7653c;--mint:#b9d8cd;--violet:#d8d7f2;--warn:#9f482e;--shadow:0 18px 45px rgba(24,33,38,.09);--radius:18px}
*{box-sizing:border-box}html{background:var(--paper);color:var(--ink);font-family:"Avenir Next","Segoe UI",sans-serif}body{margin:0;min-height:100vh;background:linear-gradient(115deg,rgba(216,215,242,.34),transparent 32rem),var(--paper)}button,input{font:inherit}button{color:inherit}.shell{display:grid;grid-template-columns:19rem minmax(0,1fr);min-height:100vh}.sidebar{position:sticky;top:0;height:100vh;padding:1.4rem;border-right:1px solid var(--line);background:rgba(244,246,248,.88);backdrop-filter:blur(14px);overflow:auto}.brand{display:flex;align-items:center;gap:.8rem;margin-bottom:1.6rem}.brand-mark{width:2.2rem;height:2.2rem;border-radius:50%;border:7px solid var(--ink);box-shadow:inset 0 0 0 3px var(--paper);background:var(--oxide)}.brand h1{font-family:"Arial Narrow","Avenir Next Condensed",sans-serif;font-stretch:condensed;font-size:1.08rem;letter-spacing:.08em;text-transform:uppercase;margin:0}.brand p{margin:.15rem 0 0;color:var(--muted);font:600 .68rem ui-monospace,SFMono-Regular,monospace;letter-spacing:.08em}.search{width:100%;border:1px solid var(--line);border-radius:999px;padding:.72rem 1rem;background:var(--panel);outline:none}.search:focus{border-color:var(--cobalt);box-shadow:0 0 0 3px rgba(49,87,213,.15)}.route-list{display:grid;gap:.55rem;margin-top:1rem}.route-button{width:100%;border:1px solid transparent;border-radius:13px;background:transparent;padding:.8rem;text-align:left;cursor:pointer}.route-button:hover{background:rgba(255,255,255,.7)}.route-button[aria-current="true"]{background:var(--panel);border-color:var(--line);box-shadow:0 8px 20px rgba(24,33,38,.06)}.route-button strong,.route-button span{display:block}.route-button strong{font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.route-button span{margin-top:.3rem;color:var(--muted);font:600 .65rem ui-monospace,SFMono-Regular,monospace;text-transform:uppercase}.empty{color:var(--muted);font-size:.82rem;padding:1rem}.main{padding:2rem clamp(1rem,3vw,3.5rem) 4rem;overflow:hidden}.topline{display:flex;justify-content:space-between;align-items:flex-start;gap:2rem;margin-bottom:2rem}.eyebrow{font:700 .68rem ui-monospace,SFMono-Regular,monospace;letter-spacing:.13em;text-transform:uppercase;color:var(--cobalt)}.headline{font-family:"Arial Narrow","Avenir Next Condensed",sans-serif;font-stretch:condensed;font-size:clamp(2.4rem,6vw,5.8rem);line-height:.86;letter-spacing:-.055em;margin:.35rem 0 0;max-width:11ch}.grade-card{min-width:11rem;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);padding:1rem;box-shadow:var(--shadow)}.grade-card .grade{font-family:"Arial Narrow",sans-serif;font-size:3.6rem;line-height:1;color:var(--oxide)}.grade-card strong,.grade-card span{display:block}.grade-card span{color:var(--muted);font-size:.72rem;margin-top:.25rem}.metric-strip{display:grid;grid-template-columns:repeat(7,minmax(8rem,1fr));gap:.6rem;overflow:auto;padding-bottom:.45rem;margin-bottom:1.6rem}.metric{min-width:8rem;border-top:3px solid var(--ink);padding:.6rem 0}.metric strong{display:block;font:700 1rem ui-monospace,SFMono-Regular,monospace}.metric span{display:block;color:var(--muted);font-size:.67rem;margin-top:.2rem}.receipt{border:1px solid var(--line);border-radius:26px;background:var(--panel);box-shadow:var(--shadow);overflow:hidden}.receipt-head{display:flex;justify-content:space-between;gap:1rem;padding:1.3rem 1.5rem;border-bottom:1px solid var(--line)}.receipt-title{min-width:0}.receipt-title h2{font-size:1rem;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.receipt-title p{color:var(--muted);font:600 .68rem ui-monospace,SFMono-Regular,monospace;margin:.35rem 0 0}.badges{display:flex;align-items:flex-start;gap:.4rem;flex-wrap:wrap;justify-content:flex-end}.badge{border:1px solid var(--line);border-radius:999px;padding:.32rem .55rem;font:700 .61rem ui-monospace,SFMono-Regular,monospace;text-transform:uppercase}.badge.full{background:var(--mint)}.badge.partial,.badge.selected-only{background:#f6ded6;color:var(--warn)}.rail-wrap{padding:2rem 1.5rem 1.5rem;background:linear-gradient(180deg,#fff,#f8fafb)}.rail{display:grid;grid-template-columns:repeat(4,1fr);position:relative;gap:1rem}.rail:before{content:"";position:absolute;left:7%;right:7%;top:1rem;height:2px;background:linear-gradient(90deg,var(--violet),var(--cobalt),var(--oxide),var(--mint))}.rail-step{position:relative;padding-top:2.3rem;min-width:0}.rail-dot{position:absolute;top:.55rem;left:0;width:.9rem;height:.9rem;border:3px solid var(--panel);border-radius:50%;background:var(--ink);box-shadow:0 0 0 1px var(--line)}.rail-step.proposed .rail-dot{background:var(--oxide)}.rail-step label{display:block;color:var(--muted);font:700 .61rem ui-monospace,SFMono-Regular,monospace;letter-spacing:.1em;text-transform:uppercase}.rail-step strong{display:block;margin-top:.38rem;font-size:.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rail-step span{display:block;color:var(--muted);font-size:.7rem;margin-top:.25rem}.workspace{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(18rem,.65fr);border-top:1px solid var(--line)}.evidence,.sandbox{padding:1.5rem}.sandbox{border-left:1px solid var(--line);background:#fbfcfd}.section-label{font:700 .65rem ui-monospace,SFMono-Regular,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--cobalt);margin:0 0 1rem}.reason{font-size:1rem;line-height:1.6;margin:0 0 1.5rem;max-width:70ch}.candidate-table{display:grid;gap:.65rem}.candidate{border:1px solid var(--line);border-radius:14px;padding:.9rem;display:grid;grid-template-columns:minmax(9rem,1.4fr) repeat(3,minmax(5rem,.6fr));gap:.8rem;align-items:center}.candidate.selected{border-color:var(--cobalt);box-shadow:inset 3px 0 0 var(--cobalt)}.candidate.proposed{background:#fff5f0;box-shadow:inset 3px 0 0 var(--oxide)}.candidate-name strong,.candidate-name span{display:block}.candidate-name span{color:var(--muted);font-size:.68rem;margin-top:.2rem}.datum label,.datum strong{display:block}.datum label{color:var(--muted);font:700 .58rem ui-monospace,SFMono-Regular,monospace;text-transform:uppercase}.datum strong{font-size:.78rem;margin-top:.25rem}.control{margin-bottom:1rem}.control-head{display:flex;justify-content:space-between;font-size:.75rem}.control output{font:700 .72rem ui-monospace,SFMono-Regular,monospace;color:var(--cobalt)}input[type="range"]{width:100%;accent-color:var(--cobalt)}.sandbox-note{color:var(--muted);font-size:.72rem;line-height:1.5}.sandbox-result{border-top:1px solid var(--line);margin-top:1.2rem;padding-top:1.2rem}.sandbox-result strong{display:block;font-size:1rem}.sandbox-result span{display:block;color:var(--muted);font-size:.7rem;margin-top:.3rem}.lower{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1rem}.panel{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);padding:1.2rem}.gap-list,.trace-list{display:grid;gap:.55rem}.gap,.trace{display:flex;align-items:flex-start;gap:.7rem;font-size:.76rem;line-height:1.45}.gap i,.trace i{flex:0 0 .55rem;width:.55rem;height:.55rem;border-radius:50%;background:var(--violet);margin-top:.28rem}.gap.warning i{background:var(--oxide)}.trace code{font-size:.67rem}.muted{color:var(--muted)}:focus-visible{outline:3px solid rgba(49,87,213,.35);outline-offset:2px}
.metric-strip{grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));overflow:visible}.metric{min-width:0}
@media(max-width:980px){.shell{grid-template-columns:1fr}.sidebar{position:relative;height:auto;border-right:0;border-bottom:1px solid var(--line)}.route-list{grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))}.workspace{grid-template-columns:1fr}.sandbox{border-left:0;border-top:1px solid var(--line)}.headline{font-size:clamp(3rem,12vw,5rem)}.topline{align-items:flex-end}}
@media(max-width:640px){.main{padding:1.2rem .8rem 3rem}.topline{display:block}.grade-card{margin-top:1.2rem}.receipt-head{display:block}.badges{justify-content:flex-start;margin-top:.8rem}.rail{grid-template-columns:1fr 1fr}.rail:before{display:none}.rail-step{border-top:2px solid var(--line);padding-top:1rem}.rail-dot{display:none}.candidate{grid-template-columns:1fr 1fr}.candidate-name{grid-column:1/-1}.lower{grid-template-columns:1fr}}
@media(prefers-reduced-motion:no-preference){.receipt{animation:enter .45s ease-out both}@keyframes enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}
</style>
</head>
<body>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><div class="brand-mark" aria-hidden="true"></div><div><h1>AgentRoute</h1><p>Decision Lab / 0.1</p></div></div>
    <label class="eyebrow" for="route-search">Find a receipt</label>
    <input class="search" id="route-search" type="search" placeholder="Model, task, route…">
    <nav class="route-list" id="route-list" aria-label="Routing receipts"></nav>
  </aside>
  <main class="main">
    <header class="topline">
      <div><div class="eyebrow">Routing evidence, calibrated</div><h1 class="headline">Was this route defensible?</h1></div>
      <div class="grade-card" aria-label="Audit readiness"><span>Audit readiness</span><strong class="grade" id="grade">—</strong><strong id="readiness">—</strong><span>Instrumentation quality, not model quality</span></div>
    </header>
    <section class="metric-strip" id="metric-strip" aria-label="Audit-readiness metrics"></section>
    <article class="receipt" id="receipt" aria-live="polite"></article>
  </main>
</div>
<script type="application/json" id="agentroute-data">${data}</script>
<script>
const data=JSON.parse(document.getElementById('agentroute-data').textContent);let current=data.routes[0]?.route_id||null;let query='';
const $=id=>document.getElementById(id);const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n};
const fmt=v=>v===undefined?'not measured':String(v);const money=v=>v===undefined?'not measured':'$'+Number(v).toFixed(6);const percent=v=>(Number(v)*100).toFixed(0)+'%';
function renderSummary(){$('grade').textContent=data.audit.readiness_grade;$('readiness').textContent=percent(data.audit.readiness_score);const strip=$('metric-strip');strip.replaceChildren();data.audit.metrics.forEach(m=>{const card=node('div','metric');card.append(node('strong','',percent(m.ratio)),node('span','',m.label+' · '+m.covered+'/'+m.total));strip.append(card)})}
function filteredRoutes(){const q=query.trim().toLowerCase();return data.routes.filter(r=>!q||[r.route_id,r.task_type,r.selected.model,r.selected.provider,r.router].filter(Boolean).some(v=>String(v).toLowerCase().includes(q)))}
function renderList(){const list=$('route-list');list.replaceChildren();const routes=filteredRoutes();if(!routes.length){list.append(node('div','empty','No receipts match this search.'));return}routes.forEach(r=>{const b=node('button','route-button');b.type='button';b.setAttribute('aria-current',String(r.route_id===current));b.append(node('strong','',r.selected.model),node('span','',r.task_type+' · '+(r.outcome?.status||'pending')+' · '+r.fidelity));b.addEventListener('click',()=>{current=r.route_id;renderList();renderReceipt()});list.append(b)})}
function badge(text,cls){return node('span','badge '+cls,text)}
function railStep(label,main,sub,cls=''){const d=node('div','rail-step '+cls);d.append(node('i','rail-dot'),node('label','',label),node('strong','',main),node('span','',sub));return d}
function datum(label,value){const d=node('div','datum');d.append(node('label','',label),node('strong','',value));return d}
function candidateCard(c){const d=node('div','candidate'+(c.selected?' selected':''));d.dataset.candidate=c.id;const name=node('div','candidate-name');name.append(node('strong','',c.model),node('span','',c.provider||'provider not recorded'));d.append(name,datum('quality',fmt(c.estimates.quality)),datum('latency',c.estimates.latency_ms===undefined?'not measured':c.estimates.latency_ms+'ms'),datum('cost',money(c.estimates.cost_usd)));return d}
function control(id,label,value){const wrap=node('div','control');const head=node('div','control-head');const labelNode=node('label','',label);labelNode.htmlFor=id;const out=node('output','',value+'%');out.htmlFor=id;head.append(labelNode,out);const input=node('input');input.type='range';input.id=id;input.min='0';input.max='100';input.value=String(value);input.addEventListener('input',()=>{out.textContent=input.value+'%';updatePolicy()});wrap.append(head,input);return wrap}
function updatePolicy(){const route=data.routes.find(r=>r.route_id===current);if(!route)return;const inputs=['quality','latency','cost'].map(k=>$('weight-'+k));if(inputs.some(x=>!x))return;const raw=inputs.map(x=>Number(x.value));const total=raw.reduce((a,b)=>a+b,0)||1;const weights={quality:raw[0]/total,latency:raw[1]/total,cost:raw[2]/total};const scored=route.candidates.filter(c=>c.eligible&&['quality','latency','cost'].every(k=>c.scores[k]!==undefined)).map(c=>({c,score:weights.quality*c.scores.quality+weights.latency*c.scores.latency+weights.cost*c.scores.cost})).sort((a,b)=>b.score-a.score||a.c.id.localeCompare(b.c.id));document.querySelectorAll('.candidate').forEach(n=>n.classList.remove('proposed'));const result=$('sandbox-result');const proposed=$('proposed-value');const proposedSub=$('proposed-sub');if(!route.policy_ready||scored.length<2){result.querySelector('strong').textContent='Not enough evidence';result.querySelector('span').textContent='A full set of at least two eligible candidates with complete routing-time scores is required.';proposed.textContent='Not scorable';proposedSub.textContent='Complete the candidate evidence';return}const win=scored[0];document.querySelector('[data-candidate="'+CSS.escape(win.c.id)+'"]')?.classList.add('proposed');result.querySelector('strong').textContent=win.c.model;result.querySelector('span').textContent='Predicted policy score '+win.score.toFixed(3)+' · not an observed outcome';proposed.textContent=win.c.model;proposedSub.textContent='Predicted under these weights'}
function renderReceipt(){const route=data.routes.find(r=>r.route_id===current);const root=$('receipt');root.replaceChildren();if(!route){root.append(node('div','empty','Load a receipt ledger to begin.'));return}const head=node('header','receipt-head');const title=node('div','receipt-title');title.append(node('h2','',route.route_id),node('p','',route.router+(route.strategy?' / '+route.strategy:'')+' · '+new Date(route.created_at).toLocaleString()));const badges=node('div','badges');badges.append(badge(route.fidelity,route.fidelity),badge(route.outcome?.status||'pending',''));head.append(title,badges);
const railWrap=node('section','rail-wrap');const rail=node('div','rail');rail.append(railStep('Requested',route.requested_model||'Not recorded','Upstream request'),railStep('Selected',route.selected.model,route.selected.provider||'Provider not recorded'),railStep('Observed',route.outcome?.status||'Pending',route.outcome?'quality '+fmt(route.outcome.quality)+' · '+fmt(route.outcome.latency_ms)+'ms':'Awaiting evaluation'),railStep('Proposed','Move the weights','Predicted policy only','proposed'));rail.lastChild.querySelector('strong').id='proposed-value';rail.lastChild.querySelector('span').id='proposed-sub';railWrap.append(rail);
const workspace=node('div','workspace');const evidence=node('section','evidence');evidence.append(node('h3','section-label','Decision evidence'),node('p','reason',route.selection_reason));const table=node('div','candidate-table');route.candidates.forEach(c=>table.append(candidateCard(c)));evidence.append(table);
const sandbox=node('aside','sandbox');sandbox.append(node('h3','section-label','Predicted policy sandbox'),node('p','sandbox-note','Re-rank only the recorded candidate set. Weights operate on routing-time scores—not measured counterfactual outcomes.'),control('weight-quality','Quality',40),control('weight-latency','Latency',30),control('weight-cost','Cost',30));const sr=node('div','sandbox-result');sr.id='sandbox-result';sr.append(node('strong','','—'),node('span','','Adjust weights to compare.'));sandbox.append(sr);workspace.append(evidence,sandbox);
const lower=node('div','lower');const gaps=node('section','panel');gaps.append(node('h3','section-label','Evidence gaps'));const gapList=node('div','gap-list');if(route.gaps.length)route.gaps.forEach(g=>{const d=node('div','gap '+g.severity);d.append(node('i'),node('span','',g.message));gapList.append(d)});else gapList.append(node('div','muted','No audit-readiness gaps detected.'));gaps.append(gapList);const trace=node('section','panel');trace.append(node('h3','section-label','Router trace'));const traceList=node('div','trace-list');const items=[...route.attempts.map(a=>'Attempt · '+(a.provider||'provider unknown')+' · '+(a.model||'model unknown')+' · '+(a.status??'status unknown')),...route.pipeline.map(p=>'Pipeline · '+(p.name||p.type||'stage')+(p.summary?' · '+p.summary:''))];if(items.length)items.forEach(t=>{const d=node('div','trace');d.append(node('i'),node('code','',t));traceList.append(d)});else traceList.append(node('div','muted','No retry or pipeline trace was recorded.'));trace.append(traceList);lower.append(gaps,trace);root.append(head,railWrap,workspace,lower);updatePolicy()}
$('route-search').addEventListener('input',e=>{query=e.target.value;renderList()});renderSummary();renderList();renderReceipt();
</script>
</body>
</html>`;
}

export function writeDecisionLab(path: string, records: RouteRecord[]): void {
  writeFileSync(path, renderDecisionLab(records));
}
