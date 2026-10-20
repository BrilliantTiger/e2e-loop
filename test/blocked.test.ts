// 챕터 의존(사유 H: 선행 결함에 막힘), 제외 시트의 합치기(I)·번호(J).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "../src/actions.ts";
import { DefectGuard, requiresCycle, screenMatches } from "../src/chapter.ts";
import { runCase } from "../src/runner.ts";
import { addComment, listComments } from "../src/comments.ts";
import { Project } from "../src/store.ts";
import { blockedCount, excludedAllTsv, excludedRows, excludedTsv, mergeExcludedAcross, toolErrorCount } from "../src/toolerror.ts";
import { writeSheets } from "../src/sheets.ts";
import { fakeCtx } from "./helpers/fake.ts";
import type { Case, CaseResult, RoundMeta } from "../src/types.ts";

const mk = (id: string, chapter: string, over: Partial<Case> = {}): Case => ({ id, title: id, type: "spec", source_ref: "기획서 1.1", screen: "/p", feature: chapter, chapter, steps: [{ op: "goto", url: "/p" }], ...over });
const res = (id: string, status: CaseResult["status"], over: Partial<CaseResult> = {}): CaseResult => ({ id, title: id, type: "spec", status, warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: "", ...over });
const nameOf = (c: Case) => c.chapter ?? "?";

test("선행 챕터에 제품 FAIL 이 있으면 뒤 챕터는 연쇄로 막힌다(C9 → C11K → C12 → C44), 상관없는 챕터는 그대로", () => {
  const g = new DefectGuard(nameOf);
  const c9 = [mk("C9-1", "C9"), mk("C9-2", "C9")];
  const c11 = mk("C11K-1", "C11K", { requires: ["C9"] });
  const c12 = mk("C12-1", "C12", { requires: ["C11K"] });
  const c44 = mk("C44-1", "C44", { requires: ["C12"] });
  const other = mk("C20-1", "C20");
  expect(g.blockedBy(c11)).toBeUndefined(); // 아직 아무것도 안 돌았다
  g.record(c9[0]!, res("C9-1", "FAIL"));
  g.record(c9[1]!, res("C9-2", "FAIL"));
  const b11 = g.blockedBy(c11)!;
  expect(b11.chapter).toBe("C9");
  expect(b11.by).toEqual(["C9-1", "C9-2"]);
  expect(b11.detail).toBe("선행 결함에 막힘(C9-1 외 1건, 챕터 C9)");
  const na11 = g.naResult(c11, b11);
  expect(na11.status).toBe("NA");
  expect(na11.blockedBy?.chapter).toBe("C9");
  expect(na11.toolError).toBeUndefined();
  expect(na11.steps.length).toBe(0);
  g.record(c11, na11);
  const b12 = g.blockedBy(c12)!;
  expect(b12.chapter).toBe("C9"); // 뿌리 결함을 가리킨다
  g.record(c12, g.naResult(c12, b12));
  expect(g.blockedBy(c44)?.by).toEqual(["C9-1", "C9-2"]);
  expect(g.blockedBy(other)).toBeUndefined();
});

test("도구 오류 NA·통과·불안정은 선행 결함이 아니다. 자동 점검 probe 와 일부 라운드로 빠진 선행 챕터도 막지 않는다", () => {
  const g = new DefectGuard(nameOf);
  const need = mk("N-1", "X", { requires: ["C9"] });
  g.record(mk("C9-1", "C9"), res("C9-1", "NA", { toolError: { kind: "D", detail: "x" } }));
  g.record(mk("C9-2", "C9"), res("C9-2", "FLAKY"));
  g.record(mk("C9-3", "C9"), res("C9-3", "PASS"));
  g.record(mk("C9-4", "C9", { type: "probe" }), res("C9-4", "FAIL"));
  expect(g.blockedBy(need)).toBeUndefined();
  expect(g.blockedBy(mk("N-2", "X", { requires: ["없는챕터"] }))).toBeUndefined();
  g.record(mk("C9-5", "C9"), res("C9-5", "FAIL"));
  expect(g.blockedBy(need)).toBeDefined();
  expect(g.blockedBy(mk("N-3", "X", { requires: ["C9"], skipReason: "규칙" }))).toBeUndefined();
});

