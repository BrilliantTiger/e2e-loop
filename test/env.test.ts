// 1단계(환경 점검·설치) 시험. 실제 설정 파일을 건드리지 않도록 가짜 명령(stub)으로 확인한다.
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../src/env/install.ts";
import { registerE2eLoop, serverCommand } from "../src/env/clients.ts";
import { MIN_BUN, bunCheck, compareVersion, runChecks } from "../src/env/detect.ts";

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

test("최소 Bun 버전: 낮으면 경고(수동 안내 bun upgrade), 같거나 높으면 ok, 지금 도는 Bun 도 점검에 나온다", async () => {
  expect(compareVersion("1.3.10", "1.4.3")).toBeLessThan(0);
  expect(compareVersion("1.4.3", "1.4.3")).toBe(0);
  expect(compareVersion("1.10.0", "1.4.3")).toBeGreaterThan(0);
  expect(compareVersion("1.4.3-canary.1", "1.4.3")).toBe(0);
  const low = bunCheck("1.3.10");
  expect(low.status).toBe("warn");
  expect(low.fix).toBe("manual");
  expect(low.manual).toContain("bun upgrade");
  expect(low.detail).toContain(MIN_BUN);
  expect(bunCheck("1.4.3").status).toBe("ok");
  const all = await runChecks();
  expect(all.find((c) => c.id === "bun")?.detail).toContain(Bun.version);
});

test("이미 등록된 e2e-loop 의 명령·인자가 지금 설치와 다르면(저장소를 옮김) 지우고 다시 등록하고, 같으면 이미 있음으로 둔다", async () => {
  const dir = sandbox();
  const log = join(dir, "calls.log");
  const [bun, mcp] = serverCommand();
  // get 은 실제 claude·codex 처럼 Command:/command: 와 Args:/args: 줄로 등록 내용을 보여 준다
  for (const [name, cmdLabel, argsLabel] of [["claude", "Command", "Args"], ["codex", "command", "args"]] as const) {
    const state = join(dir, `${name}.registered`);
    writeFileSync(state, `${bun}\n/old/clone/e2e-loop/src/mcp.ts\n`);
    stub(
      dir,
      name,
      `echo "${name} $@" >> "${log}"
case "$1 $2" in
  "mcp get") [ -f "${state}" ] || exit 1; echo "e2e-loop:"; echo "  ${cmdLabel}: $(sed -n 1p "${state}")"; echo "  ${argsLabel}: $(sed -n 2p "${state}")"; exit 0 ;;
  "mcp list") exit 0 ;;
  "mcp remove") rm -f "${state}"; exit 0 ;;
  "mcp add") [ -f "${state}" ] && exit 1; shift 2; while [ "$1" != "--" ]; do shift; done; shift; printf '%s\\n%s\\n' "$1" "$2" > "${state}"; exit 0 ;;
esac
exit 0`,
    );
  }
  const env = envWith(dir);
  const first = await registerE2eLoop({ env });
  expect(first.map((r) => `${r.client}:${r.action}`)).toEqual(["claude:updated", "codex:updated"]);
  const calls = readFileSync(log, "utf8");
  expect(calls).toContain("claude mcp remove e2e-loop -s user");
  expect(calls).toContain("codex mcp remove e2e-loop");
  expect(readFileSync(join(dir, "claude.registered"), "utf8")).toBe(`${bun}\n${mcp}\n`);
  const second = await registerE2eLoop({ env });
  expect(second.map((r) => `${r.client}:${r.action}`)).toEqual(["claude:already", "codex:already"]);
  expect(readFileSync(log, "utf8").split("mcp remove").length).toBe(3); // 같으면 다시 지우지 않는다
});

test("승인한 ffmpeg 설치가 실패하면 설치 질문에 다시 남고, 환경이 준비됐다고 하지 않는다. 컴퓨터 제어 점검도 안내에 들어간다", async () => {
  const dir = sandbox();
  stub(dir, "brew", 'echo "Error: network down" >&2; exit 1');
  const r = await doctor({ confirm: ["ffmpeg"], env: envWith(dir) });
  if (process.platform === "darwin" && r.checks.find((c) => c.id === "ffmpeg")?.status === "missing") {
    expect(r.actions.find((a) => a.id === "ffmpeg")?.status).toBe("failed");
    const q = r.needs_confirmation.find((n) => n.id === "ffmpeg");
    expect(q?.question).toContain("실패");
    expect(r.next).not.toContain("준비됐습니다");
  }
  // 이 PATH 에는 클라이언트가 없어 컴퓨터 제어가 보이지 않는다 → 안내(manual)에 들어간다
  expect(r.checks.find((c) => c.id === "computer-use")?.status).toBe("warn");
  expect(r.manual.map((m) => m.id)).toContain("computer-use");
});

test("MCP 서버에서 부른 doctor(fix)도 Playwright 브라우저는 이 패키지 폴더에서 설치한다(대상 프로젝트의 다른 playwright 를 쓰지 않음)", async () => {
  const dir = sandbox();
  const userProject = sandbox();
  const home = sandbox();
  const log = join(dir, "bunx.log");
  stub(dir, "bunx", `pwd > "${log}"; echo "$@" >> "${log}"; exit 0`);
  const script = `import { doctor } from ${JSON.stringify(join(import.meta.dir, "../src/env/install.ts"))};
await doctor({ fix: true, env: process.env, home: ${JSON.stringify(home)} });`;
  const p = Bun.spawn([process.execPath, "-e", script], {
    cwd: userProject, // MCP 서버는 대상 프로젝트 폴더에서 돈다
    env: { ...process.env, PATH: `${dir}:/usr/bin:/bin`, HOME: home, PLAYWRIGHT_BROWSERS_PATH: sandbox() },
    stdout: "ignore",
    stderr: "pipe",
  });
  const err = await new Response(p.stderr).text();
  expect(await p.exited).toBe(0);
  expect(existsSync(log)).toBe(true);
  const [cwd, args] = readFileSync(log, "utf8").trim().split("\n");
  expect(args).toBe("playwright install chromium");
  expect(realpathSync(cwd!)).toBe(realpathSync(join(import.meta.dir, "..")));
  expect(err).not.toContain("error");
}, 60000);
