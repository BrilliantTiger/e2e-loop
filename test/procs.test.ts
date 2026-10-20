// 오류 B/F(이중 브라우저 프로세스): 시작 전에 이전 프로세스가 0개인지 점검하고, 끊을 때는 나무째 끊고 0개를 다시 확인한다.
import { expect, test } from "bun:test";
import { cleanupStale, descendants, killTree, ownedProcs, parsePs, scanProcs, staleBrowserProcs, waitNoStale } from "../src/procs.ts";
import { browserPreflight } from "../src/round.ts";

const PS = `
    1     0 /sbin/launchd
  100     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  200     1 bun src/mcp.ts
  210   200 /x/chrome --e2e-loop-owner=200 --remote-debugging-pipe
  211   210 /x/chrome --type=renderer
  300     1 /x/chrome --e2e-loop-owner=777 --remote-debugging-pipe
  301   300 /x/chrome --type=gpu-process
  400     1 ego-browser nodejs -e /*e2e-loop-owner=778*/ const task = await taskSpace("e2e-loop")
  500     1 node /x/playwright-mcp --config /c.json
`;

test("ps 출력을 pid·ppid·명령으로 읽는다", () => {
  const p = parsePs(PS);
  expect(p.length).toBe(9);
  expect(p.find((x) => x.pid === 210)).toMatchObject({ ppid: 200 });
});

test("자손은 깊은 것부터 나열한다", () => {
  expect(descendants(parsePs(PS), 200)).toEqual([211, 210]);
});

test("표지(e2e-loop-owner)가 달린 프로세스만 이 도구의 것으로 센다: 사용자 Chrome·Playwright MCP 는 제외", () => {
  const o = ownedProcs(parsePs(PS), (pid) => pid === 200);
  expect(o.map((x) => x.pid)).toEqual([210, 300, 400]);
  expect(o.find((x) => x.pid === 400)!.kind).toBe("ego");
  expect(o.find((x) => x.pid === 210)!.ownerAlive).toBe(true);
  expect(o.find((x) => x.pid === 300)!.ownerAlive).toBe(false);
});

test("이전 프로세스: 지금 이 프로세스(200)가 띄운 것은 빼고 남이 띄운 표지 프로세스만 남긴다", async () => {
  const stale = await staleBrowserProcs(200, parsePs(PS));
  expect(stale.map((x) => x.pid)).toEqual([300, 400]);
  expect((await staleBrowserProcs(999, parsePs(PS))).map((x) => x.pid)).toEqual([210, 300, 400]);
});

test("실제 프로세스: 표지가 달린 셸과 그 자식(sleep)을 나무째 끊고 0개를 다시 확인한다", async () => {
  const mark = `e2e-loop-owner=${2147480000 + (process.pid % 1000)}`;
  const holder = Bun.spawn(["/bin/sh", "-c", "sleep 300 & wait", mark], { stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(400);
  // 이 시험 프로세스가 아닌 다른 소유자의 프로세스처럼 보이도록 selfPid 를 가짜로 준다
  const fakeSelf = 2147483000;
  const before = await staleBrowserProcs(fakeSelf);
  expect(before.some((p) => p.pid === holder.pid)).toBe(true);
  const kids = descendants(await scanProcs(), holder.pid);
  expect(kids.length).toBeGreaterThanOrEqual(1);
  const r = await cleanupStale(fakeSelf, (p) => p.pid === holder.pid); // 시험이 띄운 것만 끊는다(다른 세션의 실제 라운드는 건드리지 않음)
  expect(r.before).toBeGreaterThanOrEqual(1);
  expect(r.after.filter((p) => p.pid === holder.pid)).toEqual([]);
  await holder.exited;
  for (const k of kids) expect(() => process.kill(k, 0)).toThrow(); // 자식도 죽었다
});

test("killTree: 자손까지 끊고 끊은 pid 를 돌려준다", async () => {
  const holder = Bun.spawn(["/bin/sh", "-c", "sleep 300 & sleep 300 & wait"], { stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(300);
  const killed = await killTree(holder.pid, 1500);
  expect(killed.length).toBeGreaterThanOrEqual(3);
  await holder.exited;
  for (const k of killed) expect(() => process.kill(k, 0)).toThrow();
});

test("라운드 시작 전 점검: 남은 프로세스가 있으면 시작하지 않고 끊을지 묻는다(끊지는 않는다)", async () => {
  // 시험 프로세스의 자식이 아니도록 중간 셸이 먼저 끝나게 해 고아 프로세스를 만든다
  const mark = `e2e-loop-owner=${2147470000 + (process.pid % 1000)}`;
  const starter = Bun.spawn(["/bin/sh", "-c", `nohup /bin/sh -c 'sleep 300; :' ${mark} >/dev/null 2>&1 & echo $!`], { stdout: "pipe", stderr: "ignore" });
  const shellPid = Number((await new Response(starter.stdout).text()).trim());
  await Bun.sleep(300);
  try {
    const pf = await browserPreflight({});
    expect(pf.ok).toBe(false);
    if (!pf.ok) {
      expect(pf.decision?.needs_decision).toBe(true);
      expect(pf.decision?.question).toContain("브라우저 프로세스");
      expect(pf.decision?.question).toContain(String(shellPid));
      expect(pf.decision?.options.map((o) => o.value)).toEqual(["cleanup", "stop"]);
    }
    expect(() => process.kill(shellPid, 0)).not.toThrow(); // 묻기만 하고 끊지 않았다
  } finally {
    await killTree(shellPid);
  }
  expect(() => process.kill(shellPid, 0)).toThrow();
});
