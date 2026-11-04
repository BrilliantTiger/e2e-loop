// 영어판 시험: 출력 언어(lang=en)이면 보고서·AI용 시트·제외 시트·CSV·현황판·도구 응답·판정 사유·MCP 도구 설명·CLI 도움말에 한글이 남지 않는지,
// 한국어(기본)는 그대로인지, 자기 메시지를 다시 읽는 곳이 두 언어 모두에서 맞는지 확인한다. 영어 라운드는 버그를 심은 영어 사이트로 실제로 돌린다.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as A from "../src/actions.ts";
import { Project } from "../src/store.ts";
import { defaultLang, inLangScope, lang, langTable, parseLang, resetDefaultLang, setLang, tx } from "../src/i18n.ts";
import { writeSheets } from "../src/sheets.ts";
import { exportReport } from "../src/export.ts";
import { fixHint } from "../src/report.ts";
import { completeCheck } from "../src/gate.ts";
import { lanAddresses, startDashboard } from "../src/dashboard.ts";
import type { CaseResult, RoundMeta } from "../src/types.ts";

const HANGUL = /[ㄱ-ㆎ가-힣]/;
/** 한글이 든 줄을 보여 준다(실패했을 때 어디인지 알 수 있게) */
const hangulLines = (s: string) => s.split(/\r?\n/).filter((l) => HANGUL.test(l)).slice(0, 8);
const noHangul = (label: string, s: string) => expect({ label, lines: hangulLines(s) }).toEqual({ label, lines: [] });
/** 도구 응답(객체)에 한글이 없는지. 설정의 사이트 글자 패턴(logoutPattern 등 — 사이트의 「로그아웃」 같은 글자를 찾는 정규식)은 뺀다 */
const noHangulReply = (label: string, o: unknown) => noHangul(label, JSON.stringify(o, (k, v) => (/Pattern$/.test(k) ? undefined : v), 1));

afterEach(() => setLang(undefined));
const CLI = join(import.meta.dir, "../src/cli.ts");
const MCP = join(import.meta.dir, "../src/mcp.ts");

test("언어 고르기: 기본은 한국어, 환경변수 E2E_LOOP_LANG 이 기본을 바꾸고, 프로젝트 설정(setLang)이 그보다 앞선다. 모르는 값은 거부한다", () => {
  expect(defaultLang()).toBe("ko"); // 시험은 preload 로 한국어 기본
  expect(tx("가", "a")).toBe("가");
  const keep = process.env.E2E_LOOP_LANG;
  try {
    process.env.E2E_LOOP_LANG = "en";
    resetDefaultLang();
    expect(lang()).toBe("en");
    setLang("ko");
    expect(tx("가", "a")).toBe("가");
    setLang(undefined);
    expect(tx("가", "a")).toBe("a");
  } finally {
    process.env.E2E_LOOP_LANG = keep;
    resetDefaultLang();
  }
  expect(parseLang(" EN ")).toBe("en");
  expect(() => parseLang("fr")).toThrow("fr");
});

test("언어별 표(langTable): 읽을 때마다 지금 언어의 값을 고르고, 키 목록·in 도 따른다", () => {
  const T = langTable({ ko: { a: "가", b: "나" } as Record<string, string>, en: { a: "A", b: "B" } as Record<string, string> });
  expect(T.a).toBe("가");
  setLang("en");
  expect(T.a).toBe("A");
  expect(Object.entries(T)).toEqual([["a", "A"], ["b", "B"]]);
  expect("b" in T).toBe(true);
  expect({ ...T }).toEqual({ a: "A", b: "B" });
});

