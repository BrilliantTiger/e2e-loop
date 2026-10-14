// 시험용 사이트. 일부러 버그를 넣을 수 있고(bugs.json), "수정"은 bugs.json 을 고치는 것으로 흉내 낸다.
// 사용법: bun examples/demo-site/server.ts <프로젝트폴더> [포트]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? ".";
const port = Number(process.argv[3] ?? 4567);
const bugs = () => {
  try {
    return JSON.parse(readFileSync(join(dir, "bugs.json"), "utf8")) as Record<string, boolean>;
  } catch {
    return {};
  }
};
const seed = () => [{ id: 1, name: "샘플 항목 A" }, { id: 2, name: "샘플 항목 B" }];
let items = seed();

const layout = (title: string, body: string, script = "") => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;margin:0}nav{display:flex;gap:16px;padding:12px 20px;background:#223}nav a{color:#fff}main{padding:20px}
.modal-back{position:fixed;inset:0;background:#0008;display:none;align-items:center;justify-content:center}.modal-back.open{display:flex}
.modal{background:#fff;padding:20px;border-radius:8px;min-width:280px}[role=tab][aria-selected=true]{font-weight:700;border-bottom:2px solid #36c}
#msg{color:green;min-height:1.2em}.err{color:#c00}</style></head><body>
<nav><a href="/">홈</a><a href="/items">항목</a><a href="/about">소개</a><a href="/reports">리포트</a><a href="/upload">업로드</a><a href="https://example.com" target="_blank">외부</a><a href="/logout">로그아웃</a></nav>
<main>${body}</main><script>${script}</script></body></html>`;

const home = (b: Record<string, boolean>) =>
  layout(
    "홈",
    `<h1>대시보드</h1>
<p><a href="/files/report.csv" download>보고서 내려받기</a></p>
<p><button id="open-notice">공지 열기</button> <button id="stats">통계 새로고침</button> <button id="export">내보내기</button> <button id="noop">아무 일 없음</button> <button id="del-all">전체 삭제</button></p>
<div id="stat-out"></div>
<div class="modal-back" id="mb"><div class="modal" role="dialog" aria-modal="true" aria-label="공지"><h2>공지사항</h2><p>점검 안내입니다.</p>${b.modalNoClose ? "" : '<button id="close-notice" aria-label="닫기">닫기</button>'}</div></div>
<div role="tablist"><button role="tab" aria-selected="true" id="t1">개요</button><button role="tab" aria-selected="false" id="t2">상세</button></div>
<details><summary>더 보기</summary><p>숨은 내용</p></details>
<h2>가입</h2>
<form id="signup">
 <label>이메일 <input name="email" type="email" required placeholder="이메일"></label><br>
 <label>이름 <input name="name" type="text" maxlength="10" placeholder="이름"></label><br>
 <label>역할 <select name="role"><option value="user">사용자</option><option value="admin">관리자</option></select></label><br>
 <label><input type="checkbox" name="agree"> 약관 동의</label><br>
 <button type="submit">가입하기</button>
</form><div id="msg"></div>`,
    `
const $=(s)=>document.querySelector(s);
$('#open-notice').onclick=()=>$('#mb').classList.add('open');
${b.modalNoClose ? "" : "$('#close-notice').onclick=()=>$('#mb').classList.remove('open');document.addEventListener('keydown',e=>{if(e.key==='Escape')$('#mb').classList.remove('open')});"}
$('#stats').onclick=async()=>{const r=await fetch('/api/stats');const j=await r.json().catch(()=>({}));$('#stat-out').textContent=r.ok?('항목 '+j.count+'개'):'오류';};
$('#export').onclick=()=>{ ${b.exportThrows ? "const x=undefined; x.rows.map(r=>r);" : "$('#stat-out').textContent='내보냈습니다';"} };
$('#del-all').onclick=async()=>{await fetch('/api/items',{method:'DELETE'});$('#stat-out').textContent='모두 삭제됨';};
document.querySelectorAll('[role=tab]').forEach(t=>t.onclick=()=>{document.querySelectorAll('[role=tab]').forEach(x=>x.setAttribute('aria-selected',x===t));});
$('#signup').onsubmit=async(e)=>{e.preventDefault();const f=new FormData(e.target);const r=await fetch('/api/signup',{method:'POST',body:JSON.stringify(Object.fromEntries(f))});$('#msg').textContent=r.ok?'가입 완료':'가입 실패';};
`,
  );

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    const b = bugs();
    const html = (s: string, status = 200) => new Response(s, { status, headers: { "content-type": "text/html; charset=utf-8" } });
    if (u.pathname === "/") return html(home(b));
    if (u.pathname === "/items")
      return html(layout("항목", `<h1>항목</h1><ul id="list">${items.map((i) => `<li>${i.name}</li>`).join("")}</ul><p id="count"></p><a href="/">홈으로</a>`, `fetch('/api/items').then(r=>r.json()).then(j=>{document.querySelector('#count').textContent='총 '+j.length+'개';});`));
    if (u.pathname === "/upload")
      return html(layout("업로드", `<h1>업로드</h1><input id="file" type="file" accept=".csv,text/csv" aria-label="파일 선택"><button id="send">올리기</button><div id="up-out"></div>`, `
const $=(s)=>document.querySelector(s);
$('#send').onclick=async()=>{const f=$('#file').files[0];if(!f){$('#up-out').textContent='파일을 고르세요';return;}const fd=new FormData();fd.append('file',f);const r=await fetch('/api/upload',{method:'POST',body:fd});const j=await r.json().catch(()=>({}));$('#up-out').textContent=r.ok?('업로드 완료 '+j.name):'업로드 실패';};
`));
    if (u.pathname === "/admin/audit")
      return html(layout("감사 로그", `<h1>감사 로그</h1><button id="refresh-audit">새로고침</button><div id="audit-out"></div>`, `
const $=(s)=>document.querySelector(s);
fetch('/api/audit').then(r=>r.json()).then(j=>{$('#audit-out').textContent='기록 '+j.length+'건';});
$('#refresh-audit').onclick=()=>fetch('/api/audit');
`));
    if (u.pathname === "/files/report.csv")
      return new Response(b.downloadEmpty ? "" : "id,name\n1,샘플 항목 A\n2,샘플 항목 B\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="report.csv"' } });
    if (u.pathname === "/api/upload" && req.method === "POST") {
      const fd = await req.formData();
      const f = fd.get("file") as File | null;
      return f ? Response.json({ ok: true, name: f.name, size: f.size }) : new Response("{}", { status: 400 });
    }
    if (u.pathname === "/api/audit") return Response.json([{ at: 1, what: "login" }]);
    if (u.pathname === "/api/health") return Response.json({ status: "ok" });
    if (u.pathname === "/about") return html(layout("소개", `<h1>소개</h1><p>데모 사이트</p>`));
    if (u.pathname === "/reports") return b.brokenLink ? html(layout("404 Not Found", "<h1>찾을 수 없음</h1>"), 404) : html(layout("리포트", "<h1>리포트</h1>"));
    if (u.pathname === "/logout") return html(layout("로그아웃", "<h1>로그아웃됨</h1>"));
    if (u.pathname === "/api/stats") return b.statsApi ? new Response('{"error":"boom"}', { status: 500 }) : Response.json({ count: items.length });
    if (u.pathname === "/api/signup" && req.method === "POST") {
      const j = JSON.parse((await req.text()) || "{}");
      if (!j.email) return new Response("{}", { status: 400 });
      items.push({ id: items.length + 1, name: `가입자 ${j.email}` });
      return Response.json({ ok: true });
    }
    if (u.pathname === "/api/items" && req.method === "DELETE") {
      items = [];
      return Response.json({ ok: true });
    }
    if (u.pathname === "/api/items") return Response.json(items);
    if (u.pathname === "/api/reset" && req.method === "POST") {
      items = seed();
      return Response.json({ ok: true, items: items.length });
    }
    if (u.pathname === "/favicon.ico") return new Response("", { status: 204 });
    return html("not found", 404);
  },
});
console.log(`demo site on http://127.0.0.1:${port} (project dir: ${dir}${existsSync(join(dir, "bugs.json")) ? "" : ", bugs.json 없음"})`);
