// 터미널 진입점(src/cli.ts)과 독립 현황판을 띄우는 셸 명령 시험. 임시 프로젝트만 쓴다.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project } from "../src/store.ts";
import { standaloneCommand } from "../src/actions.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");
const tmp = () => mkdtempSync(join(tmpdir(), "e2e-loop-cli-"));
const cli = async (args: string[]) => {
  const p = Bun.spawn([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
};

test("[ 나 { 로 시작하지만 JSON 이 아닌 값은 그대로 글자로 받는다(요청 글 「[긴급] …」)", async () => {
  const root = tmp();
  const r = await cli(["feedback", "--text", "[긴급] 저장 버튼이 안 눌림", "--project", root]);
  expect(r.err).not.toContain("SyntaxError");
  expect(r.code).toBe(0);
  expect(new Project(root).feedback().map((f) => f.text)).toEqual(["[긴급] 저장 버튼이 안 눌림"]);
  // JSON 인 값은 여전히 풀어서 받는다
  const m = await cli(["intake", "--materials", '[{"kind":"plan","location":"없는.md"}]', "--project", root]);
  expect(JSON.parse(m.out).evidence.rejected[0].location).toContain("없는.md");
});

test("CLI 에서 「지금 회차부터」 질문의 선택지 next 를 주면 다음 회차 적용으로 기록한다", async () => {
  const root = tmp();
  const p = new Project(root);
  p.ensure();
  p.writeJson("rounds/R01/meta.json", { id: "R01", n: 1, status: "running", scope: "full" });
  writeFileSync(p.p("running.json"), JSON.stringify({ pid: process.pid, round: "R01" }));
  const r = await cli(["feedback", "--text", "로그인 케이스 추가", "--apply", "now", "--mode", "next", "--project", root]);
  expect(r.code).toBe(0);
  expect(p.feedback()[0]).toMatchObject({ appliesTo: "next-round", appliesFrom: "R02" });
});

test("독립 현황판 명령: 경로와 host 의 $()·백틱·따옴표를 셸이 풀지 않고 그대로 넘긴다", async () => {
  const dir = tmp();
  const evil = join(dir, "p$(touch pwned1)`touch pwned2`'q");
  const log = join(dir, "out.log");
  // 실제 bun 대신 echo 로 인자만 받아 적는다
  const cmd = standaloneCommand("/bin/echo", "cli.ts", evil, log, "10.0.0.1; touch pwned3");
  const sh = Bun.spawn(["/bin/sh", "-c", cmd], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  await sh.exited;
  for (let i = 0; i < 20 && !(existsSync(log) && readFileSync(log, "utf8").includes("\n")); i++) await Bun.sleep(50);
  expect(readFileSync(log, "utf8").trim()).toBe(`cli.ts dashboard --project ${evil} --host 10.0.0.1; touch pwned3`);
  for (const f of ["pwned1", "pwned2", "pwned3"]) expect(existsSync(join(dir, f))).toBe(false);
});
