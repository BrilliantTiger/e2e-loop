// 1단계(환경 점검·설치) 시험. 실제 설정 파일을 건드리지 않도록 가짜 명령(stub)으로 확인한다.
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../src/env/install.ts";
import { registerE2eLoop, serverCommand } from "../src/env/clients.ts";
import { runChecks } from "../src/env/detect.ts";

const stub = (dir: string, name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
const sandbox = () => mkdtempSync(join(tmpdir(), "e2e-loop-env-"));
const envWith = (dir: string) => ({ ...process.env, PATH: `${dir}:/usr/bin:/bin` });

test("ffmpeg 가 없으면 사용자에게 물어야 하는 항목(ask)으로 나온다", async () => {
  const dir = sandbox();
  stub(dir, "brew", "exit 0");
  const checks = await runChecks(envWith(dir));
  const ff = checks.find((c) => c.id === "ffmpeg")!;
  expect(ff.status).toBe("missing");
  if (process.platform === "darwin") {
    expect(ff.fix).toBe("ask");
    expect(ff.command).toEqual([join(dir, "brew"), "install", "ffmpeg"]);
  }
});

test("승인(confirm) 없이는 ffmpeg 를 설치하지 않고, 승인하면 설치 명령을 실행 목록에 넣는다", async () => {
  const dir = sandbox();
  stub(dir, "brew", "exit 0");
  const env = envWith(dir);
  const noConfirm = await doctor({ fix: true, dryRun: true, env });
  expect(noConfirm.actions.find((a) => a.id === "ffmpeg")).toBeUndefined();
  if (process.platform === "darwin") {
    expect(noConfirm.needs_confirmation.map((n) => n.id)).toContain("ffmpeg");
    const confirmed = await doctor({ confirm: ["ffmpeg"], dryRun: true, env });
    const act = confirmed.actions.find((a) => a.id === "ffmpeg")!;
    expect(act.status).toBe("planned");
    expect(act.command.slice(-2)).toEqual(["install", "ffmpeg"]);
    expect(confirmed.needs_confirmation.map((n) => n.id)).not.toContain("ffmpeg");
  }
});

test("ego-browser 는 MCP 가 아니라 안내 항목(manual)이며, 없어도 다른 브라우저로 ok", async () => {
  const dir = sandbox();
  const r = await doctor({ env: envWith(dir) });
  const ego = r.checks.find((c) => c.id === "ego")!;
  expect(["ok", "warn", "na"]).toContain(ego.status);
  expect(ego.manual).toContain("MCP 서버가 아니라");
  expect(r.driver_choices.map((d) => d.value)).toEqual(["ego", "chrome", "edge", "chromium"]);
});

test("감지된 모든 클라이언트에 e2e-loop 를 등록하고, 두 번째는 이미 있음으로 건너뛴다", async () => {
  const dir = sandbox();
  const log = join(dir, "calls.log");
  const state = (n: string) => join(dir, `${n}.registered`);
  for (const name of ["claude", "codex"]) {
    stub(
      dir,
      name,
      `echo "${name} $@" >> "${log}"
case "$1 $2" in
  "mcp get") [ -f "${state(name)}" ] && exit 0 || exit 1 ;;
  "mcp list") echo "computer-use: ok"; exit 0 ;;
  "mcp add") touch "${state(name)}"; exit 0 ;;
esac
exit 0`,
    );
  }
  const env = envWith(dir);
  const first = await registerE2eLoop({ env });
  expect(first.map((r) => `${r.client}:${r.action}`)).toEqual(["claude:added", "codex:added"]);
  const calls = readFileSync(log, "utf8");
  const [bun, mcp] = serverCommand();
  expect(calls).toContain(`claude mcp add e2e-loop -s user -- ${bun} ${mcp}`);
  expect(calls).toContain(`codex mcp add e2e-loop -- ${bun} ${mcp}`);
  expect(existsSync(mcp)).toBe(true);
  const second = await registerE2eLoop({ env });
  expect(second.map((r) => `${r.client}:${r.action}`)).toEqual(["claude:already", "codex:already"]);
});

test("클라이언트가 없으면 건너뛰고, dry-run 은 아무것도 등록하지 않는다", async () => {
  const dir = sandbox();
  const none = await registerE2eLoop({ env: envWith(dir) });
  expect(none.every((r) => r.action === "skipped")).toBe(true);
  stub(dir, "claude", `case "$1 $2" in "mcp get") exit 1;; esac; exit 0`);
  const planned = await registerE2eLoop({ env: envWith(dir), dryRun: true });
  expect(planned.find((r) => r.client === "claude")!.action).toBe("planned");
});
