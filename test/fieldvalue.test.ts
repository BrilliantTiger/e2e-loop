// 오류 W: 입력 칸 값을 화면 글(innerText)로 읽음 — 입력 칸 값은 innerText 에 실리지 않아 「값이 안 들어감」으로 잘못 판정한다.
// 글 기대가 어긋나면 그 요소(또는 안에 든 입력 칸)의 값으로 다시 확인한다. 시험 창은 앞으로 끌어오지 않는다(오류 O 정정).
import { expect, test } from "bun:test";
import { runCase } from "../src/runner.ts";
import { fakeCtx } from "./helpers/fake.ts";
import type { Case } from "../src/types.ts";

const mk = (id: string, exp: Record<string, unknown>): Case => ({ id, title: id, type: "spec", source_ref: "기획서 1110", screen: "/datasets/new", feature: "등록 모달", steps: [{ op: "goto", url: "/datasets/new" }, { op: "expect", sel: "#org-modal", ...exp, basis: "CCB-1110" }] });

test("모달 글에는 없고 입력 칸 값에 있으면 통과 — 입력 칸 값으로 확인했다고 남긴다", async () => {
  const ctx = fakeCtx({ text: async () => "기관 선택 만들기", evaluate: async (x: string): Promise<any> => (x.includes("querySelectorAll('input,textarea,select')") ? ["ADNI / 새 기관"] : undefined) });
  const r = await runCase(ctx, mk("W-1", { textContains: "ADNI" }));
  expect(r.status).toBe("PASS");
  expect(r.steps[1]!.desc).toContain("입력 칸 값으로 확인(「ADNI / 새 기관」)");
  const exact = await runCase(ctx, mk("W-2", { text: "ADNI / 새 기관" }));
  expect(exact.status).toBe("PASS");
});

test("입력 칸 값에도 없으면 그대로 FAIL 이고, 실패 글에 입력 칸 값을 같이 적는다", async () => {
  const ctx = fakeCtx({ text: async () => "기관 선택 만들기", evaluate: async (x: string): Promise<any> => (x.includes("querySelectorAll('input,textarea,select')") ? ["OPEN / 다른 기관"] : undefined) });
  const r = await runCase(ctx, mk("W-3", { textContains: "ADNI" }));
  expect(r.status).toBe("FAIL");
  expect(r.reason).toContain("입력 칸 값 「OPEN / 다른 기관」");
});

test("케이스를 시작할 때 시험 창을 앞으로 끌어오지 않는다(사용자 마우스·포커스를 뺏지 않음)", async () => {
  let fronts = 0;
  const ctx = fakeCtx({ text: async () => "ADNI", front: async () => void fronts++ });
  ctx.cfg.headless = false;
  await runCase(ctx, mk("W-4", { textContains: "ADNI" }));
  expect(fronts).toBe(0);
});
