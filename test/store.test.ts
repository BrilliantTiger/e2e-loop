// 라운드 기록(.e2e/rounds) 읽기 시험.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project, caseHash } from "../src/store.ts";
import { completeCheck } from "../src/gate.ts";
import type { Case } from "../src/types.ts";

test("라운드 번호가 100을 넘어도 번호 순서로 읽고, 완료 판정은 가장 최근 라운드로 한다", () => {
  const p = new Project(mkdtempSync(join(tmpdir(), "e2e-loop-store-")));
  p.ensure();
  p.saveConfig(p.config());
  const cases: Case[] = [{ id: "C1", title: "t", type: "spec", steps: [{ op: "goto", url: "/" }] }];
  p.saveCases(cases);
  for (const n of [9, 10, 98, 99, 100, 101]) {
    const id = "R" + String(n).padStart(2, "0");
    p.writeJson(`rounds/${id}/meta.json`, { id, n, status: "finished", scope: "full", caseHash: caseHash(cases) });
    p.writeJson(`rounds/${id}/results.json`, [{ id: "C1", status: n >= 100 ? "FAIL" : "PASS", reason: "x", steps: [], warnings: [] }]);
  }
  expect(p.rounds().map((r) => r.id)).toEqual(["R09", "R10", "R98", "R99", "R100", "R101"]);
  expect(p.nextRoundId().id).toBe("R102");
  const g = completeCheck(p);
  expect(g.round).toBe("R101");
  expect(g.complete).toBe(false);
});
