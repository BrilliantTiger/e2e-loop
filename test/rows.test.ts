// B: 표 줄은 번호가 아니라 컬럼 이름·글자로 찾는다. 줄 번호 선택자는 등록을 막고, 줄을 바꾼 뒤에는 목록을 다시 읽는다.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { aCaseUpsert } from "../src/actions.ts";
import { isRowSel, rowByNumber, translateSel } from "../src/rows.ts";
import { LIB } from "../src/drivers/inpage.ts";
import { runCase } from "../src/runner.ts";
import { fakeCtx } from "./helpers/fake.ts";
import type { Case } from "../src/types.ts";

let browser: Browser;
let page: Page;

const HTML = `<!doctype html><body>
<table id="t"><thead><tr><th>파일</th><th>상태</th><th>작업</th></tr></thead><tbody>
<tr data-testid="row-1"><td>a.csv</td><td>대기</td><td><button class="act" aria-label="결정">결정</button></td></tr>
<tr data-testid="row-2"><td>visit.csv</td><td>완료</td><td><button class="act" aria-label="결정">결정</button></td></tr>
<tr data-testid="row-3"><td>lab "x".csv</td><td>막힘</td><td><button class="act" aria-label="결정">결정</button></td></tr>
</tbody></table>
<div role="grid"><div role="row"><span role="columnheader">이름</span><span role="columnheader">단계</span></div>
<div role="row"><span role="gridcell">홍길동</span><span role="gridcell">L2</span></div>
<div role="row"><span role="gridcell">김철수</span><span role="gridcell">L3</span></div></div>
</body>`;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(HTML);
});
afterAll(async () => {
  await browser.close();
});

const texts = async (sel: string) => (await page.locator(translateSel(sel)).allInnerTexts()).map((t) => t.trim());

test("row=<글자> 는 그 글자가 든 줄만 찾는다(번호와 무관)", async () => {
  expect(await texts("row=visit.csv")).toEqual(["visit.csv\t완료\t결정"]);
  expect((await page.locator(translateSel("row=csv")).count())).toBe(3);
});

test('row="정확한 칸 글자" 는 칸 하나가 정확히 같은 줄만, 따옴표가 든 글자도 찾는다', async () => {
  expect((await page.locator(translateSel('row="a.csv"')).count())).toBe(1);
  expect((await page.locator(translateSel('row="csv"')).count())).toBe(0);
  expect((await page.locator(translateSel('row=lab "x".csv')).count())).toBe(1);
});

test("cell[col][row] 는 컬럼 이름 머리글 아래 칸을 줄 글자로 찾는다", async () => {
  expect(await texts('cell[col="상태"][row="visit.csv"]')).toEqual(["완료"]);
  expect(await texts('cell[col="상태"][row="a.csv"]')).toEqual(["대기"]);
  expect(await texts('cell[col="상태"]')).toEqual(["대기", "완료", "막힘"]); // col 만 쓰면 그 컬럼의 모든 칸
});

test("줄 목록이 다시 정렬되어도 같은 파일 줄을 찾는다(번호가 아니라 글자)", async () => {
  await page.evaluate(() => { const b = document.querySelector("#t tbody")!; b.appendChild(b.firstElementChild!); });
  expect(await texts('cell[col="상태"][row="a.csv"]')).toEqual(["대기"]);
  expect(await texts('cell[col="상태"][row="visit.csv"]')).toEqual(["완료"]);
  await page.setContent(HTML);
});

test("역할 기반 표(role=grid)도 컬럼 이름으로 찾는다", async () => {
  expect(await texts('cell[col="단계"][row="김철수"]')).toEqual(["L3"]);
});

test("줄 안쪽 요소: row=… >> button 은 그 줄의 버튼만", async () => {
  expect((await page.locator(translateSel("row=visit.csv >> button.act")).count())).toBe(1);
  expect((await page.locator(translateSel('row=visit.csv >> [aria-label="결정"]')).count())).toBe(1);
  expect(() => translateSel("row=visit.csv >> div button")).toThrow(/단순 CSS/);
});

