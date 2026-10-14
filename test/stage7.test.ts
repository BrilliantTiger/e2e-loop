// 7단계 시험: 사용자 요청 반영 규칙. 다음 라운드가 기본, "지금 라운드부터"는 방식을 먼저 묻고, 반영 전에는 다음 라운드를 시작하지 않는다.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "../src/actions.ts";
import { addFeedback, resolveFeedback } from "../src/feedback.ts";
import { Project } from "../src/store.ts";
import { completeCheck } from "../src/gate.ts";
import { precheck } from "../src/round.ts";
import type { Case, RoundMeta } from "../src/types.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "e2e-loop-s7-"));
const spec = (id: string, steps: Case["steps"], over: Partial<Case> = {}): Case => ({ id, title: id, type: "spec", source_ref: "시험", screen: "/", feature: "시험", steps, ...over });

/** 진행 중인 라운드를 흉내 낸다(이 프로세스가 돌리는 것으로) */
function fakeRunning(p: Project, n = 1) {
  const id = "R" + String(n).padStart(2, "0");
  const meta: RoundMeta = { id, n, status: "running", startedAt: "", driver: "t", headless: true, data: { decision: "keep", scope: "round" }, scope: "full", caseHash: "x", caseCount: 3, code: {}, baseUrl: "http://x" };
  p.writeJson(`rounds/${id}/meta.json`, meta);
  writeFileSync(p.p("running.json"), JSON.stringify({ pid: process.pid, round: id }));
  return id;
}

test("진행 중인 라운드가 없으면 다음 라운드부터 적용하고, 반영하고 표시할 때까지 pending", () => {
  const p = new Project(tmp());
  p.ensure();
  const r: any = addFeedback(p, { text: "소개 화면 제목도 확인해줘" });
  expect(r.ok).toBe(true);
  expect(r.feedback).toMatchObject({ id: "FB001", appliesTo: "next-round", appliesFrom: "R01", status: "pending" });
  expect(r.message).toContain("R01 회차부터");
  const done = resolveFeedback(p, ["FB001"], "케이스 SPEC-9 추가");
  expect(done[0]).toMatchObject({ status: "done", note: "케이스 SPEC-9 추가" });
  expect(done[0]!.resolvedAt).toBeTruthy();
});

test("라운드 도중 요청은 지금 라운드를 건드리지 않고 다음 라운드부터 적용한다(기본)", () => {
  const p = new Project(tmp());
  p.ensure();
  const id = fakeRunning(p, 3);
  const r: any = addFeedback(p, { text: "로그인 후 화면도 봐줘" });
  expect(r.ok).toBe(true);
  expect(r.feedback).toMatchObject({ appliesTo: "next-round", appliesFrom: "R04", duringRound: id });
  expect(r.message).toContain("R03 회차는 그대로 두고 R04 회차부터");
  expect(existsSync(p.p("stop"))).toBe(false); // 라운드를 멈추지 않았다
  // apply=next 를 명시해도 같다
  expect((addFeedback(p, { text: "또 하나", apply: "next" }) as any).feedback.appliesTo).toBe("next-round");
});

test('"지금 라운드부터"는 처음부터 다시 / 지금 흐름에서 적용을 먼저 묻고, 답이 오기 전에는 아무것도 바꾸지 않는다', () => {
  const p = new Project(tmp());
  p.ensure();
  fakeRunning(p, 2);
  const ask: any = addFeedback(p, { text: "지금 라운드부터 적용해줘", apply: "now" });
  expect(ask.ok).toBe(false);
  expect(ask.needs_decision).toBe(true);
  expect(ask.question).toContain("R02 회차가 진행 중");
  expect(ask.options.map((o: any) => o.value)).toEqual(["restart", "in-flow", "next"]);
  expect(p.feedback()).toEqual([]); // 기록도 하지 않았다
  expect(existsSync(p.p("stop"))).toBe(false);
  expect(existsSync(p.p("inject.json"))).toBe(false);
});

test("처음부터 다시(restart): 진행 중인 라운드를 멈추라고 요청하고, 멈춘 뒤 반영·표시해야 새로 시작할 수 있다", () => {
  const p = new Project(tmp());
  p.ensure();
  fakeRunning(p, 1);
  const r: any = addFeedback(p, { text: "지금 라운드부터", apply: "now", mode: "restart" });
  expect(r.ok).toBe(true);
  expect(r.feedback.appliesTo).toBe("now-restart");
  expect(existsSync(p.p("stop"))).toBe(true);
  expect(r.message).toContain("처음부터 다시");
});