test("e2e_init·e2e_prestart 의 lang 이 프로젝트 설정에 남고, 그 프로젝트를 여는 도구는 그 언어로 답한다", async () => {
  const root = mkdtempSync(join(tmpdir(), "e2e-loop-i18n-"));
  noHangulReply("init", await A.aInit({ project: root, lang: "en" } as any));
  expect(new Project(root).config().lang).toBe("en");
  setLang(undefined);
  noHangulReply("status", A.aStatus({ project: root }));
  noHangulReply("prestart", A.aPrestart({ project: root }));
  noHangulReply("complete", A.aCompleteCheck({ project: root }));
  expect(() => A.aPrestart({ project: root, lang: "xx" })).toThrow("xx");
  A.aPrestart({ project: root, lang: "ko" });
  expect(JSON.stringify(A.aStatus({ project: root }))).toMatch(HANGUL);
}, 120_000);

test("언어 칸: 동시에 도는 두 호출이 서로 다른 언어를 골라도, await 뒤에도 자기 언어를 지킨다(MCP 호출·현황판 요청)", async () => {
  const gate = Promise.withResolvers<void>();
  const a = inLangScope(async () => {
    setLang("en");
    await gate.promise; // 이 사이에 다른 호출이 한국어로 바꾼다
    return tx("가", "a");
  });
  const b = inLangScope(async () => {
    setLang("ko");
    gate.resolve();
    return tx("가", "a");
  });
  expect(await Promise.all([a, b])).toEqual(["a", "가"]);
  expect(lang()).toBe("ko"); // 칸 밖(프로세스 값)은 건드리지 않음
});

// ---------- 결과물(가짜 라운드) ----------

const res = (id: string, status: CaseResult["status"], over: Partial<CaseResult> = {}): CaseResult => ({ id, title: "Case " + id, type: "spec", status, warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 3, startedAt: "", source_ref: "Plan 1.1", ...over });
const meta = (id: string, over: Partial<RoundMeta> = {}): RoundMeta => ({ id, n: Number(id.slice(1)), status: "finished", startedAt: "2026-11-04T00:00:00Z", finishedAt: "2026-11-04T00:10:00Z", driver: "playwright+chromium", headless: true, data: { decision: "keep", scope: "round" }, scope: "full", caseHash: "", caseCount: 8, code: { head: "abc1234" }, baseUrl: "http://site.test", ...over });
const steps = (err?: string) => [{ i: 0, op: "goto", desc: "goto /", status: "ok" as const, ms: 5 }, { i: 1, op: "click", desc: "click #save", status: (err ? "fail" : "ok") as "fail" | "ok", ms: 7, error: err, measure: { verdict: "freeze" as const, summary: "1200 ms", why: "long task" } }];

function englishProject() {
  const p = new Project(mkdtempSync(join(tmpdir(), "e2e-loop-i18n-")));
  p.ensure();
  p.saveConfig({ ...p.config(), lang: "en", baseUrl: "http://site.test" });
  p.saveCases([
    { id: "c1", title: "Case c1", type: "spec", source_ref: "Plan 1.1", screen: "/", feature: "Home", chapter: "C1", steps: [{ op: "goto", url: "/" }, { op: "click", sel: "#save" }] },
    { id: "c5", title: "Case c5", type: "spec", source_ref: "Plan 2.1", screen: "/list", feature: "List", chapter: "C2", requires: ["C1"], steps: [{ op: "goto", url: "/list" }, { op: "expect", sel: "h1", text: "List" }] },
  ] as any);
  const r1 = [res("c1", "FAIL", { reason: "text differs: expected \"Saved\" / actual \"Error\"", steps: steps("text differs") }), res("c2", "PASS"), res("c3", "FAIL")];
  p.writeJson("rounds/R01/meta.json", meta("R01", { summary: { PASS: 1, FAIL: 2, FLAKY: 0, BLOCKED: 0, SKIP: 0, NA: 0, total: 3 } as any }));
  p.writeJson("rounds/R01/results.json", r1);
  const r2 = [
    res("c1", "FAIL", { reason: "text differs: expected \"Saved\" / actual \"Error\"", steps: steps("text differs"), pageErrors: ["TypeError: x is undefined"], failedRequests: ["500 GET /api/stats"], warnings: ["slow response"] }),
    res("c2", "FLAKY", { reason: "timeout", retries: { n: 3, pass: 1, fail: 2, reasons: ["timeout"] } }),
    res("c3", "PASS", { steps: steps() }),
    res("c4", "BLOCKED", { reason: "no basis" }),
    res("c5", "NA", { reason: "blocked", blockedBy: { chapter: "C1", by: ["c1"], detail: "C1 failed" } as any }),
    res("c6", "NA", { reason: "tool error", toolError: { kind: "D", detail: "read before the screen was drawn" } }),
    res("c7", "SKIP", { reason: "destructive action" }),
    res("c8", "PASS", { warnings: ["a warning"] }),
  ];
  const m2 = meta("R02", { summary: { PASS: 2, FAIL: 1, FLAKY: 1, BLOCKED: 1, SKIP: 1, NA: 2, total: 8 } as any });
  p.writeJson("rounds/R02/meta.json", m2);
  p.writeJson("rounds/R02/results.json", r2);
  return { p, m2, r2 };
}

