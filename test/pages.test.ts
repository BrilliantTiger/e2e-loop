// 오류 C(추가): 쪽 넘김 — 여러 쪽에 흩어진 같은 이름 줄을 모든 쪽을 돌며 모은다.
import { expect, test } from "bun:test";
import { collectRows, perPage } from "../src/pages.ts";
import { runCase } from "../src/runner.ts";
import { aCaseUpsert } from "../src/actions.ts";
import { missingBasis } from "../src/basis.ts";
import { fakeCtx, basePage } from "./helpers/fake.ts";
import type { DPage } from "../src/drivers/index.ts";
import type { Case } from "../src/types.ts";

/** 쪽 번호로 줄이 바뀌는 가짜 목록. data[i] 가 i+1쪽의 줄 글자들 */
function listPage(data: string[][], over: Partial<{ nextState: (page: number) => string; sticky: boolean }> = {}): DPage & { clicks: string[] } {
  let page = 0;
  const clicks: string[] = [];
  const nextState = over.nextState ?? ((p: number) => (p >= data.length - 1 ? "disabled" : "ok"));
  return {
    ...basePage(),
    clicks,
    click: async (sel: string) => {
      clicks.push(sel);
      if (sel === "#next" && !over.sticky && nextState(page) === "ok") page++;
      if (sel === "#first") page = 0;
    },
    evaluate: (async (script: string) => {
      if (script.includes("e.disabled")) return nextState(page);
      if (script.includes("e.innerText || e.textContent")) return data[page] ?? [];
      if (script.includes("location.pathname")) return `sig|${page}|${(data[page] ?? []).join(",")}`;
      return undefined;
    }) as any,
  };
}

const DATA = [["홍길동 A", "김철수"], ["홍길동 B"], ["이영희", "홍길동 C"]];

test("모든 쪽을 돌며 같은 이름 줄을 모으고 쪽 번호를 함께 돌려준다", async () => {
  const p = listPage(DATA);
  const r = await collectRows(p, { sel: "row=홍길동", next: "#next" });
  expect(r.pages).toBe(3);
  expect(r.stoppedBy).toBe("마지막 쪽");
  expect(r.rows.length).toBe(5);
  expect(r.rows.filter((x) => x.text.startsWith("홍길동")).map((x) => `${x.page}:${x.text}`)).toEqual(["1:홍길동 A", "2:홍길동 B", "3:홍길동 C"]);
  expect(perPage(r)).toBe("1쪽 2줄 · 2쪽 1줄 · 3쪽 2줄");
  expect(p.clicks).toEqual(["#next", "#next"]);
});

test("next 가 없으면 한 쪽만 읽는다", async () => {
  const r = await collectRows(listPage(DATA), { sel: "row=홍길동" });
  expect(r.pages).toBe(1);
  expect(r.stoppedBy).toBe("단일 쪽");
  expect(r.rows.length).toBe(2);
});

test("다음 단추가 없거나 눌러도 쪽이 안 바뀌면 거기서 멈춘다", async () => {
  expect((await collectRows(listPage(DATA, { nextState: () => "none" }), { sel: "x", next: "#next" })).stoppedBy).toBe("다음 단추 없음");
  expect((await collectRows(listPage(DATA, { nextState: () => "ok", sticky: true }), { sel: "x", next: "#next" })).stoppedBy).toBe("쪽이 안 바뀜");
});

test("쪽 상한에서 멈춘다. first 가 있으면 첫 쪽으로 돌아간 뒤 모은다", async () => {
  const big = Array.from({ length: 10 }, (_, i) => [`줄${i}`]);
  const r = await collectRows(listPage(big, { nextState: () => "ok" }), { sel: "x", next: "#next", maxPages: 4 });
  expect(r.pages).toBe(4);
  expect(r.stoppedBy).toBe("쪽 상한");
  const p = listPage(DATA);
  await p.click("#next");
  const again = await collectRows(p, { sel: "x", next: "#next", first: "#first" });
  expect(again.rows[0]!.page).toBe(1);
  expect(p.clicks).toContain("#first");
});

test("collect 스텝: 모든 쪽의 줄 개수와 포함 여부를 확인하고 쪽별 개수를 로그에 남긴다", async () => {
  const c: Case = { id: "C-1", title: "C-1", type: "spec", source_ref: "기획서", screen: "/l", feature: "목록", steps: [
    { op: "goto", url: "/l" },
    { op: "collect", sel: "row=홍길동", next: "#next", atLeast: 5, contains: ["홍길동 C", "이영희"], basis: "POL-1" },
  ] };
  const r = await runCase(fakeCtx(listPage(DATA)), c);
  expect(r.status).toBe("PASS");
  expect(r.steps[1]!.desc).toContain("3쪽에서 5줄 모음");
  expect(r.steps[1]!.found).toContain("1쪽 2줄 · 2쪽 1줄 · 3쪽 2줄");
});

test("collect 스텝: 둘째·셋째 쪽에만 있는 줄도 세므로 개수가 틀리면 쪽별 개수와 함께 FAIL", async () => {
  const c: Case = { id: "C-2", title: "C-2", type: "spec", source_ref: "기획서", screen: "/l", feature: "목록", steps: [
    { op: "goto", url: "/l" },
    { op: "collect", sel: "row=홍길동", next: "#next", count: 3, basis: "POL-1" },
  ] };
  const r = await runCase(fakeCtx(listPage(DATA)), c);
  expect(r.status).toBe("FAIL");
  expect(r.reason).toContain("기대 3 / 실제 5");
  expect(r.reason).toContain("1쪽 2줄 · 2쪽 1줄 · 3쪽 2줄");
});

test("collect 스텝: next 를 안 쓰면 한 쪽만 읽었다는 경고가 남는다", async () => {
  const c: Case = { id: "C-3", title: "C-3", type: "spec", source_ref: "기획서", screen: "/l", feature: "목록", steps: [{ op: "goto", url: "/l" }, { op: "collect", sel: "row=홍길동", atLeast: 1, basis: "POL-1" }] };
  const r = await runCase(fakeCtx(listPage(DATA)), c);
  expect(r.status).toBe("PASS");
  expect(r.warnings.some((w) => w.includes("한 쪽만 읽음"))).toBe(true);
});

test("등록: collect 는 sel 이 필요하고 근거가 없으면 경고, eval 의 pop() 읽기는 collect 를 쓰라고 경고", () => {
  const ctx = fakeCtx({});
  const col = (id: string, step: any): Partial<Case> => ({ id, title: id, type: "spec", source_ref: "x", steps: [{ op: "goto", url: "/" }, step] });
  const out = aCaseUpsert({ project: ctx.project.root, cases: [
    col("R-1", { op: "collect", next: "#n", count: 1 }),
    col("R-2", { op: "collect", sel: "row=a", next: "#n", count: 1 }),
    col("R-3", { op: "eval", script: "[...document.querySelectorAll('tr')].pop().innerText", equals: "x", basis: "POL-1" }),
  ] });
  expect(out.errors.length).toBe(1);
  expect(out.warns.some((w) => w.startsWith("R-2") && w.includes("근거"))).toBe(true);
  expect(out.warns.some((w) => w.startsWith("R-3") && w.includes("collect"))).toBe(true);
  expect(missingBasis([{ id: "R", title: "R", type: "spec", steps: [{ op: "collect", sel: "a", count: 1 }] }]).length).toBe(1);
});
