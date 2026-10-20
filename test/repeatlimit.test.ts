// 같은 이슈 반복 한도(repeatLimit): 기본 7(변경 이력 15번), 사용자가 2 이상으로 바꿀 수 있다.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project, caseHash } from "../src/store.ts";
import { aPrestart } from "../src/prestart.ts";
import { repeatedIssues } from "../src/round.ts";
import type { CaseResult, RoundMeta } from "../src/types.ts";

const res = (id: string, status: CaseResult["status"]): CaseResult => ({ id, title: id, type: "spec", status, warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 1, startedAt: "" });

function addRound(p: Project, n: number, results: CaseResult[]) {
  const id = "R" + String(n).padStart(2, "0");
  const meta: RoundMeta = { id, n, status: "finished", startedAt: "", driver: "t", headless: true, data: { decision: "keep", scope: "round" }, scope: "full", caseHash: caseHash([]), caseCount: results.length, code: {}, baseUrl: "http://x" };
  p.writeJson(`rounds/${id}/meta.json`, meta);
  p.writeJson(`rounds/${id}/results.json`, results);
}

const project = () => {
  const p = new Project(mkdtempSync(join(tmpdir(), "e2e-loop-rl-")));
  p.ensure();
  return p;
};

test("기본 반복 한도는 7이다: 6라운드 연속으로는 올리지 않고 7라운드 연속이면 올린다", () => {
  const p = project();
  expect(p.config().repeatLimit).toBe(7);
  for (const n of [1, 2, 3, 4, 5, 6]) addRound(p, n, [res("A", "FAIL")]);
  expect(repeatedIssues(p)).toEqual([]);
  addRound(p, 7, [res("A", "FAIL")]);
  expect(repeatedIssues(p)).toEqual(["A"]);
});

test("repeatLimit 을 7로 기록하면 7라운드 연속이 되어야 올리고, 중간에 끊긴 이슈는 빠진다", () => {
  const p = project();
  const r: any = aPrestart(p, { repeatLimit: 7 });
  expect(r.errors).toEqual([]);
  expect(p.config().repeatLimit).toBe(7);
  for (let n = 1; n <= 6; n++) addRound(p, n, [res("A", "FAIL"), res("B", n === 4 ? "PASS" : "FAIL")]);
  expect(repeatedIssues(p)).toEqual([]); // 6번뿐
  addRound(p, 7, [res("A", "FAIL"), res("B", "FAIL")]);
  expect(repeatedIssues(p)).toEqual(["A"]); // B 는 4라운드에서 끊겼다
});

test("repeatLimit 은 2 이상의 정수만 받는다", () => {
  const p = project();
  for (const bad of [1, 0, -3, 2.5]) expect((aPrestart(p, { repeatLimit: bad }) as any).errors.length).toBe(1);
  expect(p.config().repeatLimit).toBe(7);
  expect((aPrestart(p, { repeatLimit: 2 }) as any).errors).toEqual([]);
  expect(p.config().repeatLimit).toBe(2);
});