test("지금 흐름에서 적용(in-flow): 케이스를 저장하고 끼워 넣을 목록을 남긴다", () => {
  const p = new Project(tmp());
  p.ensure();
  p.saveCases([spec("A", [{ op: "goto", url: "/" }])]);
  fakeRunning(p, 1);
  const extra = spec("NEW-1", [{ op: "goto", url: "/about" }]);
  const r: any = addFeedback(p, { text: "소개 화면도 지금 확인해줘", apply: "now", mode: "in-flow", cases: [extra] });
  expect(r.ok).toBe(true);
  expect(r.feedback).toMatchObject({ appliesTo: "now-in-flow", appliesFrom: "R01" });
  expect(p.cases().map((c) => c.id)).toEqual(["A", "NEW-1"]);
  expect(JSON.parse(readFileSync(p.p("inject.json"), "utf8")).map((c: Case) => c.id)).toEqual(["NEW-1"]);
  expect(r.message).toContain("완료 근거가 되지 않으므로");
});

test("반영하지 않은 요청이 있으면 다음 라운드를 시작할 수 없고, 표시하면 시작할 수 있다. 상태도 그것부터 하라고 알려 준다", async () => {
  const root = tmp();
  const p = new Project(root);
  p.ensure();
  p.saveConfig(p.config());
  writeFileSync(join(root, "plan.md"), "# 기획서");
  p.writeJson("sources.json", [{ id: "S01", kind: "plan", title: "기획서", location: join(root, "plan.md"), addedAt: "" }]);
  p.saveCases([spec("A", [{ op: "goto", url: "/" }])]);
  A.aPrestart({ project: root, dataPolicy: "keep", maxRounds: 10, login: "none", account: { mode: "none" }, acknowledged: true });
  expect((precheck(p, { data: "keep" }) as any).ok).toBe(true);
  addFeedback(p, { text: "상한을 3번으로 줄여줘" });
  const blocked: any = precheck(p, { data: "keep" });
  expect(blocked.ok).toBe(false);
  expect(blocked.error).toContain("아직 반영하지 않은 사용자 요청 1건");
  expect(blocked.error).toContain("FB001");
  expect(blocked.error).toContain("e2e_feedback_resolve");
  await A.aSessionStart({ project: root, mode: "here", baseUrl: "http://127.0.0.1:1" }).catch(() => {});
  expect((A.aStatus({ project: root }) as any).next).toContain("사용자 요청 1건을 먼저 반영");
  resolveFeedback(p, ["FB001"], "해당 없음: 이미 10번 이하로 쓰는 중");
  expect((precheck(p, { data: "keep" }) as any).ok).toBe(true);
});

test("완료 판정: 도중에 끼워 넣은 케이스가 있는 라운드는 완료 근거가 아니다", () => {
  const p = new Project(tmp());
  p.ensure();
  const { caseHash } = require("../src/store.ts");
  p.saveCases([spec("A", [{ op: "goto", url: "/" }])]);
  const meta: RoundMeta = { id: "R01", n: 1, status: "finished", startedAt: "", driver: "t", headless: true, data: { decision: "keep", scope: "round" }, scope: "full", caseHash: caseHash(p.cases()), caseCount: 1, code: {}, baseUrl: "x", injected: ["A"] };
  p.writeJson("rounds/R01/meta.json", meta);
  p.writeJson("rounds/R01/results.json", [{ id: "A", title: "A", type: "spec", status: "PASS", warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 1, startedAt: "" }]);
  const g = completeCheck(p);
  expect(g.complete).toBe(false);
  expect(g.reasons.join(" ")).toContain("끼워 넣은 케이스");
  p.writeJson("rounds/R01/meta.json", { ...meta, injected: undefined });
  expect(completeCheck(p).complete).toBe(true);
});

// ---------- 실제 라운드(Chromium)로 확인 ----------

const port = 4574;
const base = `http://127.0.0.1:${port}`;
const root = tmp();
let server: ReturnType<typeof Bun.spawn>;
let p: Project;
const slow = (id: string) => spec(id, [{ op: "goto", url: "/" }, { op: "wait", ms: 2500 }, { op: "expect", sel: "h1", text: "대시보드" }]);

beforeAll(async () => {
  writeFileSync(join(root, "bugs.json"), "{}");
  writeFileSync(join(root, "PLAN.md"), "# 기획서\n");
  server = Bun.spawn(["bun", join(import.meta.dir, "../examples/demo-site/server.ts"), root, String(port)], { stdout: "ignore", stderr: "inherit" });
  await Bun.sleep(800);
  p = new Project(root);
  p.ensure();
  p.saveConfig({ ...p.config(), baseUrl: base, driver: "chromium", headless: true, dashboardPort: 7860 });
  A.aPrestart({ project: root, dataPolicy: "keep", maxRounds: 10, login: "none", account: { mode: "none" }, acknowledged: true });
  A.aSourceAdd({ project: root, kind: "plan", title: "기획서", location: join(root, "PLAN.md") });
  A.aCaseUpsert({ project: root, cases: [slow("S1"), slow("S2"), slow("S3")] });
});
afterAll(() => server?.kill());