test("영어: 사람용 보고서·AI용 시트(md·json)·제외 시트에 한글이 없다", () => {
  const { p, m2, r2 } = englishProject();
  setLang("en");
  const out = writeSheets(p, m2, r2);
  const dir = p.roundDir("R02");
  noHangul("report.html", readFileSync(out.files.human, "utf8"));
  noHangul("ai-sheet.md", readFileSync(out.files.aiMd, "utf8"));
  noHangul("ai-sheet.json", readFileSync(out.files.aiJson, "utf8"));
  noHangul("excluded_issues.tsv", readFileSync(join(dir, "excluded_issues.tsv"), "utf8"));
  noHangul("excluded_all.tsv", readFileSync(p.p("excluded_all.tsv"), "utf8"));
  expect(readFileSync(out.files.human, "utf8")).toContain('<html lang="en"');
});

test("영어: 내보내기(CSV 세 파일·한 파일 HTML)에 한글이 없다", async () => {
  const { p } = englishProject();
  setLang("en");
  const r = await exportReport(p, { formats: ["csv", "html"] });
  for (const f of [r.files.csv!.issues, r.files.csv!.history, r.files.csv!.rounds, r.files.html!]) noHangul(f, readFileSync(f, "utf8"));
  noHangul("notes", r.notes.join("\n"));
});

test("한국어 기본은 그대로: 같은 라운드를 한국어로 쓰면 한국어 머리말이 나온다", () => {
  const { p, m2, r2 } = englishProject();
  p.saveConfig({ ...p.config(), lang: undefined });
  setLang(undefined);
  const html = readFileSync(writeSheets(p, m2, r2).files.human, "utf8");
  expect(html).toContain("이슈 추이");
  expect(html).toContain('<html lang="ko"');
});

test("자기 메시지를 다시 읽는 곳: 영어 화면에서는 영어 사유와 예전 한국어 기록 모두에 같은 힌트를 고른다(한국어 화면은 예전 그대로 한국어 사유만 본다)", () => {
  const ko = fixHint({ reason: "처리 안 된 JS 오류: TypeError" } as any);
  expect(ko).not.toBe(fixHint({ reason: "something else" } as any));
  // 한국어 화면: 한국어 사유 속 선택자(#modal)가 영어 낱말에 걸려 힌트가 바뀌지 않는다
  expect(fixHint({ reason: "텍스트가 다름: 기대 \"a\" / 실제 \"b\" (#modal)" } as any)).toBe(fixHint({ reason: "텍스트가 다름: 기대 \"a\" / 실제 \"b\" (#x)" } as any));
  setLang("en");
  const en = fixHint({ reason: "Unhandled JS error: TypeError" } as any);
  expect(en).toBe(fixHint({ reason: "처리 안 된 JS 오류: TypeError" } as any)); // 예전 한국어 기록에도 같은 힌트
  expect(en).not.toMatch(HANGUL);
  expect(en).not.toBe(fixHint({ reason: "something else" } as any));
});

