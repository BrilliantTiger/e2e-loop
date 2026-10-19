// 5단계 시험: 라운드 결과물(사람용 시트·AI용 시트)이 요구한 항목을 모두 담는지. 실패 케이스가 있는 실제 라운드(Chromium)로 확인한다.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "../src/actions.ts";
import { Project } from "../src/store.ts";
import { buildTasks, expectedOf, type AiIssue } from "../src/sheets.ts";
import type { CaseResult, RoundMeta } from "../src/types.ts";

const DEMO_SRC = join(import.meta.dir, "../examples/demo-site/src");
const port = 4573;
const base = `http://127.0.0.1:${port}`;
const root = mkdtempSync(join(tmpdir(), "e2e-loop-s5-"));
const bugs = (b: Record<string, boolean>) => writeFileSync(join(root, "bugs.json"), JSON.stringify(b));
let server: ReturnType<typeof Bun.spawn>;
let p: Project;

beforeAll(async () => {
  bugs({ modalNoClose: true, statsApi: true, exportThrows: true });
  writeFileSync(join(root, "PLAN.md"), "# 기획서\n");
  server = Bun.spawn(["bun", join(import.meta.dir, "../examples/demo-site/server.ts"), root, String(port)], { stdout: "ignore", stderr: "inherit" });
  await Bun.sleep(800);
  p = new Project(root);
  p.ensure();
  p.saveConfig({ ...p.config(), baseUrl: base, driver: "chromium", headless: true, dashboardPort: 7795 });
  A.aPrestart({ project: root, dataPolicy: "keep", maxRounds: 10, login: "none", account: { mode: "none" }, acknowledged: true });
  A.aSourceAdd({ project: root, kind: "plan", title: "기획서", location: join(root, "PLAN.md") });
  await A.aIntake({ project: root, baseUrl: base, materials: [{ kind: "code", location: DEMO_SRC }] });
  await A.aAnalyze({ project: root, rediscover: false });
  A.aCaseUpsert({
    project: root,
    cases: [
      { id: "S-STATS", title: "통계를 누르면 항목 수가 나온다", type: "spec", source_ref: "기획서 3.1", screen: "/", feature: "통계", steps: [{ op: "goto", url: "/" }, { op: "click", sel: "#stats" }, { op: "expect", sel: "#stat-out", textContains: "항목" }] },
      { id: "S-API", title: "통계 API 가 객체를 돌려준다", type: "spec", source_ref: "기능정의서 API-2", screen: "/", feature: "통계", steps: [{ op: "goto", url: "/" }, { op: "api", via: "page", method: "GET", url: "/api/stats", status: 200, jsonHas: ["count"] }] },
      { id: "S-MODAL", title: "공지 모달이 닫힌다", type: "spec", source_ref: "기획서 1.4", screen: "/", feature: "공지", steps: [{ op: "goto", url: "/" }, { op: "probe", kind: "click", sel: "#open-notice", label: "공지 열기" }] },
      { id: "S-EXPORT", title: "내보내기를 누르면 완료 문구", type: "spec", source_ref: "기획서 4.2", screen: "/", feature: "내보내기", steps: [{ op: "goto", url: "/" }, { op: "click", sel: "#export" }, { op: "expect", sel: "#stat-out", text: "내보냈습니다" }] },
      { id: "S-HOME", title: "홈에 대시보드 제목이 보인다", type: "spec", source_ref: "기획서 1.1", screen: "/", feature: "통계", steps: [{ op: "goto", url: "/" }, { op: "expect", sel: "h1", text: "대시보드" }] },
      { id: "S-BLOCKED", title: "관리자 승인 흐름", type: "spec", source_ref: "기획서 9.9", screen: "/admin", feature: "승인", steps: [{ op: "goto", url: "/admin" }], status: "blocked", reason: "기대값 근거 없음" },
    ],
  });
});
afterAll(() => server?.kill());

const round = async () => {
  const start: any = await A.aRoundStart({ project: root, data: "keep", headless: true, only: ["S-STATS", "S-API", "S-MODAL", "S-EXPORT", "S-HOME", "S-BLOCKED"] });
  expect(start.started).toBe(true);
  let st: any;
  do st = await A.aRoundStatus({ project: root, wait_seconds: 30 });
  while (st.running);
  return start.round as string;
};

