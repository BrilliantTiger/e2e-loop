// 사유 R: 선행 챕터가 제품 FAIL 이 아니라 도구 오류(NA)로 끝나면 하위 챕터의 증거가 생기지 않는다 —
// 하위 챕터는 돌리지 않고 「선행 도구 오류로 미실행」 NA(R)로 두고, 재시험 대기열에 올려 선행 챕터를 다시 시험한 뒤 돌린다.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefectGuard } from "../src/chapter.ts";
import { readRetest, retestSelection, updateRetest } from "../src/retest.ts";
import { toolErrorCount, blockedCount } from "../src/toolerror.ts";
import * as A from "../src/actions.ts";
import { Project, nowIso } from "../src/store.ts";
import type { Case, CaseResult } from "../src/types.ts";

const mk = (id: string, chapter: string, requires?: string[]): Case => ({ id, title: id, type: "spec", source_ref: "x", chapter, ...(requires ? { requires } : {}), steps: [{ op: "goto", url: "/" }] });
const res = (c: Case, over: Partial<CaseResult>): CaseResult => ({ id: c.id, title: c.title, type: "spec", status: "PASS", warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: nowIso(), ...over });

test("선행 챕터가 도구 오류로 끝나면 하위 챕터는 NA(R), 그 아래 챕터도 같은 뿌리로 R, 제품 FAIL(H)이 먼저다", () => {
  const g = new DefectGuard((c) => c.chapter!);
  const c45 = mk("C45-1", "C45");
  const c44 = mk("C44-1", "C44", ["C45"]);
  const c50 = mk("C50-1", "C50", ["C44"]);
  g.record(c45, res(c45, { status: "NA", toolError: { kind: "C", detail: "sv 줄 정규식이 화면과 다름" } }));
  expect(g.blockedBy(c44)).toBeUndefined();
  const by = g.toolBlockedBy(c44)!;
  expect(by).toEqual({ chapter: "C45", by: ["C45-1"] });
  const r44 = g.toolNaResult(c44, by);
  expect(r44).toMatchObject({ status: "NA", toolError: { kind: "R" }, retest: { after: "C45", by: ["C45-1"] } });
  expect(r44.reason).toContain("선행 도구 오류로 미실행(C45-1, 챕터 C45)");
  g.record(c44, r44);
  expect(g.toolBlockedBy(c50)).toEqual({ chapter: "C45", by: ["C45-1"] });
  expect(toolErrorCount([r44])).toBe(1);
  expect(blockedCount([r44])).toBe(0);
  // 제품 FAIL 이 있으면 H 가 먼저
  const g2 = new DefectGuard((c) => c.chapter!);
  g2.record(c45, res(c45, { status: "FAIL", reason: "x" }));
  expect(g2.blockedBy(c44)?.chapter).toBe("C45");
});

test("재시험 대기열: 막힌 케이스를 넣고, 다시 돈 케이스는 빼며, 재시험 라운드는 선행 챕터와 대기 케이스를 원래 순서로 고른다", () => {
  const p = new Project(mkdtempSync(join(tmpdir(), "e2e-loop-rt-")));
  p.ensure();
  const cases = [mk("C45-1", "C45"), mk("C45-2", "C45"), mk("C44-1", "C44", ["C45"]), mk("C44-2", "C44", ["C45"]), mk("C60-1", "C60")];
  const ch = (id: string) => cases.find((c) => c.id === id)!.chapter!;
  const r = (id: string) => res(cases.find((c) => c.id === id)!, { status: "NA", toolError: { kind: "R", detail: "-" }, retest: { after: "C45", by: ["C45-1"] }, reason: "선행 도구 오류로 미실행" });
  updateRetest(p, "R09", [res(cases[0]!, {}), r("C44-1"), r("C44-2")], ch);
  expect(readRetest(p).map((e) => `${e.case}<${e.after}`)).toEqual(["C44-1<C45", "C44-2<C45"]);
  expect(retestSelection(p, cases, (c) => c.chapter!).map((c) => c.id)).toEqual(["C45-1", "C45-2", "C44-1", "C44-2"]);
  // 다음 라운드에서 C44-1 은 돌았고(통과) C44-2 는 이번 라운드에 없었다
  updateRetest(p, "R10", [res(cases[2]!, {})], ch);
  expect(readRetest(p).map((e) => e.case)).toEqual(["C44-2"]);
});

