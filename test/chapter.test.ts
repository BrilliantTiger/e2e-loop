// 오류 F(앞 단계가 실패했는데 뒤 단계를 계속 누름) 시험: 챕터 선행 조건과 연속 읽기 실패.
import { expect, test } from "bun:test";
import { runCase } from "../src/runner.ts";
import { ChapterGuard, isReadFailure } from "../src/chapter.ts";
import { aCaseUpsert } from "../src/actions.ts";
import { toolErrorCount } from "../src/toolerror.ts";
import { fakeCtx } from "./helpers/fake.ts";
import type { Case, CaseResult } from "../src/types.ts";

const mk = (id: string, steps: Case["steps"], over: Partial<Case> = {}): Case => ({ id, title: id, type: "spec", source_ref: "기획서 1.1", screen: "/list", feature: "삭제", steps, ...over });
const key = (c: Case) => `${c.screen}|${c.feature}`;

const res = (id: string, status: CaseResult["status"], over: Partial<CaseResult> = {}): CaseResult => ({
  id, title: id, type: "spec", status, warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: "", ...over,
});
const notFound = (id: string): CaseResult =>
  res(id, "FAIL", { reason: "x", steps: [{ i: 1, op: "click", desc: "클릭", status: "fail", ms: 1, error: "Timeout 5000ms exceeded. waiting for locator('row=A')" }] });
const blank = (id: string): CaseResult => res(id, "NA", { toolError: { kind: "D", detail: "실제 값을 읽지 못함(빈 칸·undefined·NaN)" } });

test("prereq 스텝: 대상 줄을 못 찾으면 FAIL 이 아니라 NA(F) 이고 뒤 동작을 누르지 않는다", async () => {
  const clicked: string[] = [];
  const ctx = fakeCtx({ count: async () => 0, click: async (s) => void clicked.push(s) });
  const r = await runCase(ctx, mk("T-PRE", [
    { op: "goto", url: "/list" },
    { op: "prereq", name: "대상 줄을 찾았다", sel: "row=홍길동", count: 1 },
    { op: "click", sel: "row=홍길동 >> button" },
    { op: "expect", sel: "#msg", text: "삭제됨", basis: "POL-1" },
  ]));
  expect(r.status).toBe("NA");
  expect(r.toolError?.kind).toBe("F");
  expect(r.reason).toContain("선행 조건 실패 — 도구");
  expect(r.reason).toContain("대상 줄을 찾았다");
  expect(clicked).toEqual([]);
  expect(r.steps.map((s) => s.status)).toEqual(["ok", "fail", "skip", "skip"]);
  expect(toolErrorCount([r])).toBe(1);
});

test("prereq 스텝: 조건을 채우면 뒤 스텝이 그대로 돈다", async () => {
  const clicked: string[] = [];
  const ctx = fakeCtx({ count: async () => 1, click: async (s) => void clicked.push(s) });
  const r = await runCase(ctx, mk("T-PRE-OK", [
    { op: "goto", url: "/list" },
    { op: "prereq", name: "대상 줄을 찾았다", sel: "#row", count: 1 },
    { op: "click", sel: "#del" },
  ]));
  expect(r.status).toBe("PASS");
  expect(clicked).toEqual(["#del"]);
});

test("prereq 등록: name 과 확인할 내용이 없으면 거부한다", () => {
  const ctx = fakeCtx({});
  const out = aCaseUpsert({ project: ctx.project.root, cases: [
    mk("C-1", [{ op: "goto", url: "/" }, { op: "prereq", sel: "#a", count: 1 }]),
    mk("C-2", [{ op: "goto", url: "/" }, { op: "prereq", name: "줄 있음" }]),
    mk("C-3", [{ op: "goto", url: "/" }, { op: "prereq", name: "줄 있음", sel: "#a", count: 1 }, { op: "expect", sel: "#a", text: "x", basis: "POL-1" }]),
  ] });
  expect(out.errors.length).toBe(2);
  expect(out.added).toBe(1);
});

