import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { normalize, resolve, sep } from "node:path";
import { Project } from "./store.ts";
import type { CaseResult, RoundMeta } from "./types.ts";
import { trend } from "./report.ts";
import { runningRound } from "./round.ts";
import { isIssue } from "./issues.ts";

const MIME: Record<string, string> = { html: "text/html; charset=utf-8", png: "image/png", jpg: "image/jpeg", webm: "video/webm", mp4: "video/mp4", mov: "video/quicktime", txt: "text/plain; charset=utf-8", json: "application/json", md: "text/plain; charset=utf-8", zip: "application/zip", ndjson: "text/plain" };

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
  const cfg = project.config();
  const counts = {
    pass: results.filter((r) => r.status === "PASS").length,
    issue: results.filter((r) => isIssue(r, cfg)).length,
    skip: results.filter((r) => r.status === "SKIP" || r.status === "NA").length,
    warn: results.filter((r) => r.status === "PASS" && r.warnings.length).length,
  };
  return {
    project: project.root,
    counts,
    rounds: rounds.map((r) => ({ id: r.id, status: r.status, scope: r.scope, summary: r.summary })),
    round: cur ?? null,
    running: !!running && running.id === cur?.id,
    progress: { done: results.length, total: caseTotal, current: last ? { id: last.case, title: last.title } : null },
    results: results.map((r) => ({ id: r.id, title: r.title, status: r.status, reason: r.reason, warnings: r.warnings.length, ms: r.durationMs, video: r.video, priority: r.priority })),
    events,
    trend: trend(project),
    feedback: project.feedback().filter((f) => f.status === "pending"),
    hasReport: !!cur && existsSync(project.p("rounds", cur.id, "report.html")),
    notice: "영상과 스크린샷에 화면이 그대로 남습니다. 테스트 데이터와 테스트 계정만 입력하세요.",
  };
}

export interface Lan {
  name: string;
  address: string;
}

/** 내부망 IPv4 주소(192.168.x.x · 10.x.x.x). 루프백·외부 주소는 제외한다. */
export function lanAddresses(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): Lan[] {
  const out: Lan[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      if (/^(192\.168\.|10\.)/.test(i.address)) out.push({ name, address: i.address });
    }
  }
  return out;
}

/** 접속 토큰: 프로젝트마다 .e2e/dashboard-token 에 두고 계속 쓴다(rotate 하면 새로 만든다). 토큰 없는 접속은 막는다. */
export function dashboardToken(project: Project, rotate = false): string {
  const file = project.p("dashboard-token");
  if (!rotate) {
    try {
      const t = readFileSync(file, "utf8").trim();
      if (/^[0-9a-f]{48}$/.test(t)) return t;
    } catch {}
  }
  const t = randomBytes(24).toString("hex");
  project.ensure();
  writeFileSync(file, t, { mode: 0o600 });
  return t;
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const cookieOf = (req: Request, name: string) => (req.headers.get("cookie") ?? "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name)?.[1];

/** 파일을 내려 주되 영상 되감기(Range)를 지원한다. */
function fileResponse(full: string, req: Request, ext: string): Response {
  const file = Bun.file(full);
  const size = file.size;
  const type = MIME[ext] ?? "application/octet-stream";
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return new Response("range not satisfiable", { status: 416, headers: { "content-range": `bytes */${size}` } });
    return new Response(file.slice(start, end + 1), { status: 206, headers: { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1), "accept-ranges": "bytes", "cache-control": "no-store" } });
  }
  return new Response(file, { headers: { "content-type": type, "content-length": String(size), "accept-ranges": "bytes", "cache-control": "no-store" } });
}

const DENY = `<!doctype html><meta charset="utf-8"><title>접속 토큰 필요</title><body style="font:15px sans-serif;margin:3rem"><h2>접속 토큰이 필요합니다</h2><p>e2e-loop 가 알려 준 접속 주소(토큰이 붙은 주소)로 들어오세요.</p>`;

export interface DashboardInfo {
  port: number;
  host: string;
  /** 토큰 없는 기본 주소 */
  url: string;
  /** 토큰이 붙은 접속 주소(비밀로 다룬다) */
  access_url: string;
  token: string;
  /** 내부망 IP 로 띄웠는가 */
  lan: boolean;
  alternatives: string[];
  warn?: string;
  stop: () => void;
}