test("Ego 가 쓰는 브라우저 안 resolve(xpath=)로도 같은 요소를 찾는다", async () => {
  const n = await page.evaluate(`(() => { ${LIB}; return window.__e2e.resolve(${JSON.stringify(translateSel('cell[col="상태"][row="visit.csv"]'))}).map((e) => e.innerText); })()`);
  expect(n).toEqual(["완료"]);
});

test("줄 번호로 찾는 선택자를 알아본다 / 줄 도우미와 평범한 선택자는 통과", () => {
  for (const s of ['[data-testid="row-3"]', "#row_2", "tr.row-1", "tr:nth-child(3)", "tbody tr:nth-of-type(2) td", '[role="row"]:nth-child(2)', "tr >> nth=2"]) expect(rowByNumber(s)).not.toBeNull();
  for (const s of ["#save", '[data-testid="l1-data-row-"]', 'row=visit.csv', 'cell[col="상태"][row="a"]', "table tr", "td:nth-child(2)", "[data-testid=arrow-14]"]) expect(rowByNumber(s)).toBeNull();
  expect(isRowSel("row=a")).toBe(true);
  expect(isRowSel("#row")).toBe(false);
});

const mk = (id: string, steps: Case["steps"]): Case => ({ id, title: id, type: "spec", source_ref: "기획서 2.1", steps });

test("등록 때 줄 번호 선택자는 막고 줄 도우미는 받는다", () => {
  const root = mkdtempSync(join(tmpdir(), "e2e-loop-row-"));
  const bad = aCaseUpsert({ project: root, cases: [mk("R-1", [{ op: "goto", url: "/" }, { op: "click", sel: '[data-testid="row-3"] button' }, { op: "expect", sel: "#x", visible: true }])] });
  expect(bad.errors.length).toBe(1);
  expect(bad.errors[0]).toContain("오류 B");
  expect(bad.added + bad.updated).toBe(0);
  const badNth = aCaseUpsert({ project: root, cases: [mk("R-2", [{ op: "goto", url: "/" }, { op: "click", sel: "tr:nth-child(2) button" }])] });
  expect(badNth.errors.length).toBe(1);
  const malformed = aCaseUpsert({ project: root, cases: [mk("R-3", [{ op: "goto", url: "/" }, { op: "click", sel: "cell[row=\"a\"]" }])] });
  expect(malformed.errors[0]).toContain("col");
  const ok = aCaseUpsert({ project: root, cases: [mk("R-4", [{ op: "goto", url: "/" }, { op: "click", sel: "row=visit.csv >> button" }, { op: "expect", sel: 'cell[col="상태"][row="visit.csv"]', text: "완료" }])] });
  expect(ok.errors).toEqual([]);
  expect(ok.added).toBe(1);
});

test("러너: 줄 도우미 선택자를 xpath 로 바꿔 쓰고, 클릭 뒤 목록이 가라앉기를 기다린 다음 읽는다. 오류 글에는 원래 선택자가 나온다", async () => {
  const seen: string[] = [];
  let evals = 0;
  const ctx = fakeCtx({
    click: async (sel) => { seen.push(sel); },
    evaluate: async () => `sig${Math.min(++evals, 3)}` as any, // 처음 몇 번은 화면이 계속 바뀌다 가라앉는다
    text: async () => "대기",
  });
  const r = await runCase(ctx, mk("R-RUN", [{ op: "goto", url: "/" }, { op: "click", sel: "row=visit.csv >> button" }, { op: "expect", sel: 'cell[col="상태"][row="visit.csv"]', text: "완료" }]));
  expect(seen[0]!.startsWith("xpath=//")).toBe(true);
  expect(evals).toBeGreaterThanOrEqual(3); // 클릭 뒤 settleList 가 화면을 여러 번 다시 읽음
  expect(r.status).toBe("FAIL");
  expect(r.reason).toContain('cell[col="상태"][row="visit.csv"]');
  expect(r.reason).not.toContain("xpath=");
  expect(r.steps[1]!.desc).toContain("row=visit.csv >> button");
});

test("없는 컬럼 이름이면 아무 칸도 찾지 않는다(첫 칸으로 잘못 잡지 않는다)", async () => {
  expect((await page.locator(translateSel('cell[col="없는 컬럼"][row="visit.csv"]')).count())).toBe(0);
  expect((await page.locator(translateSel('cell[col="상태"][row="없는 줄"]')).count())).toBe(0);
});