const wait = async () => {
  let st: any;
  do st = await A.aRoundStatus({ project: root, wait_seconds: 30 });
  while (st.running);
};

test("지금 흐름에서 적용: 도중에 끼워 넣은 케이스가 같은 라운드에서 실행되지만, 그 라운드는 완료 근거가 아니고 새 전체 라운드 뒤에 완료된다", async () => {
  const start: any = await A.aRoundStart({ project: root, data: "keep", headless: true });
  expect(start.started).toBe(true);
  await Bun.sleep(1200);
  const r: any = A.aFeedback({ project: root, text: "소개 화면도 지금 확인해줘", apply: "now", mode: "in-flow", cases: [spec("NEW-ABOUT", [{ op: "goto", url: "/about" }, { op: "expect", sel: "h1", text: "소개" }], { screen: "/about" })] });
  expect(r.ok).toBe(true);
  await wait();
  const results = p.readJson<any[]>(`rounds/${start.round}/results.json`, []);
  expect(results.map((x) => x.id)).toEqual(["S1", "S2", "S3", "NEW-ABOUT"]);
  expect(results.every((x) => x.status === "PASS")).toBe(true);
  const meta = p.readJson<RoundMeta>(`rounds/${start.round}/meta.json`, null as any);
  expect(meta.injected).toEqual(["NEW-ABOUT"]);
  expect(meta.caseCount).toBe(4);
  // 요청을 반영했다고 표시하기 전에는 다음 라운드를 시작할 수 없다
  const blocked: any = await A.aRoundStart({ project: root, data: "keep", headless: true });
  expect(blocked.error).toContain("아직 반영하지 않은 사용자 요청 1건");
  A.aFeedbackResolve({ project: root, ids: [r.feedback.id], note: "NEW-ABOUT 케이스로 반영" });
  // 이 라운드는 완료 근거가 아니다
  const gate = A.aCompleteCheck({ project: root });
  expect(gate.complete).toBe(false);
  expect(gate.reasons.join(" ")).toContain("끼워 넣은 케이스");
  // 시트에는 이 라운드에 반영한 요청이 적힌다(도중 적용으로)
  const ai = JSON.parse(readFileSync(join(p.roundDir(start.round), "ai-sheet.json"), "utf8"));
  expect(ai.appliedFeedback).toEqual([expect.objectContaining({ id: r.feedback.id, appliesTo: "now-in-flow" })]);
  expect(readFileSync(join(p.roundDir(start.round), "ai-sheet.md"), "utf8")).toContain("도중 적용");
  expect(readFileSync(join(p.roundDir(start.round), "report.html"), "utf8")).toContain("라운드 도중에 적용");
  // 새 전체 라운드가 통과하면 완료
  const second: any = await A.aRoundStart({ project: root, data: "keep", headless: true });
  expect(second.started).toBe(true);
  await wait();
  expect(A.aCompleteCheck({ project: root }).complete).toBe(true);
}, 300000);

test("처음부터 다시: 라운드가 멈추고(중단은 상한에 세지 않음), 요청을 반영·표시한 뒤 처음부터 다시 돌린다", async () => {
  const start: any = await A.aRoundStart({ project: root, data: "keep", headless: true });
  await Bun.sleep(1200);
  const r: any = A.aFeedback({ project: root, text: "지금 라운드부터, 공지 화면도", apply: "now", mode: "restart" });
  expect(r.ok).toBe(true);
  await wait();
  const meta = p.readJson<RoundMeta>(`rounds/${start.round}/meta.json`, null as any);
  expect(meta.status).toBe("aborted");
  expect(A.aCompleteCheck({ project: root }).complete).toBe(false); // 중단된 라운드는 근거가 아니다
  const blocked: any = await A.aRoundStart({ project: root, data: "keep", headless: true });
  expect(blocked.error).toContain("아직 반영하지 않은 사용자 요청");
  A.aCaseUpsert({ project: root, cases: [spec("NEW-NOTICE", [{ op: "goto", url: "/" }, { op: "expect", sel: "#open-notice", visible: true }])] });
  A.aFeedbackResolve({ project: root, ids: [r.feedback.id], note: "NEW-NOTICE 추가" });
  const again: any = await A.aRoundStart({ project: root, data: "keep", headless: true });
  expect(again.started).toBe(true);
  expect(again.scope).toBe("full");
  expect(again.cases).toBe(5); // 처음부터 전부 다시(새 케이스 포함)
  await wait();
  const res = p.readJson<any[]>(`rounds/${again.round}/results.json`, []);
  expect(res.map((x) => x.id)).toEqual(["S1", "S2", "S3", "NEW-ABOUT", "NEW-NOTICE"]);
  expect(A.aCompleteCheck({ project: root }).complete).toBe(true);
}, 300000);
