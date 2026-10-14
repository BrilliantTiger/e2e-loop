// Ego 종단 시험: Ego 가 설치돼 있고 앱이 켜져 있을 때만 돈다. 이동·클릭·입력·API·업로드·다운로드를 Ego 로 실제 실행한다.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "../src/actions.ts";
import { Project } from "../src/store.ts";
import type { Case } from "../src/types.ts";

const ego = Bun.which("ego-browser");
const port = 4593;
const base = `http://127.0.0.1:${port}`;
const root = mkdtempSync(join(tmpdir(), "e2e-loop-ego-"));
let server: ReturnType<typeof Bun.spawn>;
let p: Project;
let usable = false;

const spec = (id: string, steps: Case["steps"]): Case => ({ id, title: id, type: "spec", source_ref: "시험", screen: "/", feature: "Ego", steps });

beforeAll(async () => {
  if (!ego) return;
  const probe = Bun.spawn([ego, "nodejs", "-e", "console.log('ok')"], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => probe.kill(), 20000);
  const out = (await new Response(probe.stdout).text()) + (await new Response(probe.stderr).text());
  clearTimeout(timer);
  usable = out.includes("ok");
  if (!usable) return;
  writeFileSync(join(root, "bugs.json"), "{}");
  writeFileSync(join(root, "PLAN.md"), "# 기획서\n");
  server = Bun.spawn(["bun", join(import.meta.dir, "../examples/demo-site/server.ts"), root, String(port)], { stdout: "ignore", stderr: "inherit" });
  await Bun.sleep(800);
  p = new Project(root);
  p.ensure();
  p.saveConfig({ ...p.config(), baseUrl: base, driver: "ego", headless: false, dashboardPort: 7794 });
  A.aPrestart({ project: root, dataPolicy: "keep", maxRounds: 10, login: "none", account: { mode: "none" }, acknowledged: true });
  A.aSourceAdd({ project: root, kind: "plan", title: "기획서", location: join(root, "PLAN.md") });
  A.aCaseUpsert({
    project: root,
    cases: [
      spec("EG-NAV", [{ op: "goto", url: "/" }, { op: "expect", sel: "h1", text: "대시보드" }, { op: "expect", titleContains: "홈" }]),
      spec("EG-CLICK", [{ op: "goto", url: "/" }, { op: "click", sel: "#stats" }, { op: "expect", sel: "#stat-out", textContains: "항목" }]),
      spec("EG-FORM", [{ op: "goto", url: "/" }, { op: "fill", sel: "input[name=email]", value: "e2e+ego@example.com" }, { op: "click", sel: 'button:text-is("가입하기")' }, { op: "expect", sel: "#msg", text: "가입 완료" }]),
      spec("EG-API", [{ op: "goto", url: "/" }, { op: "api", via: "page", method: "GET", url: "/api/stats", status: "2xx", jsonHas: ["count"] }]),
      spec("EG-UPLOAD", [{ op: "goto", url: "/upload" }, { op: "probe", kind: "upload", sel: "#file", attrs: { accept: ".csv" } }]),
      spec("EG-DOWNLOAD", [{ op: "goto", url: "/" }, { op: "probe", kind: "download", sel: 'a[download]', label: "보고서 내려받기" }]),
    ],
  });
}, 60000);
afterAll(() => server?.kill());

test.skipIf(!ego)("Ego 로 케이스를 실제로 실행한다: 이동·클릭·입력·API·업로드·다운로드", async () => {
  if (!usable) {
    console.log("Ego 앱이 응답하지 않아 건너뜀(ego lite 앱을 켜고 온보딩을 마쳐야 함)");
    return;
  }
  const start: any = await A.aRoundStart({ project: root, data: "keep", only: p.cases().map((c) => c.id) });
  expect(start.started).toBe(true);
  expect(start.driver).toBe("ego-browser");
  let st: any;
  do st = await A.aRoundStatus({ project: root, wait_seconds: 30 });
  while (st.running);
  const results = p.readJson<any[]>(`rounds/${start.round}/results.json`, []);
  expect(results.map((r) => `${r.id}:${r.status}${r.status === "PASS" ? "" : " " + r.reason}`)).toEqual(results.map((r) => `${r.id}:PASS`));
  const rdir = p.roundDir(start.round);
  // 증거: 스크린샷은 항상 남고(도장), 영상은 Ego 창을 찾았을 때만 — 못 찾으면 이유가 경고로 남는다
  const man = JSON.parse(readFileSync(join(rdir, "evidence.json"), "utf8"));
  expect(man.files.filter((f: any) => f.kind === "screenshot").length).toBeGreaterThan(0);
  const noVideo = results.filter((r) => !r.video);
  for (const r of noVideo) expect(r.warnings.join(" ")).toContain("Ego 창 녹화");
  for (const r of results.filter((r) => r.video)) expect(existsSync(join(rdir, r.video))).toBe(true);
}, 300000);
