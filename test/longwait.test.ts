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
  const ctx = fakeCtx({ count: async () => 0, isVisible: async () => false, evaluate: async () => "계산 중" as any }, log);
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
