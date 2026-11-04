// 라운드 결과물(사람용·AI용 시트, 이전 라운드 비교, 커버리지)의 계산을 브라우저 없이 확인한다.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project } from "../src/store.ts";
import { diffWithPrevious } from "../src/report.ts";
import { coverage } from "../src/coverage.ts";
import { buildTasks, expectedOf, writeSheets, type AiIssue } from "../src/sheets.ts";
import type { CaseResult, RoundMeta } from "../src/types.ts";

const tmpProject = () => {
  const p = new Project(mkdtempSync(join(tmpdir(), "e2e-loop-sheets-")));
  p.ensure();
  return p;
};
const res = (id: string, status: CaseResult["status"], over: Partial<CaseResult> = {}): CaseResult => ({ id, title: id, type: "spec", status, warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: "", ...over });
const meta = (id: string, scope: RoundMeta["scope"], over: Partial<RoundMeta> = {}): RoundMeta => ({ id, n: Number(id.slice(1)), status: "finished", startedAt: "", driver: "t", headless: true, data: { decision: "keep", scope: "round" }, scope, caseHash: "", caseCount: 3, code: {}, baseUrl: "http://x", ...over });

test("이전 라운드 비교: 전체 라운드는 앞 전체 라운드와 비교한다 — 사이의 부분 라운드(수정 확인용)에 없던 케이스의 회귀가 숨지 않는다", () => {
  const p = tmpProject();
  p.writeJson("rounds/R01/meta.json", meta("R01", "full"));
  p.writeJson("rounds/R01/results.json", [res("c1", "FAIL"), res("c2", "PASS"), res("c3", "PASS")]);
  p.writeJson("rounds/R02/meta.json", meta("R02", "partial"));
  p.writeJson("rounds/R02/results.json", [res("c1", "PASS")]);
  const d = diffWithPrevious(p, meta("R03", "full"), [res("c1", "PASS"), res("c2", "FAIL"), res("c3", "PASS")]);
  expect(d.prev).toBe("R01");
  expect(d.regressed).toEqual(["c2"]);
  expect(d.fixed).toEqual(["c1"]);
  expect(d.newCases).toEqual([]);
  // 부분 라운드는 지금처럼 바로 앞 라운드(종류와 상관없이)와 비교한다
  expect(diffWithPrevious(p, meta("R03", "partial"), [res("c1", "FAIL")]).prev).toBe("R02");
});

test("기대값 설명: eval 의 equals · collect 의 줄 수·포함 · prereq 의 확인 조건을 근거와 함께 적는다", () => {
  expect(expectedOf({ op: "eval", script: "document.title", equals: "홈", basis: "POL-1" }, undefined)).toBe('스크립트 결과 = "홈" (근거: POL-1)');
  expect(expectedOf({ op: "collect", sel: "row=파일", next: ".next", count: 17, basis: "POL-2" }, undefined)).toBe("row=파일 모든 쪽에서 모은 줄 17줄 (근거: POL-2)");
  expect(expectedOf({ op: "collect", sel: "row=파일", atLeast: 2, contains: ["a.csv", "b.csv"] }, undefined)).toBe("row=파일 모든 쪽에서 모은 줄 2줄 이상 · 「a.csv」 가 있는 줄이 있음 · 「b.csv」 가 있는 줄이 있음");
  expect(expectedOf({ op: "prereq", name: "목록이 열림", sel: "#list", visible: true, basis: "POL-3" }, undefined)).toBe("선행 조건 「목록이 열림」: #list 보임 (근거: POL-3)");
  // 기대가 없는 eval·collect 는 지금처럼
  expect(expectedOf({ op: "eval", script: "x()" }, { id: "A", title: "제목", type: "spec", steps: [] })).toBe("제목");
});

const issue = (id: string, api: AiIssue["api"]): AiIssue => ({ id, title: id, symptom: "", status: "FAIL", priority: "P2", reproduction: [], expected: "", actual: "", api, console: { consoleErrors: [], pageErrors: [], failedRequests: [] }, evidence: { screenshots: [] }, suspectCode: [], warnings: [], hint: "", comments: [] });

