// 오류 O: 창이 가려진 채 잰 멈춤 측정은 무효 — 측정만 NA(O)로 올리고, 창을 보이게 한 뒤 다시 재며, 기능 판정은 따로 남긴다.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeFreeze, freezeSummary, type FreezeRaw } from "../src/freeze.ts";
import { runCase } from "../src/runner.ts";
import { excludedRows, measureInvalidCount, toolErrorCount } from "../src/toolerror.ts";
import { Project } from "../src/store.ts";
import { fakeCtx } from "./helpers/fake.ts";
import type { Case } from "../src/types.ts";

const raw = (over: Partial<FreezeRaw>): FreezeRaw => ({ ms: 3000, lt: [], ev: [], gaps: [], tgaps: [], first: 20, hidden: false, blur: false, ...over });

test("측정 판정: 멈춤 없음 · Long Task 로 설명되는 1초 넘는 멈춤(freeze) · 가려진 창 서명(invalid)을 가린다", () => {
  expect(judgeFreeze(raw({ gaps: [[0, 120]] })).verdict).toBe("ok");
  // 진짜 멈춤: 1.3초 Long Task 가 그 간격을 덮는다
  const real = judgeFreeze(raw({ lt: [[100, 1300]], gaps: [[90, 1320]], ev: [[95, 1310, 5]] }));
  expect(real.verdict).toBe("freeze");
  expect(real.why).toContain("1초 넘게 멈춤");
  // 창이 가려짐
  expect(judgeFreeze(raw({ hidden: true, gaps: [[0, 1008]] })).verdict).toBe("invalid");
  // Long Task 없이 1000ms 근처 간격이 몰림 — 가려진 창에서 브라우저가 늦춘 서명(Round 9 R9-D-04 의 모양)
  const sig = judgeFreeze(raw({ lt: [[10, 197], [400, 120]], gaps: [[1000, 1083], [2100, 1008]] }));
  expect(sig.verdict).toBe("invalid");
  expect(sig.why).toContain("1000ms 근처에 몰림");
  // 포커스를 잃은 채 Long Task 없이 1초 넘는 간격 하나
  expect(judgeFreeze(raw({ blur: true, tgaps: [[0, 1050]] })).verdict).toBe("invalid");
  // 포커스는 있고 설명 안 되는 간격 하나뿐이면 멈춤으로 본다(서명이 아님)
  expect(judgeFreeze(raw({ gaps: [[0, 1050]] })).verdict).toBe("freeze");
  expect(freezeSummary(raw({ lt: [[0, 197], [300, 308]], ev: [[0, 1008, 1007]], gaps: [[0, 1083]], first: 54 }))).toBe("Long Task 2건 합 505ms 최대 308ms · 클릭→첫 변화 54ms · 이벤트 처리 최대 1008ms(입력 지연 1007ms) · 프레임 간격 최대 1083ms");
});

const mk = (id: string, steps: Case["steps"]): Case => ({ id, title: id, type: "spec", source_ref: "기획서 1", screen: "/visit", feature: "Visit key", chapter: "C22", steps });

test("가려진 창: 측정만 NA(O), 창을 앞으로 가져와 화면 열기는 그 자리에서 다시 재고, 누름은 다음 라운드 재측정. 기능 판정은 PASS 그대로", async () => {
  const log: string[] = [];
  let reads = 0;
  let front = 0;
  let gotos = 0;
  const hidden = raw({ hidden: true, gaps: [[0, 1008]] });
  const ctx = fakeCtx({
    goto: async () => void gotos++,
    front: async () => void front++,
    evaluate: async (expr: string): Promise<any> => {
      if (expr.includes("const gaps = z.gaps.slice()")) return [hidden, raw({}), hidden][reads++] ?? raw({});
      if (expr.includes("v: document.visibilityState")) return { v: front > 0, f: front > 0 };
      return true;
    },
  }, log);
  const r = await runCase(ctx, mk("O-1", [{ op: "goto", url: "/visit" }, { op: "click", sel: "#open" }, { op: "expect", sel: "#out", text: "", basis: "POL-1" }]));
  expect(r.status).toBe("PASS"); // 기능 판정은 측정과 따로
  expect(front).toBeGreaterThanOrEqual(1);
  expect(gotos).toBe(2); // 화면 열기를 창이 보인 뒤 한 번 더
  expect(r.steps[0]!.measure).toMatchObject({ verdict: "ok" });
  expect(r.steps[0]!.measure!.remeasured).toContain("멈춤 없음");
  expect(r.steps[1]!.measure?.verdict).toBe("invalid");
  expect(r.steps[1]!.measure?.why).toContain("다음 라운드에 재측정");
  expect(log.some((l) => l.includes('"type":"measure-invalid"'))).toBe(true);
  expect(measureInvalidCount([r])).toBe(1);
  expect(toolErrorCount([r])).toBe(0); // 케이스가 NA 가 된 것은 아니다
  const rows = excludedRows([r], () => "-", { round: "R09", stepInfo: (_r, s) => ({ chapter: "C22", screen: "/visit", element: s.i === 1 ? "#open" : "/visit", verb: s.i === 1 ? "클릭" : "이동" }) });
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ no: "R09-X-01", kind: "O", element: "#open", verb: "클릭" });
  expect(rows[0]!.reason).toContain("측정 무효(창 가림");
  expect(rows[0]!.note).toContain("기능 판정은 PASS");
  expect(rows[0]!.action).toContain("창이 보이게 된 뒤 재측정");
});