export function startDashboard(project: Project, preferred?: number, opts: { host?: string; ifaces?: ReturnType<typeof networkInterfaces>; rotateToken?: boolean } = {}): DashboardInfo {
  const base = preferred ?? project.config().dashboardPort;
  const lans = lanAddresses(opts.ifaces);
  const want = opts.host ?? project.config().dashboardHost;
  if (want && !lans.some((l) => l.address === want) && !/^(192\.168\.|10\.)/.test(want)) throw new Error(`dashboardHost 는 내부망 주소(192.168.x.x · 10.x.x.x)여야 합니다: ${want}`);
  const host = want ?? lans[0]?.address ?? "127.0.0.1";
  const lan = host !== "127.0.0.1";
  const token = dashboardToken(project, opts.rotateToken);
  const fails = new Map<string, number[]>();
  let server: ReturnType<typeof Bun.serve> | undefined;
  for (let port = base; port < base + 30 && !server; port++) {
    try {
      server = Bun.serve({
        port,
        hostname: host,
        fetch(req, srv) {
          const u = new URL(req.url);
          const ip = srv.requestIP(req)?.address ?? "?";
          const now = Date.now();
          const recent = (fails.get(ip) ?? []).filter((t) => now - t < 60000);
          if (recent.length >= 20) return new Response("too many attempts", { status: 429 });
          const given = u.searchParams.get("token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? cookieOf(req, "e2e_token") ?? "";
          if (!given || !safeEq(given, token)) {
            fails.set(ip, [...recent, now]);
            return new Response(DENY, { status: 401, headers: { "content-type": MIME.html!, "cache-control": "no-store" } });
          }
          // 토큰이 주소에 실려 왔으면 쿠키로 바꿔 심고 주소에서 지운다(영상·이미지 요청도 쿠키로 통과)
          if (u.searchParams.has("token")) {
            u.searchParams.delete("token");
            return new Response(null, { status: 302, headers: { location: u.pathname + (u.search || ""), "set-cookie": `e2e_token=${token}; Path=/; HttpOnly; SameSite=Strict`, "cache-control": "no-store" } });
          }
          if (u.pathname === "/") return new Response(PAGE, { headers: { "content-type": MIME.html!, "cache-control": "no-store" } });
          if (u.pathname === "/api/state") return Response.json(state(project, u.searchParams.get("round") ?? undefined), { headers: { "cache-control": "no-store" } });
          if (u.pathname.startsWith("/files/")) {
            const rel = decodeURIComponent(u.pathname.slice(7));
            const root = resolve(project.p("rounds"));
            const full = normalize(resolve(root, rel));
            if (full !== root && !full.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
            if (!existsSync(full) || !statSync(full).isFile()) return new Response("not found", { status: 404 });
            return fileResponse(full, req, full.split(".").pop() ?? "");
          }
          return new Response("not found", { status: 404 });
        },
      });
    } catch {}
  }
  if (!server) throw new Error("대시보드 포트를 잡지 못했습니다(" + base + "~" + (base + 29) + ")");
  const url = `http://${host}:${server.port}`;
  const access_url = `${url}/?token=${token}`;
  project.writeJson("dashboard.json", { port: server.port, host, pid: process.pid, url, lan });
  return {
    port: server.port!, host, url, access_url, token, lan,
    alternatives: lans.filter((l) => l.address !== host).map((l) => `http://${l.address}:${server!.port}`),
    warn: lan ? undefined : "내부망 IP(192.168.x.x · 10.x.x.x)를 찾지 못해 이 컴퓨터에서만 접속됩니다. 같은 망의 다른 기기에서 보려면 네트워크에 연결한 뒤 다시 띄우세요.",
    stop: () => server!.stop(true),
  };
}

// 주의: 한글이 든 HTML 은 String.raw 로 쓰지 않는다. Bun 이 String.raw 안의 한글을 유니코드 이스케이프 글자로 바꿔 화면에 그대로 찍힌다.
const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>E2E 실시간</title>
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
.wide{grid-column:1/-1}.tabs button.on{background:var(--acc);color:#fff}.note{background:#fff3cd;color:#664d03;padding:6px 16px;font-size:12px}.s.FLAKY{background:var(--warn)}.s.BLOCKED{background:var(--fail)}
</style></head><body>
<div class="note" id="notice"></div>
<header><h1>E2E 실시간 대시보드</h1><span id="proj" style="color:var(--mut)"></span><select id="sel"></select><span id="st" class="pill"></span><a id="rep" style="display:none" target="_blank">결과 보고서 열기</a></header>
<main>
<section class="card"><h2>진행</h2><div class="bar"><i id="bar" style="width:0"></i></div><div id="prog" style="margin:6px 0"></div>
<div class="cnt"><div><b id="cp" class="ok">0</b>통과</div><div><b id="cf" class="fail">0</b>이슈</div><div><b id="cs">0</b>스킵·해당 없음</div><div><b id="cw" style="color:var(--warn)">0</b>경고</div></div>
<div id="cur" style="font-weight:600"></div><div id="fbs"></div></section>
<section class="card live"><h2>지금 화면</h2><img id="live" alt="아직 화면이 없습니다"></section>
<section class="card"><h2>이슈 추이 (0 에 수렴하면 종료)</h2><div class="tr" id="tr"></div></section>
<section class="card"><h2>실시간 로그</h2><div id="feed"></div></section>
<section class="card wide"><h2>케이스 <span class="tabs"><button data-f="all" class="on">전체</button> <button data-f="issue">이슈</button> <button data-f="PASS">통과</button> <button data-f="other">스킵·기타</button></span></h2><table><thead><tr><th>상태</th><th>케이스</th><th>사유</th><th>영상</th></tr></thead><tbody id="rows"></tbody></table></section>
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
$('notice').textContent=s.notice;$('cp').textContent=s.counts.pass;$('cf').textContent=s.counts.issue;$('cs').textContent=s.counts.skip;$('cw').textContent=s.counts.warn;
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
const isI=r=>['FAIL','FLAKY','BLOCKED'].includes(r.status);const rows=s.results.filter(r=>filter==='all'||(filter==='issue'?isI(r):filter==='other'?(!isI(r)&&r.status!=='PASS'):r.status===filter));
$('rows').innerHTML=rows.slice().reverse().map(r=>'<tr><td><span class="s '+r.status+'">'+r.status+'</span></td><td><b>'+esc(r.id)+'</b> '+esc(r.title)+(r.priority?' <b class="fail">'+r.priority+'</b>':'')+'</td><td>'+esc(r.reason||'')+(r.warnings?' <span style="color:var(--warn)">경고 '+r.warnings+'</span>':'')+'</td><td>'+(r.video?'<a target="_blank" href="/files/'+s.round.id+'/'+r.video+'">▶ 영상</a>':'')+'</td></tr>').join('')}
tick();setInterval(tick,1200);
</script></body></html>`;
