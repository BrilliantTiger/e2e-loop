// 3단계 종단 시험(Chromium): 코드 분석 + 사이트 탐색 대조, API·다운로드·업로드 이벤트가 케이스로 생기고 실제로 도는지.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "../src/actions.ts";
import { Project } from "../src/store.ts";
import { applyOsPolicy } from "../src/analysis/os.ts";

const DEMO_SRC = join(import.meta.dir, "../examples/demo-site/src");
const port = 4571;
const root = mkdtempSync(join(tmpdir(), "e2e-loop-s3-"));
const bugs = (b: Record<string, boolean>) => writeFileSync(join(root, "bugs.json"), JSON.stringify(b));
let server: ReturnType<typeof Bun.spawn>;
let p: Project;

beforeAll(async () => {
  bugs({});
  mkdirSync(root, { recursive: true });
  server = Bun.spawn(["bun", join(import.meta.dir, "../examples/demo-site/server.ts"), root, String(port)], { stdout: "ignore", stderr: "inherit" });
  await Bun.sleep(800);
  p = new Project(root);
  p.ensure();
  A.aPrestart({ project: root, dataPolicy: "keep", maxRounds: 10, login: "none", account: { mode: "none" }, acknowledged: true });
  p.saveConfig({ ...p.config(), baseUrl: `http://127.0.0.1:${port}`, driver: "chromium", headless: true, dashboardPort: 7791 });
});
afterAll(() => server?.kill());

const runPartial = async (only: string[]) => {
  const start: any = await A.aRoundStart({ project: root, data: "keep", headless: true, only });
  expect(start.started).toBe(true);
  let st: any;
  do st = await A.aRoundStatus({ project: root, wait_seconds: 30 });
  while (st.running);
  return p.readJson<any[]>(`rounds/${start.round}/results.json`, []);
};

test("웹 주소 + 코드를 근거로 받고, 사이트를 탐색하면 다운로드·업로드·API 이벤트가 케이스로 생긴다", async () => {
  const it: any = await A.aIntake({ project: root, baseUrl: `http://127.0.0.1:${port}`, materials: [{ kind: "code", location: DEMO_SRC }] });
  expect(it.can_start).toBe(true);

  const d: any = await A.aDiscover({ project: root });
  expect(d.events.downloads).toBe(1); // 보고서 내려받기 링크(download 속성)
  expect(d.events.uploads).toBe(1);
  expect(d.events.apis_observed.join(" ")).toContain("GET /api/items → 200");
  const cs = p.cases();
  const ev = (e: string) => cs.filter((c) => c.event === e);
  expect(ev("download").map((c) => c.title).join("|")).toContain("다운로드 링크 “보고서 내려받기”");
  expect(ev("download").some((c) => c.steps.some((s) => s.soft))).toBe(true); // “내보내기” 버튼은 추정이라 약하게 점검
  expect(ev("upload").length).toBe(1);
  expect(ev("api").some((c) => c.title.includes("GET /api/items"))).toBe(true);
  expect(cs.every((c) => c.screen && c.feature)).toBe(true); // 모든 케이스가 화면·기능 단위를 가진다
}, 120000);

test("코드 분석을 사이트 탐색과 대조해 링크로 안 닿는 화면·화면에 없는 이벤트·관측 안 된 API 를 찾는다", async () => {
  const r: any = await A.aAnalyze({ project: root });
  expect(r.code[0].frameworks).toEqual(["react-router"]);
  expect(r.totals.routes).toBe(7);
  expect(r.rediscovered).toBe(true); // 못 닿은 /admin/audit 를 직접 열어 보려고 다시 탐색
  expect(r.cross_check.code_only.join(" ")).toContain("/admin/audit");
  expect(r.cross_check.dynamic).toEqual(["/items/:id"]);
  expect(r.cross_check.unreached).toEqual([]);
  expect(r.cross_check.events_not_on_screen.join(" ")).toContain("beta-banner-close");
  expect(r.cross_check.apis_not_observed.join(" ")).toContain("GET /api/health");
  const cs = p.cases();
  expect(cs.some((c) => c.id.startsWith("PG-") && c.title.includes("/admin/audit"))).toBe(true);
  expect(cs.some((c) => c.id.startsWith("A-") && c.title.includes("/api/audit"))).toBe(true); // 직접 연 화면에서 관측
  expect(cs.some((c) => c.id.startsWith("CA-") && c.title.includes("/api/health"))).toBe(true);
}, 180000);

test("시트: 화면 → 기능 단위 → 케이스, 빈틈 요약", () => {
  const s: any = A.aSheet({ project: root });
  expect(s.ready_to_start).toBe(true);
  expect(existsSync(s.paths.markdown)).toBe(true);
  const sheet = JSON.parse(readFileSync(s.paths.json, "utf8"));
  expect(sheet.totals.screens).toBeGreaterThanOrEqual(6);
  expect(sheet.screens.find((x: any) => x.screen === "/upload").features.map((f: any) => f.feature)).toContain("파일 다운로드·업로드");
  expect(s.summary).toContain("빈틈과 주의");
  expect(s.summary).toContain("/items/:id");
  expect(s.summary).toContain("beta-banner-close");
});

test("Chrome 계열 라운드: 다운로드·업로드·API·직접 연 화면 케이스가 실제로 통과하고, API 요청·응답이 기록에 남는다", async () => {
  const ids = p.cases().filter((c) => ["download", "upload", "api", "page"].includes(c.event ?? "")).map((c) => c.id);
  const results = await runPartial(ids);
  const bad = results.filter((r) => r.status !== "PASS");
  expect(bad.map((r) => `${r.id} ${r.status} ${r.reason}`)).toEqual([]);
  const dl = results.find((r) => r.title.includes("다운로드 링크"))!;
  expect(dl.steps.at(-1).desc).toContain("report.csv");
  const apiRes = results.find((r) => r.id.startsWith("A-") && r.title.includes("/api/items"))!;
  const apiStep = apiRes.steps.find((s: any) => s.op === "api");
  expect(apiStep.api).toMatchObject({ method: "GET", status: 200, via: "page" });
  expect(apiStep.api.responseBody).toContain("샘플 항목");
}, 240000);

test("다운로드한 파일이 비어 있으면 실패하고, 이유가 적힌다", async () => {
  bugs({ downloadEmpty: true });
  const id = p.cases().find((c) => c.event === "download" && c.title.includes("다운로드 링크"))!.id;
  const results = await runPartial([id]);
  bugs({});
  expect(results[0].status).toBe("FAIL");
  expect(results[0].reason).toContain("비어 있음");
}, 120000);

test("OS 창을 스킵하기로 하면 해당 케이스는 SKIP 으로 기록된다(이슈 아님)", async () => {
  const target = p.cases().find((c) => c.event === "upload")!;
  p.saveCases(p.cases().map((c) => (c.id === target.id ? { ...c, tags: ["os-window"] } : c)));
  p.writeJson("os-policy.json", { decision: "skip", decidedAt: "", by: "user" });
  expect(applyOsPolicy(p).skipped).toBe(1);
  const ids = [target.id];
  const results = await runPartial(ids);
  expect(results.every((r) => r.status === "SKIP")).toBe(true);
  expect(results[0].reason).toContain("[OS 창]");
  p.writeJson("os-policy.json", null);
  applyOsPolicy(p);
  expect(p.cases().some((c) => c.skipReason)).toBe(false);
}, 120000);
