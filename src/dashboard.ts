import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { normalize, resolve, sep } from "node:path";
import { Project } from "./store.ts";
import type { CaseResult, RoundMeta } from "./types.ts";
import { trend } from "./report.ts";
import { FLOW_CSS, flowChartSvg, issueFlow, issueHistoryHtml } from "./charts.ts";
import { runningRound } from "./round.ts";
import { isIssue } from "./issues.ts";
import { addComment, notifyTester, readComments } from "./comments.ts";
import { triggerResponder } from "./responder.ts";
import { exportReport } from "./export.ts";
import { byLang, lang, setLang, tx, inLangScope } from "./i18n.ts";

const MIME: Record<string, string> = { html: "text/html; charset=utf-8", png: "image/png", jpg: "image/jpeg", webm: "video/webm", mp4: "video/mp4", mov: "video/quicktime", txt: "text/plain; charset=utf-8", json: "application/json", md: "text/plain; charset=utf-8", zip: "application/zip", ndjson: "text/plain", pdf: "application/pdf", csv: "text/csv; charset=utf-8" };

function state(project: Project, roundId?: string, role: "owner" | "viewer" = "viewer") {
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
    skip: results.filter((r) => r.status === "SKIP" || (r.status === "NA" && !r.toolError && !r.blockedBy)).length,
    toolError: results.filter((r) => r.status === "NA" && r.toolError).length,
    blocked: results.filter((r) => r.status === "NA" && r.blockedBy).length,
    warn: results.filter((r) => r.status === "PASS" && r.warnings.length).length,
  };
  return {
    project: project.root,
    counts,
    comments: readComments(project),
    role,
    responder: project.config().responder.mode,
    rounds: rounds.map((r) => ({ id: r.id, status: r.status, scope: r.scope, summary: r.summary })),
    round: cur ?? null,
    running: !!running && running.id === cur?.id,
    progress: { done: results.length, total: caseTotal, current: last ? { id: last.case, title: last.title } : null },
    results: results.map((r) => ({ id: r.id, title: r.title, status: r.status, reason: r.reason, warnings: r.warnings.length, ms: r.durationMs, video: r.video, priority: r.priority })),
    events,
    trend: trend(project),
    // 이슈 흐름 그래프와 이슈 목록(라운드별 이력): 보고서와 같은 그림을 서버에서 만들어 보낸다(끝난 라운드만)
    flow: (() => {
      const f = issueFlow(project);
      return { chart: flowChartSvg(f.rounds), history: issueHistoryHtml(f) };
    })(),
    feedback: project.feedback().filter((f) => f.status === "pending"),
    hasReport: !!cur && existsSync(project.p("rounds", cur.id, "report.html")),
    notice: tx("영상과 스크린샷에 화면이 그대로 남습니다. 테스트 데이터와 테스트 계정만 입력하세요.", "Videos and screenshots record the screen as it is. Enter only test data and test accounts."),
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
export function dashboardToken(project: Project, rotate = false, kind: "viewer" | "owner" = "viewer"): string {
  const file = project.p(kind === "owner" ? "dashboard-owner-token" : "dashboard-token");
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

const deny = () =>
  `<!doctype html><meta charset="utf-8"><title>${tx("접속 토큰 필요", "Access token required")}</title><body style="font:15px sans-serif;margin:3rem"><h2>${tx("접속 토큰이 필요합니다", "An access token is required")}</h2><p>${tx("e2e-loop 가 알려 준 접속 주소(토큰이 붙은 주소)로 들어오세요.", "Open the access address that e2e-loop gave you (the address with the token).")}</p>`;

export interface DashboardInfo {
  port: number;
  host: string;
  /** 토큰 없는 기본 주소 */
  url: string;
  /** 토큰이 붙은 접속 주소(비밀로 다룬다) */
  access_url: string;
  token: string;
  /** 오너 토큰(AI 의 주인만 안다. 수정 지시를 보낼 수 있다) */
  ownerToken: string;
  /** 오너 전용 접속 주소 */
  owner_url: string;
  /** 내부망 IP 로 띄웠는가 */
  lan: boolean;
  alternatives: string[];
  warn?: string;
  stop: () => void;
}

export function startDashboard(project: Project, preferred?: number, opts: { host?: string; ifaces?: ReturnType<typeof networkInterfaces>; rotateToken?: boolean; rotateOwnerToken?: boolean } = {}): DashboardInfo {
  const base = preferred ?? project.config().dashboardPort;
  const lans = lanAddresses(opts.ifaces);
  const want = opts.host ?? project.config().dashboardHost;
  if (want && !lans.some((l) => l.address === want) && !/^(192\.168\.|10\.)/.test(want)) throw new Error(tx(`dashboardHost 는 내부망 주소(192.168.x.x · 10.x.x.x)여야 합니다: ${want}`, `dashboardHost must be an internal network address (192.168.x.x or 10.x.x.x): ${want}`));
  const host = want ?? lans[0]?.address ?? "127.0.0.1";
  const lan = host !== "127.0.0.1";
  const token = dashboardToken(project, opts.rotateToken);
  const ownerToken = dashboardToken(project, opts.rotateOwnerToken, "owner");
  const fails = new Map<string, number[]>();
  const commentHits = new Map<string, number[]>();
  const exportHits = new Map<string, number[]>();
  let server: ReturnType<typeof Bun.serve> | undefined;
  for (let port = base; port < base + 30 && !server; port++) {
    try {
      server = Bun.serve({
        port,
        hostname: host,
        fetch(req, srv) {
          // 현황판은 다른 프로젝트의 도구 호출과 한 프로세스를 같이 쓸 수 있다: 요청마다 자기 언어 칸에서 이 프로젝트의 언어로 그린다
          return inLangScope(() => {
          setLang(project.config().lang);
          const u = new URL(req.url);
          const ip = srv.requestIP(req)?.address ?? "?";
          const now = Date.now();
          const recent = (fails.get(ip) ?? []).filter((t) => now - t < 60000);
          if (recent.length >= 20) return new Response("too many attempts", { status: 429 });
          const given = u.searchParams.get("token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? cookieOf(req, "e2e_token") ?? "";
          // 역할은 어느 토큰으로 들어왔는지로 서버가 정한다(오너 토큰은 AI 의 주인만 안다)
          const role: "owner" | "viewer" | null = !given ? null : safeEq(given, ownerToken) ? "owner" : safeEq(given, token) ? "viewer" : null;
          if (!role) {
            fails.set(ip, [...recent, now]);
            return new Response(deny(), { status: 401, headers: { "content-type": MIME.html!, "cache-control": "no-store" } });
          }
          // 토큰이 주소에 실려 왔으면 쿠키로 바꿔 심고 주소에서 지운다(영상·이미지 요청도 쿠키로 통과)
          if (u.searchParams.has("token")) {
            u.searchParams.delete("token");
            return new Response(null, { status: 302, headers: { location: u.pathname + (u.search || ""), "set-cookie": `e2e_token=${role === "owner" ? ownerToken : token}; Path=/; HttpOnly; SameSite=Strict`, "cache-control": "no-store" } });
          }
          if (u.pathname === "/") return new Response(page(), { headers: { "content-type": MIME.html!, "cache-control": "no-store" } });
          if (u.pathname === "/api/comments" && req.method === "POST") {
            // 코멘트: JSON 만 받고, 우리 페이지가 붙이는 헤더가 있어야 하며, 다른 사이트에서 온 요청은 막는다
            if (!/^application\/json/i.test(req.headers.get("content-type") ?? "")) return Response.json({ error: tx("JSON 만 받습니다", "Only JSON is accepted") }, { status: 415 });
            if (req.headers.get("x-e2e-comment") !== "1") return Response.json({ error: tx("허용되지 않은 요청", "Request not allowed") }, { status: 403 });
            const origin = req.headers.get("origin");
            if (origin) {
              try {
                if (new URL(origin).host !== u.host) return Response.json({ error: tx("다른 출처의 요청", "Request from another origin") }, { status: 403 });
              } catch {
                return Response.json({ error: tx("잘못된 출처", "Invalid origin") }, { status: 403 });
              }
            }
            const recentC = (commentHits.get(ip) ?? []).filter((t) => now - t < 60000);
            if (recentC.length >= 10) return Response.json({ error: tx("코멘트를 너무 자주 달고 있습니다. 잠시 뒤에 다시 하세요", "Too many comments. Try again in a moment") }, { status: 429 });
            return req.text().then((raw) => {
              if (raw.length > 6000) return Response.json({ error: tx("너무 깁니다", "Too long") }, { status: 413 });
              try {
                const b = JSON.parse(raw);
                const c = addComment(project, { case: String(b.case ?? ""), text: String(b.text ?? ""), author: String(b.author ?? ""), round: typeof b.round === "string" ? b.round : undefined, role, instruct: b.instruct === true });
                commentHits.set(ip, [...recentC, Date.now()]);
                // 자동 응답이 켜져 있으면 일회용 AI 가, 꺼져 있으면 테스터 세션 터미널 알림이 맡는다
                if (project.config().responder.mode === "off") void notifyTester(project).catch(() => {});
                else triggerResponder(project);
                return Response.json(c, { status: 201 });
              } catch (e: any) {
                return Response.json({ error: String(e?.message ?? e) }, { status: 400 });
              }
            });
          }
          if (u.pathname === "/api/export" && req.method === "GET") {
            // 보고서 내보내기: format = pdf · html(한 파일) · issues · history · rounds(엑셀용 CSV 세 가지)
            const recentE = (exportHits.get(ip) ?? []).filter((t) => now - t < 60000);
            if (recentE.length >= 10) return Response.json({ error: tx("내보내기를 너무 자주 했습니다. 잠시 뒤에 다시 하세요", "Too many exports. Try again in a moment") }, { status: 429 });
            exportHits.set(ip, [...recentE, now]);
            const fmt = u.searchParams.get("format") ?? "";
            const kind = fmt === "pdf" ? "pdf" : fmt === "html" ? "html" : ["issues", "history", "rounds"].includes(fmt) ? "csv" : null;
            if (!kind) return Response.json({ error: tx("format 은 pdf · html · issues · history · rounds 중 하나", "format must be one of pdf, html, issues, history, rounds") }, { status: 400 });
            return exportReport(project, { round: u.searchParams.get("round") ?? undefined, formats: [kind] }).then(
              (r) => {
                const file = kind === "pdf" ? r.files.pdf! : kind === "html" ? r.files.html! : r.files.csv![fmt as "issues" | "history" | "rounds"];
                const ext = file.split(".").pop()!;
                const res = fileResponse(file, req, ext);
                res.headers.set("content-disposition", `attachment; filename="${file.split(sep).pop()!.replace(/[^\w.-]/g, "_")}"`);
                return res;
              },
              (e: any) => Response.json({ error: String(e?.message ?? e) }, { status: 400 }),
            );
          }
          if (u.pathname === "/api/state") return Response.json(state(project, u.searchParams.get("round") ?? undefined, role), { headers: { "cache-control": "no-store" } });
          if (u.pathname.startsWith("/files/")) {
            const rel = decodeURIComponent(u.pathname.slice(7));
            const root = resolve(project.p("rounds"));
            const full = normalize(resolve(root, rel));
            if (full !== root && !full.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
            if (!existsSync(full) || !statSync(full).isFile()) return new Response("not found", { status: 404 });
            return fileResponse(full, req, full.split(".").pop() ?? "");
          }
          return new Response("not found", { status: 404 });
          });
        },
      });
    } catch {}
  }
  if (!server) throw new Error(tx("대시보드 포트를 잡지 못했습니다(", "Could not get a dashboard port (") + base + "~" + (base + 29) + ")");
  const url = `http://${host}:${server.port}`;
  const access_url = `${url}/?token=${token}`;
  project.writeJson("dashboard.json", { port: server.port, host, pid: process.pid, url, lan });
  return {
    port: server.port!, host, url, access_url, token, ownerToken, owner_url: `${url}/?token=${ownerToken}`, lan,
    alternatives: lans.filter((l) => l.address !== host).map((l) => `http://${l.address}:${server!.port}`),
    warn: lan ? undefined : tx("내부망 IP(192.168.x.x · 10.x.x.x)를 찾지 못해 이 컴퓨터에서만 접속됩니다. 같은 망의 다른 기기에서 보려면 네트워크에 연결한 뒤 다시 띄우세요.", "No internal network IP (192.168.x.x or 10.x.x.x) was found, so the dashboard opens only on this computer. To view it from another device on the same network, connect to the network and start the dashboard again."),
    stop: () => server!.stop(true),
  };
}

// 주의: 한글이 든 HTML 은 String.raw 로 쓰지 않는다. Bun 이 String.raw 안의 한글을 유니코드 이스케이프 글자로 바꿔 화면에 그대로 찍힌다.
// 요청마다 지금 언어로 그린다. 클라이언트 JS 가 쓰는 글은 작은따옴표 문자열에 끼우지 않고 JSON 객체(T) 하나로 넣는다.
/** 클라이언트 JS 가 쓰는 글(언어별) */
const clientText = byLang({
  ko: { running: "진행 중", finished: "완료", aborted: "중단", idle: "대기", owner: "🔑 오너 모드", cases: " 케이스", data: " · 데이터 ", fb: "다음 회차에 적용할 요청 ", found: " · 찾음 ", fdone: " ✔ 기능 완료", fpA: " · 케이스 ", fpB: "건 모두 통과", warnA: "경고 ", warnB: "", video: "▶ 영상", wait: " · 답 대기 ", ownerBadge: "오너", instruct: "🔧 수정 지시", st: { open: "답 대기", answered: "AI 답변함", resolved: "정리됨" }, ai: "AI", user: "사용자", name: "이름(선택)", phOwner: "오너로 코멘트합니다. 아래 “수정 지시”를 체크하면 AI 가 코드를 고칩니다", phViewer: "이 이슈에 코멘트를 남기면 AI 가 읽고 대응합니다", instLabel: " 🔧 수정 지시(AI 가 코드를 고침)", send: "코멘트 달기", empty: "내용을 적어 주세요", fail: "실패", sendFail: "보내지 못했습니다" },
  en: { running: "Running", finished: "Finished", aborted: "Stopped", idle: "Waiting", owner: "🔑 Owner mode", cases: " cases", data: " · data ", fb: "Request for the next round ", found: " · found ", fdone: " ✔ Feature done", fpA: " · all cases passed (", fpB: ")", warnA: "warnings: ", warnB: "", video: "▶ video", wait: " · awaiting reply ", ownerBadge: "owner", instruct: "🔧 fix instruction", st: { open: "awaiting reply", answered: "AI replied", resolved: "resolved" }, ai: "AI", user: "user", name: "Name (optional)", phOwner: "You comment as the owner. Check “fix instruction” below and the AI fixes the code", phViewer: "Leave a comment on this issue and the AI reads it and responds", instLabel: " 🔧 Fix instruction (the AI fixes the code)", send: "Add comment", empty: "Write a comment first", fail: "Failed", sendFail: "Could not send" },
});

const page = () => {
  const T = clientText();
  return `<!doctype html><html lang="${lang()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${tx("E2E 실시간", "E2E live")}</title>
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
${FLOW_CSS}
.exp{font-size:12px;color:var(--mut)}
.fb{background:#fff3cd;color:#664d03;border-radius:6px;padding:6px 10px;margin-top:6px;font-size:12px}a{color:var(--acc)}
.wide{grid-column:1/-1}.tabs button.on{background:var(--acc);color:#fff}.badge{background:var(--acc);color:#fff;border-radius:99px;padding:1px 8px;font-size:11px;font-weight:700}.badge.ins{background:var(--warn)}.cm.own{border-left-color:var(--acc)}.inst{display:flex;align-items:center;gap:4px;font-size:12px;margin:4px 0;white-space:nowrap}.cf input[type=checkbox]{width:auto}.cmrow td{background:var(--card)}.cm{border-left:3px solid var(--line);padding:2px 10px;margin:6px 0}.cm .rp{margin:4px 0 4px 14px;border-left:3px solid var(--acc);padding-left:8px}.cm .txt{white-space:pre-wrap}.mut{color:var(--mut);font-size:12px}.cf{display:flex;gap:6px;flex-wrap:wrap;align-items:flex-start;margin-top:6px}.cf textarea{flex:1;min-width:240px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font:inherit}.cf input{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px;width:120px}.note{background:#fff3cd;color:#664d03;padding:6px 16px;font-size:12px}.s.FLAKY{background:var(--warn)}.s.BLOCKED{background:var(--fail)}
</style></head><body>
<div class="note" id="notice"></div>
<header><h1>${tx("E2E 실시간 대시보드", "E2E live dashboard")}</h1><span id="who" class="badge" style="display:none"></span><span id="proj" style="color:var(--mut)"></span><select id="sel"></select><span id="st" class="pill"></span><a id="rep" style="display:none" target="_blank">${tx("결과 보고서 열기", "Open the result report")}</a><span id="exp" class="exp" style="display:none">${tx("내보내기", "Export")}: <a data-x="pdf" download>PDF</a> · <a data-x="html" download>${tx("HTML(한 파일)", "HTML (one file)")}</a> · ${tx("엑셀용 CSV", "CSV for Excel")} <a data-x="issues" download>${tx("이슈 목록", "Issue list")}</a> <a data-x="history" download>${tx("이슈 이력", "Issue history")}</a> <a data-x="rounds" download>${tx("라운드별 수", "Counts per round")}</a></span></header>
<main>
<section class="card"><h2>${tx("진행", "Progress")}</h2><div class="bar"><i id="bar" style="width:0"></i></div><div id="prog" style="margin:6px 0"></div>
<div class="cnt"><div><b id="cp" class="ok">0</b>${tx("통과", "Passed")}</div><div><b id="cf" class="fail">0</b>${tx("이슈", "Issues")}</div><div><b id="cs">0</b>${tx("스킵·해당 없음", "Skipped / not applicable")}</div><div><b id="ct" style="color:var(--warn)">0</b>${tx("도구 오류(NA)", "Tool error (NA)")}</div><div><b id="cb" style="color:var(--warn)">0</b>${tx("선행 결함에 막힘", "Blocked by a prior defect")}</div><div><b id="cw" style="color:var(--warn)">0</b>${tx("경고", "Warnings")}</div></div>
<div id="cur" style="font-weight:600"></div><div id="fbs"></div></section>
<section class="card live"><h2>${tx("지금 화면", "Current screen")}</h2><img id="live" alt="${tx("아직 화면이 없습니다", "No screen yet")}"></section>
<section class="card"><h2>${tx("이슈 흐름 (라운드별 · 0 에 수렴하면 종료)", "Issue flow (per round · ends when it reaches 0)")}</h2><div id="tr"></div></section>
<section class="card"><h2>${tx("실시간 로그", "Live log")}</h2><div id="feed"></div></section>
<section class="card wide"><h2>${tx("이슈 목록 — 라운드별 이력", "Issue list — history per round")}</h2><div id="hist"></div></section>
<section class="card wide"><h2>${tx("케이스", "Cases")} <span class="tabs"><button data-f="all" class="on">${tx("전체", "All")}</button> <button data-f="issue">${tx("이슈", "Issues")}</button> <button data-f="PASS">${tx("통과", "Passed")}</button> <button data-f="other">${tx("스킵·기타", "Skipped / other")}</button></span></h2><table><thead><tr><th>${tx("상태", "Status")}</th><th>${tx("케이스", "Case")}</th><th>${tx("사유", "Reason")}</th><th>${tx("영상", "Video")}</th></tr></thead><tbody id="rows"></tbody></table></section>
</main>
<script>
const T=${JSON.stringify(T)};
let round=null,filter='all',last=null;const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
$('sel').onchange=e=>{round=e.target.value;tick()};
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{filter=b.dataset.f;document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x===b));draw()});
let sig='';async function tick(){try{const r=await fetch('/api/state'+(round?'?round='+round:''));const j=await r.json();const sg=JSON.stringify(j);if(sg===sig)return;sig=sg;last=j;draw()}catch(e){}}
function draw(){const s=last;if(!s)return;$('proj').textContent=s.project;
const sel=$('sel');if(sel.options.length!==s.rounds.length){sel.innerHTML=s.rounds.map(r=>'<option>'+r.id+'</option>').join('')}if(s.round&&!round)sel.value=s.round.id;
const st=$('st');const rs=s.round?s.round.status:'';st.textContent=rs==='running'?T.running:rs==='finished'?T.finished:rs==='aborted'?T.aborted:T.idle;st.className='pill '+rs;
const rep=$('rep');if(s.hasReport){rep.style.display='';rep.href='/files/'+s.round.id+'/report.html'}else rep.style.display='none';
const exp=$('exp');if(s.round&&s.round.status!=='running'&&s.progress.done){exp.style.display='';exp.querySelectorAll('a').forEach(a=>a.href='/api/export?round='+encodeURIComponent(s.round.id)+'&format='+a.dataset.x)}else exp.style.display='none';
$('notice').textContent=s.notice;$('who').textContent=s.role==='owner'?T.owner:'';$('who').style.display=s.role==='owner'?'':'none';$('cp').textContent=s.counts.pass;$('cf').textContent=s.counts.issue;$('cs').textContent=s.counts.skip;$('ct').textContent=s.counts.toolError;$('cb').textContent=s.counts.blocked;$('cw').textContent=s.counts.warn;
const pr=s.progress;$('bar').style.width=pr.total?Math.round(pr.done/pr.total*100)+'%':'0';$('prog').textContent=pr.done+' / '+pr.total+T.cases+(s.round?' · '+s.round.driver+T.data+s.round.data.decision:'');
$('cur').textContent=s.running&&pr.current?'▶ '+pr.current.id+' '+pr.current.title:'';
$('fbs').innerHTML=(s.feedback||[]).map(f=>'<div class="fb">'+T.fb+esc(f.id)+': '+esc(f.text)+'</div>').join('');
if(s.round){$('live').src='/files/'+s.round.id+'/live.png?t='+Date.now()}
if($('tr').dataset.v!==s.flow.chart){$('tr').innerHTML=s.flow.chart;$('tr').dataset.v=s.flow.chart}if($('hist').dataset.v!==s.flow.history){$('hist').innerHTML=s.flow.history;$('hist').dataset.v=s.flow.history}
$('feed').innerHTML=s.events.slice().reverse().map(e=>{const t=new Date(e.t).toLocaleTimeString();
if(e.type==='step')return '<div class="'+(e.status==='ok'?'ok':'fail')+'">'+t+' '+esc(e.case)+' · '+esc(e.desc)+(e.found?T.found+esc(e.found):'')+(e.error?' ✗ '+esc(e.error):'')+'</div>';
if(e.type==='wait-log')return '<div class="skip">'+t+' ⏳ '+esc(e.case)+' · '+esc(e.line)+'</div>';
if(e.type==='feature-pass')return '<div class="ok"><b>'+t+T.fdone+'</b> '+esc(e.feature)+' ('+esc(e.screen)+')'+T.fpA+e.cases+T.fpB+'</div>';
if(e.type==='case-start')return '<div><b>'+t+' ▶ '+esc(e.case)+'</b> '+esc(e.title)+'</div>';
if(e.type==='case-end')return '<div class="'+(e.status==='PASS'?'ok':e.status==='FAIL'?'fail':'skip')+'"><b>'+t+' '+esc(e.status)+'</b> '+esc(e.case)+(e.reason?' — '+esc(e.reason):'')+'</div>';
return '<div>'+t+' '+esc(e.type)+(e.round?' '+esc(e.round):'')+'</div>'}).join('');
const isI=r=>['FAIL','FLAKY','BLOCKED'].includes(r.status);const rows=s.results.filter(r=>filter==='all'||(filter==='issue'?isI(r):filter==='other'?(!isI(r)&&r.status!=='PASS'):r.status===filter));
const cm=s.comments||[];const byCase={};cm.forEach(c=>{(byCase[c.case]=byCase[c.case]||[]).push(c)});
const keep=document.activeElement&&document.activeElement.dataset&&document.activeElement.dataset.draft;
$('rows').innerHTML=rows.slice().reverse().map(r=>{const list=byCase[r.id]||[];const open=openPanels.has(r.id);const canC=isI(r)||list.length;
const wait=list.filter(c=>c.status==='open').length;
let h='<tr><td><span class="s '+r.status+'">'+r.status+'</span></td><td><b>'+esc(r.id)+'</b> '+esc(r.title)+(r.priority?' <b class="fail">'+r.priority+'</b>':'')+'</td><td>'+esc(r.reason||'')+(r.warnings?' <span style="color:var(--warn)">'+T.warnA+r.warnings+T.warnB+'</span>':'')+'</td><td>'+(r.video?'<a target="_blank" href="/files/'+s.round.id+'/'+r.video+'">'+T.video+'</a> ':'')+(canC?'<button data-toggle="'+esc(r.id)+'">💬 '+list.length+(wait?T.wait+wait:'')+'</button>':'')+'</td></tr>';
if(open&&canC){h+='<tr class="cmrow"><td colspan="4">'+list.map(c=>'<div class="cm'+(c.role==='owner'?' own':'')+'"><b>'+(c.role==='owner'?'🔑 ':'')+esc(c.author)+'</b>'+(c.role==='owner'?' <span class="badge">'+T.ownerBadge+'</span>':'')+(c.instruct?' <span class="badge ins">'+T.instruct+'</span>':'')+' <span class="mut">'+new Date(c.createdAt).toLocaleString()+' · '+(T.st[c.status])+'</span><div class="txt">'+esc(c.text)+'</div>'+c.replies.map(x=>'<div class="rp"><b>'+(x.by==='ai'?T.ai:T.user)+'</b> <span class="mut">'+new Date(x.at).toLocaleString()+'</span><div class="txt">'+esc(x.text)+'</div></div>').join('')+'</div>').join('')+'<div class="cf"><input data-draft="a-'+esc(r.id)+'" placeholder="'+T.name+'" maxlength="40" value="'+esc(drafts['a-'+r.id]??localStorage.getItem('e2e_author')??'')+'"><textarea data-draft="t-'+esc(r.id)+'" rows="2" maxlength="2000" placeholder="'+(s.role==='owner'?T.phOwner:T.phViewer)+'">'+esc(drafts['t-'+r.id]??'')+'</textarea>'+(s.role==='owner'?'<label class="inst"><input type="checkbox" data-inst="'+esc(r.id)+'"'+(drafts['i-'+r.id]?' checked':'')+'>'+T.instLabel+'</label>':'')+'<button data-send="'+esc(r.id)+'">'+T.send+'</button> <span class="mut" id="msg-'+esc(r.id)+'"></span></div></td></tr>'}
return h}).join('');
if(keep){const el=document.querySelector('[data-draft="'+keep+'"]');if(el){el.focus();try{el.setSelectionRange(el.value.length,el.value.length)}catch(e){}}}}
const openPanels=new Set(),drafts={};
$('rows').addEventListener('input',e=>{const d=e.target.dataset&&e.target.dataset.draft;if(d)drafts[d]=e.target.value;if(e.target.dataset&&e.target.dataset.inst)drafts['i-'+e.target.dataset.inst]=e.target.checked});
$('rows').addEventListener('click',async e=>{const t=e.target;if(t.dataset&&t.dataset.toggle){const id=t.dataset.toggle;openPanels.has(id)?openPanels.delete(id):openPanels.add(id);draw();return}
if(t.dataset&&t.dataset.send){const id=t.dataset.send;const text=(drafts['t-'+id]||'').trim();const author=(drafts['a-'+id]??localStorage.getItem('e2e_author')??'').trim();const msg=document.getElementById('msg-'+id);
if(!text){msg.textContent=T.empty;return}
try{const r=await fetch('/api/comments',{method:'POST',headers:{'content-type':'application/json','x-e2e-comment':'1'},body:JSON.stringify({case:id,text,author,round:last&&last.round?last.round.id:undefined,instruct:!!drafts['i-'+id]})});const j=await r.json();if(!r.ok){msg.textContent=j.error||T.fail;return}
if(author)localStorage.setItem('e2e_author',author);drafts['t-'+id]='';drafts['i-'+id]=false;await tick()}catch(err){msg.textContent=T.sendFail}}});
tick();setInterval(tick,1200);
</script></body></html>`;
};
