// 오류 A(추가): 긴 계산 대기 — 케이스마다 대기 상한을 정하고, 무변화 구간은 로그만 남기며 상한까지 기다린다.
import { expect, test } from "bun:test";
import { waitEndState } from "../src/waits.ts";
import { runCase } from "../src/runner.ts";
import { aCaseUpsert } from "../src/actions.ts";
import { ToolError } from "../src/toolerror.ts";
import { fakeCtx, basePage } from "./helpers/fake.ts";
import type { Case } from "../src/types.ts";

const never = { ...basePage(), count: async () => 0, isVisible: async () => false, evaluate: async () => "같은 화면" as any };
const states = { 완료: "#done", 오류: "#err" };

test("기본 대기: 화면이 idleMs 동안 안 바뀌면 NA(A) 로 끝난다", async () => {
  const log: string[] = [];
  const e = await waitEndState(never, { endStates: states, idleMs: 150, timeout: 5000 }, { pollMs: 20, onLog: (l) => log.push(l) }).catch((x) => x);
  expect(e).toBeInstanceOf(ToolError);
  expect(e.kind).toBe("A");
  expect(e.message).toContain("안 바뀜");
});

test("긴 계산 대기: 무변화는 실패가 아니라 현재 화면 글자를 로그에 남기고, 전체 상한에서 NA(A) 로 끝난다", async () => {
  const log: string[] = [];
  const t0 = Date.now();
  const e = await waitEndState(never, { endStates: states, idleMs: 100, timeout: 450 }, { pollMs: 20, longWait: true, onLog: (l) => log.push(l) }).catch((x) => x);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(430);
  expect(e).toBeInstanceOf(ToolError);
  expect(e.message).toContain("상한 안에");
  expect(e.message).not.toContain("안 바뀜");
  const idleLogs = log.filter((l) => l.includes("안 바뀜(긴 계산 대기"));
  expect(idleLogs.length).toBeGreaterThanOrEqual(2);
  expect(idleLogs[0]).toContain("현재 화면: 같은 화면");
});

test("긴 계산 대기: 상한 안에 끝 상태가 오면 통과한다(무변화 구간이 있었어도)", async () => {
  const t0 = Date.now();
  const page = { ...never, count: async () => (Date.now() - t0 > 300 ? 1 : 0), isVisible: async () => Date.now() - t0 > 300 };
  const r = await waitEndState(page, { endStates: states, idleMs: 100, timeout: 3000 }, { pollMs: 20, longWait: true });
  expect(r.state).toBe("완료");
});

test("케이스의 maxWaitSec 이 끝 상태 대기의 전체 상한이 되고 무변화로는 끝나지 않는다", async () => {
  const log: string[] = [];
  const ctx = fakeCtx({ count: async () => 0, isVisible: async () => false, evaluate: async () => "같은 화면" as any }, log);
  const c: Case = { id: "L-1", title: "L-1", type: "spec", source_ref: "기획서 1", screen: "/t", feature: "계산", maxWaitSec: 1, steps: [{ op: "goto", url: "/t" }, { op: "wait", endStates: { 완료: "#done", 오류: "#err" } }] };
  const t0 = Date.now();
  const r = await runCase(ctx, c);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
  expect(r.status).toBe("NA");
  expect(r.toolError?.kind).toBe("A");
  expect(r.reason).toContain("1초 상한");
});

test("maxWaitSec 등록: 숫자가 아니면 거부하고, 끝 상태 없이 sel 만 쓰는 대기는 거부한다", () => {
  const ctx = fakeCtx({});
  const mk = (id: string, over: Partial<Case>, steps: Case["steps"]) => ({ id, title: id, type: "spec" as const, source_ref: "x", steps, ...over });
  const out = aCaseUpsert({ project: ctx.project.root, cases: [
    mk("M-1", { maxWaitSec: -5 as any }, [{ op: "goto", url: "/" }, { op: "wait", endStates: { a: "#a", b: "#b" } }, { op: "expect", sel: "#a", text: "x", basis: "POL" }]),
    mk("M-2", { maxWaitSec: 720 }, [{ op: "goto", url: "/" }, { op: "wait", sel: "#done" }, { op: "expect", sel: "#a", text: "x", basis: "POL" }]),
    mk("M-3", { maxWaitSec: 720 }, [{ op: "goto", url: "/" }, { op: "wait", endStates: { 완료: "#done", 확인필요: "#review", 오류: "#err" } }, { op: "expect", sel: "#done", text: "x", basis: "POL" }]),
  ] });
  expect(out.errors.length).toBe(2);
  expect(out.errors[1]).toContain("끝 상태를 모두 명시");
  expect(out.added).toBe(1);
});

// ---- 오류 L: 무변화 종료 규칙이 너무 짧음(진행 신호가 보이는데 끝냄) ----
const busyPage = (text: string) => ({ ...never, evaluate: async (s: string) => (s.includes("aria-busy") ? (text ? "progress:" + text : "") : "같은 화면") as any });

