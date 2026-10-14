import { existsSync, statfsSync } from "node:fs";
import { chromium } from "playwright";
import { detectEnv } from "./drivers/index.ts";

export interface DoctorReport {
  ok: boolean;
  bun: string;
  playwright: { package: string; chromium: boolean; path?: string };
  chrome: string | null;
  ego: { path: string | null; works?: boolean };
  git: boolean;
  diskFreeGB?: number;
  driver_choices: { value: string; available: boolean; note: string }[];
  auto_would_use: string;
  actions: string[];
  problems: string[];
}

async function run(cmd: string[], timeout = 600000) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill(), timeout);
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(t);
  return { code: await p.exited, out: (o + e).trim() };
}

export async function doctor(fix: boolean): Promise<DoctorReport> {
  const actions: string[] = [];
  const problems: string[] = [];
  const env = await detectEnv();
  let chromiumPath: string | undefined;
  try {
    chromiumPath = chromium.executablePath();
  } catch {}
  let hasChromium = !!chromiumPath && existsSync(chromiumPath);
  if (!hasChromium && fix) {
    actions.push("playwright chromium 내려받는 중 (bunx playwright install chromium)");
    const r = await run(["bunx", "playwright", "install", "chromium"]);
    actions.push(r.code === 0 ? "playwright chromium 설치 완료" : `playwright chromium 설치 실패: ${r.out.slice(-300)}`);
    try {
      chromiumPath = chromium.executablePath();
      hasChromium = !!chromiumPath && existsSync(chromiumPath);
    } catch {}
  }
  if (!hasChromium) problems.push("playwright chromium 이 없습니다. e2e_doctor(fix=true) 또는 `bunx playwright install chromium`");
  let egoWorks: boolean | undefined;
  if (env.ego) {
    const r = await run([env.ego, "nodejs", "-e", "console.log('ok')"], 20000).catch(() => ({ code: 1, out: "" }));
    egoWorks = r.code === 0 && r.out.includes("ok");
    if (!egoWorks) problems.push("ego-browser 명령은 있으나 실행이 안 됩니다. ego lite 앱을 켜고 온보딩을 마치세요.");
  }
  const git = (await run(["git", "--version"]).catch(() => ({ code: 1, out: "" }))).code === 0;
  let disk: number | undefined;
  try {
    const s = statfsSync("/");
    disk = Math.round((Number(s.bavail) * Number(s.bsize)) / 1e9);
    if (disk < 5) problems.push(`디스크 여유 ${disk}GB — 녹화 영상이 쌓이면 부족할 수 있습니다`);
  } catch {}
  const egoOk = !!env.ego && egoWorks !== false;
  const choices = [
    { value: "ego", available: egoOk, note: egoOk ? "ego lite 브라우저로 실제 화면 조작(영상 대신 단계별 스크린샷, 네트워크 감시 없음)" : "ego-browser 없음 — ego lite 설치: sh ~/.claude/skills/ego-browser/scripts/install.sh 후 온보딩" },
    { value: "chrome", available: !!env.chrome, note: env.chrome ? "설치된 Google Chrome 을 Playwright 로 조작(영상·trace·네트워크 감시)" : "Google Chrome 없음" },
    { value: "chromium", available: hasChromium, note: hasChromium ? "Playwright 내장 Chromium(영상·trace·네트워크 감시)" : "chromium 미설치 — e2e_doctor(fix=true)" },
  ];
  const auto = egoOk ? "ego" : env.chrome ? "chrome" : hasChromium ? "chromium" : "(없음)";
  return {
    ok: problems.length === 0 && auto !== "(없음)",
    bun: Bun.version,
    playwright: { package: require("playwright/package.json").version, chromium: hasChromium, path: chromiumPath },
    chrome: env.chrome,
    ego: { path: env.ego, works: egoWorks },
    git,
    diskFreeGB: disk,
    driver_choices: choices,
    auto_would_use: auto,
    actions,
    problems,
  };
}
