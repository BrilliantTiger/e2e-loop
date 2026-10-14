import type { Config, DriverName } from "../types.ts";

export interface Drained {
  console: string[];
  pageErrors: string[];
  failedRequests: string[];
}

/** 브라우저가 보낸 API 요청(fetch·XHR) 한 건 */
export interface NetEntry {
  method: string;
  /** 경로+쿼리 */
  url: string;
  origin: string;
  status: number;
  contentType?: string;
  jsonKeys?: string[];
  jsonArray?: boolean;
}

/** 브라우저 밖 OS 창이 필요해서 이 드라이버로는 직접 할 수 없는 동작 */
export class OsWindowRequired extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "OsWindowRequired";
  }
}

export interface DPage {
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  click(sel: string, label?: string): Promise<void>;
  dblclick(sel: string): Promise<void>;
  hover(sel: string): Promise<void>;
  fill(sel: string, value: string): Promise<void>;
  selectOption(sel: string, value: string): Promise<void>;
  check(sel: string, on: boolean): Promise<void>;
  press(sel: string | null, key: string): Promise<void>;
  waitFor(sel: string, state: "visible" | "hidden" | "attached" | "detached", timeout: number): Promise<void>;
  count(sel: string): Promise<number>;
  isVisible(sel: string): Promise<boolean>;
  text(sel: string): Promise<string>;
  value(sel: string): Promise<string>;
  evaluate<T = any>(expr: string): Promise<T>;
  url(): Promise<string>;
  title(): Promise<string>;
  screenshot(path: string): Promise<void>;
  /** 마지막 drain 이후 모인 콘솔 오류·페이지 오류·실패 요청 */
  drain(): Promise<Drained>;
  /** 마지막 호출 이후 브라우저가 보낸 API 요청(fetch·XHR)과 응답 */
  drainNet(): Promise<NetEntry[]>;
  /** 파일 선택 창을 거치지 않고 input[type=file] 에 파일을 넣는다 */
  upload(sel: string, filePath: string): Promise<void>;
  /** sel 을 눌러 시작된 다운로드를 dir 에 저장한다. timeoutMs 안에 다운로드가 없으면 null */
  download(sel: string, dir: string, timeoutMs: number): Promise<{ filename: string; size: number; path: string } | null>;
}

export interface Session {
  page: DPage;
  finish(passed: boolean): Promise<{ video?: string; trace?: string }>;
}

export interface Driver {
  name: string;
  capabilities: { video: boolean; network: boolean; /** 파일 선택·다운로드를 OS 창 없이 직접 다룰 수 있는가 */ files: boolean };
  open(): Promise<void>;
  newSession(evidenceDir: string): Promise<Session>;
  close(): Promise<void>;
}

export async function detectEnv() {
  const { existsSync } = await import("node:fs");
  const which = (c: string) => Bun.which(c) ?? null;
  const home = process.env.HOME ?? "";
  const ego = which("ego-browser") ?? (existsSync(`${home}/.local/bin/ego-browser`) ? `${home}/.local/bin/ego-browser` : null);
  const first = (ps: string[]) => ps.find((p) => existsSync(p)) ?? null;
  const chrome = first(["/Applications/Google Chrome.app", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "C:/Program Files/Google/Chrome/Application/chrome.exe"]);
  const edge = first(["/Applications/Microsoft Edge.app", "/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]);
  return { ego, chrome, edge };
}

/** 설정과 설치 상태로 실제 쓸 브라우저를 정한다. */
export async function pickDriverName(cfg: Config, want?: DriverName): Promise<"ego" | "chrome" | "edge" | "chromium"> {
  const name = want ?? cfg.driver;
  const env = await detectEnv();
  let pick: "ego" | "chrome" | "edge" | "chromium";
  if (name === "auto") pick = env.ego ? "ego" : env.chrome ? "chrome" : env.edge ? "edge" : "chromium";
  else pick = name;
  if (pick === "ego" && !env.ego) throw new Error("ego-browser 가 설치돼 있지 않습니다. driver 를 chrome/edge/chromium 으로 바꾸거나 ego lite 를 설치하세요(e2e_doctor 참고).");
  if (pick === "chrome" && !env.chrome) throw new Error("Google Chrome 이 설치돼 있지 않습니다. driver 를 chromium 으로 바꾸세요(e2e_doctor fix 로 설치).");
  if (pick === "edge" && !env.edge) throw new Error("Microsoft Edge 가 설치돼 있지 않습니다. driver 를 chrome/chromium 으로 바꾸세요.");
  return pick;
}

export async function resolveDriver(cfg: Config, want?: DriverName): Promise<Driver> {
  const pick = await pickDriverName(cfg, want);
  const env = await detectEnv();
  if (pick === "ego") {
    const { EgoDriver } = await import("./ego.ts");
    return new EgoDriver(cfg, env.ego!);
  }
  const { PwDriver } = await import("./playwright.ts");
  return new PwDriver(cfg, pick);
}
