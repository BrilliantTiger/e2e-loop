// 사용자 요청(e2e_feedback)과 완료 판정의 연결 시험. 브라우저 없이 라운드 기록만 흉내 낸다.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFeedback, resolveFeedback } from "../src/feedback.ts";
import { completeCheck } from "../src/gate.ts";
import { Project, caseHash } from "../src/store.ts";
import type { Case, CaseResult, RoundMeta } from "../src/types.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "e2e-loop-fb-"));
const spec = (id: string, steps: Case["steps"], over: Partial<Case> = {}): Case => ({ id, title: id, type: "spec", source_ref: "시험", screen: "/", feature: "시험", steps, ...over });
const pass = (id: string): CaseResult => ({ id, title: id, type: "spec", status: "PASS", warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 1, startedAt: "" });
const meta = (p: Project, n: number, status: RoundMeta["status"]): RoundMeta => ({ id: "R" + String(n).padStart(2, "0"), n, status, startedAt: "", driver: "t", headless: true, data: { decision: "keep", scope: "round" }, scope: "full", caseHash: caseHash(p.cases()), caseCount: 1, code: {}, baseUrl: "x" });

/** 이 프로세스가 돌리는 라운드처럼 기록한다 */
function running(p: Project, n: number) {
  const m = meta(p, n, "running");
  p.writeJson(`rounds/${m.id}/meta.json`, m);
  writeFileSync(p.p("running.json"), JSON.stringify({ pid: process.pid, round: m.id }));
  return m.id;
}
/** 라운드를 전부 PASS 로 끝낸다 */
function finish(p: Project, n: number) {
  rmSync(p.p("running.json"), { force: true });
  const m = meta(p, n, "finished");
  p.writeJson(`rounds/${m.id}/meta.json`, m);
  p.writeJson(`rounds/${m.id}/results.json`, p.cases().map((c) => pass(c.id)));
}
function project() {
  const p = new Project(tmp());
  p.ensure();
  p.saveConfig(p.config());
  p.saveCases([spec("A", [{ op: "goto", url: "/" }, { op: "expect", sel: "h1", text: "홈" }])]);
  return p;
}

test("완료 판정: 마지막 라운드 도중 받은 요청을 아직 반영하지 않았으면 이슈 0 이어도 완료가 아니다", () => {
  const p = project();
  running(p, 1);
  addFeedback(p, { text: "회원가입 이메일 형식 케이스도 넣어줘" }); // 다음 라운드부터
  finish(p, 1);
  const g = completeCheck(p);
  expect(g.complete).toBe(false);
  expect(g.reasons.join(" ")).toContain("반영하지 않은 사용자 요청 1건");
  expect(g.reasons.join(" ")).toContain("FB001");
});

test("완료 판정: 「지금 흐름에서 적용」 요청이 든 라운드는 케이스를 끼워 넣지 않았어도 완료 근거가 아니고, 새 전체 라운드 뒤에 완료된다", () => {
  const p = project();
  running(p, 1);
  const r: any = addFeedback(p, { text: "지금부터 로그인 계정 B 로", apply: "now", mode: "in-flow" });
  expect(r.feedback.appliesTo).toBe("now-in-flow");
  resolveFeedback(p, [r.feedback.id], "설정 반영");
  finish(p, 1);
  const g = completeCheck(p);
  expect(g.complete).toBe(false);
  expect(g.reasons.join(" ")).toContain("지금 흐름에서 적용");
  expect(g.reasons.join(" ")).toContain(r.feedback.id);
  running(p, 2);
  finish(p, 2);
  expect(completeCheck(p).complete).toBe(true);
});

test("지금 흐름에서 적용: 고쳐 넣은 케이스는 저장된 정의와 합쳐져 파괴적 표시·챕터·선행·잠금이 남는다", () => {
  const p = project();
  p.saveCases([spec("D1", [{ op: "goto", url: "/" }, { op: "click", sel: "text=탈퇴" }], { risk: "destructive", chapter: "C9", requires: ["C8"], lock: "dataset:1" })]);
  running(p, 1);
  const r: any = addFeedback(p, { text: "탈퇴 문구 수정", apply: "now", mode: "in-flow", cases: [{ id: "D1", title: "계정 탈퇴", steps: [{ op: "goto", url: "/" }, { op: "click", sel: "text=탈퇴" }, { op: "expect", sel: "h1", text: "안녕히" }] } as any] }); // 이미 있는 케이스를 고칠 때 risk 등을 빼고 보내는 경우
  expect(r.ok).toBe(true);
  const saved = p.cases().find((c) => c.id === "D1")!;
  expect(saved).toMatchObject({ risk: "destructive", chapter: "C9", requires: ["C8"], lock: "dataset:1" });
  expect(saved.steps.length).toBe(3);
  const inj = JSON.parse(readFileSync(p.p("inject.json"), "utf8")) as Case[];
  expect(inj[0]).toMatchObject({ id: "D1", risk: "destructive", chapter: "C9" });
});