test("창을 앞으로 가져오지 못하면 재측정하지 않고 그 까닭을 남긴다. 측정을 끄면(freeze.mode=off) 재지 않는다", async () => {
  const ctx = fakeCtx({ evaluate: async (expr: string): Promise<any> => (expr.includes("const gaps = z.gaps.slice()") ? raw({ hidden: true }) : expr.includes("v: document.visibilityState") ? { v: false, f: false } : true) });
  const r = await runCase(ctx, mk("O-2", [{ op: "goto", url: "/visit" }, { op: "expect", sel: "#out", text: "", basis: "POL-1" }]));
  expect(r.steps[0]!.measure?.verdict).toBe("invalid");
  expect(r.steps[0]!.measure?.why).toContain("앞으로 가져오지 못해");
  const off = fakeCtx({ evaluate: async (): Promise<any> => raw({ hidden: true }) });
  off.cfg.freeze = { mode: "off" };
  const r2 = await runCase(off, mk("O-3", [{ op: "goto", url: "/visit" }, { op: "click", sel: "#open" }]));
  expect(r2.steps.every((s) => s.measure === undefined)).toBe(true);
}, 20000);

// ---- 실제 브라우저: 1.3초 붙잡는 단추는 멈춤, 바로 끝나는 단추는 멈춤 없음 ----
const port = 4596;
const root = mkdtempSync(join(tmpdir(), "e2e-loop-fz-"));
let server: ReturnType<typeof Bun.spawn>;
beforeAll(async () => {
  writeFileSync(join(root, "bugs.json"), "{}");
  server = Bun.spawn(["bun", join(import.meta.dir, "../examples/demo-site/server.ts"), root, String(port)], { stdout: "ignore", stderr: "inherit" });
  await Bun.sleep(800);
});
afterAll(() => server?.kill());

test("실제 브라우저: 화면을 1.3초 붙잡는 클릭은 「1초 넘게 멈춤」 경고(기능은 PASS), 바로 끝나는 클릭은 멈춤 없음", async () => {
  const p = new Project(root);
  p.ensure();
  const cfg = { ...p.config(), baseUrl: `http://127.0.0.1:${port}`, driver: "chromium" as const, headless: true };
  const { PwDriver } = await import("../src/drivers/playwright.ts");
  const driver = new PwDriver(cfg, "chromium");
  await driver.open();
  try {
    const ctx = { project: p, cfg, driver, roundId: "R01", decision: "keep" as const, emit: () => {} };
    const r = await runCase(ctx, mk("FZ-1", [
      { op: "goto", url: "/busy" },
      { op: "click", sel: "#slow" },
      { op: "expect", sel: "#out", text: "끝", basis: "POL-1" },
      { op: "click", sel: "#fast" },
      { op: "expect", sel: "#out", text: "바로 끝", basis: "POL-1" },
    ]));
    expect(r.status).toBe("PASS");
    const slow = r.steps[1]!.measure!;
    expect(slow.verdict).toBe("freeze");
    expect(slow.summary).toMatch(/Long Task 1건 합 1[23]\d\dms/);
    expect(r.warnings.some((w) => w.startsWith("측정: 화면이 1초 넘게 멈춤") && w.includes("기능 판정과 따로"))).toBe(true);
    expect(r.steps[3]!.measure?.verdict).toBe("ok");
    expect(r.steps[0]!.measure?.verdict).toBe("ok");
  } finally {
    await driver.close();
  }
}, 60000);

