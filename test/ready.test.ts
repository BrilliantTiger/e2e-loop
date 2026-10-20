// 오류 M: 서버 비동기 계산이 아직 안 끝났는데 동작을 누름 — 준비 신호가 올 때까지 누르지 않고 기다리고, 상한 안에 안 오면 NA(M).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { runCase, waitReady } from "../src/runner.ts";
import { aCaseUpsert } from "../src/actions.ts";
import { excludedRows, toolErrorCount } from "../src/toolerror.ts";
import { fakeCtx } from "./helpers/fake.ts";
import type { Case, CaseResult } from "../src/types.ts";

const mk = (id: string, over: Partial<Case>): Case => ({ id, title: id, type: "spec", source_ref: "기획서 1", screen: "/time-key", feature: "결정", chapter: "C11U", steps: [{ op: "goto", url: "/time-key" }, { op: "click", sel: "#undecided" }, { op: "expect", sel: "#count", text: "4 / 7", basis: "POL-1" }], ...over });

test("화면 준비 신호: 「최신」이 뜰 때까지 누르지 않고 기다린 뒤 누른다", async () => {
  const log: string[] = [];
  const t0 = Date.now();
  const ready = () => Date.now() - t0 > 400;
  const ctx = fakeCtx({
    count: async (s: string) => (s === "#state" ? (ready() ? 1 : 0) : 1),
    isVisible: async (s: string) => (s === "#state" ? ready() : true),
    text: async (s: string) => (s === "#state" ? "최신" : "4 / 7"),
    click: async (s: string) => void log.push(`click ${s} at ${Date.now() - t0 >= 400 ? "after" : "before"}`),
  });
  const r = await runCase(ctx, mk("M-UI", { ready: { name: "후보 최신", sel: "#state", text: "최신", pollMs: 50 } }));
  expect(r.status).toBe("PASS");
  expect(log).toEqual(["click #undecided at after"]);
  expect(r.steps[1]!.desc).toContain("준비 신호 「후보 최신」 확인");
});

test("준비 신호가 상한 안에 안 오면 누르지 않고 FAIL 이 아니라 「선행 계산 미완료」 NA(M)", async () => {
  const log: string[] = [];
  const ctx = fakeCtx({ count: async () => 0, isVisible: async () => false, click: async (s: string) => void log.push(s) });
  const r = await runCase(ctx, mk("M-NO", { ready: { name: "후보 최신", sel: "#state", timeoutSec: 0.3, pollMs: 50 } }));
  expect(r.status).toBe("NA");
  expect(r.toolError?.kind).toBe("M");
  expect(r.reason).toContain("선행 계산 미완료");
  expect(r.reason).toContain("후보 최신");
  expect(log).toEqual([]);
  expect(toolErrorCount([r])).toBe(1);
});

// API 준비 신호: 서버 상태값이 up_to_date 가 될 때까지
let calls = 0;
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ timekey: { status: ++calls >= 3 ? "up_to_date" : "recounting" } }) });
});
afterAll(() => server.stop(true));

test("API 준비 신호: 서버 상태값이 up_to_date 가 될 때까지 되풀이해 묻고, 되면 넘어간다", async () => {
  calls = 0;
  const lines: string[] = [];
  const base = `http://127.0.0.1:${server.port}`;
  const ctx = fakeCtx({});
  const msg = await waitReady({} as any, { ...ctx.cfg, baseUrl: base } as any, { ready: { api: { url: "/api/timekey/state", json: { "timekey.status": "up_to_date" } }, pollMs: 30 } }, (l) => lines.push(l));
  expect(calls).toBeGreaterThanOrEqual(3);
  expect(msg).toContain('timekey.status');
  // 안 오면 지금 값을 담아 NA(M)
  calls = -100;
  const e = await waitReady({} as any, { ...ctx.cfg, baseUrl: base } as any, { ready: { api: { url: "/api/timekey/state", json: { "timekey.status": "up_to_date" } }, timeoutSec: 0.2, pollMs: 30 } }).catch((x) => x);
  expect(e.kind).toBe("M");
  expect(e.message).toContain('timekey.status="recounting"');
});

test("제외 시트: 같은 준비 신호를 기다리다 NA(M) 가 된 줄은 요소·동작이 달라도 한 원인으로 한 줄에 묶이고 횟수를 센다", () => {
  const m = (id: string, el: string): CaseResult => ({ id, title: id, type: "spec", status: "NA", toolError: { kind: "M", detail: "선행 계산 미완료: …", evidenceText: "후보 최신" }, warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: "", reason: el });
  const info = (r: CaseResult) => ({ chapter: "C11U", screen: "/time-key", element: r.reason!, verb: "클릭" });
  const rows = excludedRows([m("D-05", "결정 못 함"), m("D-06", "되돌리기"), m("D-07", "남은 Table 결정 못 함")], () => "현상", { round: "R08", info });
  expect(rows.length).toBe(1);
  expect([rows[0]!.no, rows[0]!.count, rows[0]!.kind]).toEqual(["R08-X-01", 3, "M"]);
  expect(rows[0]!.cases).toEqual(["D-05", "D-06", "D-07"]);
  expect(rows[0]!.reason).toContain("M 선행 계산 미완료");
});

test("준비 신호 등록: api 와 sel 중 하나, 상한은 양수만 받는다", () => {
  const ctx = fakeCtx({});
  const out = aCaseUpsert({ project: ctx.project.root, cases: [
    mk("R-1", { ready: { sel: "#state", text: "최신" } }),
    mk("R-2", { ready: [{ api: { url: "/api/s", json: { status: "up_to_date" } } }, { sel: "#ok" }] }),
    mk("R-3", { ready: { name: "없음" } as any }),
    mk("R-4", { ready: { sel: "#a", api: { url: "/x" } } as any }),
    mk("R-5", { ready: { sel: "#a", timeoutSec: -1 } }),
    mk("R-6", { ready: [] as any }),
  ] });
  expect(out.errors.length).toBe(4);
  expect(out.added).toBe(2);
});