test("영어: 완료 판정 사유에 한글이 없다", () => {
  const { p } = englishProject();
  setLang("en");
  const g = completeCheck(p);
  expect(g.complete).toBe(false);
  noHangul("gate", JSON.stringify(g));
});

// ---------- MCP 도구 설명·CLI 도움말 ----------

test("영어: E2E_LOOP_LANG=en 으로 띄운 MCP 서버의 도구 제목·설명·인자 설명에 한글이 없다(한국어 기본은 한국어)", async () => {
  for (const want of ["en", "ko"] as const) {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], env: { ...(process.env as Record<string, string>), E2E_LOOP_LANG: want } }));
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.length).toBeGreaterThan(25);
      const withHangul = tools.filter((t) => HANGUL.test(JSON.stringify(t))).map((t) => t.name);
      if (want === "en") expect(withHangul).toEqual([]);
      else expect(withHangul.length).toBeGreaterThan(20);
    } finally {
      await client.close();
    }
  }
}, 60_000);

test("영어: E2E_LOOP_LANG=en 이면 CLI 도움말에 한글이 없다", async () => {
  const proc = Bun.spawn([process.execPath, CLI, "help"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, E2E_LOOP_LANG: "en" } });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  await proc.exited;
  expect(out).toContain("export");
  noHangul("cli help", out);
});

// ---------- 현황판 ----------

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));
test.skipIf(!lanAddresses().length)("영어: 현황판 화면·상태·토큰 없는 접속 안내에 한글이 없다", async () => {
  const { p } = englishProject();
  const d = startDashboard(p, 7975);
  stops.push(d.stop);
  setLang("ko"); // 다른 프로젝트 일로 프로세스 언어가 바뀌어 있어도, 요청마다 그 프로젝트의 언어로 그린다
  const h = { authorization: `Bearer ${d.token}` };
  const page = await (await fetch(d.url + "/", { headers: h })).text();
  noHangul("dashboard page", page);
  expect(page).toContain('<html lang="en"');
  noHangul("dashboard state", JSON.stringify(await (await fetch(d.url + "/api/state", { headers: h })).json()));
  noHangul("deny", await (await fetch(d.url + "/")).text());
});

// ---------- 실제 영어 라운드 ----------

/** 버그를 심은 영어 사이트: 없는 링크, 500 을 내는 통계 API, 닫히지 않는 모달, 누르면 JS 오류 */
function englishSite(port: number) {
  const page = (body: string, title = "Demo") => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/stats") return new Response("boom", { status: 500 });
      if (u.pathname === "/about") return page(`<h1>About</h1><a href="/">Home</a>`, "About");
      if (u.pathname === "/") {
        return page(`<h1>Dashboard</h1>
<nav><a href="/about">About</a> <a href="/missing">Reports</a></nav>
<form id="signup" onsubmit="event.preventDefault();document.getElementById('msg').textContent='Signed up'"><input name="email" type="email" placeholder="Email"><button type="submit">Sign up</button></form>
<p id="msg"></p>
<button id="stats" onclick="fetch('/api/stats').then(r=>r.ok?r.text():Promise.reject(r.status)).then(t=>document.getElementById('stat-out').textContent=t).catch(()=>{})">Stats</button><p id="stat-out"></p>
<button id="open" onclick="document.getElementById('dlg').style.display='block'">Open details</button>
<div id="dlg" role="dialog" aria-modal="true" style="display:none;position:fixed;inset:20%;background:#fff;border:1px solid #000">Details <button>Close</button></div>
<button id="crash" onclick="window.undefinedFunction()">Export</button>`, "Dashboard");
      }
      return new Response("Not found", { status: 404 });
    },
  });
}

