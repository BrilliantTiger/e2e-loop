// 환경 점검: 무엇이 있고 무엇이 없는지 읽기만 한다. 설치는 install.ts 가 한다.
import { existsSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export async function runChecks(env: Env = process.env): Promise<Check[]> {
  const checks: Check[] = [];
  const platform = process.platform;

  checks.push({ id: "bun", name: "bun", status: "ok", detail: `bun ${Bun.version}`, fix: "none" });

  const pw = await checkPlaywrightChromium();
  checks.push({
    id: "playwright-chromium",
    name: "Playwright Chromium 브라우저",
    status: pw.ok ? "ok" : "missing",
    detail: pw.ok ? pw.path! : "설치되어 있지 않음",
    fix: pw.ok ? "none" : "auto",
    command: ["bunx", "playwright", "install", "chromium"],
    neededFor: "Chrome 계열 실행(기본 내장 브라우저)",
  });

  const chrome = firstExisting(CHROME_PATHS);
  checks.push({ id: "chrome", name: "Google Chrome", status: chrome ? "ok" : "na", detail: chrome ?? "없음(없어도 Chromium 으로 대체 가능)", fix: "none" });
  const edge = firstExisting(EDGE_PATHS);
  checks.push({ id: "edge", name: "Microsoft Edge", status: edge ? "ok" : "na", detail: edge ?? "없음(선택 사항)", fix: "none" });

  const egoBin = which("ego-browser", env) ?? (existsSync(join(homedir(), ".local/bin/ego-browser")) ? join(homedir(), ".local/bin/ego-browser") : null);
  const egoApp = firstExisting(["/Applications/ego lite.app", join(homedir(), "Applications/ego lite.app")]);
  let egoWorks: boolean | null = null;
  if (egoBin) {
    const r = await run([egoBin, "nodejs", "-e", "console.log('ok')"], { env, timeoutMs: 20000 });
    egoWorks = r.code === 0 && r.out.includes("ok");
  }
  checks.push({
    id: "ego",
    name: "Ego Browser (ego-browser 명령 + ego lite 앱)",
    status: egoBin && egoWorks ? "ok" : egoBin || egoApp ? "warn" : "na",
    detail: egoBin ? `${egoBin}${egoWorks ? " — 동작 확인" : " — 명령은 있으나 실행되지 않음(ego lite 앱을 켜고 온보딩을 마치세요)"}` : egoApp ? "앱은 있으나 ego-browser 명령이 없음(온보딩을 마치면 PATH 에 등록됨)" : "설치되어 있지 않음(Ego 를 쓰지 않으면 필요 없음)",
    fix: egoBin && egoWorks ? "none" : "manual",
    manual: "Ego 를 쓰려면: https://lite.ego.app/ 에서 ego lite 설치 → 앱을 열어 첫 실행 온보딩 완료(이때 ego-browser 명령이 PATH 에 등록됨). macOS 전용. Ego 는 MCP 서버가 아니라 스킬 + ego-browser 명령으로 동작하며, e2e-loop 는 그 명령을 직접 사용하므로 별도 MCP 등록은 필요 없다.",
    neededFor: "Ego 브라우저 선택 시",
  });

  const ff = which("ffmpeg", env);
  const brew = which("brew", env);
  const winget = which("winget", env);
  let ffCommand: string[] | undefined;
  let ffManual: string | undefined;
  if (platform === "darwin") {
    if (brew) ffCommand = [brew, "install", "ffmpeg"];
    else ffManual = "Homebrew 가 없습니다. https://brew.sh 에서 설치한 뒤 `brew install ffmpeg`";
  } else if (platform === "win32") {
    if (winget) ffCommand = [winget, "install", "--id", "Gyan.FFmpeg", "-e"];
    else ffManual = "winget 이 없습니다. https://ffmpeg.org/download.html 에서 받아 PATH 에 추가";
  } else ffManual = "패키지 관리자로 설치: 예) `sudo apt-get install -y ffmpeg` 또는 `sudo dnf install -y ffmpeg`";
  checks.push({
    id: "ffmpeg",
    name: "ffmpeg",
    status: ff ? "ok" : "missing",
    detail: ff ?? "없음",
    fix: ff ? "none" : ffCommand ? "ask" : "manual",
    command: ffCommand,
    manual: ffManual,
    neededFor: "영상을 mp4(h264) + 챕터 파일로 만들 때(Chrome 계열 webm 변환, Ego 창 녹화 후처리)",
  });

  const git = which("git", env);
  checks.push({ id: "git", name: "git", status: git ? "ok" : "warn", detail: git ?? "없음 — 증거에 기록할 커밋 해시를 못 남김", fix: git ? "none" : "manual", manual: "git 설치: https://git-scm.com/downloads", neededFor: "증거 기록(커밋 해시)" });

  const orca = which("orca", env);
  let orcaReady: boolean | null = null;
  if (orca) {
    const r = await run([orca, "status"], { env, timeoutMs: 15000 });
    orcaReady = r.code === 0 && /runtimeReachable:\s*true/.test(r.out);
  }
  checks.push({
    id: "orca",
    name: "Orca CLI (테스터 새 세션 자동 실행)",
    status: orca ? (orcaReady === false ? "warn" : "ok") : "na",
    detail: orca ? `${orca}${orcaReady === false ? " — 런타임에 연결되지 않음(Orca 앱을 켜세요)" : ""}` : "없음 — 새 세션은 명령어를 사용자에게 주는 방식으로 대신한다",
    fix: "none",
    neededFor: "테스터 세션",
  });

  let disk: number | null = null;
  try {
    const s = statfsSync("/");
    disk = Math.round((Number(s.bavail) * Number(s.bsize)) / 1e9);
  } catch {}
  checks.push({ id: "disk", name: "디스크 여유", status: disk === null ? "na" : disk < 5 ? "warn" : "ok", detail: disk === null ? "확인 불가" : `${disk}GB`, fix: "none", neededFor: "녹화 영상 보관" });

  if (platform === "darwin") {
    const perm = await macPermissions(env);
    checks.push({
      id: "mac-screen-recording",
      name: "macOS 화면 녹화 권한 (Ego 창 녹화)",
      status: perm.screenRecording === true ? "ok" : perm.screenRecording === false ? "warn" : "na",
      detail: perm.screenRecording === true ? "허용됨" : perm.screenRecording === false ? "허용되지 않음 — 시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음에서 터미널(또는 이 도구를 실행하는 앱)을 켜세요" : "확인하지 못함",
      fix: "manual",
      manual: "시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음 → 이 도구를 실행하는 앱 허용. 테스트 전 한 번만 하면 되는 설정 단계다.",
      neededFor: "Ego 선택 시 영상 녹화",
    });
    checks.push({
      id: "mac-accessibility",
      name: "macOS 접근성 권한 (컴퓨터 제어 도구)",
      status: perm.accessibility === true ? "ok" : perm.accessibility === false ? "warn" : "na",
      detail: perm.accessibility === true ? "허용됨" : perm.accessibility === false ? "허용되지 않음" : "확인하지 못함",
      fix: "manual",
      manual: "시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 → 컴퓨터 제어 도구를 실행하는 앱 허용.",
      neededFor: "브라우저 밖 OS 창(다운로드·파일 선택) 처리",
    });
  }
  return checks;
}
