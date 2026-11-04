// 환경 점검: 무엇이 있고 무엇이 없는지 읽기만 한다. 설치는 install.ts 가 한다.
import { existsSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { tx } from "../i18n.ts";

export type Env = Record<string, string | undefined>;

export function which(cmd: string, env: Env = process.env): string | null {
  return Bun.which(cmd, { PATH: env.PATH ?? "" }) ?? null;
}

export async function run(cmd: string[], opts: { env?: Env; timeoutMs?: number; cwd?: string } = {}) {
  try {
    const p = Bun.spawn(cmd, { env: opts.env as Record<string, string>, cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), opts.timeoutMs ?? 60000);
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(timer);
    return { code, out: (o + e).trim() };
  } catch (e: any) {
    return { code: 127, out: String(e?.message ?? e) };
  }
}

export type Status = "ok" | "missing" | "warn" | "na";
export type FixKind = "auto" | "ask" | "manual" | "none";

export interface Check {
  id: string;
  name: string;
  status: Status;
  detail: string;
  /** auto = fix=true 일 때 알아서 설치 / ask = 사용자 승인 뒤에만 설치 / manual = 안내만 */
  fix: FixKind;
  command?: string[];
  /** command 를 실행할 폴더(없으면 부른 쪽의 현재 폴더) */
  cwd?: string;
  manual?: string;
  /** 이 도구가 필요한 상황 */
  neededFor?: string;
}

const EDGE_PATHS = ["/Applications/Microsoft Edge.app", "/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"];
const CHROME_PATHS = ["/Applications/Google Chrome.app", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "C:/Program Files/Google/Chrome/Application/chrome.exe"];

export const firstExisting = (paths: string[]) => paths.find((p) => existsSync(p)) ?? null;

export async function checkPlaywrightChromium(): Promise<{ ok: boolean; path?: string }> {
  try {
    const { chromium } = await import("playwright");
    const path = chromium.executablePath();
    return { ok: !!path && existsSync(path), path };
  } catch {
    return { ok: false };
  }
}

/** macOS 권한 근사 점검. 권한은 "이 프로세스를 띄운 앱" 기준이라 힌트로만 쓴다. (python ctypes: 0.1초) */
export async function macPermissions(env: Env = process.env) {
  if (process.platform !== "darwin") return { screenRecording: null as boolean | null, accessibility: null as boolean | null };
  const py = [
    "import ctypes",
    "cg=ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'); cg.CGPreflightScreenCaptureAccess.restype=ctypes.c_bool",
    "ax=ctypes.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices'); ax.AXIsProcessTrusted.restype=ctypes.c_bool",
    "print(cg.CGPreflightScreenCaptureAccess(), ax.AXIsProcessTrusted())",
  ].join("\n");
  const r = await run(["/usr/bin/python3", "-c", py], { env, timeoutMs: 8000 });
  if (r.code !== 0) return { screenRecording: null, accessibility: null };
  const [sr, ac] = r.out.trim().split(/\s+/);
  return { screenRecording: sr === "True", accessibility: ac === "True" };
}

/** 최소 Bun 버전. 1.3.10 은 앞서 닫은 브라우저가 있는 채로 새 브라우저를 띄우면 새 브라우저의 CDP 파이프가 닫혀
 *  라운드가 멈췄다(Bun 1.4.3 에서는 재현 안 됨). 확인한 가장 낮은 정상 버전을 최소로 둔다. */
export const MIN_BUN = "1.4.3";

/** "1.4.3" 꼴 버전 비교: a < b 면 음수 */
export function compareVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export function bunCheck(version: string = Bun.version): Check {
  const ok = compareVersion(version, MIN_BUN) >= 0;
  return ok
    ? { id: "bun", name: "bun", status: "ok", detail: tx(`bun ${version} (최소 ${MIN_BUN})`, `bun ${version} (minimum ${MIN_BUN})`), fix: "none" }
    : {
        id: "bun", name: "bun", status: "warn", fix: "manual",
        detail: tx(`bun ${version} — 최소 ${MIN_BUN} 보다 낮음. 낮은 버전(1.3.10 확인)에서는 라운드 도중 브라우저가 조용히 사라져 라운드가 멈춘다`, `bun ${version} — lower than the minimum ${MIN_BUN}. On a lower version (seen on 1.3.10) the browser silently disappears during a round and the round stops`),
        manual: tx("bun upgrade 로 올린 뒤 MCP 서버(또는 세션)를 다시 시작", "Upgrade with bun upgrade, then restart the MCP server (or the session)"),
        neededFor: tx("라운드 실행(브라우저를 여러 번 띄우는 모든 경우)", "running rounds (every case that starts the browser more than once)"),
      };
}

export async function runChecks(env: Env = process.env): Promise<Check[]> {
  const checks: Check[] = [];
  const platform = process.platform;

  checks.push(bunCheck());

  const pw = await checkPlaywrightChromium();
  checks.push({
    id: "playwright-chromium",
    name: tx("Playwright Chromium 브라우저", "Playwright Chromium browser"),
    status: pw.ok ? "ok" : "missing",
    detail: pw.ok ? pw.path! : tx("설치되어 있지 않음", "not installed"),
    fix: pw.ok ? "none" : "auto",
    command: ["bunx", "playwright", "install", "chromium"],
    // MCP 서버는 대상 프로젝트 폴더에서 돈다. 그 폴더에서 bunx 를 부르면 그 프로젝트의(또는 npm 최신) playwright 가 잡혀
    // 이 패키지가 쓰는 판과 다른 브라우저를 깐다. 이 패키지 폴더에서 실행해 고정된 판을 쓴다
    cwd: resolve(import.meta.dir, "../.."),
    neededFor: tx("Chrome 계열 실행(기본 내장 브라우저)", "running the Chrome family (the default built-in browser)"),
  });

  const chrome = firstExisting(CHROME_PATHS);
  checks.push({ id: "chrome", name: "Google Chrome", status: chrome ? "ok" : "na", detail: chrome ?? tx("없음(없어도 Chromium 으로 대체 가능)", "none (Chromium can be used instead)"), fix: "none" });
  const edge = firstExisting(EDGE_PATHS);
  checks.push({ id: "edge", name: "Microsoft Edge", status: edge ? "ok" : "na", detail: edge ?? tx("없음(선택 사항)", "none (optional)"), fix: "none" });

  const egoBin = which("ego-browser", env) ?? (existsSync(join(homedir(), ".local/bin/ego-browser")) ? join(homedir(), ".local/bin/ego-browser") : null);
  const egoApp = firstExisting(["/Applications/ego lite.app", join(homedir(), "Applications/ego lite.app")]);
  let egoWorks: boolean | null = null;
  if (egoBin) {
    const r = await run([egoBin, "nodejs", "-e", "console.log('ok')"], { env, timeoutMs: 20000 });
    egoWorks = r.code === 0 && r.out.includes("ok");
  }
  checks.push({
    id: "ego",
    name: tx("Ego Browser (ego-browser 명령 + ego lite 앱)", "Ego Browser (ego-browser command + ego lite app)"),
    status: egoBin && egoWorks ? "ok" : egoBin || egoApp ? "warn" : "na",
    detail: egoBin
      ? `${egoBin}${egoWorks ? tx(" — 동작 확인", " — works") : tx(" — 명령은 있으나 실행되지 않음(ego lite 앱을 켜고 온보딩을 마치세요)", " — the command exists but does not run (open the ego lite app and finish onboarding)")}`
      : egoApp
        ? tx("앱은 있으나 ego-browser 명령이 없음(온보딩을 마치면 PATH 에 등록됨)", "the app exists but the ego-browser command does not (it is added to PATH when onboarding is finished)")
        : tx("설치되어 있지 않음(Ego 를 쓰지 않으면 필요 없음)", "not installed (not needed if you do not use Ego)"),
    fix: egoBin && egoWorks ? "none" : "manual",
    manual: tx(
      "Ego 를 쓰려면: https://lite.ego.app/ 에서 ego lite 설치 → 앱을 열어 첫 실행 온보딩 완료(이때 ego-browser 명령이 PATH 에 등록됨). macOS 전용. Ego 는 MCP 서버가 아니라 스킬 + ego-browser 명령으로 동작하며, e2e-loop 는 그 명령을 직접 사용하므로 별도 MCP 등록은 필요 없다.",
      "To use Ego: install ego lite from https://lite.ego.app/ → open the app and finish the first-run onboarding (this adds the ego-browser command to PATH). macOS only. Ego is not an MCP server. It works through a skill and the ego-browser command, and e2e-loop calls that command directly, so no separate MCP registration is needed.",
    ),
    neededFor: tx("Ego 브라우저 선택 시", "when the Ego browser is chosen"),
  });

  const ff = which("ffmpeg", env);
  const brew = which("brew", env);
  const winget = which("winget", env);
  let ffCommand: string[] | undefined;
  let ffManual: string | undefined;
  if (platform === "darwin") {
    if (brew) ffCommand = [brew, "install", "ffmpeg"];
    else ffManual = tx("Homebrew 가 없습니다. https://brew.sh 에서 설치한 뒤 `brew install ffmpeg`", "Homebrew is not installed. Install it from https://brew.sh, then run `brew install ffmpeg`");
  } else if (platform === "win32") {
    if (winget) ffCommand = [winget, "install", "--id", "Gyan.FFmpeg", "-e"];
    else ffManual = tx("winget 이 없습니다. https://ffmpeg.org/download.html 에서 받아 PATH 에 추가", "winget is not installed. Download ffmpeg from https://ffmpeg.org/download.html and add it to PATH");
  } else ffManual = tx("패키지 관리자로 설치: 예) `sudo apt-get install -y ffmpeg` 또는 `sudo dnf install -y ffmpeg`", "Install with the package manager, for example `sudo apt-get install -y ffmpeg` or `sudo dnf install -y ffmpeg`");
  checks.push({
    id: "ffmpeg",
    name: "ffmpeg",
    status: ff ? "ok" : "missing",
    detail: ff ?? tx("없음", "none"),
    fix: ff ? "none" : ffCommand ? "ask" : "manual",
    command: ffCommand,
    manual: ffManual,
    neededFor: tx("영상을 mp4(h264) + 챕터 파일로 만들 때(Chrome 계열 webm 변환, Ego 화면 프레임을 영상으로 만들기)", "making videos as mp4 (h264) + chapter file (converting Chrome-family webm, turning Ego screen frames into video)"),
  });

  const git = which("git", env);
  checks.push({ id: "git", name: "git", status: git ? "ok" : "warn", detail: git ?? tx("없음 — 증거에 기록할 커밋 해시를 못 남김", "none — the commit hash cannot be recorded in the evidence"), fix: git ? "none" : "manual", manual: tx("git 설치: https://git-scm.com/downloads", "Install git: https://git-scm.com/downloads"), neededFor: tx("증거 기록(커밋 해시)", "evidence records (commit hash)") });

  const orca = which("orca", env);
  let orcaReady: boolean | null = null;
  if (orca) {
    const r = await run([orca, "status"], { env, timeoutMs: 15000 });
    orcaReady = r.code === 0 && /runtimeReachable:\s*true/.test(r.out);
  }
  checks.push({
    id: "orca",
    name: tx("Orca CLI (테스터 새 세션 자동 실행)", "Orca CLI (starts the new tester session automatically)"),
    status: orca ? (orcaReady === false ? "warn" : "ok") : "na",
    detail: orca ? `${orca}${orcaReady === false ? tx(" — 런타임에 연결되지 않음(Orca 앱을 켜세요)", " — not connected to the runtime (open the Orca app)") : ""}` : tx("없음 — 새 세션은 명령어를 사용자에게 주는 방식으로 대신한다", "none — for a new session, the command is given to the user instead"),
    fix: "none",
    neededFor: tx("테스터 세션", "tester session"),
  });

  let disk: number | null = null;
  try {
    const s = statfsSync("/");
    disk = Math.round((Number(s.bavail) * Number(s.bsize)) / 1e9);
  } catch {}
  checks.push({ id: "disk", name: tx("디스크 여유", "Free disk space"), status: disk === null ? "na" : disk < 5 ? "warn" : "ok", detail: disk === null ? tx("확인 불가", "cannot check") : `${disk}GB`, fix: "none", neededFor: tx("녹화 영상 보관", "storing recorded videos") });

  if (platform === "darwin") {
    const perm = await macPermissions(env);
    checks.push({
      id: "mac-accessibility",
      name: tx("macOS 접근성 권한 (컴퓨터 제어 도구)", "macOS Accessibility permission (computer control tool)"),
      status: perm.accessibility === true ? "ok" : perm.accessibility === false ? "warn" : "na",
      detail: perm.accessibility === true ? tx("허용됨", "allowed") : perm.accessibility === false ? tx("허용되지 않음", "not allowed") : tx("확인하지 못함", "could not check"),
      fix: "manual",
      manual: tx("시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 → 컴퓨터 제어 도구를 실행하는 앱 허용.", "System Settings → Privacy & Security → Accessibility → allow the app that runs the computer control tool."),
      neededFor: tx("브라우저 밖 OS 창(다운로드·파일 선택) 처리", "handling OS windows outside the browser (download, file chooser)"),
    });
  }
  return checks;
}