test("챕터 의존의 순환을 찾는다", () => {
  expect(requiresCycle([{ chapter: "A", requires: ["B"] }, { chapter: "B", requires: ["C"] }, { chapter: "C", requires: ["A"] }])).toEqual(["A", "B", "C", "A"]);
  expect(requiresCycle([{ chapter: "A", requires: ["B"] }, { chapter: "B", requires: ["C"] }])).toBeUndefined();
  expect(requiresCycle([{ chapter: "A" }, { requires: ["A"] }])).toBeUndefined();
});

test("등록: requires 는 이름 배열이어야 하고 자기 자신·순환·빈 값은 거부, 없는 챕터는 경고", () => {
  const ctx = fakeCtx({});
  const out = A.aCaseUpsert({ project: ctx.project.root, cases: [
    mk("R-1", "A", { requires: ["B"] }),
    mk("R-2", "B", { requires: ["A"] }), // 순환
    mk("R-3", "C", { requires: ["C"] }), // 자기 자신
    mk("R-4", "D", { requires: [] }),
    mk("R-5", "E", { requires: ["없음"] }),
    mk("R-6", "F", { chapter: "  " }),
  ] });
  expect(out.errors.length).toBe(4);
  expect(out.errors.join("\n")).toContain("돌고 돎");
  expect(out.errors.join("\n")).toContain("자기 자신");
  expect(out.warns.some((w) => w.includes("R-1") && w.includes("「B」"))).toBe(true); // B 를 가진 R-2 는 순환이라 거부돼 B 가 없음 → 경고
  expect(out.warns.some((w) => w.includes("R-5") && w.includes("없음"))).toBe(true);
  expect(out.added).toBe(2);
});

const excl = (id: string, kind: "D" | "F", over: Partial<CaseResult> = {}) => res(id, "NA", { title: id, toolError: { kind, detail: "읽지 못함" }, steps: [{ i: 1, op: "expect", desc: "확인", status: "fail", ms: 1 }], ...over });
const info = (r: CaseResult) => ({ chapter: r.id.startsWith("B") ? "C12" : "C44", screen: "/p", element: "#total", verb: "확인" });

test("제외 줄: 같은 (챕터, 화면, 요소, 동작, 사유)는 한 줄로 합쳐 횟수를 세고, 줄마다 <라운드>-X-<NN> 번호가 붙는다", () => {
  const blocked = res("H-1", "NA", { blockedBy: { chapter: "C9", by: ["C9-1"], detail: "선행 결함에 막힘(C9-1, 챕터 C9)" } });
  const rows = excludedRows([excl("A-1", "D"), excl("A-2", "D"), excl("A-3", "D"), excl("B-1", "D"), excl("A-4", "F"), blocked], () => "현상", { round: "R07", info });
  expect(rows.map((x) => [x.no, x.count, x.kind])).toEqual([["R07-X-01", 3, "D"], ["R07-X-02", 1, "D"], ["R07-X-03", 1, "F"], ["R07-X-04", 1, "H"]]);
  expect(rows[0]!.cases).toEqual(["A-1", "A-2", "A-3"]);
  expect(rows[3]!.reason).toContain("H 선행 결함에 막힘: 선행 결함에 막힘(C9-1, 챕터 C9)");
  expect(rows[3]!.note).toContain("도구 오류 아님");
  const tsv = excludedTsv(rows).split("\n");
  expect(tsv[0]).toBe("번호\t케이스\t챕터\t횟수\t반복\t현상\t제외 사유\t처리\t비고\t증거");
  expect(tsv[1]!.split("\t").slice(0, 4)).toEqual(["R07-X-01", "A-1, A-2, A-3", "C44", "3"]);
  // 도구 오류 수에는 H 가 들어가지 않는다
  expect(toolErrorCount([excl("A-1", "D"), blocked])).toBe(1);
  expect(blockedCount([excl("A-1", "D"), blocked])).toBe(1);
});

