// 3단계 시험(브라우저 없음): 코드 분석, 사이트 대조, 상태코드 판정, OS 창 정책, 시트.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeCode, routeRegex } from "../src/analysis/code.ts";
import { reconcile } from "../src/analysis/reconcile.ts";
import { saveAnalyses } from "../src/analysis/store.ts";
import { extraCases } from "../src/analysis/cases.ts";
import { applyOsPolicy, osCheck, osPending } from "../src/analysis/os.ts";
import { statusMatches } from "../src/runner.ts";
import { Project } from "../src/store.ts";
import { aSheet, buildSheet, renderSheetMd, sheetGate } from "../src/sheet.ts";
import { precheck } from "../src/round.ts";
import type { Case, Inventory } from "../src/types.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "e2e-loop-an-"));
const put = (root: string, rel: string, text: string) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const DEMO_SRC = join(import.meta.dir, "../examples/demo-site/src");

test("React Router 소스에서 화면·이벤트·API·다운로드/업로드 후보를 뽑는다", () => {
  const a = analyzeCode(DEMO_SRC);
  expect(a.frameworks).toEqual(["react-router"]);
  const paths = a.routes.map((r) => r.path);
  expect(paths).toEqual(["/", "/items", "/items/:id", "/about", "/reports", "/upload", "/admin/audit"]);
  expect(a.routes.find((r) => r.path === "/items/:id")!.dynamic).toBe(true);
  expect(a.routes.find((r) => r.path === "/admin/audit")!.component).toBe("AuditLog");
  // 이벤트: 파일의 컴포넌트 이름으로 화면에 묶이고, 요소를 찾을 단서(id·testid·글자)를 뽑는다
  const stats = a.events.find((e) => e.hints.id === "stats")!;
  expect(stats.kind).toBe("click");
  expect(stats.route).toBe("/");
  expect(a.events.find((e) => e.hints.testid === "beta-banner-close")!.hints.text).toBe("배너 닫기");
  expect(a.events.find((e) => e.kind === "submit")!.hints.id).toBe("signup");
  expect(a.events.find((e) => e.route === "/items")!.hints.text).toBe("삭제");
  // API: 메서드·주소, 값이 들어가는 주소는 dynamic
  const api = (m: string, u: string) => a.apis.find((x) => x.method === m && x.url === u);
  expect(api("GET", "/api/stats")!.line).toBe(7);
  expect(api("POST", "/api/signup")).toBeTruthy();
  expect(api("DELETE", "/api/items")).toBeTruthy();
  expect(api("DELETE", "/api/items/:param")!.dynamic).toBe(true);
  expect(api("POST", "/api/upload")).toBeTruthy();
  // 파일
  expect(a.fileOps.some((o) => o.type === "download" && o.file.endsWith("Home.tsx"))).toBe(true);
  expect(a.fileOps.some((o) => o.type === "upload" && o.hint === "input[type=file]" && o.route === "/upload")).toBe(true);
});

test("Next.js app·pages 라우터: 경로 규칙(그룹·동적·index)과 서버 API 정의를 읽는다", () => {
  const r = tmp();
  put(r, "package.json", JSON.stringify({ dependencies: { next: "15.0.0" } }));
  put(r, "app/page.tsx", "export default function Home(){return <button onClick={go}>시작</button>}");
  put(r, "app/dashboard/settings/page.tsx", "export default function S(){return null}");
  put(r, "app/(auth)/login/page.tsx", "export default function L(){return null}");
  put(r, "app/users/[id]/page.tsx", "export default function U(){return null}");
  put(r, "app/api/items/route.ts", "export async function GET(){return Response.json([])}\nexport async function POST(){return Response.json({})}");
  put(r, "pages/legacy/index.tsx", "export default function X(){return null}");
  put(r, "pages/_app.tsx", "export default function A(){return null}");
  put(r, "pages/api/hello.ts", "export default function h(req,res){res.json({})}");
  const a = analyzeCode(r);
  expect(a.frameworks).toContain("next-app");
  const paths = a.routes.map((x) => x.path).sort();
  expect(paths).toEqual(["/", "/dashboard/settings", "/legacy", "/login", "/users/:id"].sort());
  expect(a.routes.find((x) => x.path === "/users/:id")!.dynamic).toBe(true);
  const defs = a.apis.filter((x) => x.defined).map((x) => `${x.method} ${x.url}`).sort();
  expect(defs).toEqual(["ANY /api/hello", "GET /api/items", "POST /api/items"]);
  expect(a.events.find((e) => e.hints.text === "시작")!.route).toBe("/");
});

