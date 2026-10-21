// 오류 X: 확인 없는 통과 — 마지막 동작(누름·고름·쓰기) 뒤에 결과 기대가 없으면 「오류 없음」만으로는 PASS 가 아니다.
// 고른 값이 틀려도(예: 근거 없이 첫 후보·아무 컬럼을 고름) PASS 로 남던 것을 NA(X)로 막는다.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uncheckedAction } from "../src/basis.ts";
import { runCase } from "../src/runner.ts";
import { excludedRows, toolErrorCount } from "../src/toolerror.ts";
import * as A from "../src/actions.ts";
import { Project } from "../src/store.ts";
import { fakeCtx } from "./helpers/fake.ts";
import type { Case, Step } from "../src/types.ts";

const pick: Step[] = [{ op: "goto", url: "/l2/datasets/1/keys" }, { op: "select", sel: "#feature", value: "PHASE" }, { op: "click", sel: "#save" }];
const mk = (id: string, steps: Step[]): Case => ({ id, title: id, type: "spec", source_ref: "기획서 2321", screen: "/l2/datasets/1/keys", feature: "Key 지정", chapter: "C11K", steps });

test("마지막 동작 뒤에 기대가 있는지 본다: 토스트 참고·이동만으로는 기대가 아니다", () => {
  expect(uncheckedAction(pick)).toBe(2);
  expect(uncheckedAction([...pick, { op: "expect", sel: "#feature", value: "VSBPSYS", basis: "CCB-2321" }])).toBeUndefined();
  expect(uncheckedAction([...pick, { op: "goto", url: "/x" }])).toBe(2);
  expect(uncheckedAction([...pick, { op: "api", url: "/api/keys", status: 200 }])).toBeUndefined();
  expect(uncheckedAction([{ op: "goto", url: "/" }, { op: "expect", sel: "h1", text: "a" }])).toBeUndefined();
  expect(uncheckedAction([{ op: "api", url: "/api/x", method: "POST" }])).toBe(0);
});

test("기대 없이 고르고 저장만 한 케이스는 오류가 없어도 PASS 가 아니라 NA(X), 기대를 넣으면 그 기대로 판정한다", async () => {
  const r = await runCase(fakeCtx({}), mk("X-1", pick));
  expect(r.status).toBe("NA");
  expect(r.toolError?.kind).toBe("X");
  expect(r.reason).toContain("확인 없는 통과");
  expect(toolErrorCount([r])).toBe(1);
  expect(excludedRows([r], () => "C11K", { round: "R12" })[0]!.action).toContain("근거의 값으로");
  const wrong = await runCase(fakeCtx({ value: async () => "PHASE" }), mk("X-2", [...pick, { op: "expect", sel: "#feature", value: "VSBPSYS", basis: "CCB-2321" }]));
  expect(wrong.status).toBe("FAIL");
  const right = await runCase(fakeCtx({ value: async () => "VSBPSYS" }), mk("X-3", [...pick, { op: "expect", sel: "#feature", value: "VSBPSYS", basis: "CCB-2321" }]));
  expect(right.status).toBe("PASS");
  // 자동 점검 케이스는 대상이 아니다
  expect((await runCase(fakeCtx({}), { ...mk("X-4", pick), type: "probe" } as any)).toolError).toBeUndefined();
});

test("등록 때 마지막 동작 뒤에 기대가 없으면 경고한다", () => {
  const root = mkdtempSync(join(tmpdir(), "e2e-loop-ux-"));
  new Project(root).ensure();
  const up = A.aCaseUpsert({ project: root, cases: [mk("X-9", pick)] });
  expect(up.warns.join("\n")).toContain("X-9: 마지막 동작 #3 뒤에 결과 기대가 없음");
});