test("개발 작업 순서: 선행 작업이 이어진 사슬(A → B → C)에서도 선행 작업이 늘 먼저 온다", () => {
  // A 의 원인 /a, B 의 원인 /b, C 의 원인 /c. A 는 /b 를, B 는 /c 를 함께 부른다 → A 는 B 뒤, B 는 C 뒤
  const tasks = buildTasks(
    [
      issue("A", [{ method: "GET", url: "/a", failed: true }, { method: "GET", url: "/b", status: 200, failed: false }]),
      issue("B", [{ method: "GET", url: "/b", failed: true }, { method: "GET", url: "/c", status: 200, failed: false }]),
      issue("C", [{ method: "GET", url: "/c", failed: true }]),
    ],
    [], [], {} as RoundMeta,
  );
  expect(tasks.map((t) => t.issues[0])).toEqual(["C", "B", "A"]);
  const pos = new Map(tasks.map((t, i) => [t.id, i]));
  for (const [i, t] of tasks.entries()) for (const d of t.dependsOn) expect(pos.get(d)!).toBeLessThan(i);
});

test("커버리지: 절 이름은 경계에서만 맞춘다 — 3.1 은 3.10 이, POL-1 은 POL-12 가 덮지 않고, 「3.1절」 처럼 한글이 붙은 것은 덮는다", () => {
  const p = tmpProject();
  p.writeJson("sources.json", [{ id: "S01", kind: "plan", title: "기획서", location: "x", sections: ["3.1", "3.10", "POL-1", "POL-12", "2.3", "로그인"], addedAt: "" }]);
  p.saveCases([
    { id: "c1", title: "t", type: "spec", source_ref: "기획서 3.10 · POL-12", steps: [] },
    { id: "c2", title: "t", type: "spec", source_ref: "기획서 2.3절(로그인화면)", steps: [] },
  ]);
  const s = coverage(p).sources[0]!;
  expect(s.uncoveredSections).toEqual(["3.1", "POL-1"]);
  expect(s.sections.find((x) => x.name === "2.3")!.cases).toBe(1);
  expect(s.sections.find((x) => x.name === "로그인")!.cases).toBe(1);
});

test("멈춤 측정 줄(O 측정 무효 · U 멈춤 미재현)은 「도구 오류(NA)」 로 세거나 그 아래에 두지 않고 따로 보인다", () => {
  const p = tmpProject();
  const measured = (id: string, verdict: "invalid" | "unconfirmed") => res(id, "PASS", { steps: [{ i: 0, op: "goto", desc: `${id} 열기`, status: "ok", ms: 1, measure: { verdict, summary: "Long Task 1200ms", why: verdict === "invalid" ? "visibilityState=hidden" : "다시 열면 멈추지 않음" } }] });
  const results = [measured("O-1", "invalid"), measured("U-1", "unconfirmed"), res("D-1", "NA", { reason: "도구 판정 불가(D)", toolError: { kind: "D", detail: "읽지 못함" } })];
  const m = meta("R01", "full", { summary: { PASS: 2, FAIL: 0, FLAKY: 0, BLOCKED: 0, NA: 1, SKIP: 0, total: 3, toolError: 1, blockedByDefect: 0 } });
  p.writeJson("rounds/R01/meta.json", m);
  p.writeJson("rounds/R01/results.json", results);
  const out = writeSheets(p, m, results);
  const ai = readFileSync(out.files.aiMd, "utf8");
  expect(ai).toContain("## 도구 오류(NA) 1줄");
  expect(ai).toContain("## 멈춤 측정 제외(측정 무효 O · 멈춤 미재현 U) 2줄");
  const toolPart = ai.slice(ai.indexOf("## 도구 오류(NA)"), ai.indexOf("## 멈춤 측정 제외"));
  expect(toolPart).not.toContain("[O]");
  expect(toolPart).not.toContain("[U]");
  const html = readFileSync(out.files.human, "utf8");
  expect(html).toContain("도구 오류 1줄 · 선행 결함에 막힘 0줄 · 측정 무효(O) 1줄 · 멈춤 미재현(U) 1줄");
});
