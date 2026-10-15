// 영상 프레임 상한(videoFps): 화면이 계속 바뀌는 페이지(/anim)를 녹화해 초당 프레임 수가 상한 안에서 실제로 나오는지 확인한다.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PwDriver } from "../src/drivers/playwright.ts";
import { EgoDriver } from "../src/drivers/ego.ts";
import { DEFAULT_CONFIG } from "../src/store.ts";
import { run } from "../src/env/detect.ts";
import type { Config } from "../src/types.ts";

const port = 4575;
let server: ReturnType<typeof Bun.spawn>;
const ego = Bun.which("ego-browser");
let egoUsable = false;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "e2e-loop-fps-"));
  writeFileSync(join(root, "bugs.json"), "{}");
  server = Bun.spawn(["bun", join(import.meta.dir, "../examples/demo-site/server.ts"), root, String(port)], { stdout: "ignore", stderr: "inherit" });
  await Bun.sleep(800);
  if (ego) {
    const p = Bun.spawn([ego, "nodejs", "-e", "console.log('ok')"], { stdout: "pipe", stderr: "pipe" });
    const t = setTimeout(() => p.kill(), 20000);
    egoUsable = ((await new Response(p.stdout).text()) + (await new Response(p.stderr).text())).includes("ok");
    clearTimeout(t);
  }
}, 60000);
afterAll(() => server?.kill());

/** 영상에서 1초 안에 가장 많이 들어간 프레임 수(최대 순간 fps)와 길이 */
async function peakFps(video: string) {
  const pk = await run(["ffprobe", "-v", "error", "-show_entries", "packet=pts_time", "-of", "csv=p=0", video]);
  const ts = pk.out.split("\n").map(Number).filter((x) => !isNaN(x));
  let best = 0;
  for (let i = 0; i < ts.length; i++) {
    let j = i;
    while (j < ts.length && ts[j]! - ts[i]! < 1) j++;
    best = Math.max(best, j - i);
  }
  return { best, frames: ts.length, last: ts.at(-1) ?? 0 };
}

const record = async (driver: PwDriver | EgoDriver) => {
  await driver.open();
  const dir = mkdtempSync(join(tmpdir(), "e2e-loop-fps-ev-"));
  const s = await driver.newSession(dir);
  await s.page.goto(`http://127.0.0.1:${port}/anim`);
  await Bun.sleep(2500);
  const r = await s.finish(true);
  await driver.close();
  expect(r.warn).toBeUndefined();
  return peakFps(r.video!);
};
const cfg = (videoFps: number): Config => ({ ...DEFAULT_CONFIG, baseUrl: `http://127.0.0.1:${port}`, headless: true, videoFps });

test("기본 상한은 60fps", () => {
  expect(DEFAULT_CONFIG.videoFps).toBe(60);
});

test("Chrome 계열: 상한 60 이면 초당 40~63 프레임, 상한 30 이면 33 이하 (Playwright 내장 녹화의 25fps 고정을 넘는다)", async () => {
  const a = await record(new PwDriver(cfg(60), "chromium"));
  expect(a.best).toBeGreaterThan(40);
  expect(a.best).toBeLessThanOrEqual(63);
  const b = await record(new PwDriver(cfg(30), "chromium"));
  expect(b.best).toBeGreaterThan(20);
  expect(b.best).toBeLessThanOrEqual(33);
}, 120000);

test.skipIf(!ego)("Ego: 상한 60 이면 초당 40~63 프레임(작업 공간 화면을 스크린캐스트로 받음)", async () => {
  if (!egoUsable) return;
  const a = await record(new EgoDriver(cfg(60), ego!));
  expect(a.best).toBeGreaterThan(40);
  expect(a.best).toBeLessThanOrEqual(63);
}, 120000);
