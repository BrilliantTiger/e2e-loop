// 오류 D(추가): 누르기 전 대기(waitGone · waitEnabled)와 토스트 참고 전용.
import { expect, test } from "bun:test";
import { runCase } from "../src/runner.ts";
import { aCaseUpsert } from "../src/actions.ts";
import { waitEnabled, waitGone } from "../src/reads.ts";
import { isToastStep } from "../src/toast.ts";
import { missingBasis } from "../src/basis.ts";
import { fakeCtx, basePage } from "./helpers/fake.ts";
import type { Case } from "../src/types.ts";

const mk = (id: string, steps: Case["steps"], over: Partial<Case> = {}): Case => ({ id, title: id, type: "spec", source_ref: "기획서 1.1", screen: "/up", feature: "업로드", steps, ...over });

test("켜질 때까지 대기: 비활성이다가 켜지면 그때 통과하고 단추 글자를 돌려준다", async () => {
  let n = 0;
  const page = { ...basePage(), evaluate: async () => ({ enabled: ++n >= 4, text: "업로드 시작" }) as any };
  const r = await waitEnabled(page, "#go", 2000);
  expect(r).toEqual({ ok: true, text: "업로드 시작", state: "켜짐" });
  expect(n).toBe(4);
});

test("켜질 때까지 대기: 끝내 비활성이면 마지막 상태를 알려 준다. 요소가 없으면 없음", async () => {
  const off = await waitEnabled({ ...basePage(), evaluate: async () => ({ enabled: false, text: "시작" }) as any }, "#go", 250);
  expect(off).toEqual({ ok: false, text: "시작", state: "비활성" });
  const none = await waitEnabled({ ...basePage(), evaluate: async () => null as any }, "#go", 250);
  expect(none.state).toBe("없음");
});

test("사라질 때까지 대기: 보이던 표시가 사라지면 통과, 안 사라지면 남은 선택자를 알려 준다", async () => {
  let n = 0;
  const gone = await waitGone({ ...basePage(), count: async () => (++n < 3 ? 1 : 0) }, "text=세는 중", 2000);
  expect(gone.ok).toBe(true);
  const stuck = await waitGone({ ...basePage(), count: async () => 1, isVisible: async () => true }, ["text=세는 중"], 250);
  expect(stuck).toEqual({ ok: false, remaining: ["text=세는 중"] });
});

test("업로드 모달: 「세는 중」이 사라지고 단추가 켜진 뒤에 누른다", async () => {
  const log: string[] = [];
  let tick = 0;
  let counting = 0;
  const ctx = fakeCtx({
    count: async (sel) => (sel.includes("세는 중") ? (++counting < 3 ? 1 : 0) : 1),
    isVisible: async () => true,
    evaluate: async (script: string) => {
      if (script.includes("enabled:")) {
        tick++;
        return { enabled: tick >= 5, text: "업로드" } as any;
      }
      return undefined as any;
    },
    click: async (s) => void log.push(`click ${s} tick=${tick}`),
  });
  const r = await runCase(ctx, mk("U-1", [{ op: "goto", url: "/up" }, { op: "click", sel: "#upload", waitGone: "text=세는 중", waitEnabled: true }, { op: "expect", sel: "#done", visible: true, basis: "POL-1" }]));
  expect(r.status).toBe("PASS");
  expect(log.length).toBe(1);
  expect(Number(log[0]!.split("tick=")[1])).toBeGreaterThanOrEqual(5);
  expect(r.steps[1]!.desc).toContain("사라짐 확인");
  expect(r.steps[1]!.desc).toContain("켜짐 확인: 「업로드」");
});

test("단추가 안 켜지면 누르지 않고 실패하며 단추 글자를 알려 준다", async () => {
  const log: string[] = [];
  const ctx = fakeCtx({ evaluate: async () => ({ enabled: false, text: "업로드" }) as any, click: async (s) => void log.push(s) });
  const r = await runCase(ctx, mk("U-2", [{ op: "goto", url: "/up" }, { op: "click", sel: "#upload", waitEnabled: true, waitTimeout: 300 }]));
  expect(r.status).toBe("FAIL");
  expect(r.reason).toContain("켜지지 않음");
  expect(r.reason).toContain("업로드");
  expect(log).toEqual([]);
});

test("토스트 expect 는 참고로만: 없거나 달라도 케이스는 통과하고 경고로 남는다", async () => {
  const ctx = fakeCtx({ text: async () => "" });
  const r = await runCase(ctx, mk("T-1", [
    { op: "goto", url: "/up" },
    { op: "click", sel: "#del" },
    { op: "expect", sel: ".Toastify__toast", text: "삭제되었습니다" },
    { op: "expect", sel: "#done", visible: true, basis: "POL-1" },
  ]));
  expect(r.status).toBe("PASS");
  expect(r.warnings.some((w) => w.startsWith("토스트 참고(판정 아님)"))).toBe(true);
  expect(r.steps[2]!.desc).toContain("토스트 참고만");
});

test("토스트가 있으면 확인됨으로 적고, toast:true 를 단 expect 도 참고 전용이다", async () => {
  const ctx = fakeCtx({ text: async () => "삭제되었습니다" });
  const r = await runCase(ctx, mk("T-2", [{ op: "goto", url: "/up" }, { op: "expect", sel: "#msg", toast: true, text: "삭제되었습니다" }]));
  expect(r.status).toBe("PASS");
  expect(r.steps[1]!.desc).toContain("토스트 확인됨(참고)");
  expect(r.warnings).toEqual([]);
});

test("토스트 말고 일반 expect 가 어긋나면 그대로 FAIL 이다", async () => {
  const ctx = fakeCtx({ text: async () => "남은 행 3" });
  const r = await runCase(ctx, mk("T-3", [{ op: "goto", url: "/up" }, { op: "expect", sel: "#rows", text: "남은 행 2" }]));
  expect(r.status).toBe("FAIL");
});

test("토스트 expect 는 기대 칸으로 세지 않아 근거 경고를 받지 않고, 등록할 때는 서버 효과로 판정하라고 경고한다", () => {
  expect(isToastStep({ op: "expect", sel: ".snackbar", text: "x" })).toBe(true);
  expect(isToastStep({ op: "expect", sel: "#row", text: "x" })).toBe(false);
  expect(isToastStep({ op: "click", sel: ".toast" })).toBe(false);
  const c = mk("T-4", [{ op: "goto", url: "/" }, { op: "expect", sel: ".toast", text: "저장됨" }]);
  expect(missingBasis([c])).toEqual([]);
  const ctx = fakeCtx({});
  const out = aCaseUpsert({ project: ctx.project.root, cases: [c] });
  expect(out.warns.some((w) => w.includes("서버 효과"))).toBe(true);
  expect(out.warns.some((w) => w.includes("expect 스텝이 없어"))).toBe(true);
});
