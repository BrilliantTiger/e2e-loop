// 4단계 종단 시험(Chromium): 재시도로 불안정 판정, 승격한 경고, 파괴적 동작 규칙, 영상·도장·챕터 증거.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "../src/actions.ts";
import { Project } from "../src/store.ts";
import { run } from "../src/env/detect.ts";
import type { Case } from "../src/types.ts";

const port = 4572;
const base = `http://127.0.0.1:${port}`;
const root = mkdtempSync(join(tmpdir(), "e2e-loop-s4r-"));
let server: ReturnType<typeof Bun.spawn>;
let p: Project;

const spec = (id: string, steps: Case["steps"], over: Partial<Case> = {}): Case => ({ id, title: id, type: "spec", source_ref: "시험", screen: "/", feature: "시험", steps, ...over });

beforeAll(async () => {
  writeFileSync(join(root, "bugs.json"), "{}");
  writeFileSync(join(root, "PLAN.md"), "# 기획서\n");
  server = Bun.spawn(["bun", join(import.meta.dir, "../examples/demo-site/server.ts"), root, String(port)], { stdout: "ignore", stderr: "inherit" });
  await Bun.sleep(800);
  p = new Project(root);
  p.ensure();
  p.saveConfig({ ...p.config(), baseUrl: base, driver: "chromium", headless: true, dashboardPort: 7793 });
  A.aPrestart({ project: root, dataPolicy: "keep", maxRounds: 10, login: "none", account: { mode: "none" }, acknowledged: true });
  A.aSourceAdd({ project: root, kind: "plan", title: "기획서", location: join(root, "PLAN.md") });
  A.aCaseUpsert({
    project: root,
    cases: [
      spec("FL-0", [{ op: "api", method: "GET", url: "/api/flaky/reset", status: 200 }]),
      spec("FL-1", [{ op: "goto", url: "/" }, { op: "api", via: "page", method: "GET", url: "/api/flaky", status: 200 }]),
      spec("PW-1", [{ op: "goto", url: "/" }, { op: "probe", kind: "click", sel: "#noop", label: "아무 일 없음" }]),
      spec("SG-1", [{ op: "goto", url: "/" }, { op: "fill", sel: "input[name=email]", value: "e2e+777@example.com" }, { op: "click", sel: 'button:text-is("가입하기")' }, { op: "expect", sel: "#msg", text: "가입 완료" }]),
      spec("DEL-OWN", [{ op: "goto", url: "/items" }, { op: "probe", kind: "delete", sel: "xpath=//li[contains(., 'e2e+777')]/button", label: "삭제(내가 등록한 항목)" }], { risk: "delete" }),
      spec("DEL-OTHER", [{ op: "goto", url: "/items" }, { op: "probe", kind: "delete", sel: "xpath=//li[contains(., '샘플 항목 A')]/button", label: "삭제(다른 항목)" }], { risk: "delete" }),
      spec("DEL-BULK", [{ op: "goto", url: "/" }, { op: "probe", kind: "delete", sel: "#del-all", label: "전체 삭제" }], { risk: "delete" }),
      spec("DX-1", [{ op: "goto", url: "/" }, { op: "click", sel: "#noop" }], { risk: "destructive" }),
      spec("LO-1", [{ op: "goto", url: "/" }, { op: "probe", kind: "logout", sel: 'a[href="/logout"]', label: "로그아웃" }], { risk: "logout" }),
    ],
  });
});
afterAll(() => server?.kill());

const round = async (only?: string[]) => {
  const start: any = await A.aRoundStart({ project: root, data: "keep", headless: true, only });
  expect(start.started).toBe(true);
  let st: any;
  do st = await A.aRoundStatus({ project: root, wait_seconds: 30 });
  while (st.running);
  return { id: start.round as string, results: p.readJson<any[]>(`rounds/${start.round}/results.json`, []) };
};

