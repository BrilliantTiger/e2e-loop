// 오류 S: 기대의 근거가 기획서가 아니라 화면설계서 — 근거 칸에 화면설계서 번호를 받고, 기획서와 화면설계서가 다르면 둘 다 적게 하며,
// 다르다고 적은 기대가 어긋나면 어느 쪽을 따를지 정할 때까지 결함(FAIL)이 아니라 NA(S).
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basisParts, basisProblem, basisText, hasBasis, missingBasis } from "../src/basis.ts";
import { runCase } from "../src/runner.ts";
import { excludedRows } from "../src/toolerror.ts";
import { expectedOf } from "../src/sheets.ts";
import { buildSheet } from "../src/sheet.ts";
import * as A from "../src/actions.ts";
import { Project } from "../src/store.ts";
import { fakeCtx } from "./helpers/fake.ts";
import type { Case } from "../src/types.ts";

const DESIGN = "화면설계서 08-common CCB-1940 Description 1";

test("근거 칸: 화면설계서 번호도 근거로 받고, 기획서·화면설계서를 나눠 읽는다", () => {
  expect(basisParts(DESIGN)).toEqual({ design: DESIGN });
  expect(basisParts("POL-CCB_057")).toEqual({ plan: "POL-CCB_057" });
  expect(hasBasis({ op: "expect", basis: DESIGN })).toBe(true);
  expect(hasBasis({ op: "expect", basis: { design: "08-common CCB-1940" } })).toBe(true);
  expect(hasBasis({ op: "expect", basis: {} })).toBe(false);
  expect(missingBasis([{ id: "S-0", title: "x", type: "spec", steps: [{ op: "expect", sel: "h1", text: "a", basis: DESIGN }] }])).toEqual([]);
  const both = { plan: "CCB-1940", design: "08-common CCB-1940 Description 1", differs: "기획서는 제목 옆, 화면설계서는 제목 아래 줄" };
  expect(basisText(both)).toBe("기획서 CCB-1940 · 화면설계서 08-common CCB-1940 Description 1 — 기획서와 화면설계서가 다름: 기획서는 제목 옆, 화면설계서는 제목 아래 줄");
  expect(basisProblem({ design: "08-common", differs: "형식이 다름" })).toContain("둘 다 적을 것");
  expect(basisProblem(both)).toBeUndefined();
  expect(expectedOf({ op: "expect", sel: "#sub", textContains: "Description", basis: both }, undefined)).toContain("근거: 기획서 CCB-1940 · 화면설계서 08-common");
});

const mk = (id: string, basis: unknown): Case => ({ id, title: id, type: "spec", source_ref: "08-common", screen: "/common", feature: "제목", chapter: "C19", steps: [{ op: "goto", url: "/common" }, { op: "expect", sel: "#sub", text: "제목 아래 줄", basis }] });

test("다르다고 적은 기대가 어긋나면 FAIL 이 아니라 NA(S), 근거가 하나뿐인 기대의 어긋남은 그대로 FAIL", async () => {
  const ctx = fakeCtx({ text: async () => "제목 옆 줄" });
  const r = await runCase(ctx, mk("S-1", { plan: "CCB-1940", design: "08-common CCB-1940 Description 1", differs: "줄 위치" }));
  expect(r.status).toBe("NA");
  expect(r.toolError?.kind).toBe("S");
  expect(r.reason).toContain("기획서와 화면설계서가 다름: 줄 위치");
  const row = excludedRows([r], () => "-", { round: "R09" })[0]!;
  expect(row.kind).toBe("S");
  expect(row.action).toContain("어느 쪽(기획서·화면설계서)을 따를지");
  const plain = await runCase(ctx, mk("S-2", DESIGN));
  expect(plain.status).toBe("FAIL");
  const ok = await runCase(fakeCtx({ text: async () => "제목 아래 줄" }), mk("S-3", { plan: "CCB-1940", design: "08-common", differs: "줄 위치" }));
  expect(ok.status).toBe("PASS");
});

test("등록: 다르다고 적었는데 한쪽이 빠지면 거부하고, 시트에 다른 기대를 올린다", () => {
  const root = mkdtempSync(join(tmpdir(), "e2e-loop-bs-"));
  new Project(root).ensure();
  const bad = A.aCaseUpsert({ project: root, cases: [mk("S-8", { design: "08-common", differs: "줄 위치" })] });
  expect(bad.errors.join()).toContain("S-8: 근거 칸 #2: 기획서와 화면설계서가 다르면(differs) 둘 다 적을 것");
  const ok = A.aCaseUpsert({ project: root, cases: [mk("S-9", { plan: "CCB-1940", design: "08-common", differs: "줄 위치" }), mk("S-10", DESIGN)] });
  expect(ok.errors).toEqual([]);
  expect(ok.warns.join()).not.toContain("근거(basis");
  expect(buildSheet(new Project(root)).gaps.basisDiffers).toEqual([{ id: "S-9", detail: "#2 기획서 CCB-1940 · 화면설계서 08-common — 기획서와 화면설계서가 다름: 줄 위치" }]);
});