// ---- 실제 라운드 ----
const port = 4597;
const root = mkdtempSync(join(tmpdir(), "e2e-loop-rt-run-"));
let server: ReturnType<typeof Bun.spawn>;
beforeAll(async () => {
  writeFileSync(join(root, "bugs.json"), "{}");
  writeFileSync(join(root, "PLAN.md"), "# 기획서\n");
  server = Bun.spawn(["bun", join(import.meta.dir, "../examples/demo-site/server.ts"), root, String(port)], { stdout: "ignore", stderr: "inherit" });
  await Bun.sleep(800);
  const p = new Project(root);
  p.ensure();
  p.saveConfig({ ...p.config(), baseUrl: `http://127.0.0.1:${port}`, driver: "chromium", headless: true, dashboardPort: 7799 });
  A.aPrestart({ project: root, dataPolicy: "keep", maxRounds: 10, login: "none", account: { mode: "none" }, acknowledged: true });
  A.aSourceAdd({ project: root, kind: "plan", title: "기획서", location: join(root, "PLAN.md") });
});
afterAll(() => server?.kill());

const wait = async () => {
  let st: any;
  do st = await A.aRoundStatus({ project: root, wait_seconds: 30 });
  while (st.running);
  return st;
};

test("라운드: 선행 챕터의 도구 오류로 하위 챕터는 누르지 않고 NA(R)·대기열에 오르고, 선행을 고친 뒤 retest=true 로 둘 다 돌아 대기열이 빈다", async () => {
  const chk = (id: string, chapter: string, step: Case["steps"][number], requires?: string[]): Case => ({ id, title: id, type: "spec", source_ref: "x", screen: "/", feature: chapter, chapter, ...(requires ? { requires } : {}), steps: [{ op: "goto", url: "/" }, step] });
  // 선행 C45: 판정용 값을 잘라 비교해 어긋남 → 도구 오류 NA(G)
  const broken = chk("C45-1", "C45", { op: "eval", script: "document.title.slice(0, 1)", equals: "없는 값", basis: "POL-1" });
  const fixed = chk("C45-1", "C45", { op: "expect", sel: "h1", textContains: "", basis: "POL-1" });
  const down = chk("C44-1", "C44", { op: "expect", sel: "h1", textContains: "", basis: "POL-1" }, ["C45"]);
  const other = chk("C60-1", "C60", { op: "expect", sel: "h1", textContains: "", basis: "POL-1" });
  expect(A.aCaseUpsert({ project: root, cases: [broken, down, other] }).errors).toEqual([]);
  const r1: any = await A.aRoundStart({ project: root, data: "keep", headless: true });
  expect(r1.started).toBe(true);
  await wait();
  const p = new Project(root);
  const res1 = p.readJson<CaseResult[]>(`rounds/${r1.round}/results.json`, []);
  const by = (rs: CaseResult[], k: string) => rs.find((r) => r.id === k)!;
  expect(by(res1, "C45-1").toolError?.kind).toBe("G");
  expect(by(res1, "C44-1")).toMatchObject({ status: "NA", toolError: { kind: "R" }, retest: { after: "C45" } });
  expect(by(res1, "C44-1").steps.length).toBe(0);
  expect(by(res1, "C60-1").status).toBe("PASS");
  expect(readRetest(p).map((e) => e.case)).toEqual(["C44-1"]);
  expect(readFileSync(p.p("rounds", r1.round, "events.ndjson"), "utf8")).toContain('"type":"chapter-retest"');
  expect(readFileSync(p.p("rounds", r1.round, "ai-sheet.md"), "utf8")).toContain("재시험 대기열 1건 — C44 1건(선행 C45 재시험 뒤)");
  // 선행 챕터의 시험을 고친 뒤 재시험 라운드: 선행 C45 와 대기 C44 만 돈다
  A.aCaseUpsert({ project: root, cases: [fixed] });
  const r2: any = await A.aRoundStart({ project: root, data: "keep", headless: true, retest: true });
  expect(r2.started).toBe(true);
  expect(r2.scope).toBe("partial");
  await wait();
  const res2 = p.readJson<CaseResult[]>(`rounds/${r2.round}/results.json`, []);
  expect(res2.map((r) => `${r.id}:${r.status}`)).toEqual(["C45-1:PASS", "C44-1:PASS"]);
  expect(readRetest(p)).toEqual([]);
  const again: any = await A.aRoundStart({ project: root, data: "keep", headless: true, retest: true });
  expect(again.error).toContain("재시험 대기열이 비어 있습니다");
}, 200000);