test("영어 라운드(실제 브라우저): 판정 사유·경고·단계 오류·보고서·AI용 시트·제외 시트·도구 응답에 한글이 없다", async () => {
  const port = 4593;
  const server = englishSite(port);
  const root = mkdtempSync(join(tmpdir(), "e2e-loop-i18n-round-"));
  try {
    const base = `http://127.0.0.1:${port}`;
    writeFileSync(join(root, "PLAN.md"), "# Plan\n1.1 Home\n2.1 Stats\n");
    const replies: unknown[] = [];
    // 테스터는 첫 라운드 전에 사용자 언어를 기록한다(SKILL.md). 여기서는 먼저 기록해 세션 시작 응답부터 영어인지 본다
    replies.push(await A.aInit({ project: root, baseUrl: base, driver: "chromium", headless: true, lang: "en", dashboardPort: 7976 } as any));
    replies.push(await A.aSessionStart({ project: root, mode: "here", baseUrl: base, materials: [{ kind: "plan", location: join(root, "PLAN.md"), sections: ["1.1", "2.1"] }] } as any));
    replies.push(A.aPrestart({ project: root, dataPolicy: "keep", maxRounds: 10, login: "none", account: { mode: "none" }, acknowledged: true } as any));
    replies.push(await A.aDiscover({ project: root }));
    replies.push(
      A.aCaseUpsert({
        project: root,
        cases: [
          { id: "SPEC-1", title: "The home page shows the dashboard title", source_ref: "Plan 1.1", screen: "/", feature: "Home", steps: [{ op: "goto", url: "/" }, { op: "expect", sel: "h1", text: "Dashboard" }] },
          { id: "SPEC-2", title: "Stats shows the item count", source_ref: "Plan 2.1", screen: "/", feature: "Stats", steps: [{ op: "goto", url: "/" }, { op: "click", sel: "#stats" }, { op: "expect", sel: "#stat-out", textContains: "items" }] },
          { id: "SPEC-3", title: "The home title is Home", source_ref: "Plan 1.1", screen: "/", feature: "Home", steps: [{ op: "goto", url: "/" }, { op: "expect", sel: "h1", text: "Home" }] },
        ] as any,
      }),
    );
    replies.push(await A.aOsCheck({ project: root }));
    replies.push(A.aSheet({ project: root }));
    const r: any = await A.aRoundStart({ project: root, data: "keep" });
    replies.push(r);
    expect(r.started).toBe(true);
    let st: any;
    do {
      st = await A.aRoundStatus({ project: root, wait_seconds: 30 });
      replies.push(st);
    } while (st.running);
    const p = new Project(root);
    const results = p.readJson<CaseResult[]>(`rounds/${r.round}/results.json`, []);
    expect(results.length).toBeGreaterThan(5);
    expect(results.some((x) => x.status === "FAIL")).toBe(true);
    // 판정 사유·경고·단계 설명·단계 오류·도구 오류 설명
    noHangul("results", results.map((x) => [x.title, x.reason, ...x.warnings, ...x.steps.flatMap((s) => [s.desc, s.error ?? ""]), x.toolError?.detail ?? "", x.blockedBy?.detail ?? ""].join("\n")).join("\n"));
    const dir = p.roundDir(r.round);
    for (const f of ["report.html", "ai-sheet.md", "ai-sheet.json", "excluded_issues.tsv"]) noHangul(f, readFileSync(join(dir, f), "utf8"));
    replies.push(A.aRoundReport({ project: root }), A.aCompleteCheck({ project: root }), A.aStatus({ project: root }), A.aCaseList({ project: root } as any), A.aCoverage({ project: root }));
    const ex = await A.aReportExport({ project: root, formats: ["csv", "html"] });
    replies.push(ex);
    for (const f of readdirSync(ex.dir)) noHangul(f, readFileSync(join(ex.dir, f), "utf8"));
    noHangulReply("tool replies", replies);
    noHangul("sheet.md", readFileSync(p.p("sheet.md"), "utf8"));
  } finally {
    server.stop(true);
  }
}, 300_000);