test("여러 라운드: 같은 줄은 새로 쌓이지 않고 처음 번호를 지킨 채 횟수만 늘고, 나온 라운드가 적힌다", () => {
  const r1 = excludedRows([excl("A-1", "D"), excl("A-2", "D"), excl("B-1", "D")], () => "현상1", { round: "R06", info });
  const r2 = excludedRows([excl("A-1", "D"), excl("B-1", "D"), excl("B-2", "F")], () => "현상2", { round: "R07", info });
  const all = mergeExcludedAcross([{ round: "R06", rows: r1 }, { round: "R07", rows: r2 }]);
  expect(all.length).toBe(3);
  const a = all.find((x) => x.chapter === "C44" && x.kind === "D")!;
  expect([a.no, a.count, a.rounds, a.lastRound, a.symptom]).toEqual(["R06-X-01", 3, ["R06", "R07"], "R07", "현상2"]);
  expect(all.find((x) => x.chapter === "C12" && x.kind === "F")?.no).toBe("R07-X-03");
  expect(excludedAllTsv(all).split("\n")[0]).toBe("번호\t케이스\t챕터\t횟수\t나온 라운드\t현상\t제외 사유\t처리\t비고\t증거");
  // key 가 없는 옛 형식의 줄은 합치지 않는다
  expect(mergeExcludedAcross([{ round: "R01", rows: [{ ...r1[0]!, key: "" }] }]).length).toBe(0);
});

const meta = (id: string, over: Partial<RoundMeta> = {}): RoundMeta => ({ id, n: Number(id.slice(1)), status: "finished", startedAt: "", driver: "t", headless: true, data: { decision: "keep", scope: "round" }, scope: "full", caseHash: "", caseCount: 3, code: {}, baseUrl: "http://x", ...over });

test("결과물: 선행 결함에 막힘(H)은 도구 오류와 따로 세고, 제외 시트 번호로 코멘트를 달 수 있다. 합친 시트는 라운드를 거듭해도 줄이 늘지 않는다", () => {
  const ctx = fakeCtx({});
  const p = ctx.project;
  const cs = [mk("C9-1", "C9"), mk("C11K-1", "C11K", { requires: ["C9"] }), mk("C12-1", "C12", { requires: ["C11K"] })];
  p.saveCases(cs);
  const g = new DefectGuard(nameOf);
  const results: CaseResult[] = [];
  for (const c of cs) {
    const b = g.blockedBy(c);
    const r = b ? g.naResult(c, b) : res(c.id, "FAIL", { reason: "BE 오류", steps: [{ i: 1, op: "api", desc: "API", status: "fail", ms: 1, error: "500" }] });
    g.record(c, r);
    results.push(r);
  }
  const summary = { PASS: 0, FAIL: 1, FLAKY: 0, BLOCKED: 0, NA: 2, SKIP: 0, total: 3, toolError: 0, blockedByDefect: 2 };
  for (const rid of ["R01", "R02"]) {
    const m = meta(rid, { summary });
    p.writeJson(`rounds/${rid}/meta.json`, m);
    p.writeJson(`rounds/${rid}/results.json`, results);
    const out = writeSheets(p, m, results);
    const ai = readFileSync(out.files.aiMd, "utf8");
    expect(ai).toContain("이슈 1 · 도구 오류(NA) 0 · 선행 결함에 막힘(H) 2");
    expect(ai).toContain("## 선행 결함에 막힘(H) 2줄");
    expect(ai).toContain(`${rid}-X-01`);
    expect(ai).toContain("선행 결함에 막힘(C9-1, 챕터 C9)");
    const j = JSON.parse(readFileSync(out.files.aiJson, "utf8"));
    expect(j.tool_error_count).toBe(0);
    expect(j.blocked_by_defect_count).toBe(2);
    expect(j.issue_count).toBe(1);
    expect(readFileSync(out.files.human, "utf8")).toContain("선행 결함에 막힘(H)");
  }
  const all = JSON.parse(readFileSync(p.p("excluded_all.json"), "utf8"));
  expect(all.length).toBe(2); // 라운드가 둘이어도 같은 줄은 한 줄
  expect(all.map((x: any) => [x.no, x.count, x.rounds])).toEqual([["R01-X-01", 2, ["R01", "R02"]], ["R01-X-02", 2, ["R01", "R02"]]]);
  expect(readFileSync(p.p("excluded_all.tsv"), "utf8").split("\n").length).toBe(4); // 머리글 + 2줄 + 끝 줄바꿈
  // 제외 번호로 코멘트를 달면 그 줄의 첫 케이스에 붙는다
  const c = addComment(p, { case: "R02-X-01", text: "선행 결함 확인함" });
  expect(c.case).toBe("C11K-1");
  expect(c.ref).toBe("R02-X-01");
  expect(listComments(p, { case: "R02-X-01" }).map((x) => x.id)).toEqual([c.id]);
  expect(() => addComment(p, { case: "R02-X-99", text: "x" })).toThrow("알 수 없는 제외 번호");
});