// ---- F 의 하위 항목: 시험 조건 불성립(일부러 만드는 실패·장애의 조건이 안 섬) ----
import { runCase } from "../src/runner.ts";
import { ChapterGuard } from "../src/chapter.ts";
import { excludedRows } from "../src/toolerror.ts";
import { fakeCtx } from "./helpers/fake.ts";

test("시험 조건이 안 서면(파일이 안 바뀌어 장애 난 API 를 안 부르는 경로) 누르지 않고 FAIL 이 아니라 「시험 조건 불성립」 NA(F), 챕터는 끝내지 않고 재시험 대기열(다음 라운드)로 간다", async () => {
  let changed = false;
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ diff: { changed } }) });
  try {
    const clicks: string[] = [];
    const ctx = fakeCtx({ click: async (s: string) => void clicks.push(s) });
    ctx.cfg.baseUrl = `http://127.0.0.1:${srv.port}`;
    const c: Case = { id: "C18-F1", title: "ccb-api 중지 중 Handoff — 실패 칩", type: "spec", source_ref: "절차서", chapter: "C18", tags: ["fault"], steps: [
      { op: "goto", url: "/handoff" },
      { op: "condition", name: "파일 내용이 바뀌어 ccb-api 를 부르는 경로", api: { url: "/api/diff", json: { "diff.changed": true } } },
      { op: "click", sel: "#send" },
      { op: "expect", sel: "row=ae", textContains: "실패", basis: "POL-057" },
    ] };
    const r = await runCase(ctx, c);
    expect(r.status).toBe("NA");
    expect(r.toolError).toMatchObject({ kind: "F", sub: "condition" });
    expect(r.reason).toContain("시험 조건 불성립: 「파일 내용이 바뀌어 ccb-api 를 부르는 경로」");
    expect(r.reason).toContain('diff.changed=false');
    expect(clicks).toEqual([]);
    const row = excludedRows([r], () => "-", { round: "R09" })[0]!;
    expect(row.reason).toContain("F 시험 조건 불성립");
    expect(row.action).toContain("다음 라운드에 재시험");
    // 챕터를 끝내지 않는다 — 같은 챕터의 다음 케이스는 돈다
    const g = new ChapterGuard((x) => x.chapter!);
    g.settle(c, r);
    expect(g.skipReason({ ...c, id: "C18-02" })).toBeUndefined();
    // 재시험 대기열: 선행 챕터 없이 다음 라운드
    const p = new Project(mkdtempSync(join(tmpdir(), "e2e-loop-rtc-")));
    p.ensure();
    updateRetest(p, "R09", [r], () => "C18");
    expect(readRetest(p)).toMatchObject([{ case: "C18-F1", kind: "F" }]);
    expect(readRetest(p)[0]!.after).toBeUndefined();
    // 조건이 서면 그대로 누르고 판정한다
    changed = true;
    const ok = await runCase(ctx, { ...c, steps: [...c.steps.slice(0, 3), { op: "expect", sel: "#done", visible: true, basis: "POL-1" }] });
    expect(ok.status).toBe("PASS");
    expect(ok.steps[1]!.desc).toContain("성립(diff.changed=true)");
    expect(clicks).toEqual(["#send"]);
  } finally {
    srv.stop(true);
  }
});

test("등록: 시험 조건에 name·확인할 것이 없으면 거부, 장애를 일부러 만드는 케이스(태그 fault)에 시험 조건이 없으면 경고", () => {
  const up = A.aCaseUpsert({ project: root, cases: [
    { id: "F-BAD", title: "x", type: "spec", source_ref: "x", steps: [{ op: "goto", url: "/" }, { op: "condition", name: "조건" }] },
    { id: "F-NOC", title: "x", type: "spec", source_ref: "x", tags: ["fault"], steps: [{ op: "goto", url: "/" }, { op: "expect", sel: "h1", textContains: "", basis: "POL-1" }] },
  ] });
  expect(up.errors.join()).toContain("F-BAD: 시험 조건 #2 에는 name");
  expect(up.warns.join()).toContain("F-NOC: 실패·장애를 일부러 만드는 케이스(태그 fault)에 시험 조건(condition 스텝)이 없음");
  A.aCaseSetStatus({ project: root, ids: ["F-NOC"], status: "na", reason: "시험용" });
});
