// 8단계 종단 시험: 버그를 심은 데모 사이트로 "1라운드 실패 → 수정 → 2라운드 통과(이슈 0, 완료 판정)"를 테스터 절차 그대로 돌린다.
// 사람용·AI용 시트, 영상, 현황판까지 확인한다. Chrome 계열(Chromium·Chrome)은 항상, Ego 는 앱이 응답할 때만 돈다.
//   Ego 는 기본이 대표 케이스만 도는 부분 라운드, 전체 라운드까지 보려면 E2E_EGO_FULL=1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "../src/actions.ts";
import { Project } from "../src/store.ts";
import { run } from "../src/env/detect.ts";
import type { DriverName } from "../src/types.ts";

const DEMO_SRC = join(import.meta.dir, "../examples/demo-site/src");
const SPEC = [
  { id: "SPEC-001", title: "홈에 대시보드 제목이 보인다", source_ref: "기획서 1.1", screen: "/", feature: "홈", steps: [{ op: "goto", url: "/" }, { op: "expect", sel: "h1", text: "대시보드" }] },
  { id: "SPEC-002", title: "가입하면 '가입 완료'가 보인다", source_ref: "기획서 2.3", screen: "/", feature: "회원 가입", steps: [{ op: "goto", url: "/" }, { op: "fill", sel: "input[name=email]", value: "e2e+full@example.com" }, { op: "click", sel: 'button:text-is("가입하기")' }, { op: "expect", sel: "#msg", text: "가입 완료" }] },
  { id: "SPEC-003", title: "통계를 누르면 항목 수가 나온다", source_ref: "기획서 3.1", screen: "/", feature: "통계", steps: [{ op: "goto", url: "/" }, { op: "click", sel: "#stats" }, { op: "expect", sel: "#stat-out", textContains: "항목" }] },
];

const chromeInstalled = existsSync("/Applications/Google Chrome.app");
const ego = Bun.which("ego-browser");
let egoUsable = false;

