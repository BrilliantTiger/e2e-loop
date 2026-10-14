import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { Project } from "./store.ts";
import type { CaseResult, RoundMeta } from "./types.ts";
import { trend } from "./report.ts";
import { runningRound } from "./round.ts";

const MIME: Record<string, string> = { html: "text/html; charset=utf-8", png: "image/png", jpg: "image/jpeg", webm: "video/webm", json: "application/json", md: "text/plain; charset=utf-8", zip: "application/zip", ndjson: "text/plain" };

function state(project: Project, roundId?: string) {
  const rounds = project.rounds();
  const running = runningRound(project);
  const cur: RoundMeta | undefined = rounds.find((r) => r.id === (roundId ?? running?.id)) ?? rounds[rounds.length - 1];
  const results = cur ? project.readJson<CaseResult[]>(`rounds/${cur.id}/results.json`, []) : [];
  let events: any[] = [];
  if (cur) {
    try {
      events = readFileSync(project.p("rounds", cur.id, "events.ndjson"), "utf8").trim().split("\n").slice(-80).map((l) => JSON.parse(l));
    } catch {}
  }
  const caseTotal = cur?.caseCount ?? 0;
  const last = [...events].reverse().find((e) => e.type === "case-start");
  return {
    project: project.root,
    rounds: rounds.map((r) => ({ id: r.id, status: r.status, scope: r.scope, summary: r.summary })),
    round: cur ?? null,
    running: !!running && running.id === cur?.id,
    progress: { done: results.length, total: caseTotal, current: last ? { id: last.case, title: last.title } : null },
    results: results.map((r) => ({ id: r.id, title: r.title, status: r.status, reason: r.reason, warnings: r.warnings.length, ms: r.durationMs, video: r.video, priority: r.priority })),
    events,
    trend: trend(project),
    feedback: project.feedback().filter((f) => f.status === "pending"),
    hasReport: !!cur && existsSync(project.p("rounds", cur.id, "report.html")),
  };
}

export function startDashboard(project: Project, preferred?: number): { port: number; url: string; stop: () => void } {
  const base = preferred ?? project.config().dashboardPort;
  let server: ReturnType<typeof Bun.serve> | undefined;
  for (let port = base; port < base + 30 && !server; port++) {
    try {
      server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch(req) {
          const u = new URL(req.url);
          if (u.pathname === "/") return new Response(PAGE, { headers: { "content-type": MIME.html! } });
          if (u.pathname === "/api/state") return Response.json(state(project, u.searchParams.get("round") ?? undefined));
          if (u.pathname.startsWith("/files/")) {
            const rel = decodeURIComponent(u.pathname.slice(7));
            const full = normalize(resolve(project.p("rounds"), rel));
            if (!full.startsWith(resolve(project.p("rounds")))) return new Response("forbidden", { status: 403 });
            if (!existsSync(full) || !statSync(full).isFile()) return new Response("not found", { status: 404 });
            const ext = full.split(".").pop() ?? "";
            return new Response(Bun.file(full), { headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" } });
          }
          return new Response("not found", { status: 404 });
        },
      });
    } catch {}
  }
  if (!server) throw new Error("대시보드 포트를 잡지 못했습니다(" + base + "~" + (base + 29) + ")");
  const url = `http://127.0.0.1:${server.port}`;
  project.writeJson("dashboard.json", { port: server.port, pid: process.pid, url });
  return { port: server.port!, url, stop: () => server!.stop(true) };
}