// ---- 실제 브라우저 라운드: 선행 챕터가 FAIL 이면 뒤 챕터를 누르지 않는다 ----
const port = 4581;
const root = mkdtempSync(join(tmpdir(), "e2e-loop-blk-"));
let server: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  writeFileSync(join(root, "bugs.json"), "{}");
  writeFileSync(join(root, "PLAN.md"), "# 기획서\n");
  server = Bun.spawn(["bun", join(import.meta.dir, "../examples/demo-site/server.ts"), root, String(port)], { stdout: "ignore", stderr: "inherit" });
  await Bun.sleep(800);
  const p = new Project(root);
  p.ensure();
  p.saveConfig({ ...p.config(), baseUrl: `http://127.0.0.1:${port}`, driver: "chromium", headless: true, dashboardPort: 7794 });
  A.aPrestart({ project: root, dataPolicy: "keep", maxRounds: 10, login: "none", account: { mode: "none" }, acknowledged: true });
  A.aSourceAdd({ project: root, kind: "plan", title: "기획서", location: join(root, "PLAN.md") });
});
afterAll(() => server?.kill());

test("라운드: 선행 챕터(C9)가 제품 FAIL 이면 C11·C12 는 돌지 않고 NA(H), 상관없는 챕터는 통과한다", async () => {
  const chk = (id: string, chapter: string, text: string, over: Partial<Case> = {}) =>
    mk(id, chapter, { screen: "/", steps: [{ op: "goto", url: "/" }, { op: "expect", sel: "h1", textContains: text, basis: "POL-1" }], ...over });
  const out = A.aCaseUpsert({ project: root, cases: [
    chk("C9-1", "C9", "절대로 없는 제목"),
    chk("C11-1", "C11", "아무거나", { requires: ["C9"] }),
    chk("C12-1", "C12", "아무거나", { requires: ["C11"] }),
    chk("C12-2", "C12", "아무거나", { requires: ["C11"] }),
    chk("C30-1", "C30", ""),
  ] });
  expect(out.errors).toEqual([]);
  const start: any = await A.aRoundStart({ project: root, data: "keep", headless: true });
  expect(start.started).toBe(true);
  let st: any;
  do st = await A.aRoundStatus({ project: root, wait_seconds: 30 });
  while (st.running);
  const p = new Project(root);
  const results = p.readJson<CaseResult[]>(`rounds/${start.round}/results.json`, []);
  const by = (k: string) => results.find((r) => r.id === k)!;
  expect(by("C9-1").status).toBe("FAIL");
  for (const k of ["C11-1", "C12-1", "C12-2"]) {
    expect(by(k).status).toBe("NA");
    expect(by(k).blockedBy?.chapter).toBe("C9");
    expect(by(k).blockedBy?.by).toEqual(["C9-1"]);
    expect(by(k).steps.length).toBe(0);
  }
  expect(by("C30-1").status).toBe("PASS");
  const meta2 = p.readJson<RoundMeta>(`rounds/${start.round}/meta.json`, {} as RoundMeta);
  expect(meta2.summary?.blockedByDefect).toBe(3);
  expect(meta2.summary?.toolError).toBe(0);
  const events = readFileSync(p.p("rounds", start.round, "events.ndjson"), "utf8");
  expect(events).toContain("chapter-blocked");
  const ex = JSON.parse(readFileSync(p.p("rounds", start.round, "excluded_issues.json"), "utf8"));
  expect(ex.every((x: any) => x.kind === "H")).toBe(true);
  expect(ex.map((x: any) => x.no)[0]).toBe(`${start.round}-X-01`);
}, 180000);