test("실패가 있는 라운드: AI용 시트가 이슈마다 요구한 항목을 모두 담고 작업 단위로 쪼갠다", async () => {
  const id = await round();
  const rdir = p.roundDir(id);
  const ai = JSON.parse(readFileSync(join(rdir, "ai-sheet.json"), "utf8"));
  expect(existsSync(join(rdir, "ai-sheet.md"))).toBe(true);
  expect(ai.verdict).toBe("FAIL");
  const ids = ai.issues.map((i: any) => i.id).sort();
  expect(ids).toEqual(["S-API", "S-BLOCKED", "S-EXPORT", "S-MODAL", "S-STATS"]);
  const by = (k: string) => ai.issues.find((i: any) => i.id === k);

  // 재현 단계·기대값·실제값
  const stats = by("S-STATS");
  expect(stats.status).toBe("FAIL");
  expect(stats.reproduction.map((s: any) => s.action)).toEqual(["이동 /", "클릭 #stats", expect.stringContaining("확인")]);
  expect(stats.reproduction.map((s: any) => s.result)).toEqual(["통과", "통과", "실패"]);
  expect(stats.expected).toContain('#stat-out 텍스트에 "항목" 포함');
  expect(stats.actual).toContain("텍스트에");
  expect(stats.source_ref).toBe("기획서 3.1");
  expect(stats.screen).toBe("/");
  expect(stats.feature).toBe("통계");

  // API 요청과 응답
  const api = by("S-API");
  expect(api.expected).toContain("API GET /api/stats");
  const call = api.api.find((a: any) => a.url.includes("/api/stats"));
  expect(call).toMatchObject({ method: "GET", status: 500, failed: true });
  expect(call.responseBody).toContain("boom");

  // 콘솔 로그
  expect(stats.console.failedRequests.join(" ")).toContain("500");
  expect(by("S-EXPORT").console.pageErrors.length).toBeGreaterThan(0);

  // 스크린샷과 영상 위치(영상 시각)
  for (const k of ["S-STATS", "S-API", "S-EXPORT"]) {
    const ev = by(k).evidence;
    expect(existsSync(join(rdir, ev.screenshot))).toBe(true);
    expect(ev.video).toMatch(/\.mp4$/);
    expect(existsSync(join(rdir, ev.video))).toBe(true);
    expect(ev.videoAt.at).toMatch(/^\d\d:\d\d\.\d$/);
    expect(typeof ev.videoAt.seconds).toBe("number");
  }
  // 영상 위치의 챕터는 실패한 단계(3번째)를 가리킨다
  expect(by("S-STATS").evidence.videoAt.chapter).toMatch(/^3\. /);

  // 의심 코드 위치(코드 분석이 있을 때)
  const where = stats.suspectCode.map((s: any) => `${s.file}:${s.line}`);
  expect(where.some((w: string) => w.startsWith("pages/Home.tsx"))).toBe(true);
  expect(stats.suspectCode.map((s: any) => s.why).join(" ")).toContain("핸들러");
  expect(api.suspectCode.some((s: any) => s.why.includes("/api/stats"))).toBe(true);

  // 작업 단위: 같은 원인(통계 API)은 한 작업, 나머지는 따로. 코드 수정 작업이 먼저, 사용자 조치 작업은 마지막
  const tasks = ai.tasks;
  const apiTask = tasks.find((t: any) => t.issues.includes("S-API"));
  expect(apiTask.issues.sort()).toEqual(["S-API", "S-STATS"]);
  expect(apiTask.title).toContain("/api/stats");
  expect(apiTask.scope.apis).toContain("GET /api/stats");
  expect(apiTask.scope.code.length).toBeGreaterThan(0);
  expect(apiTask.acceptance.sort()).toEqual(["S-API", "S-STATS"]); // 수용 기준 = 통과해야 할 케이스
  expect(apiTask.verify).toContain("e2e_round_start only=");
  // 회귀 주의: 같은 화면·기능에서 지금 통과 중인 케이스
  expect(apiTask.regressionWatch.map((x: any) => x.id)).toContain("S-HOME");
  expect(tasks.at(-1).kind).toBe("needs-input");
  expect(tasks.at(-1).issues).toEqual(["S-BLOCKED"]);
  expect(tasks.filter((t: any) => t.kind === "fix").length).toBe(3);
  const md = readFileSync(join(rdir, "ai-sheet.md"), "utf8");
  for (const word of ["재현 단계", "기대값", "실제값", "API 요청과 응답", "콘솔 로그", "의심 코드 위치", "수정 범위", "수용 기준", "회귀 주의", "선행 작업", "@ "]) {
    if (word === "선행 작업") continue; // 선행 의존은 아래 단위 시험에서 확인
    expect(md).toContain(word);
  }
  expect(md).toContain("pages/Home.tsx");
}, 300000);

