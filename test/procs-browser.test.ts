// 실제 Chromium 으로 확인: 이 도구가 띄운 브라우저에 표지가 달려 있고, 닫은 뒤 0개이며, 다른 프로세스에서는 남은 것으로 보인다.
import { expect, test } from "bun:test";
import { PwDriver } from "../src/drivers/playwright.ts";
import { cleanupOwn, ownBrowserProcs, staleBrowserProcs } from "../src/procs.ts";
import { Project } from "../src/store.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Playwright 브라우저에 표지가 달리고, 닫으면 0개이며, 다른 소유자 눈에는 남은 프로세스로 보인다", async () => {
  const p = new Project(mkdtempSync(join(tmpdir(), "e2e-loop-pb-")));
  const cfg = { ...p.config(), headless: true };
  const d = new PwDriver(cfg, "chromium");
  await d.open();
  try {
    const own = await ownBrowserProcs();
    expect(own.length).toBeGreaterThanOrEqual(1);
    expect(own.every((x) => x.owner === process.pid)).toBe(true);
    // 이 프로세스에게는 이전 라운드의 것이 아니다
    expect((await staleBrowserProcs()).filter((x) => own.some((o) => o.pid === x.pid))).toEqual([]);
    // 다른 프로세스(가짜 pid)가 점검하면 남은 것으로 보인다
    expect((await staleBrowserProcs(2147483000)).some((x) => own.some((o) => o.pid === x.pid))).toBe(true);
  } finally {
    await d.close();
  }
  const left = await cleanupOwn();
  expect(left.after).toEqual([]);
  expect(await ownBrowserProcs()).toEqual([]);
}, 60000);
