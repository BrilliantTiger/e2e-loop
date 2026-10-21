// 오류 C(주소): 손으로 쓴 케이스가 없는 주소(404)로 가면 사이트 결함이 아니라 케이스 주소가 틀린 것 — FAIL 이 아니라 NA(C).
import { expect, test } from "bun:test";
import { runCase } from "../src/runner.ts";
import { fakeCtx } from "./helpers/fake.ts";
import type { Case } from "../src/types.ts";

const nav = (code: number) => async (x: string): Promise<any> => (x.includes("getEntriesByType('navigation')") ? code : undefined);
const mk = (id: string, extra: Partial<Case> = {}, status?: number): Case => ({ id, title: id, type: "spec", source_ref: "기획서 2120", screen: "/l2/datasets/1/tables", feature: "Table 현황", steps: [{ op: "goto", url: "/l2/datasets/1/tables", ...(status ? { status } : {}) }, { op: "expect", sel: "#tables", textContains: "Table", basis: "CCB-2120" }], ...extra });

test("손으로 쓴 케이스가 404 주소로 가면 읽지 않고 NA(C) — 주소를 고치라고 남긴다", async () => {
  const reads: string[] = [];
  const r = await runCase(fakeCtx({ evaluate: nav(404), text: async (s: string) => (reads.push(s), "") }), mk("C-1"));
  expect(r.status).toBe("NA");
  expect(r.toolError?.kind).toBe("C");
  expect(r.reason).toContain("없는 주소로 감(404): /l2/datasets/1/tables");
  expect(reads).toEqual([]);
});

test("404 가 아니거나, 404 를 기대하는 스텝이거나, 자동 점검 케이스면 그대로 둔다", async () => {
  expect((await runCase(fakeCtx({ evaluate: nav(200), text: async () => "Table 현황" }), mk("C-2"))).status).toBe("PASS");
  expect((await runCase(fakeCtx({ evaluate: nav(404), text: async () => "Table 현황" }), mk("C-3", {}, 404))).status).toBe("PASS");
  expect((await runCase(fakeCtx({ evaluate: nav(404), text: async () => "Table 현황" }), mk("C-4", { type: "probe" } as any))).toolError).toBeUndefined();
});