test("사람용 시트: 영상(챕터 버튼)·스크린샷·이슈 추이·화면별 묶음을 담는다. 수정 뒤 라운드로 추이가 내려간다", async () => {
  const id1 = "R01";
  const html1 = readFileSync(join(p.roundDir(id1), "report.html"), "utf8");
  expect(html1).toContain("<video");
  expect(html1).toMatch(/src="evidence\/[^"]+\.mp4"/);
  expect(html1).toMatch(/<img loading="lazy" src="evidence\/[^"]+\.png"/);
  expect(html1).toContain("이슈 추이");
  expect(html1).toContain("화면별 결과");
  expect(html1).toContain("통계"); // 기능 단위 이름
  expect(html1).toContain('class="chs"'); // 영상 챕터 버튼
  expect(html1).toContain("개발 작업 단위");
  expect(html1).toContain("이슈 5건");

  // 수정(버그 제거) → 2라운드 → 추이 5 → 1(검증 못 한 것만 남음)
  bugs({});
  const id2 = await round();
  const html2 = readFileSync(join(p.roundDir(id2), "report.html"), "utf8");
  const rep: any = A.aRoundReport({ project: root, format: "json" });
  expect(rep.trend.map((t: any) => t.issues)).toEqual([5, 1]);
  expect(rep.issues.map((i: any) => i.id)).toEqual(["S-BLOCKED"]);
  expect(rep.diff.fixed.sort()).toEqual(["S-API", "S-EXPORT", "S-MODAL", "S-STATS"]);
  expect(html2).toMatch(/<td>R01 \(부분\)<\/td><td><b>5<\/b>/);
  expect(html2).toMatch(/<td>R02 \(부분\)<\/td><td><b>1<\/b>/);
  const paths: any = A.aRoundReport({ project: root, format: "paths" });
  expect(existsSync(paths.human)).toBe(true);
  expect(existsSync(paths.ai_md)).toBe(true);
  expect(existsSync(paths.ai_json)).toBe(true);
}, 300000);

// ---------- 단위 ----------

const mkIssue = (id: string, over: Partial<AiIssue>): AiIssue => ({ id, title: id, symptom: "", status: "FAIL", reproduction: [], expected: "", actual: "", api: [], console: { consoleErrors: [], pageErrors: [], failedRequests: [] }, evidence: { screenshots: [] }, suspectCode: [], warnings: [], hint: "", comments: [], ...over });

test("작업 의존: 다른 작업의 원인 API 를 쓰는 작업은 그 API 작업 뒤에 오고 선행 작업으로 적힌다", () => {
  const meta = {} as RoundMeta;
  const issues = [
    mkIssue("UI-1", { screen: "/orders", feature: "주문 목록", api: [{ method: "GET", url: "/api/orders", status: 200, failed: false }] }),
    mkIssue("API-1", { screen: "/orders", feature: "주문 API", api: [{ method: "GET", url: "/api/orders", status: 500, failed: true }] }),
  ];
  const results = [{ id: "OK-1", title: "다른 통과", status: "PASS", steps: [{ api: { method: "GET", url: "/api/orders" } }] } as unknown as CaseResult];
  const tasks = buildTasks(issues, results, [{ id: "OK-1", title: "다른 통과", type: "spec", screen: "/x", steps: [] } as any], meta);
  expect(tasks.map((t) => t.issues[0])).toEqual(["API-1", "UI-1"]); // 원인 API 작업이 먼저
  expect(tasks[1]!.dependsOn).toEqual([tasks[0]!.id]);
  expect(tasks[0]!.dependsOn).toEqual([]);
  expect(tasks[0]!.regressionWatch.map((x) => x.id)).toEqual(["OK-1"]); // 같은 API 를 쓰는 통과 케이스
});

test("기대값 설명: 스텝 종류별로 사람이 읽을 수 있게 적는다", () => {
  expect(expectedOf({ op: "expect", sel: "#msg", text: "가입 완료" }, undefined)).toBe('#msg 텍스트 = "가입 완료"');
  expect(expectedOf({ op: "api", method: "post", url: "/api/x", status: [200, 201], jsonHas: ["id"] }, undefined)).toBe("API POST /api/x → 상태 [200,201] · 응답에 id 포함");
  expect(expectedOf({ op: "probe", kind: "download" }, undefined)).toContain("파일이 내려받아져야");
  expect(expectedOf(undefined, { id: "A", title: "제목", type: "spec", steps: [] })).toBe("제목");
});