test("지금 흐름에서 적용: 등록과 같은 검사를 거쳐 줄 번호 선택자는 막고, 아무것도 기록·저장하지 않는다", () => {
  const p = project();
  running(p, 1);
  expect(() => addFeedback(p, { text: "세 번째 줄도", apply: "now", mode: "in-flow", cases: [spec("N1", [{ op: "goto", url: "/" }, { op: "click", sel: "tr:nth-child(3) button" }])] })).toThrow("N1");
  expect(p.feedback()).toEqual([]);
  expect(p.cases().map((c) => c.id)).toEqual(["A"]);
  expect(existsSync(p.p("inject.json"))).toBe(false);
});

test("지금 흐름에서 적용: 실행기가 읽기 전에 두 번 요청하면 끼워 넣을 목록에 둘 다 남는다(덮어쓰지 않음)", () => {
  const p = project();
  running(p, 1);
  const s = (id: string) => spec(id, [{ op: "goto", url: "/" + id }, { op: "expect", sel: "h1", text: id }]);
  addFeedback(p, { text: "첫째", apply: "now", mode: "in-flow", cases: [s("N1")] });
  addFeedback(p, { text: "둘째", apply: "now", mode: "in-flow", cases: [s("N2")] });
  const inj = JSON.parse(readFileSync(p.p("inject.json"), "utf8")) as Case[];
  expect(inj.map((c) => c.id)).toEqual(["N1", "N2"]);
});

test("「지금 회차부터」 질문에서 고른 「다음 라운드부터」(next)는 다음 라운드 적용으로 기록되고 지금 라운드는 건드리지 않는다", () => {
  const p = project();
  running(p, 2);
  const ask: any = addFeedback(p, { text: "지금 라운드부터", apply: "now" });
  expect(ask.options.map((o: any) => o.value)).toContain("next");
  const r: any = addFeedback(p, { text: "지금 라운드부터", apply: "now", mode: "next" });
  expect(r.ok).toBe(true);
  expect(r.feedback).toMatchObject({ appliesTo: "next-round", appliesFrom: "R03", duringRound: "R02" });
  expect(existsSync(p.p("stop"))).toBe(false);
  expect(existsSync(p.p("inject.json"))).toBe(false);
});

test("「지금 회차부터」에 모르는 mode 를 주면 지금 흐름 적용으로 넘기지 않고 오류를 낸다", () => {
  const p = project();
  running(p, 1);
  expect(() => addFeedback(p, { text: "x", apply: "now", mode: "foo" as any })).toThrow("mode");
  expect(p.feedback()).toEqual([]);
});

test("완료 판정: 선행 챕터에 FAIL 이 없어도 「선행 미완료」(H)로 돌지 않은 케이스가 있으면 완료가 아니다 — 도구 오류(R)는 여기서 세지 않는다", () => {
  const p = project();
  running(p, 1);
  finish(p, 1);
  const [a] = p.readJson<any[]>("rounds/R01/results.json", []);
  const held = { ...a, id: "A", status: "NA", reason: "선행 미완료: 목표 화면으로 갔는데 다른 화면에 머묾", blockedBy: { chapter: "C11U", by: [], detail: "선행 미완료(챕터 C11U)" } };
  p.writeJson("rounds/R01/results.json", [held]);
  const g = completeCheck(p);
  expect(g.complete).toBe(false);
  expect(g.reasons.join(" ")).toContain("선행 단계에 막혀 실행하지 못한 케이스 1건: A(선행 C11U)");
  p.writeJson("rounds/R01/results.json", [{ ...a, id: "A", status: "NA", reason: "도구 판정 불가(R): 선행 도구 오류", toolError: { kind: "R", detail: "선행 도구 오류" }, retest: { after: "C45", by: [] } }]);
  expect(completeCheck(p).reasons.join(" ")).not.toContain("선행 단계에 막혀");
});
