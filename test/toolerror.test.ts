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

// ---------- A: 끝 상태 집합 대기 ----------
import { waitEndState, singleEndState, SINGLE_STATE_WARNING } from "../src/waits.ts";
import { aCaseUpsert } from "../src/actions.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basePage } from "./helpers/fake.ts";

const ends = { 완료: "#done", "확인 필요": "#review", 막힘: "#blocked", 오류: "#error", "비활성 사유": "#why" };
/** 선택자별로 보이기 시작하는 시각이 정해진 가짜 화면 */
const timed = (showAt: Record<string, number>, text: () => string = () => "처리 중") => {
  const t0 = Date.now();
  const on = (sel: string) => showAt[sel] !== undefined && Date.now() - t0 >= showAt[sel]!;
  return { ...basePage(), count: async (sel: string) => (on(sel) ? 1 : 0), isVisible: async (sel: string) => on(sel), evaluate: async (expr: string) => (expr.includes("location.pathname") ? `sig|${text()}` : text()) as any };
};

test("A: 오지 않을 「완료」 대신 「확인 필요」가 나타나면 그 상태로 끝난다(끝없이 기다리지 않는다)", async () => {
  const got = await waitEndState(timed({ "#review": 200 }), { endStates: ends }, { pollMs: 30 });
  expect(got.state).toBe("확인 필요");
});

test("A: expectState 와 다른 끝 상태가 오면 실패(기대와 다른 끝 상태)이고 도구 오류가 아니다", async () => {
  await expect(waitEndState(timed({ "#review": 100 }), { endStates: ends, expectState: "완료" }, { pollMs: 30 })).rejects.toThrow(/「확인 필요」/);
  const ok = await waitEndState(timed({ "#done": 100 }), { endStates: ends, expectState: ["완료", "확인 필요"] }, { pollMs: 30 });
  expect(ok.state).toBe("완료");
});

test("A: 화면이 idleMs 동안 안 바뀌면 현재 상태를 로그에 남기고 대기 실패(NA·A)로 끝난다", async () => {
  const logs: string[] = [];
  const err: any = await waitEndState(timed({}), { endStates: ends, idleMs: 250 }, { pollMs: 30, logEveryMs: 100, onLog: (l) => logs.push(l) }).catch((e) => e);
  expect(err.name).toBe("ToolError");
  expect(err.kind).toBe("A");
  expect(err.message).toContain("처리 중");
  expect(err.message).toContain("완료 · 확인 필요 · 막힘 · 오류 · 비활성 사유");
  expect(logs.some((l) => l.startsWith("대기 중"))).toBe(true); // 주기 로그
  expect(logs.at(-1)).toContain("대기 실패(도구 판정 불가)");
});

test("A: 화면이 계속 바뀌면(진행 중) idleMs 를 넘겨도 기다리고, 끝 상태가 오면 끝난다", async () => {
  let n = 0;
  const page = timed({ "#done": 700 }, () => `진행 ${++n}`);
  const got = await waitEndState(page, { endStates: ends, idleMs: 200 }, { pollMs: 40 });
  expect(got.state).toBe("완료");
});

test("A: 전체 상한을 넘기면 도구 판정 불가", async () => {
  let n = 0;
  const err: any = await waitEndState(timed({}, () => `진행 ${++n}`), { endStates: ends, idleMs: 99999, timeout: 200 }, { pollMs: 30 }).catch((e) => e);
  expect(err.kind).toBe("A");
});

test("A: 러너에서 끝 상태 대기가 NA(A)가 되고 제외 사유에 A 가 표시된다. 끝 상태를 하나만 받으면 경고한다", async () => {
  const log: string[] = [];
  const ctx = fakeCtx(timed({}), log);
  const r = await runCase(ctx, mk("T-A", [{ op: "goto", url: "/h" }, { op: "wait", endStates: { 완료: "#done" }, idleMs: 200 }]));
  expect(r.status).toBe("NA");
  expect(r.toolError?.kind).toBe("A");
  expect(r.warnings).toContain(SINGLE_STATE_WARNING);
  expect(log.some((l) => l.includes("wait-log"))).toBe(true);
  const rows = excludedRows([r], () => "x");
  expect(rows[0]!.reason).toContain("A 오지 않을 상태를 기다림");
});

test("A: 러너에서 끝 상태가 도착하면 통과하고 도착한 상태를 단계 설명에 남긴다", async () => {
  const ctx = fakeCtx(timed({ "#blocked": 100 }));
  const r = await runCase(ctx, mk("T-A2", [{ op: "goto", url: "/h" }, { op: "wait", endStates: ends }]));
  expect(r.status).toBe("PASS");
  expect(r.steps[1]!.desc).toContain("도착: 「막힘」");
  expect(r.warnings.some((w) => w.includes("끝 상태가 하나뿐"))).toBe(false);
});

