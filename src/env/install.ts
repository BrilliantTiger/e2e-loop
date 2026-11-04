// 설치 실행. auto 항목은 바로, ask 항목은 사용자가 승인(confirm)한 것만 실행한다.
import { run, runChecks, type Check, type Env } from "./detect.ts";
import { registerE2eLoop, detectClients, type RegisterResult, type ClientState } from "./clients.ts";
import { installSkills, type SkillInstallResult } from "./skills.ts";
import { tx } from "../i18n.ts";

export interface InstallAction {
  id: string;
  command: string[];
  status: "done" | "failed" | "planned";
  detail: string;
}

export interface EnvReport {
  ok: boolean;
  platform: string;
  checks: Check[];
  clients: ClientState[];
  /** 사용자에게 물은 뒤 confirm 으로 다시 호출해야 설치되는 것 */
  needs_confirmation: { id: string; question: string; command: string }[];
  /** 사람이 직접 해야 하는 것 */
  manual: { id: string; why: string; steps: string }[];
  actions: InstallAction[];
  registration: RegisterResult[];
  skills: SkillInstallResult[];
  driver_choices: { value: string; available: boolean; note: string }[];
  auto_would_use: string;
  /** 지원하지 않는 브라우저 안내 */
  unsupported: string;
  next: string;
}

const q = (c: string[]) => c.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ");

export interface DoctorOpts {
  /** 자동 설치(auto)와 클라이언트 등록을 실제로 수행 */
  fix?: boolean;
  /** 사용자가 설치를 승인한 항목 id (예: "ffmpeg") */
  confirm?: string[];
  /** 실행하지 않고 할 일만 보여 줌 */
  dryRun?: boolean;
  env?: Env;
  /** 스킬 설치 위치의 홈 폴더(시험용). 기본은 실제 홈 */
  home?: string;
}