test("Vue Router·정적 HTML·jQuery 패턴도 읽는다", () => {
  const r = tmp();
  put(r, "package.json", JSON.stringify({ dependencies: { vue: "3", "vue-router": "4" } }));
  put(r, "src/router.js", "import { createRouter } from 'vue-router'\nexport default createRouter({ routes: [ { path: '/', component: Home }, { path: '/orders/:id', component: () => import('./views/OrderDetail.vue') } ] })");
  put(r, "src/views/Home.vue", `<template><button @click="save" id="save-btn">저장</button><input v-model="name"></template>`);
  put(r, "public/contact.html", `<a href="#">x</a><script>$('#send').click(function(){ $.post('/api/contact', {}) }); document.getElementById('menu').onclick = open;</script>`);
  const a = analyzeCode(r);
  expect(a.frameworks).toEqual(expect.arrayContaining(["vue-router", "static-html"]));
  expect(a.routes.map((x) => x.path)).toEqual(expect.arrayContaining(["/", "/orders/:id", "/contact.html"]));
  expect(a.events.find((e) => e.hints.id === "save-btn")!.route).toBe("/");
  expect(a.events.some((e) => e.kind === "input")).toBe(true);
  expect(a.events.find((e) => e.hints.id === "send")!.kind).toBe("click");
  expect(a.events.find((e) => e.hints.id === "menu")).toBeTruthy();
  expect(a.apis.find((x) => x.url === "/api/contact")!.method).toBe("POST");
});

test("라우터가 없으면 그 사실을 알리고, 없는 경로는 오류", () => {
  const r = tmp();
  put(r, "main.js", "fetch('/api/x')");
  const a = analyzeCode(r);
  expect(a.routes.length).toBe(0);
  expect(a.notes.join(" ")).toContain("라우터를 찾지 못했습니다");
  expect(() => analyzeCode(join(r, "없음"))).toThrow("코드 경로가 없습니다");
});

test("경로 템플릿 정규식", () => {
  expect(routeRegex("/items/:id").test("/items/7")).toBe(true);
  expect(routeRegex("/items/:id").test("/items")).toBe(false);
  expect(routeRegex("/docs/:slug*").test("/docs/a/b/c")).toBe(true);
  expect(routeRegex("/a.b").test("/aXb")).toBe(false);
});

const inv = (over: Partial<Inventory> = {}): Inventory => ({
  generatedAt: "", baseUrl: "http://x", skipped: [], elements: [],
  pages: [{ path: "/", title: "", elements: 0, forms: 0, depth: 0, via: "link" }, { path: "/items", title: "", elements: 0, forms: 0, depth: 1, via: "link" }, { path: "/admin/audit", title: "", elements: 0, forms: 0, depth: 0, via: "code" }],
  ...over,
});

test("코드엔 있고 탐색으로 못 닿은 화면: 링크로 닿음 / 코드로만 닿음 / 못 열었음 / 값이 필요함을 가른다", () => {
  const a = analyzeCode(DEMO_SRC);
  const i = inv();
  i.pages = i.pages.filter((p) => p.path !== "/upload"); // 업로드 화면은 어디서도 못 닿았다고 가정
  const rec = reconcile([a], i);
  const st = (p: string) => rec.routes.find((r) => r.route.path === p)!.status;
  expect(st("/")).toBe("link");
  expect(st("/admin/audit")).toBe("code-only");
  expect(st("/upload")).toBe("unreached");
  expect(st("/about")).toBe("unreached");
  expect(st("/items/:id")).toBe("dynamic");
  expect(rec.summary).toMatchObject({ codeRoutes: 7, link: 2, codeOnly: 1, dynamic: 1, unreached: 3 });
  // 탐색 전이면 "아직 탐색 전"
  expect(reconcile([a], null).routes.find((r) => r.route.path === "/about")!.status).toBe("not-crawled");
});

