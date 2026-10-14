import type { Config, DriverName } from "../types.ts";

export interface Drained {
  console: string[];
  pageErrors: string[];
  failedRequests: string[];
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
}

export interface Session {
  page: DPage;
  finish(passed: boolean): Promise<{ video?: string; trace?: string }>;
}

export interface Driver {
  name: string;
  capabilities: { video: boolean; network: boolean };
  open(): Promise<void>;
  newSession(evidenceDir: string): Promise<Session>;
  close(): Promise<void>;
}

export async function detectEnv() {
  const which = async (c: string) => {
    const p = Bun.spawn(["/bin/sh", "-lc", `command -v ${c}`], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    return out || null;
  };
  const ego = (await which("ego-browser")) ?? (Bun.file(`${process.env.HOME}/.local/bin/ego-browser`).size ? `${process.env.HOME}/.local/bin/ego-browser` : null);
  const chromeApp = [
    "/Applications/Google Chrome.app",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ].find((p) => {
    try {
      return require("node:fs").existsSync(p);
    } catch {
      return false;
    }
  });
  return { ego, chrome: chromeApp ?? null };
}

export async function resolveDriver(cfg: Config, want?: DriverName): Promise<Driver> {
  const name = want ?? cfg.driver;
  const env = await detectEnv();
  let pick: "ego" | "chrome" | "chromium";
  if (name === "auto") pick = env.ego ? "ego" : env.chrome ? "chrome" : "chromium";
  else pick = name;
  if (pick === "ego" && !env.ego) throw new Error("ego-browser 가 설치돼 있지 않습니다. driver 를 chrome/chromium 으로 바꾸거나 ego lite 를 설치하세요.");
  if (pick === "chrome" && !env.chrome) throw new Error("Google Chrome 이 설치돼 있지 않습니다. driver 를 chromium 으로 바꾸세요(playwright 가 내려받음).");
  if (pick === "ego") {
    const { EgoDriver } = await import("./ego.ts");
    return new EgoDriver(cfg, env.ego!);
  }
  const { PwDriver } = await import("./playwright.ts");
  return new PwDriver(cfg, pick);
}
