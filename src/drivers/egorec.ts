// Ego 창 녹화: macOS 에서 창 하나만 `screencapture -v -l<창ID>` 로 녹화한다.
// 창 ID 는 CoreGraphics 창 목록에서 찾는다(osascript JXA). 후처리(대기 구간 줄이기·챕터·mp4)는 evidence.ts 가 한다.
import { existsSync, statSync } from "node:fs";
import type { Env } from "../env/detect.ts";
import { which } from "../env/detect.ts";

export interface EgoWindow {
  id: number;
  name: string;
  owner: string;
  width: number;
  height: number;
}

const JXA = `ObjC.import("CoreGraphics");
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)));
JSON.stringify(list.filter(w => /ego/i.test(w.kCGWindowOwnerName || "") && w.kCGWindowLayer === 0).map(w => ({ id: w.kCGWindowNumber, name: w.kCGWindowName || "", owner: w.kCGWindowOwnerName, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height })));`;

export async function listEgoWindows(env: Env = process.env): Promise<EgoWindow[]> {
  const bin = which("osascript", env);
  if (!bin) return [];
  try {
    const p = Bun.spawn([bin, "-l", "JavaScript", "-e", JXA], { stdout: "pipe", stderr: "pipe", env: env as Record<string, string> });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return JSON.parse(out.trim() || "[]");
  } catch {
    return [];
  }
}

/** 작업 공간 이름이 제목에 든, 충분히 큰 창. 다른 작업이 보이는 창은 고르지 않는다. */
export async function findEgoWindow(spaceName: string, opts: { env?: Env; waitMs?: number } = {}): Promise<EgoWindow | null> {
  const until = Date.now() + (opts.waitMs ?? 2500);
  for (;;) {
    const w = (await listEgoWindows(opts.env)).find((x) => x.name.includes(spaceName) && x.width > 300 && x.height > 200);
    if (w) return w;
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 400));
  }
}

export interface WindowRecording {
  stop(): Promise<{ video?: string; warn?: string }>;
}

/** 창 하나를 녹화한다. 시작하지 못하면 이유(warn)를 돌려준다 — 영상이 없어도 스크린샷으로 증거는 남는다. */
export async function startWindowRecording(out: string, spaceName: string, opts: { env?: Env; waitMs?: number } = {}): Promise<WindowRecording | { warn: string }> {
  const env = opts.env ?? process.env;
  const bin = which("screencapture", env);
  if (!bin) return { warn: "screencapture 가 없어 Ego 창 녹화를 하지 못했습니다(macOS 전용). 스크린샷으로만 증거를 남깁니다." };
  const win = await findEgoWindow(spaceName, { env, waitMs: opts.waitMs });
  if (!win) return { warn: `Ego 창 녹화를 하지 못했습니다: “${spaceName}” 작업이 보이는 Ego 창을 찾지 못했습니다(다른 작업이 앞에 보이거나 창이 가려졌을 수 있음). 스크린샷으로만 증거를 남깁니다.` };
  const proc = Bun.spawn([bin, "-v", "-x", `-l${win.id}`, out], { stdout: "pipe", stderr: "pipe", env: env as Record<string, string> });
  await new Promise((r) => setTimeout(r, 600));
  if (proc.exitCode !== null) {
    const err = (await new Response(proc.stderr).text()).trim();
    return { warn: `Ego 창 녹화를 시작하지 못했습니다(화면 녹화 권한 확인): ${err.slice(0, 160)}` };
  }
  return {
    async stop() {
      proc.kill("SIGINT"); // screencapture 는 SIGINT 를 받아야 파일을 마무리한다
      await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 10000))]);
      if (proc.exitCode === null) proc.kill();
      if (existsSync(out) && statSync(out).size > 0) return { video: out };
      return { warn: "Ego 창 녹화 파일이 만들어지지 않았습니다." };
    },
  };
}
