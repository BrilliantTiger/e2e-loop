// 시험 도구 오류(NA) 시험: 실제 칸이 비었거나 undefined · NaN 이면 FAIL 이 아니라 NA, 제외 시트와 「이슈 N · 도구 오류 M」 분리.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCase } from "../src/runner.ts";
import { isIssue } from "../src/issues.ts";
import { excludedRows, excludedTsv, isBlankActual, symptomSentence, toolErrorCount } from "../src/toolerror.ts";
import { symptomOfResult, writeSheets } from "../src/sheets.ts";
import { featureDone } from "../src/round.ts";
import { fakeCtx } from "./helpers/fake.ts";
import type { Case, CaseResult, RoundMeta } from "../src/types.ts";

const mk = (id: string, steps: Case["steps"], over: Partial<Case> = {}): Case => ({ id, title: id, type: "spec", source_ref: "기획서 1.1", screen: "/list", feature: "목록", steps, ...over });

test("실제 칸이 비었거나 undefined · NaN · null 이면 도구가 못 읽은 것으로 본다", () => {
  for (const v of ["", "  ", "undefined", "NaN", "null", "합계 NaN원", "줄 undefined", undefined, null, NaN]) expect(isBlankActual(v)).toBe(true);
  for (const v of ["0", "저장됨", "Nancy", "undefinedBehavior"]) expect(isBlankActual(v)).toBe(false);
});

test("기대한 글이 있는데 실제 글이 비면 FAIL 이 아니라 NA(D) 이고 이슈가 아니다", async () => {
  const ctx = fakeCtx({ text: async () => "" });
  const r = await runCase(ctx, mk("T-EMPTY", [{ op: "goto", url: "/list" }, { op: "expect", sel: "#total", text: "3건" }]));
  expect(r.status).toBe("NA");
  expect(r.toolError?.kind).toBe("D");
  expect(r.reason).toContain("도구 판정 불가");
  expect(isIssue(r, { acceptedSkips: [] })).toBe(false);
  expect(r.priority).toBeUndefined();
});

test("실제 글이 undefined 문자열이어도 NA(D) 이다", async () => {
  const ctx = fakeCtx({ text: async () => "줄 undefined" });
  const r = await runCase(ctx, mk("T-UNDEF", [{ op: "goto", url: "/list" }, { op: "expect", sel: "#row", textContains: "visit" }]));
  expect(r.status).toBe("NA");
  expect(r.toolError?.kind).toBe("D");
});

test("실제 글이 있고 기대와 다르면 그대로 FAIL 이다(사이트 결함)", async () => {
  const ctx = fakeCtx({ text: async () => "5건" });
  const r = await runCase(ctx, mk("T-REAL", [{ op: "goto", url: "/list" }, { op: "expect", sel: "#total", text: "3건" }]));
  expect(r.status).toBe("FAIL");
  expect(r.toolError).toBeUndefined();
});

test("기대가 빈 글이면 빈 실제 글은 통과다", async () => {
  const ctx = fakeCtx({ text: async () => "" });
  const r = await runCase(ctx, mk("T-OK", [{ op: "goto", url: "/list" }, { op: "expect", sel: "#msg", text: "" }]));
  expect(r.status).toBe("PASS");
});

test("값 확인도 비면 NA(D) 이고, 한 확인에 진짜 불일치가 섞이면 FAIL 이 먼저다", async () => {
  const ctx = fakeCtx({ value: async () => "", title: async () => "다른 제목" });
  const a = await runCase(ctx, mk("T-VAL", [{ op: "goto", url: "/list" }, { op: "expect", sel: "#q", value: "abc" }]));
  expect(a.status).toBe("NA");
  const b = await runCase(ctx, mk("T-MIX", [{ op: "goto", url: "/list" }, { op: "expect", sel: "#q", value: "abc", title: "목록" }]));
  expect(b.status).toBe("FAIL");
});

test("현상 문장은 「<화면>에서 「<요소>」에 대해 「<동작>」 했더니 「<실제>」 가 나왔다. 기대는 <기대>」 형식이다", () => {
  expect(symptomSentence({ screen: "/list", element: "#total", action: "확인", actual: "5건", expected: "3건" })).toBe("/list에서 「#total」에 대해 「확인」 했더니 「5건」 가 나왔다. 기대는 3건");
});

const meta = (extra: Partial<RoundMeta> = {}): RoundMeta => ({ id: "R01", n: 1, status: "finished", startedAt: "", driver: "t", headless: true, data: { decision: "keep", scope: "round" }, scope: "full", caseHash: "", caseCount: 2, code: {}, baseUrl: "http://x", ...extra });

test("제외 시트에는 NA(도구 오류)만 오르고 사유에 A~E 가 표시된다. 해당 없음(NA)은 오르지 않는다", async () => {
  const ctx = fakeCtx({ text: async () => "" });
  const c1 = mk("T-1", [{ op: "goto", url: "/list" }, { op: "expect", sel: "#total", text: "3건" }]);
  const na = await runCase(ctx, c1);
  const plain: CaseResult = { id: "T-N", title: "해당 없음", type: "spec", status: "NA", reason: "이 환경엔 없음", warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: "" };
  const rows = excludedRows([na, plain], (r) => symptomOfResult(0, r, c1));
  expect(rows.length).toBe(1);
  expect(rows[0]!.kind).toBe("D");
  expect(rows[0]!.reason).toContain("D 화면이 그려지기 전에 읽음");
  expect(rows[0]!.symptom).toContain("/list에서 「#total」에 대해 「확인」 했더니");
  expect(excludedTsv(rows).split("\n")[0]).toBe("케이스\t현상\t제외 사유\t처리\t비고\t증거");
  expect(toolErrorCount([na, plain])).toBe(1);
});