test("진행 신호(「처리 중」 글자)가 보이면 무변화여도 끝내지 않고, 상한까지 남아 있으면 NA(L) 로 둔다", async () => {
  const log: string[] = [];
  const t0 = Date.now();
  const e = await waitEndState(busyPage("비식별 처리 중 (3/17)"), { endStates: states, idleMs: 100, timeout: 450 }, { pollMs: 20, onLog: (l) => log.push(l) }).catch((x) => x);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(430); // 100ms 무변화로 끝나지 않았다
  expect(e).toBeInstanceOf(ToolError);
  expect(e.kind).toBe("L");
  expect(e.message).toContain("진행 신호 「비식별 처리 중 (3/17)」");
  expect(e.message).toContain("maxWaitSec");
  expect(log.some((l) => l.includes("진행 신호") && l.includes("계속 기다림"))).toBe(true);
});

test("진행 신호가 보이다가 끝 상태가 오면 통과한다", async () => {
  const t0 = Date.now();
  const page = { ...busyPage("처리 중"), count: async () => (Date.now() - t0 > 300 ? 1 : 0), isVisible: async () => Date.now() - t0 > 300 };
  const r = await waitEndState(page, { endStates: states, idleMs: 80, timeout: 3000 }, { pollMs: 20 });
  expect(r.state).toBe("완료");
});

test("적은 진행 신호 선택자(wait.progress)가 보이는 동안 끝내지 않는다. progress:false 면 알아서 찾지 않아 무변화로 NA(A)", async () => {
  const page = { ...never, count: async (s: string) => (s === "#busy" ? 1 : 0), isVisible: async (s: string) => s === "#busy" };
  const e = await waitEndState(page, { endStates: states, idleMs: 80, timeout: 400, progress: "#busy" }, { pollMs: 20 }).catch((x) => x);
  expect(e.kind).toBe("L");
  expect(e.message).toContain("「#busy」");
  const off = await waitEndState(busyPage("처리 중"), { endStates: states, idleMs: 80, timeout: 3000, progress: false }, { pollMs: 20 }).catch((x) => x);
  expect(off.kind).toBe("A");
  expect(off.message).toContain("안 바뀜");
});

test("진행 신호가 없으면 예전처럼 무변화 idleMs 에서 NA(A) 로 끝난다", async () => {
  const e = await waitEndState(busyPage(""), { endStates: states, idleMs: 100, timeout: 5000 }, { pollMs: 20 }).catch((x) => x);
  expect(e.kind).toBe("A");
});

test("케이스에 무변화 시간(idleMs)을 짧게 적었어도 진행 신호가 있으면 케이스 상한(maxWaitSec)까지 기다리고, 넘으면 NA(L) 이며 이슈가 아니다", async () => {
  const ctx = fakeCtx({ count: async () => 0, isVisible: async () => false, evaluate: async (s: string) => (s.includes("aria-busy") ? "progress:처리 중" : "같은 화면") as any });
  const c: Case = { id: "L-P", title: "L-P", type: "spec", source_ref: "기획서 1", screen: "/t", feature: "비식별", maxWaitSec: 1, steps: [{ op: "goto", url: "/t" }, { op: "wait", idleMs: 150, endStates: { 완료: "#done", 오류: "#err" } }] };
  const t0 = Date.now();
  const r = await runCase(ctx, c);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
  expect(r.status).toBe("NA");
  expect(r.toolError?.kind).toBe("L");
  expect(r.reason).toContain("1초 상한까지 진행 신호");
});

test("wait.progress 등록: 글자·글자 배열·false 만 받는다", () => {
  const ctx = fakeCtx({});
  const mk = (id: string, progress: any) => ({ id, title: id, type: "spec" as const, source_ref: "x", steps: [{ op: "goto", url: "/" }, { op: "wait", endStates: { 완료: "#d", 오류: "#e" }, progress }, { op: "expect", sel: "#d", text: "x", basis: "POL" }] });
  const out = aCaseUpsert({ project: ctx.project.root, cases: [mk("P-1", "text=처리 중"), mk("P-2", ["#a", "#b"]), mk("P-3", false), mk("P-4", 3), mk("P-5", [""]), mk("P-6", true)] });
  expect(out.errors.length).toBe(3);
  expect(out.added).toBe(3);
});

test("실제 브라우저: 「처리 중」 글자·진행 막대는 진행 신호로 찾고, 진행 신호가 없는 화면은 무변화로 NA(A)", async () => {
  const { chromium } = await import("playwright");
  const b = await chromium.launch({ headless: true });
  try {
    const pg = await (await b.newContext()).newPage();
    const dp: any = { ...basePage(), count: (s: string) => pg.locator(s).count(), isVisible: (s: string) => pg.locator(s).first().isVisible(), evaluate: (s: string) => pg.evaluate(s) };
    const run = (html: string) => pg.setContent(html).then(() => waitEndState(dp, { endStates: states, idleMs: 150, timeout: 700 }, { pollMs: 30 }).catch((x) => x));
    const text = await run("<p>결과</p><div>비식별 처리 중 (3/17)</div>");
    expect(text.kind).toBe("L");
    expect(text.message).toContain("비식별 처리 중 (3/17)");
    const bar = await run('<div role="progressbar" aria-label="업로드 진행" style="width:100px;height:8px"></div>');
    expect(bar.kind).toBe("L");
    expect(bar.message).toContain("업로드 진행");
    const hidden = await run('<div role="progressbar" style="display:none">x</div><p>결과 없음</p>');
    expect(hidden.kind).toBe("A");
  } finally {
    await b.close();
  }
}, 30000);