// ---- 오류 U: 화면 열기의 멈춤이 다시 열면 재현되지 않음(첫 로드 비용·동시 부하) ----
test("U: 화면 열기에서 멈춤이 잡히면 한 번 더 열어 재고, 안 멈추면 「멈춤 미재현」(U)으로 판정에서 빼며 경고도 남기지 않는다", async () => {
  let reads = 0;
  let gotos = 0;
  const frozen = raw({ lt: [[100, 2009]], gaps: [[90, 1566]] });
  const ctx = fakeCtx({ goto: async () => void gotos++, evaluate: async (expr: string): Promise<any> => (expr.includes("const gaps = z.gaps.slice()") ? [frozen, raw({})][reads++] ?? raw({}) : true) });
  const r = await runCase(ctx, mk("U-1", [{ op: "goto", url: "/history" }, { op: "expect", sel: "#out", text: "", basis: "POL-1" }]));
  expect(r.status).toBe("PASS");
  expect(gotos).toBe(2);
  expect(r.steps[0]!.measure).toMatchObject({ verdict: "unconfirmed" });
  expect(r.steps[0]!.measure!.why).toContain("미재현");
  expect(r.warnings.some((w) => w.startsWith("측정"))).toBe(false);
  const rows = excludedRows([r], () => "-", { round: "R09", stepInfo: () => ({ chapter: "C44", screen: "/history", element: "/history", verb: "이동" }) });
  expect(rows.map((x) => x.kind)).toEqual(["U"]);
  expect(rows[0]!.note).toContain("제품 결함 아님(미재현)");
  expect(measureInvalidCount([r])).toBe(0);
});

test("U: 다시 열어도 멈추면 재현된 멈춤(경고), 누르는 동작의 멈춤은 다시 누르지 않고 멈춤으로 둔다", async () => {
  const frozen = raw({ lt: [[100, 2009]], gaps: [[90, 1566]] });
  let gotos = 0;
  const ctx = fakeCtx({ goto: async () => void gotos++, evaluate: async (expr: string): Promise<any> => (expr.includes("const gaps = z.gaps.slice()") ? frozen : true) });
  const r = await runCase(ctx, mk("U-2", [{ op: "goto", url: "/history" }, { op: "click", sel: "#open" }, { op: "expect", sel: "#out", text: "", basis: "POL-1" }]));
  expect(gotos).toBe(2); // 화면 열기만 다시 열었다
  expect(r.steps[0]!.measure).toMatchObject({ verdict: "freeze" });
  expect(r.steps[0]!.measure!.why).toContain("재현됨");
  expect(r.steps[1]!.measure).toMatchObject({ verdict: "freeze" });
  expect(r.steps[1]!.measure!.why).toContain("재현은 확인하지 않음");
  expect(r.warnings.filter((w) => w.startsWith("측정")).length).toBe(2);
});

test("실제 브라우저 U: 처음 열 때만 멈추는 화면은 미재현(U), 열 때마다 멈추는 화면은 재현된 멈춤", async () => {
  const p = new Project(root);
  p.ensure();
  const cfg = { ...p.config(), baseUrl: `http://127.0.0.1:${port}`, driver: "chromium" as const, headless: true };
  const { PwDriver } = await import("../src/drivers/playwright.ts");
  const driver = new PwDriver(cfg, "chromium");
  await driver.open();
  try {
    const ctx = { project: p, cfg, driver, roundId: "R01", decision: "keep" as const, emit: () => {} };
    const first = await runCase(ctx, mk("UF-1", [{ op: "goto", url: "/firstload" }, { op: "wait", ms: 2000 }, { op: "expect", sel: "h1", text: "로드", basis: "POL-1" }]));
    expect(first.status).toBe("PASS");
    expect(first.steps[0]!.measure?.verdict).toBe("unconfirmed");
    const slow = await runCase(ctx, mk("UF-2", [{ op: "goto", url: "/slowload" }, { op: "wait", ms: 2000 }, { op: "expect", sel: "h1", text: "로드", basis: "POL-1" }]));
    expect(slow.steps[0]!.measure?.verdict).toBe("freeze");
    expect(slow.steps[0]!.measure?.why).toContain("재현됨");
  } finally {
    await driver.close();
  }
}, 60000);