test("1라운드: 재시도·삭제 규칙·로그아웃·스킵·증거", async () => {
  const { id, results } = await round();
  const by = (k: string) => results.find((r) => r.id === k)!;

  // 불안정: 첫 시도 500 → 재시도 1 통과 → 재시도 2 실패 ⇒ 일부만 통과
  expect(by("FL-1").status).toBe("FLAKY");
  expect(by("FL-1").retries).toMatchObject({ n: 2, pass: 1, fail: 1 });
  expect(by("FL-1").reason).toContain("불안정");

  // 경고만 있는 케이스는 통과(승격 전)
  expect(by("PW-1").status).toBe("PASS");
  expect(by("PW-1").warnings.join(" ")).toContain("NO_EFFECT");

  // 삭제: 내가 등록한 것만. 남의 것·전체 삭제는 스킵(이슈 아님)
  expect(by("SG-1").status).toBe("PASS");
  expect(by("DEL-OWN").status).toBe("PASS");
  expect(by("DEL-OTHER").status).toBe("SKIP");
  expect(by("DEL-OTHER").reason).toContain("이슈가 아님");
  expect(by("DEL-BULK").status).toBe("SKIP");
  const items: any[] = await (await fetch(`${base}/api/items`)).json();
  expect(items.some((i) => i.name.includes("e2e+777"))).toBe(false); // 내 것은 지워졌다
  expect(items.some((i) => i.name.includes("샘플 항목 A"))).toBe(true); // 남의 것은 그대로
  expect(by("DX-1").status).toBe("SKIP"); // 그 밖의 파괴적 동작은 스킵
  expect(by("LO-1").status).toBe("PASS");
  expect(by("LO-1").steps.map((s: any) => s.desc).join(" ")).toContain("점검(logout)");

  // 이슈: 불안정 1건만. 스킵 3건은 이슈가 아니다
  const rep: any = A.aRoundReport({ project: root, format: "json" });
  expect(rep.summary).toMatchObject({ FLAKY: 1, SKIP: 3 });
  expect(rep.issue_count).toBe(1);
  expect(rep.issues.map((i: any) => i.id)).toEqual(["FL-1"]);
  expect(rep.trend.at(-1).issues).toBe(1);
  expect(A.aCompleteCheck({ project: root }).complete).toBe(false);

  // 증거: 영상은 mp4 + 챕터, 도장 찍힌 스크린샷, 기록 파일
  const rdir = p.roundDir(id);
  const v = by("PW-1");
  expect(v.video).toMatch(/\.mp4$/);
  expect(existsSync(join(rdir, v.video))).toBe(true);
  expect(existsSync(join(rdir, v.video.replace(/\.mp4$/, ".chapters.txt")))).toBe(true);
  expect(v.chapters).toMatch(/chapters\.txt$/);
  const probe = await run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", join(rdir, v.video)]);
  expect(probe.out).toContain("h264");
  const ch = await run(["ffprobe", "-v", "error", "-show_chapters", "-of", "csv", join(rdir, v.video)]);
  expect(ch.out.trim().split("\n").length).toBeGreaterThanOrEqual(2);
  const man = JSON.parse(readFileSync(join(rdir, "evidence.json"), "utf8"));
  expect(man.files.some((f: any) => f.kind === "video" && f.case === "PW-1")).toBe(true);
  const shot = man.files.find((f: any) => f.kind === "screenshot");
  expect(shot).toBeTruthy();
  expect(shot.sha256).not.toBe(shot.rawSha256); // 도장이 찍혔다
  expect(shot.at).toMatch(/^20\d\d-/);
  expect(existsSync(join(rdir, "_stamps"))).toBe(false);
}, 400000);

test("승격한 경고는 다음 라운드부터 실패(이슈)로 센다", async () => {
  A.aPromoteWarning({ project: root, match: "NO_EFFECT", case: "PW-1" });
  const { results } = await round(["PW-1"]);
  expect(results[0].status).toBe("FAIL");
  expect(results[0].promoted).toBe(true);
  expect(results[0].reason).toContain("승격");
  A.aPromoteWarning({ project: root, match: "NO_EFFECT", case: "PW-1", remove: true });
}, 200000);

test("로그아웃은 테스트한 뒤 다시 로그인하고 로그인 상태가 돌아왔는지 확인한다(로그인 스텝이 있을 때)", async () => {
  const cfg = p.config();
  p.saveConfig({ ...cfg, auth: { setupSteps: [{ op: "goto", url: "/" }] } });
  const { results } = await round(["LO-1"]);
  const r = results[0];
  expect(r.status).toBe("PASS");
  const descs = r.steps.map((s: any) => s.desc);
  expect(descs.filter((d: string) => d.includes("점검(logout)")).length).toBe(1);
  expect(descs.some((d: string) => d.includes("점검(relogin-check)"))).toBe(true);
  expect(r.steps.every((s: any) => s.status === "ok")).toBe(true);
}, 200000);