// ---- 선행 미완료: 목표 화면으로 갔는데 선행 단계 화면에 머물면 기다리지 않고 바로 NA(H) ----

test("화면 경로 맞추기: <id>·:id·* 조각은 아무 값이나 받고, 쿼리·끝 / 는 무시한다", () => {
  expect(screenMatches("/l2/datasets/7/table", "/l2/datasets/<id>/table")).toBe(true);
  expect(screenMatches("/l2/datasets/7/time-key", "/l2/datasets/<id>/table")).toBe(false);
  expect(screenMatches("/l2/datasets/7/table/", "/l2/datasets/:id/table")).toBe(true);
  expect(screenMatches("/a?x=1", "/a")).toBe(true);
  expect(screenMatches("/a/b", "/a")).toBe(false);
});

test("선행 챕터에 기대는 케이스가 목표 화면으로 갔는데 선행 화면에 머물면 60초 기다리지 않고 바로 「선행 미완료」 NA(H)", async () => {
  const read: string[] = [];
  const ctx = fakeCtx({ url: async () => "http://fake/l2/datasets/7/time-key", text: async (s: string) => (read.push(s), "") });
  const c = mk("C12-1", "C12", { requires: ["C11U"], screen: "/l2/datasets/<id>/table", steps: [{ op: "goto", url: "/l2/datasets/7/table" }, { op: "expect", sel: "#status", text: "완료", basis: "POL-1" }] });
  const t0 = Date.now();
  const r = await runCase(ctx, c);
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(r.status).toBe("NA");
  expect(r.toolError).toBeUndefined();
  expect(r.blockedBy?.chapter).toBe("C11U");
  expect(r.reason).toContain("선행 미완료");
  expect(r.reason).toContain("/l2/datasets/7/time-key");
  expect(read).toEqual([]); // 화면 값을 읽지 않았다
  expect(blockedCount([r])).toBe(1);
  expect(toolErrorCount([r])).toBe(0);
  // 뒤 챕터도 같은 뿌리로 막힌다
  const g = new DefectGuard(nameOf);
  g.record(c, r);
  expect(g.blockedBy(mk("C44-1", "C44", { requires: ["C12"] }))?.detail).toBe("선행 미완료(챕터 C11U)");
});

test("목표 화면에 제대로 들어갔거나, 의존 선언이 없거나, 처음부터 다른 화면으로 가는 케이스는 그대로 돈다", async () => {
  const at = (u: string) => fakeCtx({ url: async () => u, text: async () => "완료" });
  const steps = [{ op: "goto", url: "/l2/datasets/7/table" }, { op: "expect", sel: "#status", text: "완료", basis: "POL-1" }];
  expect((await runCase(at("http://fake/l2/datasets/7/table"), mk("A", "C12", { requires: ["C11U"], screen: "/l2/datasets/<id>/table", steps }))).status).toBe("PASS");
  expect((await runCase(at("http://fake/l2/datasets/7/time-key"), mk("B", "C12", { screen: "/l2/datasets/<id>/table", steps }))).status).toBe("PASS");
  expect((await runCase(at("http://fake/list"), mk("C", "C12", { requires: ["C11U"], screen: "/l2/datasets/<id>/table", steps: [{ op: "goto", url: "/list" }, { op: "expect", sel: "#status", text: "완료", basis: "POL-1" }] }))).status).toBe("PASS");
});