test("코드의 이벤트·API 중 화면/관측에서 못 찾은 것을 가려낸다", () => {
  const a = analyzeCode(DEMO_SRC);
  const i = inv({
    pages: [{ path: "/", title: "", elements: 0, forms: 0, depth: 0, via: "link" }, { path: "/items", title: "", elements: 0, forms: 0, depth: 0, via: "link" }, { path: "/upload", title: "", elements: 0, forms: 0, depth: 0, via: "link" }, { path: "/admin/audit", title: "", elements: 0, forms: 0, depth: 0, via: "code" }, { path: "/about", title: "", elements: 0, forms: 0, depth: 0, via: "link" }, { path: "/reports", title: "", elements: 0, forms: 0, depth: 0, via: "link" }],
    elements: [{ id: "E-1", page: "/", layer: "page", tag: "button", kind: "button", label: "통계 새로고침", selector: "#stats", risk: "safe" }],
    apis: [{ method: "GET", path: "/api/items", sample: "/api/items", status: 200, page: "/items", sameOrigin: true, count: 1 }],
  });
  const rec = reconcile([a], i);
  const missing = rec.eventsNotOnScreen.map((e) => e.hints.testid ?? e.hints.id ?? e.hints.text);
  expect(missing).toContain("beta-banner-close");
  expect(missing).not.toContain("stats");
  const apiMiss = rec.apisNotObserved.map((x) => `${x.method} ${x.url}`);
  expect(apiMiss).toContain("GET /api/health");
  expect(apiMiss).toContain("POST /api/upload");
  expect(apiMiss).not.toContain("GET /api/items");
  expect(apiMiss).toContain("DELETE /api/items/:param");
});

test("케이스 만들기: 코드로만 닿은 화면은 '화면 열림', 관측한 GET API와 코드가 부르는 GET API는 api 케이스, 쓰기 API는 만들지 않는다", () => {
  const a = analyzeCode(DEMO_SRC);
  const i = inv({
    apis: [
      { method: "GET", path: "/api/items", sample: "/api/items", status: 200, jsonArray: true, page: "/items", sameOrigin: true, count: 1 },
      { method: "GET", path: "/api/stats", sample: "/api/stats", status: 200, jsonKeys: ["count"], page: "/", sameOrigin: true, count: 1 },
      { method: "GET", path: "/api/err", sample: "/api/err", status: 500, page: "/", sameOrigin: true, count: 1 },
      { method: "POST", path: "/api/signup", sample: "/api/signup", status: 200, page: "/", sameOrigin: true, count: 1 },
      { method: "GET", path: "/cdn/x", sample: "/cdn/x", status: 200, page: "/", sameOrigin: false, count: 1 },
    ],
  });
  const cfg = new Project(tmp()).config();
  const cs = extraCases(cfg, i, [a]);
  const byId = (pre: string) => cs.filter((c) => c.id.startsWith(pre));
  expect(byId("PG-").length).toBe(1);
  expect(byId("PG-")[0]!.title).toContain("/admin/audit");
  expect(byId("PG-")[0]!.source_ref).toMatch(/^코드 App\.tsx:\d+$/);
  const apiCases = byId("A-");
  expect(apiCases.map((c) => c.title.split(" → ")[0])).toEqual(["API GET /api/items", "API GET /api/stats"]);
  const stats = apiCases.find((c) => c.title.includes("/api/stats"))!;
  expect(stats.steps[1]).toMatchObject({ op: "api", via: "page", method: "GET", status: "2xx", jsonHas: ["count"] });
  expect(apiCases.find((c) => c.title.includes("/api/items"))!.steps[1]).toMatchObject({ jsonArray: true });
  const codeApi = byId("CA-").map((c) => c.title);
  expect(codeApi.some((t) => t.includes("/api/health"))).toBe(true);
  expect(codeApi.some((t) => t.includes("/api/audit"))).toBe(true);
  expect(codeApi.every((t) => !t.includes("POST") && !t.includes("DELETE"))).toBe(true);
  expect(codeApi.some((t) => t.includes("/api/items"))).toBe(false); // 이미 관측됨
  expect(byId("CA-")[0]!.source_ref).toMatch(/^코드 pages\/.+\.tsx:\d+$/);
});