test("선행 조건 실패(NA F)가 나면 같은 챕터의 나머지 케이스는 돌리지 않고 NA(F), 다른 챕터는 그대로", () => {
  const g = new ChapterGuard(key);
  const a1 = mk("A1", [{ op: "goto", url: "/" }]);
  const a2 = mk("A2", [{ op: "goto", url: "/" }]);
  const b1 = mk("B1", [{ op: "goto", url: "/" }], { feature: "다른 기능" });
  expect(g.skipReason(a2)).toBeUndefined();
  g.settle(a1, res("A1", "NA", { toolError: { kind: "F", detail: "선행 조건 실패 — 도구: 「줄」" } }));
  expect(g.skipReason(a2)).toContain("선행 조건 실패");
  expect(g.skipReason(b1)).toBeUndefined();
  const na = g.naResult(a2, g.skipReason(a2)!);
  expect(na.status).toBe("NA");
  expect(na.toolError?.kind).toBe("F");
  expect(na.steps.length).toBe(0);
});

test("읽기 실패 판별: 요소 못 찾음·빈 값은 읽기 실패, 값이 틀린 FAIL 과 예상 못 한 대화상자는 아니다", () => {
  expect(isReadFailure(notFound("x"))).toBe(true);
  expect(isReadFailure(blank("x"))).toBe(true);
  expect(isReadFailure(res("x", "FAIL", { steps: [{ i: 1, op: "expect", desc: "", status: "fail", ms: 1, error: '텍스트가 다름: 기대 "3건" / 실제 "5건"' }] }))).toBe(false);
  expect(isReadFailure(res("x", "NA", { toolError: { kind: "D", detail: "예상 못 한 대화상자가 떠 있어 이 단계를 판정하지 못함" } }))).toBe(false);
  expect(isReadFailure(res("x", "PASS"))).toBe(false);
});

test("읽기 실패 연속: 1번째는 그대로, 2번째부터 NA(F), 4번째에서 챕터를 끝내 뒤 케이스는 돌리지 않는다", () => {
  const g = new ChapterGuard(key);
  const cs = [1, 2, 3, 4, 5].map((n) => mk(`R${n}`, [{ op: "goto", url: "/" }]));
  const out: CaseResult[] = [];
  for (const c of cs) {
    const why = g.skipReason(c);
    if (why) {
      out.push(g.naResult(c, why));
      continue;
    }
    expect(g.willConvert(c, notFound(c.id))).toBe(out.length >= 1);
    out.push(g.settle(c, notFound(c.id)));
  }
  expect(out.map((r) => r.status)).toEqual(["FAIL", "NA", "NA", "NA", "NA"]);
  expect(out.map((r) => r.toolError?.kind)).toEqual([undefined, "F", "F", "F", "F"]);
  expect(out[3]!.reason).toContain("읽기 실패 4번 연속");
  expect(out[4]!.reason).toContain("챕터를 끝냄");
  expect(out[4]!.steps.length).toBe(0);
});

test("읽기 실패 사이에 통과하거나 값이 틀린 FAIL 이 끼면 연속이 끊긴다", () => {
  const g = new ChapterGuard(key);
  const c = mk("S", [{ op: "goto", url: "/" }]);
  expect(g.settle(c, blank("S")).status).toBe("NA"); // 1번째: 빈 값 NA(D) 그대로
  expect(g.settle(c, res("S", "PASS")).status).toBe("PASS");
  expect(g.settle(c, notFound("S")).status).toBe("FAIL"); // 다시 1번째
  expect(g.settle(c, res("S", "FAIL", { steps: [{ i: 1, op: "expect", desc: "", status: "fail", ms: 1, error: "텍스트가 다름" }] })).status).toBe("FAIL");
  expect(g.settle(c, notFound("S")).status).toBe("FAIL"); // 또 1번째
});

test("자동 점검(probe)·해당 없음·건너뜀 케이스는 챕터 가드를 받지 않는다", () => {
  const g = new ChapterGuard(key);
  const probe = mk("P", [{ op: "goto", url: "/" }], { type: "probe" });
  for (let i = 0; i < 5; i++) g.settle(probe, notFound("P"));
  expect(g.skipReason(probe)).toBeUndefined();
  expect(g.settle(probe, notFound("P")).status).toBe("FAIL");
  const spec = mk("S", [{ op: "goto", url: "/" }]);
  for (let i = 0; i < 4; i++) g.settle(spec, notFound("S"));
  expect(g.skipReason(mk("S2", [{ op: "goto", url: "/" }], { status: "blocked" }))).toBeUndefined();
  expect(g.skipReason(mk("S3", [{ op: "goto", url: "/" }], { skipReason: "규칙" }))).toBeUndefined();
  expect(g.skipReason(mk("S4", [{ op: "goto", url: "/" }]))).toContain("챕터를 끝냄");
});
