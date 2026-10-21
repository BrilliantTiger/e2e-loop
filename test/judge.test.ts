// 오류 G(판정용 문자열을 잘라서 비교) 시험과 패널 제목 대기.
import { expect, test } from "bun:test";
import { runCase } from "../src/runner.ts";
import { aCaseUpsert } from "../src/actions.ts";
import { looksTruncated, slicesValue } from "../src/judge.ts";
import { waitPanelTitle } from "../src/reads.ts";
import { isIssue } from "../src/issues.ts";
import { fakeCtx, basePage } from "./helpers/fake.ts";
import type { Case } from "../src/types.ts";

const mk = (id: string, steps: Case["steps"], over: Partial<Case> = {}): Case => ({ id, title: id, type: "spec", source_ref: "기획서 1.1", screen: "/p", feature: "상세", steps, ...over });

test("잘린 글 판별: 말줄임표로 끝나는 기대, slice·substring 으로 자르는 스크립트", () => {
  expect(looksTruncated("긴 문장의 앞부분…")).toBe(true);
  expect(looksTruncated("앞부분...")).toBe(true);
  expect(looksTruncated("3건")).toBe(false);
  expect(looksTruncated(undefined)).toBe(false);
  expect(slicesValue("document.querySelector('#a').innerText.slice(0, 40)")).toBe(true);
  expect(slicesValue("x.substring(0,5)")).toBe(true);
  expect(slicesValue("document.title")).toBe(false);
});

test("판정은 자르지 않은 전체 글로 한다: 80자가 넘는 글도 끝부분까지 비교한다", async () => {
  const long = "가".repeat(120) + "끝";
  const ctx = fakeCtx({ text: async () => long });
  const ok = await runCase(ctx, mk("G-OK", [{ op: "goto", url: "/p" }, { op: "expect", sel: "#t", textContains: "가끝" }]));
  expect(ok.status).toBe("PASS");
  const bad = await runCase(ctx, mk("G-BAD", [{ op: "goto", url: "/p" }, { op: "expect", sel: "#t", textContains: "없는글" }]));
  expect(bad.status).toBe("FAIL");
});

test("기대한 글이 …로 끝나 어긋나면 FAIL 이 아니라 NA(G) 이고 이슈가 아니다", async () => {
  const ctx = fakeCtx({ text: async () => "긴 문장의 앞부분과 뒷부분이 모두 있는 글" });
  const r = await runCase(ctx, mk("G-TRUNC", [{ op: "goto", url: "/p" }, { op: "expect", sel: "#t", textContains: "긴 문장의 앞부분…" }]));
  expect(r.status).toBe("NA");
  expect(r.toolError?.kind).toBe("G");
  expect(isIssue(r, { acceptedSkips: [] })).toBe(false);
});

test("진짜로 다른 글이면 …가 없는 한 그대로 FAIL 이다", async () => {
  const ctx = fakeCtx({ text: async () => "5건" });
  const r = await runCase(ctx, mk("G-REAL", [{ op: "goto", url: "/p" }, { op: "expect", sel: "#t", text: "3건" }]));
  expect(r.status).toBe("FAIL");
  expect(r.toolError).toBeUndefined();
});

test("eval 스크립트가 slice 로 잘라 equals 로 비교했는데 어긋나면 NA(G), 경고도 남는다. 맞으면 통과하지만 경고는 남는다", async () => {
  const script = "document.title.slice(0, 5)";
  const bad = await runCase(fakeCtx({ evaluate: async () => "abcde" as any }), mk("G-EV", [{ op: "goto", url: "/p" }, { op: "eval", script, equals: "xyz" }]));
  expect(bad.status).toBe("NA");
  expect(bad.toolError?.kind).toBe("G");
  expect(bad.warnings.some((w) => w.includes("slice"))).toBe(true);
  const ok = await runCase(fakeCtx({ evaluate: async () => "abcde" as any }), mk("G-EV2", [{ op: "goto", url: "/p" }, { op: "eval", script, equals: "abcde" }]));
  expect(ok.status).toBe("PASS");
  const plain = await runCase(fakeCtx({ evaluate: async () => "abcde" as any }), mk("G-EV3", [{ op: "goto", url: "/p" }, { op: "eval", script: "document.title", equals: "xyz" }]));
  expect(plain.status).toBe("FAIL");
});