test("상태코드 기대값: 숫자·배열·2xx·<400", () => {
  expect(statusMatches(200, 200)).toBe(true);
  expect(statusMatches(201, 200)).toBe(false);
  expect(statusMatches(204, "2xx")).toBe(true);
  expect(statusMatches(302, "2xx")).toBe(false);
  expect(statusMatches(302, "<400")).toBe(true);
  expect(statusMatches(404, "<400")).toBe(false);
  expect(statusMatches(404, [200, 404])).toBe(true);
  expect(statusMatches(500, undefined)).toBe(false);
});

// ---------- OS 창 ----------

const probe = (id: string, over: Partial<Case> = {}): Case => ({ id, title: id, type: "probe", steps: [{ op: "goto", url: "/" }], ...over });

test("Chrome 계열은 파일·다운로드를 OS 창 없이 처리하므로 컴퓨터 제어가 필요 없다", async () => {
  const p = new Project(tmp());
  p.ensure();
  p.saveCases([probe("D1", { needs_os: true, event: "download" })]);
  const r: any = await osCheck(p, { driver: "chromium" });
  expect(r.needed).toBe(false);
  expect(r.message).toContain("OS 창 없이");
});

test("OS 창이 뜨는 브라우저(Ego)에서 컴퓨터 제어가 안 되면 권한 안내와 함께 허용/스킵을 묻고, 답에 따라 포함하거나 SKIP 으로 둔다", async () => {
  const p = new Project(tmp());
  p.ensure();
  p.saveCases([probe("D1", { needs_os: true, event: "download" }), probe("U1", { needs_os: true, event: "upload" }), probe("N1")]);
  // 컴퓨터 제어가 없는 가짜 환경(claude·codex 모두 없음)
  const env = { ...process.env, PATH: `${tmp()}:/usr/bin:/bin` };
  const q: any = await osCheck(p, { _driver: "ego", env } as any);
  expect(q.needs_decision).toBe(true);
  expect(q.options.map((o: any) => o.value)).toEqual(["allow", "skip"]);
  expect(q.total).toBe(2);
  expect(q.permission_help.length).toBeGreaterThan(0);
  expect(await osPending(p, "ego" as any).catch(() => null)).toBeDefined();

  const skip: any = await osCheck(p, { _driver: "ego", env, decision: "skip" } as any);
  expect(skip.message).toContain("스킵");
  const after = p.cases();
  expect(after.find((c) => c.id === "D1")!.skipReason).toContain("[OS 창]");
  expect(after.find((c) => c.id === "N1")!.skipReason).toBeUndefined();

  const allow: any = await osCheck(p, { _driver: "ego", env, decision: "allow" } as any);
  expect(allow.decision).toBe("allow");
  expect(p.cases().find((c) => c.id === "D1")!.skipReason).toBeUndefined();
  expect(applyOsPolicy(p)).toEqual({ skipped: 0, cleared: 0 });
});

// ---------- 시트 ----------