export async function doctor(opts: DoctorOpts = {}): Promise<EnvReport> {
  const env = opts.env ?? process.env;
  const actions: InstallAction[] = [];
  let checks = await runChecks(env);

  const exec = async (c: Check) => {
    if (!c.command) return;
    if (opts.dryRun) {
      actions.push({ id: c.id, command: c.command, status: "planned", detail: tx(`실행 예정: ${q(c.command)}`, `Will run: ${q(c.command)}`) });
      return;
    }
    const r = await run(c.command, { env, cwd: c.cwd, timeoutMs: 900000 });
    actions.push({ id: c.id, command: c.command, status: r.code === 0 ? "done" : "failed", detail: r.code === 0 ? tx(`${c.name} 설치 완료`, `${c.name} installed`) : tx(`${c.name} 설치 실패: ${r.out.slice(-300)}`, `${c.name} install failed: ${r.out.slice(-300)}`) });
  };

  if (opts.fix || opts.confirm?.length) {
    for (const c of checks) {
      if (c.status !== "missing") continue;
      if (c.fix === "auto" && opts.fix) await exec(c);
      else if (c.fix === "ask" && opts.confirm?.includes(c.id)) await exec(c);
    }
    if (!opts.dryRun) checks = await runChecks(env);
  }

  let registration: RegisterResult[] = [];
  if (opts.fix) registration = await registerE2eLoop({ env, dryRun: opts.dryRun });
  const skills = opts.fix ? installSkills({ env, home: opts.home, dryRun: opts.dryRun }) : [];
  const clients = await detectClients(env);

  // 컴퓨터 제어 MCP: 클라이언트 목록에서 보이는지로만 판단한다(설치할 패키지가 따로 없다. Codex 는 앱 내장, Claude 는 기본 연동).
  const seen = clients.filter((c) => c.computerUse === true).map((c) => c.name);
  checks.push({
    id: "computer-use",
    name: tx("컴퓨터 제어 MCP (브라우저 밖 OS 창 처리)", "Computer control MCP (handles OS windows outside the browser)"),
    status: seen.length ? "ok" : "warn",
    detail: seen.length ? tx(`${seen.join(", ")} 에서 보임`, `seen in ${seen.join(", ")}`) : tx("클라이언트 목록에서 확인하지 못함(내장 기능이면 목록에 안 보일 수 있음)", "not found in the client lists (a built-in feature may not show in the list)"),
    fix: seen.length ? "none" : "manual",
    manual: tx(
      "OS 다운로드·파일 선택 창이 시트에 있을 때만 필요하다. 쓰는 클라이언트(Claude Code, Codex)의 컴퓨터 제어 기능을 켜세요. 테스트 전에 동작 여부를 점검하고, 안 되면 권한을 요구하며 스킵/허용을 묻는다.",
      "Needed only when the sheet has an OS download or file chooser window. Turn on the computer control feature of the client you use (Claude Code, Codex). It is checked before testing. If it does not work, the user is asked for the permission and asked to skip or allow.",
    ),
    neededFor: tx("브라우저 밖 OS 창(다운로드·파일 선택)", "OS windows outside the browser (download, file chooser)"),
  });

  // 승인했어도 설치가 실패해 아직 없는 것은 질문에 다시 올린다(실패를 숨기고 준비됐다고 하지 않는다)
  const failed = new Map(actions.filter((x) => x.status === "failed").map((x) => [x.id, x.detail]));
  const needs = checks
    .filter((c) => c.status === "missing" && c.fix === "ask" && (!opts.confirm?.includes(c.id) || failed.has(c.id)))
    .map((c) => ({
      id: c.id,
      question: failed.has(c.id)
        ? tx(`${failed.get(c.id)}. 원인을 확인한 뒤 다시 설치할까요?`, `${failed.get(c.id)}. Check the cause, then install again?`)
        : tx(`${c.name} 가 없습니다(${c.neededFor ?? "필요"}). 설치할까요?`, `${c.name} is not installed (needed for ${c.neededFor ?? "this tool"}). Install it?`),
      command: q(c.command!),
    }));
  // 컴퓨터 제어 점검도 안내에 넣는다(위에서 점검 목록에 붙인 뒤에 모은다)
  const manual = checks
    .filter((c) => (c.status === "missing" || c.status === "warn") && c.fix === "manual" && c.manual)
    .map((c) => ({ id: c.id, why: `${c.name}: ${c.detail}`, steps: c.manual! }));

  const has = (id: string, ok = "ok") => checks.find((c) => c.id === id)?.status === ok;
  const egoOk = has("ego");
  const chromeOk = has("chrome");
  const edgeOk = has("edge");
  const chromiumOk = has("playwright-chromium");
  const driver_choices = [
    { value: "ego", available: egoOk, note: egoOk ? tx("Ego Browser — 영상은 작업 공간의 화면을 브라우저 안쪽에서 받아 만듦(창이 가려져도 됨, ffmpeg 필요)", "Ego Browser — the video is made from the workspace screen captured inside the browser (the window may be covered; needs ffmpeg)") : tx("Ego 미설치/미동작", "Ego not installed or not working") },
    { value: "chrome", available: chromeOk, note: chromeOk ? tx("설치된 Google Chrome(Playwright 연결) — 영상·trace", "Installed Google Chrome (through Playwright) — video and trace") : tx("Google Chrome 없음", "No Google Chrome") },
    { value: "edge", available: edgeOk, note: edgeOk ? tx("설치된 Microsoft Edge(Playwright 연결) — 영상·trace", "Installed Microsoft Edge (through Playwright) — video and trace") : tx("Microsoft Edge 없음", "No Microsoft Edge") },
    { value: "chromium", available: chromiumOk, note: chromiumOk ? tx("Playwright 내장 Chromium — 영상·trace", "Playwright built-in Chromium — video and trace") : tx("Chromium 미설치 — fix 로 설치", "Chromium not installed — install it with fix") },
  ];
  // 고를 브라우저가 없을 때는 null 로 판단하고, 보여 줄 때만 「(없음)」으로 쓴다
  const autoId = egoOk ? "ego" : chromeOk ? "chrome" : edgeOk ? "edge" : chromiumOk ? "chromium" : null;
  const auto = autoId ?? tx("(없음)", "(none)");

  const blocking = checks.filter((c) => c.status === "missing" && c.id === "playwright-chromium" && !chromeOk && !edgeOk && !egoOk);
  const ok = blocking.length === 0 && autoId !== null;
  let next: string;
  if (needs.length) next = tx("사용자에게 위 설치 질문을 하고, 승인받은 항목 id 를 confirm 으로 e2e_doctor 를 다시 호출하세요.", "Ask the user the install questions above, then call e2e_doctor again with the approved item ids in confirm.");
  else if (!ok) next = tx("e2e_doctor(fix=true) 로 Playwright 브라우저를 설치하세요.", "Install the Playwright browser with e2e_doctor(fix=true).");
  else if (manual.length) next = tx("사용자에게 manual 항목(앱 설치·권한 허용)을 안내하세요. 쓰지 않을 브라우저 관련 항목은 무시해도 됩니다.", "Tell the user the manual items (app install, permission). Items for a browser the user will not use can be ignored.");
  else next = tx("환경이 준비됐습니다. e2e_init 으로 프로젝트를 설정하세요.", "The environment is ready. Set up the project with e2e_init.");
  return { ok, platform: process.platform, checks, clients, needs_confirmation: needs, manual, actions, registration, skills, driver_choices, auto_would_use: auto, unsupported: tx("Safari 는 지원하지 않습니다(Chrome 기반 브라우저 — Chrome·Chromium·Edge — 와 Ego 만 지원).", "Safari is not supported (only Chrome-based browsers — Chrome, Chromium, Edge — and Ego are supported)."), next };
}
