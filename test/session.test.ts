// 2단계(테스터 세션) 시험. 실제 설정·스킬 폴더·Orca 를 건드리지 않도록 가짜 명령(stub)과 임시 폴더를 쓴다.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project } from "../src/store.ts";
import { agentCommand, checkWebUrl, intake, readSession, sessionStart } from "../src/session.ts";
import { installSkills, skillSource } from "../src/env/skills.ts";
import { doctor } from "../src/env/install.ts";
import { aStatus } from "../src/actions.ts";
import { precheck } from "../src/round.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "e2e-loop-sess-"));
const stub = (dir: string, name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
const envWith = (dir: string) => ({ ...process.env, PATH: `${dir}:/usr/bin:/bin` });
/** Orca 가짜: status 는 연결됨/안됨, terminal create 는 호출을 기록하고 handle 을 돌려준다 */
const fakeOrca = (dir: string, reachable: boolean) => {
  const log = join(dir, "orca.log");
  stub(dir, "orca", `echo "$@" >> "${log}"
case "$1" in
  status) echo '{"ok":true,"result":{"runtime":{"reachable":${reachable}}}}' ;;
  terminal) echo '{"ok":true,"result":{"terminal":{"handle":"term_test-1234"}}}' ;;
esac
exit 0`);
  return log;
};
const fakeClaude = (dir: string) => stub(dir, "claude", `case "$1 $2" in "mcp get") exit 0;; "mcp list") echo ok; exit 0;; esac; exit 0`);

let site: ReturnType<typeof Bun.serve>;
let url: string;
beforeAll(() => {
  site = Bun.serve({ port: 0, fetch: (r) => (new URL(r.url).pathname === "/" ? new Response("ok") : new Response("없음", { status: 404 })) });
  url = `http://127.0.0.1:${site.port}`;
});
afterAll(() => site.stop(true));

// ---------- 최소 진행 조건 ----------

test("웹 주소가 열리면 ok, 닫혀 있거나 형식이 틀리면 이유와 함께 실패", async () => {
  expect((await checkWebUrl(url)).ok).toBe(true);
  const missing = await checkWebUrl(`${url}/없는-경로`);
  expect(missing.ok).toBe(false);
  expect(missing.status).toBe(404);
  expect((await checkWebUrl("http://127.0.0.1:1")).ok).toBe(false);
  expect((await checkWebUrl("localhost:3000")).ok).toBe(false);
  expect((await checkWebUrl("ftp://x.test")).reason).toContain("http");
  expect((await checkWebUrl(undefined)).ok).toBe(false);
});

test("웹 주소만 있고 근거가 없으면 시작하지 않고 근거를 요청한다", async () => {
  const p = new Project(tmp());
  const r = await intake(p, { baseUrl: url });
  expect(r.can_start).toBe(false);
  expect(r.base_url.ok).toBe(true);
  expect(r.missing).toEqual(["근거 자료 1개 이상"]);
  expect(r.ask_user.join(" ")).toContain("기획서·디자인");
});

test("근거만 있고 웹 주소가 없으면 시작하지 않고 주소를 요청한다", async () => {
  const root = tmp();
  writeFileSync(join(root, "plan.md"), "# 기획서");
  const p = new Project(root);
  const r = await intake(p, { materials: [{ kind: "plan", location: "plan.md" }] });
  expect(r.can_start).toBe(false);
  expect(r.evidence.usable.length).toBe(1);
  expect(r.missing).toEqual(["웹 주소"]);
});

test("열리지 않는 웹 주소는 근거가 있어도 시작하지 않는다", async () => {
  const root = tmp();
  writeFileSync(join(root, "plan.md"), "# 기획서");
  const r = await intake(new Project(root), { baseUrl: "http://127.0.0.1:1", materials: [{ kind: "plan", location: "plan.md" }], urlTimeoutMs: 3000 });
  expect(r.can_start).toBe(false);
  expect(r.missing).toEqual(["열리는 웹 주소"]);
  expect(r.ask_user[0]).toContain("열리지 않습니다");
});

test("없는 파일 경로는 근거로 세지 않는다", async () => {
  const p = new Project(tmp());
  const r = await intake(p, { baseUrl: url, materials: [{ kind: "design", location: "/없는/경로/design.fig" }] });
  expect(r.can_start).toBe(false);
  expect(r.evidence.rejected.length).toBe(1);
  expect(r.evidence.rejected[0]!.reason).toContain("없습니다");
  expect(p.sources().length).toBe(0);
});

test("열리는 주소 + 근거 하나(코드 폴더, Figma URL)면 시작할 수 있고, 같은 자료는 두 번 등록되지 않는다", async () => {
  const root = tmp();
  mkdirSync(join(root, "app/src"), { recursive: true });
  const p = new Project(root);
  const a = await intake(p, { baseUrl: url, materials: [{ kind: "code", location: "app" }] });
  expect(a.can_start).toBe(true);
  expect(a.missing).toEqual([]);
  expect(a.ask_optional.join(" ")).toContain("기획서");
  expect(a.ask_optional.join(" ")).not.toContain("코드");
  await intake(p, { materials: [{ kind: "code", location: "app" }, { kind: "design", location: "https://www.figma.com/design/abc" }] });
  expect(p.sources().map((s) => s.kind)).toEqual(["code", "design"]);
  expect(p.config().baseUrl).toBe(url);
});

test("live-site(개발된 사이트)만으로는 근거가 되지 않아 회차 시작이 막힌다", async () => {
  const root = tmp();
  const p = new Project(root);
  await intake(p, { baseUrl: url });
  p.writeJson("sources.json", [{ id: "S01", kind: "live-site", title: "사이트", location: url, addedAt: "" }]);
  p.saveCases([{ id: "C1", title: "t", type: "probe", steps: [{ op: "goto", url: "/" }] }]);
  const pre = precheck(p, { data: "keep" });
  expect(pre.ok).toBe(false);
  expect((pre as any).error).toContain("최소 진행 조건");
});

// ---------- 테스터 세션 ----------

test("Orca 가 있으면 mode 를 안 줘도 새 터미널을 띄우고 handle 을 기록한다", async () => {
  const bin = tmp();
  const log = fakeOrca(bin, true);
  fakeClaude(bin);
  const root = tmp();
  const r: any = await sessionStart(new Project(root), { env: envWith(bin), baseUrl: url });
  expect(r.mode).toBe("new");
  expect(r.launched).toBe(true);
  expect(r.session.launch.via).toBe("orca");
  expect(r.session.launch.terminal).toBe("term_test-1234");
  expect(r.session.launch.agent).toBe("claude");
  const calls = readFileSync(log, "utf8");
  expect(calls).toContain("terminal create");
  expect(calls).toContain("--command");
  expect(calls).toContain(`cd '${root}' && claude`);
  expect(r.intake.can_start).toBe(false); // 근거가 아직 없으므로 새 세션이 사용자에게 요청한다
  expect(readSession(new Project(root))?.launch?.terminal).toBe("term_test-1234");
});

test("Orca 가 없으면 '새 세션 / 여기서'를 묻고, 아무것도 저장하지 않는다", async () => {
  const bin = tmp();
  fakeClaude(bin);
  const root = tmp();
  const r: any = await sessionStart(new Project(root), { env: envWith(bin) });
  expect(r.needs_decision).toBe(true);
  expect(r.options.map((o: any) => o.value)).toEqual(["new", "here"]);
  expect(readSession(new Project(root))).toBeNull();
});

test("Orca 가 있어도 연결이 안 되어 있으면 묻는다", async () => {
  const bin = tmp();
  fakeOrca(bin, false);
  const r: any = await sessionStart(new Project(tmp()), { env: envWith(bin) });
  expect(r.needs_decision).toBe(true);
});

test("'새 세션'을 골랐는데 Orca 가 없으면 실행할 명령을 돌려준다(claude 우선, 없으면 codex)", async () => {
  const bin = tmp();
  fakeClaude(bin);
  const root = tmp();
  const r: any = await sessionStart(new Project(root), { env: envWith(bin), mode: "new" });
  expect(r.launched).toBe(false);
  expect(r.session.launch.via).toBe("manual");
  expect(r.command).toBe(agentCommand("claude", root));
  expect(r.command).toContain("e2e-loop 스킬");

  const bin2 = tmp();
  stub(bin2, "codex", `case "$1 $2" in "mcp get") exit 1;; esac; exit 0`);
  const r2: any = await sessionStart(new Project(tmp()), { env: envWith(bin2), mode: "new" });
  expect(r2.session.launch.agent).toBe("codex");
  expect(r2.warn.join(" ")).toContain("등록되어 있지 않습니다");
  const r3: any = await sessionStart(new Project(tmp()), { env: envWith(bin2), mode: "new", agent: "claude" });
  expect(r3.session.launch.agent).toBe("codex");
  expect(r3.warn.join(" ")).toContain("설치되어 있지 않아");
});

test("명령 안의 작은따옴표와 공백이 있는 경로도 안전하게 감싼다", () => {
  const cmd = agentCommand("claude", "/tmp/it's a dir");
  expect(cmd.startsWith(`cd '/tmp/it'\\''s a dir' && claude '`)).toBe(true);
});

test("'여기서'를 고르면 이 세션이 테스터가 되고 웹 주소·근거 검사가 같이 돈다", async () => {
  const root = tmp();
  writeFileSync(join(root, "spec.md"), "# 기능정의서");
  const r: any = await sessionStart(new Project(root), { mode: "here", baseUrl: url, materials: [{ kind: "feature-spec", location: "spec.md" }] });
  expect(r.mode).toBe("here");
  expect(r.intake.can_start).toBe(true);
  expect(readSession(new Project(root))?.mode).toBe("here");
});

test("한 세션 유지: 세션이 있으면 다시 호출해도 새로 띄우지 않고, new_session 으로 명시할 때만 새로 띄운다", async () => {
  const bin = tmp();
  const log = fakeOrca(bin, true);
  fakeClaude(bin);
  const root = tmp();
  const env = envWith(bin);
  await sessionStart(new Project(root), { env });
  const again: any = await sessionStart(new Project(root), { env });
  expect(again.reused).toBe(true);
  expect(readFileSync(log, "utf8").match(/terminal create/g)?.length).toBe(1);
  const forced: any = await sessionStart(new Project(root), { env, new_session: true });
  expect(forced.launched).toBe(true);
  expect(readFileSync(log, "utf8").match(/terminal create/g)?.length).toBe(2);
  expect(forced.session.history.length).toBe(1);
});

test("dryRun 은 Orca 를 실행하지 않고 명령만 만든다", async () => {
  const bin = tmp();
  const log = fakeOrca(bin, true);
  fakeClaude(bin);
  const root = tmp();
  const r: any = await sessionStart(new Project(root), { env: envWith(bin), dryRun: true });
  expect(r.launched).toBe(false);
  expect(r.command).toContain("claude");
  expect(readFileSync(log, "utf8")).not.toContain("terminal create");
  expect(readSession(new Project(root))).toBeNull();
});

test("e2e_status: 세션이 없으면 세션 시작을, 근거가 없으면 최소 조건 충족을 다음 행동으로 알려 준다", async () => {
  const root = tmp();
  expect((aStatus({ project: root }) as any).next).toContain("e2e_session_start");
  await sessionStart(new Project(root), { mode: "here", baseUrl: url });
  const s: any = aStatus({ project: root });
  expect(s.session.mode).toBe("here");
  expect(s.next).toContain("최소 진행 조건");
});

// ---------- 스킬 설치 ----------

test("SKILL.md 가 있고(영어) 이름·설명 머리말과 동작 흐름 9단계, 금지 사항을 담는다", () => {
  const text = readFileSync(join(skillSource(), "SKILL.md"), "utf8");
  expect(text).toMatch(/^---\nname: e2e-loop\ndescription: .+\n---/);
  for (let i = 1; i <= 9; i++) expect(text).toContain(`### ${i}. `);
  expect(text).toContain("Do not edit code");
  expect(text).toContain("from the next round");
  expect(text).toContain("in the language the user writes in");
  // 시험 도구 오류 예방: 규칙 A~E, 라운드 전 리허설, 이슈와 도구 오류(NA)를 따로 보고
  for (const t of ["endStates", "row=<row text>", "cell[col=", "data-testid", "waitFor", "basis", "`gate` step", "Rehearsal", "tool errors are 0", "excluded_issues.tsv", "issues N, tool errors (NA) M", "Do not report a tool error"]) expect(text).toContain(t);
  for (const t of ["A, waiting for a state that never comes", "B, reusing a row number", "C, finding an element", "D, reading before the screen is drawn", "E, an expectation that differs"]) expect(text).toContain(t);
  // 2차 반영: 원인 F·G, 긴 계산 대기, 누르기 전 대기, 토스트, 쪽 넘김, 문구 대조, 시트 설계, 브라우저 프로세스 점검, 반복 한도
  for (const t of ["Seventeen causes are known (A to G, L, M, N, O, P, Q, R, S, T, and U)", "T, the same failing row in several chapters", "S, an expectation based on the screen design rather than the plan", "\"differs\"", "R, a prior chapter that ended with a tool error", "retest=true", "Test conditions (part of F)", "test condition not met", "Q, an expectation that contradicts what the dataset has", "`when`", "P, a dataset-only exception list written into the judgement", "{{dataset.<name>}}", "e2e_dataset", "U, a freeze on opening a screen that does not come back", "freeze not reproduced", "O, a freeze measured in a hidden window", "measurement invalid, window covered", "N, two chapters running at once on the same tab or dataset", "concurrent run refused", "M, pressing while the server is still computing", "\"ready\"", "L, ending a wait as \"no change\" while the server is still working", "wait.progress", "F, pressing on after an earlier step failed", "G, comparing a cut string", "`prereq`", "4th ends the chapter", "panelTitle", "maxWaitSec", "720", "waitGone", "waitEnabled", "Toasts (D)", "server effect", "`collect`", "pop()", "Quote check", "Sheet design", "single version", "V2, V3", "cleanup_browsers", "repeatLimit", "with the cause A to G, L, M, or N", "Chapters that depend on each other (H, not a tool error)", "blocked by a prior defect", "`requires`", "E carried over", "기대 수정 필요", "n회째", "prerequisite not finished", "`<round>-X-<NN>`", "excluded_all.tsv"]) expect(text).toContain(t);
  expect(text.indexOf("Quote check")).toBeGreaterThan(text.indexOf("E, an expectation that differs"));
  expect(text.indexOf("Quote check")).toBeLessThan(text.indexOf("F, pressing on"));
  expect(text.indexOf("#### Rehearsal")).toBeGreaterThan(text.indexOf("### 6. "));
  expect(text.indexOf("#### Rehearsal")).toBeLessThan(text.indexOf("### 7. "));
  for (const t of ["e2e_status", "e2e_session_start", "e2e_intake", "e2e_analyze", "e2e_os_check", "e2e_sheet", "e2e_prestart", "e2e_account", "e2e_comments", "e2e_round_start", "e2e_complete_check", "e2e_feedback"]) expect(text).toContain(t);
});

test("스킬을 Claude(~/.claude/skills)와 Codex(~/.agents/skills)에 링크하고, 두 번째는 이미 있음", () => {
  const home = tmp();
  const bin = tmp();
  stub(bin, "claude", "exit 0");
  stub(bin, "codex", "exit 0");
  const first = installSkills({ env: envWith(bin), home });
  expect(first.map((r) => `${r.client}:${r.action}`)).toEqual(["claude:linked", "codex:linked"]);
  expect(readlinkSync(join(home, ".claude/skills/e2e-loop"))).toBe(skillSource());
  expect(existsSync(join(home, ".agents/skills/e2e-loop/SKILL.md"))).toBe(true);
  expect(installSkills({ env: envWith(bin), home }).map((r) => r.action)).toEqual(["already", "already"]);
});

test("클라이언트가 없으면 건너뛰고, 같은 이름의 실제 폴더는 덮어쓰지 않으며, dry-run 은 만들지 않는다", () => {
  const home = tmp();
  const bin = tmp();
  expect(installSkills({ env: envWith(bin), home }).every((r) => r.action === "skipped")).toBe(true);
  stub(bin, "claude", "exit 0");
  const planned = installSkills({ env: envWith(bin), home, dryRun: true });
  expect(planned[0]!.action).toBe("planned");
  expect(existsSync(join(home, ".claude/skills/e2e-loop"))).toBe(false);
  mkdirSync(join(home, ".claude/skills/e2e-loop"), { recursive: true });
  writeFileSync(join(home, ".claude/skills/e2e-loop/mine.txt"), "내 것");
  const conflict = installSkills({ env: envWith(bin), home });
  expect(conflict[0]!.action).toBe("conflict");
  expect(lstatSync(join(home, ".claude/skills/e2e-loop")).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(home, ".claude/skills/e2e-loop/mine.txt"), "utf8")).toBe("내 것");
});

test("옛 위치를 가리키는 링크는 새 위치로 바꾼다", () => {
  const home = tmp();
  const bin = tmp();
  stub(bin, "claude", "exit 0");
  mkdirSync(join(home, ".claude/skills"), { recursive: true });
  require("node:fs").symlinkSync(tmp(), join(home, ".claude/skills/e2e-loop"));
  const r = installSkills({ env: envWith(bin), home });
  expect(r[0]!.action).toBe("linked");
  expect(readlinkSync(join(home, ".claude/skills/e2e-loop"))).toBe(skillSource());
});

test("setup(doctor fix)이 스킬 설치도 하며, 임시 홈 밖은 건드리지 않는다", async () => {
  const home = tmp();
  const bin = tmp();
  stub(bin, "claude", `case "$1 $2" in "mcp get") exit 0;; esac; exit 0`);
  const rep = await doctor({ fix: true, dryRun: true, env: envWith(bin), home });
  expect(rep.skills.find((s) => s.client === "claude")!.action).toBe("planned");
  expect(existsSync(join(home, ".claude"))).toBe(false);
});