test("라운드 결과물: 「이슈 N · 도구 오류(NA) M」을 따로 보여 주고 excluded_issues 파일을 쓴다", async () => {
  const ctx = fakeCtx({ text: async () => "" });
  const c1 = mk("T-1", [{ op: "goto", url: "/list" }, { op: "expect", sel: "#total", text: "3건" }]);
  const na = await runCase(ctx, c1);
  const p = ctx.project;
  p.saveCases([c1]);
  const results: CaseResult[] = [na];
  const m = meta({ summary: { PASS: 0, FAIL: 0, FLAKY: 0, BLOCKED: 0, NA: 1, SKIP: 0, total: 1, toolError: 1 } });
  p.writeJson("rounds/R01/meta.json", m);
  p.writeJson("rounds/R01/results.json", results);
  const out = writeSheets(p, m, results);
  const dir = p.roundDir("R01");
  expect(readFileSync(out.files.aiMd, "utf8")).toContain("이슈 0 · 도구 오류(NA) 1");
  expect(readFileSync(out.files.aiMd, "utf8")).toContain("## 도구 오류(NA) 1건");
  const j = JSON.parse(readFileSync(out.files.aiJson, "utf8"));
  expect(j.issue_count).toBe(0);
  expect(j.tool_error_count).toBe(1);
  expect(j.excluded[0].id).toBe("T-1");
  expect(readFileSync(join(dir, "excluded_issues.tsv"), "utf8")).toContain("T-1");
  expect(readFileSync(out.files.human, "utf8")).toContain("도구 오류(NA)");
  expect(out.verdict).toBe("PASS");
});

test("이슈의 현상 칸은 문장 형식이다", async () => {
  const ctx = fakeCtx({ text: async () => "5건" });
  const c1 = mk("T-2", [{ op: "goto", url: "/list" }, { op: "expect", sel: "#total", text: "3건" }]);
  const r = await runCase(ctx, c1);
  ctx.project.saveCases([c1]);
  const s = symptomOfResult(0, r, c1);
  expect(s).toMatch(/^\/list에서 「#total」에 대해 「확인」 했더니 「.*5건.*」 가 나왔다\. 기대는 /);
});

test("도구 오류가 있는 기능 단위는 통과로 보고하지 않는다", async () => {
  const ctx = fakeCtx({ text: async () => "" });
  const a = mk("T-A", [{ op: "goto", url: "/list" }]);
  const b = mk("T-B", [{ op: "goto", url: "/list" }, { op: "expect", sel: "#t", text: "x" }]);
  const ra = await runCase(ctx, a);
  const rb = await runCase(ctx, b);
  expect(ra.status).toBe("PASS");
  expect(rb.status).toBe("NA");
  expect(featureDone([a, b], [ra, rb], new Set())).toBeNull();
});

test("빈 글이 사이트의 JS 오류와 함께 나오면 도구 탓이 아니라 사이트 결함이라 FAIL 이다", async () => {
  const ctx = fakeCtx({ text: async () => "", drain: async () => ({ console: [], pageErrors: ["Cannot read properties of undefined (reading 'rows')"], failedRequests: [] }) });
  const r = await runCase(ctx, mk("T-JS", [{ op: "goto", url: "/list" }, { op: "expect", sel: "#total", text: "3건" }]));
  expect(r.status).toBe("FAIL");
  expect(r.toolError).toBeUndefined();
});

// ---------- D: 읽기 전에 그려졌는지 기다린다 ----------

/** 처음 N번 count 를 부르는 동안은 아직 안 그려진 화면 */
const lateRender = (after: number, text: string) => {
  let calls = 0;
  return { count: async () => (++calls > after ? 1 : 0), text: async () => (calls > after ? text : ""), value: async () => (calls > after ? text : "") };
};

test("D: 목록이 늦게 그려져도 읽기 전에 등장을 기다려 통과한다(빈 칸으로 읽지 않는다)", async () => {
  const ctx = fakeCtx(lateRender(4, "3건"));
  const r = await runCase(ctx, mk("T-LATE", [{ op: "goto", url: "/list" }, { op: "expect", sel: "#total", text: "3건" }]));
  expect(r.status).toBe("PASS");
});

test("D: 개수 확인도 그 개수가 될 때까지 기다린다", async () => {
  let calls = 0;
  const ctx = fakeCtx({ count: async () => (++calls > 3 ? 17 : 0) });
  const r = await runCase(ctx, mk("T-CNT", [{ op: "goto", url: "/list" }, { op: "expect", sel: "tr.row", count: 17 }]));
  expect(r.status).toBe("PASS");
});

test("D: eval 은 waitFor 로 목록이 그려진 뒤 읽는다", async () => {
  let calls = 0;
  const ctx = fakeCtx({ count: async () => (++calls > 3 ? 2 : 0), evaluate: async () => 2 as any });
  const r = await runCase(ctx, mk("T-EVAL", [{ op: "goto", url: "/list" }, { op: "eval", script: "document.querySelectorAll('tr').length", equals: 2, waitFor: "tr.row" }]));
  expect(r.status).toBe("PASS");
});

test("D: eval 의 waitFor 목록이 끝내 안 그려지면 FAIL 이 아니라 NA(D) 로 시간과 선택자를 남긴다", async () => {
  const ctx = fakeCtx({ count: async () => 0 });
  const r = await runCase(ctx, mk("T-NEVER", [{ op: "goto", url: "/list" }, { op: "eval", script: "1", waitFor: "tr.row", timeout: 300 }]));
  expect(r.status).toBe("NA");
  expect(r.toolError?.kind).toBe("D");
  expect(r.reason).toContain("tr.row");
  expect(r.reason).toContain("300ms");
});
