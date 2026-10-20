// 사유 T: 챕터마다 같은 줄 반복 — 같은 (화면, 요소, 동작, 사유)가 여러 챕터에서 되풀이되면 제외 시트에서 한 줄로 합친다(F·I 재발).
import { expect, test } from "bun:test";
import { excludedRows, excludedTsv } from "../src/toolerror.ts";
import { nowIso } from "../src/store.ts";
import type { CaseResult } from "../src/types.ts";

const na = (id: string, kind: "D" | "N", over: Partial<CaseResult> = {}): CaseResult => ({ id, title: id, type: "spec", status: "NA", toolError: { kind, detail: "실제 값을 읽지 못함(빈 칸·undefined)" }, warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: nowIso(), ...over });

test("같은 모달의 같은 두 줄이 C9C·C9B2 에서 되풀이되면 두 줄(T)로 합치고 챕터·원래 사유·횟수를 남긴다", () => {
  const where: Record<string, { chapter: string; element: string }> = {
    "C9C-1": { chapter: "C9C", element: "일괄 Handoff 확인 모달" }, "C9C-2": { chapter: "C9C", element: "일괄 Handoff (0)" },
    "C9B2-1": { chapter: "C9B2", element: "일괄 Handoff 확인 모달" }, "C9B2-2": { chapter: "C9B2", element: "일괄 Handoff (0)" },
    "C12-1": { chapter: "C12", element: "Table 현황" },
  };
  const results = [na("C9C-1", "D"), na("C9C-2", "D"), na("C9B2-1", "D"), na("C9B2-2", "D"), na("C12-1", "D"), na("C9B2-3", "N")];
  const rows = excludedRows(results, () => "-", { round: "R09", info: (r) => ({ chapter: where[r.id]?.chapter ?? "C9B2", screen: "/1710", element: where[r.id]?.element ?? "잠금", verb: "클릭" }) });
  expect(rows.map((x) => `${x.no} ${x.kind} ${x.chapter} ${x.element} ×${x.count}`)).toEqual([
    "R09-X-01 T C9C·C9B2 일괄 Handoff 확인 모달 ×2",
    "R09-X-02 T C9C·C9B2 일괄 Handoff (0) ×2",
    "R09-X-03 D C12 Table 현황 ×1",
    "R09-X-04 N C9B2 잠금 ×1",
  ]);
  expect(rows[0]).toMatchObject({ origKind: "D", chapters: ["C9C", "C9B2"], cases: ["C9C-1", "C9B2-1"] });
  expect(rows[0]!.reason).toContain("T 챕터마다 같은 줄 반복(챕터 C9C·C9B2): D 화면이 그려지기 전에 읽음");
  expect(rows[0]!.action).toContain("한 번 고치면 모든 챕터에서 풀림");
  expect(excludedTsv(rows).split("\n")[1]).toContain("\tC9C·C9B2\t2\t");
});

test("한 챕터 안의 같은 줄은 지금처럼 그 챕터의 줄로 합치고(I), 선행 결함에 막힘(H)은 챕터를 넘어 합치지 않는다", () => {
  const h = (id: string, ch: string): CaseResult => ({ ...na(id, "D"), toolError: undefined, blockedBy: { chapter: "C9", by: ["C9-1"], detail: "선행 결함에 막힘(C9-1, 챕터 C9)" } });
  const rows = excludedRows([na("A-1", "D"), na("A-2", "D"), h("B-1", "C11"), h("C-1", "C12")], () => "-", { round: "R09", info: (r) => ({ chapter: r.id.startsWith("A") ? "C1" : r.id.startsWith("B") ? "C11" : "C12", screen: "/x", element: "#y", verb: "확인" }) });
  expect(rows.map((x) => `${x.kind} ${x.chapter} ×${x.count}`)).toEqual(["D C1 ×2", "H C11 ×1", "H C12 ×1"]);
});