test("브라우저가 중간에 죽으면 다시 띄워 그 케이스를 한 번 더 돌리고, 그래도 안 되면 사이트 결함이 아니라 검증 못 한 것(BLOCKED)으로 둔다", async () => {
  const { PwDriver } = await import("../src/drivers/playwright.ts");
  const orig = PwDriver.prototype.newSession;
  const opens: number[] = [];
  const origOpen = PwDriver.prototype.open;
  PwDriver.prototype.open = async function (this: any) {
    opens.push(Date.now());
    return origOpen.call(this);
  };
  try {
    // 1) 한 번만 죽는다 → 다시 띄우고 통과
    let calls = 0;
    PwDriver.prototype.newSession = async function (this: any, dir: string) {
      if (++calls === 2) throw new Error("async newContext: Target page, context or browser has been closed");
      return orig.call(this, dir);
    };
    A.aCaseUpsert({ project: root, cases: [spec("RB-1", [{ op: "goto", url: "/about" }, { op: "expect", sel: "h1", text: "소개" }]), spec("RB-2", [{ op: "goto", url: "/about" }, { op: "expect", sel: "h1", text: "소개" }])] });
    const a = await round(["RB-1", "RB-2"]);
    expect(a.results.map((r) => `${r.id}:${r.status}`)).toEqual(["RB-1:PASS", "RB-2:PASS"]);
    expect(opens.length).toBe(2); // 라운드 시작 + 죽은 뒤 다시 띄움
    expect(readFileSync(p.p("rounds", a.id, "events.ndjson"), "utf8")).toContain("browser-relaunch");

    // 2) 계속 죽는다 → 사이트 결함(FAIL)이 아니라 BLOCKED
    PwDriver.prototype.newSession = async function () {
      throw new Error("async newContext: Target page, context or browser has been closed");
    };
    const b = await round(["RB-1"]);
    expect(b.results[0].status).toBe("BLOCKED");
    expect(b.results[0].reason).toContain("브라우저가 죽어");
  } finally {
    PwDriver.prototype.newSession = orig;
    PwDriver.prototype.open = origOpen;
  }
}, 200000);

test("기능 단위의 케이스가 모두 통과하면 그때그때 보고한다(실패가 섞인 기능은 보고하지 않고, 한 번만 알린다)", async () => {
  const ok = [{ op: "goto", url: "/about" }, { op: "expect", sel: "h1", text: "소개" }];
  A.aCaseUpsert({
    project: root,
    cases: [
      spec("FA-1", ok, { feature: "기능 A" }), spec("FA-2", ok, { feature: "기능 A" }),
      spec("FB-1", ok, { feature: "기능 B" }), spec("FB-2", [{ op: "goto", url: "/about" }, { op: "expect", sel: "h1", text: "없는 글" }], { feature: "기능 B" }),
      spec("FC-1", ok, { feature: "기능 C" }),
    ],
  });
  const start: any = await A.aRoundStart({ project: root, data: "keep", headless: true, only: ["FA-1", "FA-2", "FB-1", "FB-2", "FC-1"] });
  const seen: string[] = [];
  let st: any;
  do {
    st = await A.aRoundStatus({ project: root, wait_seconds: 5 });
    seen.push(...(st.feature_reports?.report_to_user ?? []));
  } while (st.running);
  seen.push(...((await A.aRoundStatus({ project: root })) as any).feature_reports.report_to_user); // 이미 알린 것은 다시 나오지 않는다
  const evs = readFileSync(p.p("rounds", start.round, "events.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const order = evs.filter((e) => e.type === "feature-pass" || e.type === "case-end").map((e) => (e.type === "feature-pass" ? `보고:${e.feature}` : e.case));
  // 기능 A 는 두 번째 케이스가 끝난 직후에 보고된다(첫 케이스 뒤가 아니다)
  expect(order.indexOf("보고:기능 A")).toBe(order.indexOf("FA-2") + 1);
  expect(order.filter((x) => x.startsWith("보고:")).sort()).toEqual(["보고:기능 A", "보고:기능 C"]); // B 는 실패가 섞여 보고 없음
  // 상태 조회가 같은 보고를 두 번 돌려주지 않는다
  expect(seen.sort()).toEqual(["기능 “기능 A” (화면 /) 의 케이스 2건이 모두 통과했습니다", "기능 “기능 C” (화면 /) 의 케이스 1건이 모두 통과했습니다"]);
}, 200000);