test("A: 선택자 하나만 기다리는 wait 는 실행 때도 등록 때도 경고한다", async () => {
  const ctx = fakeCtx({});
  const r = await runCase(ctx, mk("T-A3", [{ op: "goto", url: "/h" }, { op: "wait", sel: "#done" }]));
  expect(r.warnings.some((w) => w.includes("끝 상태를 하나만 받는 대기"))).toBe(true);
  const root = mkdtempSync(join(tmpdir(), "e2e-loop-up-"));
  const up = aCaseUpsert({ project: root, cases: [mk("U-1", [{ op: "goto", url: "/" }, { op: "wait", sel: "#done" }, { op: "expect", sel: "#done", visible: true }]), mk("U-2", [{ op: "goto", url: "/" }, { op: "wait", endStates: { 완료: "#a" } }, { op: "expect", sel: "#a", visible: true }]), mk("U-3", [{ op: "goto", url: "/" }, { op: "wait", endStates: ends }, { op: "expect", sel: "#a", visible: true }])] });
  expect(up.warns.filter((w) => w.startsWith("U-1") && w.includes("끝 상태를 하나만")).length).toBe(1);
  expect(up.warns.filter((w) => w.startsWith("U-2") && w.includes("끝 상태가 하나뿐")).length).toBe(1);
  expect(up.warns.some((w) => w.startsWith("U-3") && w.includes("하나"))).toBe(false);
  const bad = aCaseUpsert({ project: root, cases: [mk("U-4", [{ op: "goto", url: "/" }, { op: "wait", endStates: "#done" }])] });
  expect(bad.errors.length).toBe(1);
  expect(singleEndState({ endStates: ends })).toBe(false);
});

// ---------- C: 요소 찾는 방법 ----------
import { labelOnly, describeFound } from "../src/finders.ts";

test("C: 라벨 글자만으로 찾는 선택자를 알아보고, testid·id·name·역할·값이 있으면 통과시킨다", () => {
  for (const s of ['text="트랙"', "text=저장", 'button:text-is("저장")', 'div:has-text("트랙")', 'td:text-is("IRB")']) expect(labelOnly(s)).toBe(true);
  for (const s of ['[data-testid="track-cell"]', "#save", 'input[name="track"]', 'role=button[name="저장"]', '[role=button]:text-is("저장")', '[data-testid="row"]:has-text("a")', 'xpath=//td', 'row=visit.csv', 'cell[col="상태"][row="a"]', "button.primary", 'a[href="/x"]']) expect(labelOnly(s)).toBe(false);
});

test("C: 처음 쓰는 요소는 찾은 요소의 글자·값·식별 속성을 남기고, 같은 선택자는 다시 남기지 않는다", async () => {
  const log: string[] = [];
  const el = { n: 1, tag: "input", text: "", value: "IRB", testid: "track-cell" };
  const ctx = { ...fakeCtx({ value: async () => "IRB", evaluate: async (expr: string) => (expr.includes("textOf(e)") ? (el as any) : undefined) }, log), seenSels: new Set<string>() };
  const r = await runCase(ctx, mk("T-C1", [{ op: "goto", url: "/" }, { op: "expect", sel: '[data-testid="track-cell"]', value: "IRB" }, { op: "expect", sel: '[data-testid="track-cell"]', value: "IRB" }]));
  expect(r.status).toBe("PASS");
  expect(r.steps[1]!.found).toContain("<input>");
  expect(r.steps[1]!.found).toContain("값 「IRB」");
  expect(r.steps[1]!.found).toContain("data-testid=track-cell");
  expect(r.steps[2]!.found).toBeUndefined();
  expect(log.filter((l) => l.includes("element-found")).length).toBe(1);
});

test("C: 찾은 요소가 여러 개면 개수를 적는다. 없으면 적지 않는다", async () => {
  const many = await describeFound({ ...basePage(), evaluate: async () => ({ n: 3, tag: "td", text: "트랙" }) as any }, "td");
  expect(many).toContain("일치 3개 중 첫 번째");
  expect(await describeFound({ ...basePage(), evaluate: async () => null as any }, "td")).toBeUndefined();
});

test("C: 사람이 쓴 케이스(spec)가 라벨 글자만으로 찾으면 실행 때 경고하고, 자동 점검(probe)에는 경고하지 않는다", async () => {
  const steps: Case["steps"] = [{ op: "goto", url: "/" }, { op: "click", sel: 'text="트랙"' }];
  const spec = await runCase(fakeCtx({}), mk("T-C2", steps));
  expect(spec.warnings.some((w) => w.includes("라벨 글자만으로 찾는 선택자") && w.includes("오류 C"))).toBe(true);
  const probe = await runCase(fakeCtx({}), mk("T-C3", steps, { type: "probe" }));
  expect(probe.warnings.some((w) => w.includes("라벨 글자만으로"))).toBe(false);
});

test("C: 케이스 등록 때도 라벨 글자만 쓰면 경고한다", () => {
  const root = mkdtempSync(join(tmpdir(), "e2e-loop-c-"));
  const up = aCaseUpsert({ project: root, cases: [mk("U-C", [{ op: "goto", url: "/" }, { op: "click", sel: 'button:text-is("저장")' }, { op: "expect", sel: '[data-testid="ok"]', visible: true }])] });
  expect(up.warns.filter((w) => w.startsWith("U-C") && w.includes("라벨 글자만으로")).length).toBe(1);
  expect(up.errors).toEqual([]);
});
