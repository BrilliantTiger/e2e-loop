// 브라우저 없이 runCase 를 시험하는 가짜 드라이버. 필요한 메서드만 덮어쓴다.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DPage, Driver } from "../../src/drivers/index.ts";
import { Project } from "../../src/store.ts";
import type { RunCtx } from "../../src/runner.ts";

export const basePage = (): DPage => ({
  goto: async () => {},
  reload: async () => {},
  click: async () => {},
  dblclick: async () => {},
  hover: async () => {},
  fill: async () => {},
  selectOption: async () => {},
  check: async () => {},
  press: async () => {},
  waitFor: async () => {},
  count: async () => 1,
  isVisible: async () => true,
  text: async () => "",
  value: async () => "",
  evaluate: async () => undefined as any,
  url: async () => "http://fake/",
  title: async () => "fake",
  screenshot: async () => {},
  drain: async () => ({ console: [], pageErrors: [], failedRequests: [] }),
  drainNet: async () => [],
  upload: async () => {},
  download: async () => null,
});

export function fakeCtx(over: Partial<DPage>, log: string[] = []): RunCtx & { project: Project } {
  const project = new Project(mkdtempSync(join(tmpdir(), "e2e-loop-fake-")));
  project.ensure();
  const page: DPage = { ...basePage(), ...over };
  const driver: Driver = {
    name: "fake",
    capabilities: { video: true, network: false, files: false },
    open: async () => {},
    newSession: async () => ({ page, finish: async () => ({}) }),
    close: async () => {},
  };
  return { project, cfg: project.config(), driver, roundId: "R01", decision: "keep", emit: (ev) => log.push(JSON.stringify(ev)) };
}