test("시트: 화면 → 기능 단위 → 케이스로 묶고, 근거와 빈틈을 적는다", () => {
  const root = tmp();
  const p = new Project(root);
  p.ensure();
  const cases: Case[] = [
    { id: "SPEC-1", title: "가입하면 가입 완료", type: "spec", screen: "/", feature: "회원 가입", source_ref: "기획서 2.3", steps: [{ op: "goto", url: "/" }] },
    { id: "SPEC-2", title: "가입 이메일 형식 오류", type: "spec", feature: "회원 가입", source_ref: "기획서 2.4", steps: [{ op: "goto", url: "/signup" }] },
    probe("P-1", { screen: "/", feature: "버튼 동작", title: "버튼 통계 클릭" }),
    probe("P-2", { screen: "/items", feature: "화면 이동(링크)", title: "링크 홈" }),
    probe("B-1", { status: "blocked", reason: "기대값 근거 없음", steps: [{ op: "goto", url: "/x" }] }),
    probe("D-1", { needs_os: true, skipReason: "[OS 창] 스킵", screen: "/", feature: "파일 다운로드·업로드" }),
  ];
  p.saveCases(cases);
  saveAnalyses(p, [analyzeCode(DEMO_SRC)]);
  const sh = buildSheet(p);
  expect(sh.totals).toMatchObject({ screens: 4, cases: 6, spec: 2, probe: 4, blocked: 1, skip: 1, needsOs: 1 });
  const home = sh.screens.find((s) => s.screen === "/")!;
  expect(home.features.map((f) => f.feature).sort()).toEqual(["버튼 동작", "파일 다운로드·업로드", "회원 가입"]);
  expect(sh.screens.find((s) => s.screen === "/signup")!.features[0]!.feature).toBe("회원 가입"); // 화면은 첫 goto 에서
  expect(sh.gaps.blockedCases[0]).toEqual({ id: "B-1", reason: "기대값 근거 없음" });
  expect(sh.gaps.dynamicRoutes.map((g) => g.path)).toEqual(["/items/:id"]);
  const md = renderSheetMd(sh, { full: true });
  expect(md).toContain("근거: 기획서 2.3");
  expect(md).toContain("[보류]");
  expect(md).toContain("## 빈틈과 주의");
});

test("시트 확인: 기본은 바로 시작, 확인을 원하면 승인 전에는 라운드를 시작할 수 없고 케이스가 바뀌면 다시 확인", () => {
  const root = tmp();
  const p = new Project(root);
  p.ensure();
  p.saveCases([probe("P-1", { screen: "/", feature: "버튼 동작" })]);
  const a: any = aSheet(p, {});
  expect(a.confirm_before_start).toBe(false);
  expect(a.ready_to_start).toBe(true);
  expect(a.next).toContain("바로 시작");
  expect(sheetGate(p)).toEqual({ ok: true });

  const b: any = aSheet(p, { confirm_before_start: true });
  expect(b.ready_to_start).toBe(false);
  expect(b.next).toContain("confirm=true");
  expect((sheetGate(p) as any).ok).toBe(false);
  const c: any = aSheet(p, { confirm: true });
  expect(c.ready_to_start).toBe(true);
  expect(sheetGate(p)).toEqual({ ok: true });

  p.saveCases([...p.cases(), probe("P-2", { steps: [{ op: "goto", url: "/new" }] })]);
  expect((sheetGate(p) as any).ok).toBe(false); // 케이스가 바뀌어 다시 확인이 필요
  const d: any = aSheet(p, {});
  expect(d.confirmed).toBe(false);
});

test("회차 시작 검사(precheck)가 시트 확인 대기를 막는다", () => {
  const root = tmp();
  const p = new Project(root);
  p.ensure();
  p.saveConfig(p.config());
  writeFileSync(join(root, "plan.md"), "# 기획서");
  p.writeJson("sources.json", [{ id: "S01", kind: "plan", title: "기획서", location: join(root, "plan.md"), addedAt: "" }]);
  p.saveCases([probe("P-1")]);
  aSheet(p, { confirm_before_start: true });
  const pre: any = precheck(p, { data: "keep" });
  expect(pre.ok).toBe(false);
  expect(pre.error).toContain("시트");
  aSheet(p, { confirm: true });
  expect((precheck(p, { data: "keep" }) as any).ok).toBe(true);
});