beforeAll(async () => {
  if (!ego) return;
  const p = Bun.spawn([ego, "nodejs", "-e", "console.log('ok')"], { stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill(), 20000);
  egoUsable = ((await new Response(p.stdout).text()) + (await new Response(p.stderr).text())).includes("ok");
  clearTimeout(t);
}, 40000);

async function scenario(driver: DriverName, port: number, dash: number, opts: { subset?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), `e2e-loop-full-${driver}-`));
  const base = `http://127.0.0.1:${port}`;
  const setBugs = (b: Record<string, boolean>) => writeFileSync(join(root, "bugs.json"), JSON.stringify(b));
  setBugs({ modalNoClose: true, statsApi: true, exportThrows: true, brokenLink: true });
  writeFileSync(join(root, "PLAN.md"), "# 기획서\n1.1 홈\n2.3 가입\n3.1 통계\n");
  const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "init: 버그가 든 상태");
  const server = Bun.spawn(["bun", join(import.meta.dir, "../examples/demo-site/server.ts"), root, String(port)], { stdout: "ignore", stderr: "inherit" });
  await Bun.sleep(800);
  try {
    const p = new Project(root);
    p.ensure();
    // 1) 세션과 입력 (최소 진행 조건)
    const s: any = await A.aSessionStart({ project: root, mode: "here", baseUrl: base, materials: [{ kind: "plan", location: join(root, "PLAN.md"), sections: ["1.1", "2.3", "3.1"] }, { kind: "code", location: DEMO_SRC }] });
    expect(s.intake.can_start).toBe(true);
    // 2) 설정(기본 Headed 지만 시험은 창을 띄우지 않게 Chrome 계열만 headless), 시작 전 질문
    p.saveConfig({ ...p.config(), baseUrl: base, driver, headless: driver !== "ego", dashboardPort: dash, codeRoot: root });
    const pre: any = A.aPrestart({ project: root, dataPolicy: "keep", maxRounds: 10, login: "none", account: { mode: "none" }, acknowledged: true });
    expect(pre.ready).toBe(true);
    // 3) 분석과 시트: 탐색(Ego 시험은 Chromium 으로 탐색), 코드 대조, 기획서 케이스, OS 창 점검, 시트
    await A.aDiscover({ project: root, driver: driver === "ego" ? "chromium" : driver });
    A.aCaseUpsert({ project: root, cases: SPEC as any });
    const an: any = await A.aAnalyze({ project: root, rediscover: false });
    expect(an.totals.routes).toBe(7);
    const os: any = await A.aOsCheck({ project: root });
    expect(os.needed).toBe(false);
    if (opts.subset) {
      // Ego 부분 시험: 대표 케이스만(기획서 3건 + 모달·내보내기·링크·API·다운로드·업로드·화면 열림)
      const keep = p.cases().filter((c) => c.type === "spec" || ["P-bd8b5d", "P-f41635"].includes(c.id) || ["download", "upload", "api", "page"].includes(c.event ?? "")).map((c) => c.id);
      const sheetCases = p.cases();
      expect(keep.length).toBeGreaterThan(8);
      p.writeJson("e2e-subset.json", keep);
      expect(sheetCases.length).toBeGreaterThan(keep.length);
    }
    const only: string[] | undefined = opts.subset ? p.readJson<string[]>("e2e-subset.json", []) : undefined;
    const sheet: any = A.aSheet({ project: root });
    expect(sheet.ready_to_start).toBe(true);
    expect(sheet.summary).toContain("화면");
    const dashInfo: any = A.aDashboard({ project: root });
    expect(dashInfo.access_url).toContain("token=");

    // 4) 1라운드 (버그 있는 상태)
    const r1: any = await A.aRoundStart({ project: root, data: "keep", only });
    expect(r1.started).toBe(true);
    const live: any = await (await fetch(`${r1.dashboard_base}/api/state`, { headers: { authorization: `Bearer ${r1.dashboard_token}` } })).json();
    expect(live.running).toBe(true); // 현황판에 진행이 보인다
    expect((await fetch(`${r1.dashboard_base}/api/state`)).status).toBe(401); // 토큰 없는 접속은 막힌다
    let st: any;
    do st = await A.aRoundStatus({ project: root, wait_seconds: 30 });
    while (st.running);
    const rep1: any = A.aRoundReport({ project: root, format: "json" });
    expect(rep1.verdict).toBe("FAIL");
    expect(rep1.issue_count).toBeGreaterThanOrEqual(3);
    const ids1 = rep1.issues.map((i: any) => i.id);
    expect(ids1).toContain("SPEC-003"); // 통계 API 500
    expect(rep1.issues.every((i: any) => i.reproduction.length && i.expected && i.actual)).toBe(true);
    expect(rep1.tasks.length).toBeGreaterThan(0);
    const rdir1 = p.roundDir(r1.round);
    expect(existsSync(join(rdir1, "report.html"))).toBe(true); // 사람용
    expect(existsSync(join(rdir1, "ai-sheet.md"))).toBe(true); // AI용
    const html1 = readFileSync(join(rdir1, "report.html"), "utf8");
    expect(html1).toContain("이슈 추이");
    expect(readFileSync(join(rdir1, "ai-sheet.md"), "utf8")).toContain("수용 기준");
    const meta1 = p.readJson<any>(`rounds/${r1.round}/meta.json`, null);
    expect(meta1.code.head).toMatch(/^[0-9a-f]{7,}/); // 증거에 커밋
    const results1 = p.readJson<any[]>(`rounds/${r1.round}/results.json`, []);
    const withVideo = results1.filter((r) => r.video);
    const evidenceNotes = (meta1.evidenceWarnings ?? []).join(" ") + results1.flatMap((r) => r.warnings).join(" ");
    if (driver !== "ego") {
      // Chrome 계열: 모든 케이스가 mp4(h264)+챕터, 스크린샷에 도장
      expect(withVideo.length).toBe(results1.length);
      for (const r of withVideo) {
        expect(r.video).toMatch(/\.mp4$/);
        expect(existsSync(join(rdir1, r.video))).toBe(true);
        expect(existsSync(join(rdir1, r.chapters))).toBe(true);
      }
      const codec = await run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", join(rdir1, withVideo[0].video)]);
      expect(codec.out).toContain("h264");
      const man = JSON.parse(readFileSync(join(rdir1, "evidence.json"), "utf8"));
      expect(man.commit).toBe(meta1.code.head);
      expect(man.files.some((f: any) => f.kind === "screenshot" && f.sha256 !== f.rawSha256)).toBe(true);
      expect(html1).toContain("<video");
    } else {
      // Ego: 창을 찾으면 영상, 못 찾으면 이유가 적혀야 한다
      if (withVideo.length === 0) expect(evidenceNotes).toContain("Ego 창 녹화");
    }

    // 5) 수정(회차가 끝난 뒤) → 커밋
    setBugs({});
    git("add", ".");
    git("commit", "-qm", "fix: 결함 수정");

    // 6) 2라운드 (이슈 0 → 완료 판정은 전체 라운드일 때)
    const r2: any = await A.aRoundStart({ project: root, data: "keep", only });
    expect(r2.started).toBe(true);
    do st = await A.aRoundStatus({ project: root, wait_seconds: 30 });
    while (st.running);
    const rep2: any = A.aRoundReport({ project: root, format: "json" });
    expect(rep2.issue_count).toBe(0);
    expect(rep2.issues).toEqual([]);
    expect(rep2.verdict === "PASS" || rep2.verdict === "PASS_WITH_SKIPS").toBe(true);
    expect(rep2.trend.map((t: any) => t.issues)).toEqual([rep1.issue_count, 0]);
    expect(rep2.diff.fixed.length).toBeGreaterThanOrEqual(3);
    expect(rep2.diff.regressed).toEqual([]);
    const meta2 = p.readJson<any>(`rounds/${r2.round}/meta.json`, null);
    expect(meta2.code.head).not.toBe(meta1.code.head); // 수정 커밋이 증거에 반영
    const gate = A.aCompleteCheck({ project: root });
    if (only) expect(gate.complete).toBe(false); // 부분 라운드로는 완료 판정을 하지 않는다
    else {
      expect(gate.complete).toBe(true);
      expect(gate.reasons).toEqual([]);
    }
    const html2 = readFileSync(join(p.roundDir(r2.round), "report.html"), "utf8");
    expect(html2).toContain("통과");
    // 현황판: 끝난 뒤 추이와 보고서 링크
    const done: any = await (await fetch(`${r1.dashboard_base}/api/state`, { headers: { authorization: `Bearer ${r1.dashboard_token}` } })).json();
    expect(done.running).toBe(false);
    expect(done.trend.map((t: any) => t.issues)).toEqual([rep1.issue_count, 0]);
    expect(done.hasReport).toBe(true);
    return { rep1, rep2, gate, root };
  } finally {
    server.kill();
  }
}

test("Chromium: 1라운드 실패 → 수정 → 2라운드 통과(이슈 0, 완료 판정), 시트·영상·현황판", async () => {
  const r = await scenario("chromium", 4581, 7870);
  expect(r.gate.complete).toBe(true);
}, 600000);

test.skipIf(!chromeInstalled)("Google Chrome: 같은 시나리오", async () => {
  const r = await scenario("chrome", 4582, 7871);
  expect(r.gate.complete).toBe(true);
}, 600000);

test.skipIf(!ego)("Ego: 같은 시나리오(대표 케이스, E2E_EGO_FULL=1 이면 전체 라운드)", async () => {
  if (!egoUsable) {
    console.log("Ego 앱이 응답하지 않아 건너뜀");
    return;
  }
  const r = await scenario("ego", 4583, 7872, { subset: process.env.E2E_EGO_FULL !== "1" });
  if (process.env.E2E_EGO_FULL === "1") expect(r.gate.complete).toBe(true);
}, 1800000);