const PAGE = String.raw`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>E2E 실시간</title>
<style>
:root{--bg:#fff;--fg:#1c2230;--mut:#667;--card:#f4f6fa;--line:#dde2ea;--pass:#1a7f4b;--fail:#c0392b;--warn:#b7791f;--skip:#6b7280;--acc:#2563eb}
@media(prefers-color-scheme:dark){:root{--bg:#0e121a;--fg:#e6e9ef;--mut:#98a2b3;--card:#171d28;--line:#283142}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,"Apple SD Gothic Neo",sans-serif}
header{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line)}h1{font-size:16px;margin:0}
select,button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
.pill{padding:2px 10px;border-radius:99px;font-weight:700;color:#fff;font-size:12px}.running{background:var(--acc);animation:p 1.2s infinite}.finished{background:var(--pass)}.aborted{background:var(--fail)}@keyframes p{50%{opacity:.5}}
main{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:12px;padding:12px 16px}@media(max-width:900px){main{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.card h2{font-size:13px;margin:0 0 8px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.bar{height:10px;background:var(--line);border-radius:6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--acc);transition:width .4s}
.cnt{display:flex;gap:14px;margin:8px 0;flex-wrap:wrap}.cnt b{font-size:22px;display:block}
.live img{width:100%;border-radius:8px;border:1px solid var(--line);background:#000;min-height:120px}
#feed{max-height:260px;overflow:auto;font:12px/1.5 ui-monospace,Menlo,monospace}#feed div{padding:1px 0;border-bottom:1px dotted var(--line)}
.ok{color:var(--pass)}.fail{color:var(--fail)}.skip{color:var(--skip)}table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:4px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.s{font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px;color:#fff}.s.PASS{background:var(--pass)}.s.FAIL{background:var(--fail)}.s.SKIP,.s.NA,.s.BLOCKED{background:var(--skip)}
.tr{display:flex;gap:10px;align-items:flex-end;height:90px}.tb{display:flex;flex-direction:column;align-items:center;font-size:11px;gap:2px}.tb i{width:22px;border-radius:3px 3px 0 0;display:block}
.fb{background:#fff3cd;color:#664d03;border-radius:6px;padding:6px 10px;margin-top:6px;font-size:12px}a{color:var(--acc)}
.wide{grid-column:1/-1}.tabs button.on{background:var(--acc);color:#fff}
</style></head><body>
<header><h1>E2E 실시간 대시보드</h1><span id="proj" style="color:var(--mut)"></span><select id="sel"></select><span id="st" class="pill"></span><a id="rep" style="display:none" target="_blank">결과 보고서 열기</a></header>
<main>
<section class="card"><h2>진행</h2><div class="bar"><i id="bar" style="width:0"></i></div><div id="prog" style="margin:6px 0"></div>
<div class="cnt"><div><b id="cp" class="ok">0</b>PASS</div><div><b id="cf" class="fail">0</b>FAIL</div><div><b id="cs">0</b>SKIP/기타</div><div><b id="cw" style="color:var(--warn)">0</b>경고</div></div>
<div id="cur" style="font-weight:600"></div><div id="fbs"></div></section>
<section class="card live"><h2>지금 화면</h2><img id="live" alt="아직 화면이 없습니다"></section>
<section class="card"><h2>이슈 추이 (0 에 수렴하면 종료)</h2><div class="tr" id="tr"></div></section>
<section class="card"><h2>실시간 로그</h2><div id="feed"></div></section>
<section class="card wide"><h2>케이스 <span class="tabs"><button data-f="all" class="on">전체</button> <button data-f="FAIL">FAIL</button> <button data-f="PASS">PASS</button> <button data-f="other">기타</button></span></h2><table><thead><tr><th>상태</th><th>케이스</th><th>사유</th><th>영상</th></tr></thead><tbody id="rows"></tbody></table></section>
</main>
<script>
let round=null,filter='all',last=null;const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
$('sel').onchange=e=>{round=e.target.value;tick()};
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{filter=b.dataset.f;document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x===b));draw()});
async function tick(){try{const r=await fetch('/api/state'+(round?'?round='+round:''));last=await r.json();draw()}catch(e){}}
function draw(){const s=last;if(!s)return;$('proj').textContent=s.project;
const sel=$('sel');if(sel.options.length!==s.rounds.length){sel.innerHTML=s.rounds.map(r=>'<option>'+r.id+'</option>').join('')}if(s.round&&!round)sel.value=s.round.id;
const st=$('st');const rs=s.round?s.round.status:'';st.textContent=rs==='running'?'진행 중':rs==='finished'?'완료':rs==='aborted'?'중단':'대기';st.className='pill '+rs;
const rep=$('rep');if(s.hasReport){rep.style.display='';rep.href='/files/'+s.round.id+'/report.html'}else rep.style.display='none';
const c={PASS:0,FAIL:0,o:0,w:0};s.results.forEach(r=>{if(r.status==='PASS'){c.PASS++;if(r.warnings)c.w++}else if(r.status==='FAIL')c.FAIL++;else c.o++});
$('cp').textContent=c.PASS;$('cf').textContent=c.FAIL;$('cs').textContent=c.o;$('cw').textContent=c.w;
const pr=s.progress;$('bar').style.width=pr.total?Math.round(pr.done/pr.total*100)+'%':'0';$('prog').textContent=pr.done+' / '+pr.total+' 케이스'+(s.round?' · '+s.round.driver+' · 데이터 '+s.round.data.decision:'');
$('cur').textContent=s.running&&pr.current?'▶ '+pr.current.id+' '+pr.current.title:'';
$('fbs').innerHTML=(s.feedback||[]).map(f=>'<div class="fb">다음 회차에 적용할 요청 '+esc(f.id)+': '+esc(f.text)+'</div>').join('');
if(s.round){$('live').src='/files/'+s.round.id+'/live.png?t='+Date.now()}
const mx=Math.max(1,...s.trend.map(t=>t.issues));$('tr').innerHTML=s.trend.map(t=>'<div class="tb"><b>'+t.issues+'</b><i style="height:'+(4+t.issues/mx*60)+'px;background:'+(t.issues?'var(--fail)':'var(--pass)')+'"></i>'+t.round+(t.scope==='partial'?'·부분':'')+'</div>').join('')||'<span style="color:var(--mut)">아직 끝난 회차 없음</span>';
$('feed').innerHTML=s.events.slice().reverse().map(e=>{const t=new Date(e.t).toLocaleTimeString();
if(e.type==='step')return '<div class="'+(e.status==='ok'?'ok':'fail')+'">'+t+' '+esc(e.case)+' · '+esc(e.desc)+(e.error?' ✗ '+esc(e.error):'')+'</div>';
if(e.type==='case-start')return '<div><b>'+t+' ▶ '+esc(e.case)+'</b> '+esc(e.title)+'</div>';
if(e.type==='case-end')return '<div class="'+(e.status==='PASS'?'ok':e.status==='FAIL'?'fail':'skip')+'"><b>'+t+' '+esc(e.status)+'</b> '+esc(e.case)+(e.reason?' — '+esc(e.reason):'')+'</div>';
return '<div>'+t+' '+esc(e.type)+(e.round?' '+esc(e.round):'')+'</div>'}).join('');
const rows=s.results.filter(r=>filter==='all'||(filter==='other'?!['PASS','FAIL'].includes(r.status):r.status===filter));
$('rows').innerHTML=rows.slice().reverse().map(r=>'<tr><td><span class="s '+r.status+'">'+r.status+'</span></td><td><b>'+esc(r.id)+'</b> '+esc(r.title)+(r.priority?' <b class="fail">'+r.priority+'</b>':'')+'</td><td>'+esc(r.reason||'')+(r.warnings?' <span style="color:var(--warn)">경고 '+r.warnings+'</span>':'')+'</td><td>'+(r.video?'<a target="_blank" href="/files/'+s.round.id+'/'+r.video+'">▶ 영상</a>':'')+'</td></tr>').join('')}
tick();setInterval(tick,1200);
</script></body></html>`;