test("등록할 때 잘린 값으로 비교하는 케이스는 경고한다", () => {
  const ctx = fakeCtx({});
  const out = aCaseUpsert({ project: ctx.project.root, cases: [
    mk("W-1", [{ op: "goto", url: "/" }, { op: "eval", script: "x.slice(0,3)", equals: "abc", basis: "POL-1" }]),
    mk("W-2", [{ op: "goto", url: "/" }, { op: "expect", sel: "#a", textContains: "앞부분…", basis: "POL-1" }]),
  ] });
  expect(out.errors).toEqual([]);
  expect(out.warns.filter((w) => w.includes("오류 G")).length).toBe(2);
});

test("패널 제목 대기: 제목에 대상이 뜰 때까지 기다린 뒤 통과한다", async () => {
  let n = 0;
  const page = { ...basePage(), evaluate: async () => (++n < 4 ? [] : ["업로드 파일 선택"]) as any };
  const r = await waitPanelTitle(page, "업로드", 2000);
  expect(r.ok).toBe(true);
  expect(n).toBeGreaterThanOrEqual(4);
});

test("패널 제목 대기: 끝내 안 뜨면 지금 뜬 제목을 알려 주며 실패한다", async () => {
  const page = { ...basePage(), evaluate: async () => ["다른 모달"] as any };
  const r = await waitPanelTitle(page, "업로드", 300);
  expect(r.ok).toBe(false);
  expect(r.titles).toEqual(["다른 모달"]);
});

test("스텝에 panelTitle 을 쓰면 그 패널 제목이 뜬 뒤에 누른다", async () => {
  const log: string[] = [];
  let polls = 0;
  const ctx = fakeCtx({
    evaluate: async (script: string) => {
      if (script.includes("aria-label") && script.includes("dialogs")) return (++polls < 3 ? [] : ["대상 상세"]) as any;
      return undefined as any;
    },
    click: async (s) => void log.push("click " + s),
  });
  const r = await runCase(ctx, mk("P-OK", [{ op: "goto", url: "/p" }, { op: "click", sel: "#save", panelTitle: "대상 상세" }, { op: "expect", sel: "#done", visible: true, basis: "POL-1" }]));
  expect(r.status).toBe("PASS");
  expect(polls).toBeGreaterThanOrEqual(3);
  expect(log).toEqual(["click #save"]);
  expect(r.steps[1]!.desc).toContain("패널 제목 「대상 상세」 확인");
});

test("스텝에 panelTitle 을 썼는데 제목이 안 뜨면 누르지 않고 실패한다", async () => {
  const log: string[] = [];
  const ctx = fakeCtx({ evaluate: async () => ["엉뚱한 모달"] as any, click: async (s) => void log.push(s) });
  const r = await runCase(ctx, mk("P-BAD", [{ op: "goto", url: "/p" }, { op: "click", sel: "#save", panelTitle: "대상 상세", panelTimeout: 300 }]));
  expect(r.status).toBe("FAIL");
  expect(r.reason).toContain("엉뚱한 모달");
  expect(log).toEqual([]);
});

test("wait 스텝에 panelTitle 만 쓰면 제목이 뜰 때까지만 기다리고 따로 쉬지 않는다", async () => {
  const ctx = fakeCtx({ evaluate: async () => ["대상 상세"] as any });
  const t0 = Date.now();
  const r = await runCase(ctx, mk("P-WAIT", [{ op: "goto", url: "/p" }, { op: "wait", panelTitle: "대상 상세" }]));
  expect(r.status).toBe("PASS");
  expect(Date.now() - t0).toBeLessThan(450);
});
