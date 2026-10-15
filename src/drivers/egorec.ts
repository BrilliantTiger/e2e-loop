// Ego 작업 공간(space)의 페이지 화면을 브라우저 안쪽(CDP)에서 직접 프레임으로 받아 영상으로 만든다.
// Ego 도 Chromium 기반이라 창이 가려져 있거나 다른 작업이 앞에 보여도(탭이 뒤에 있어도) 캡처된다. 화면 녹화 권한도 필요 없다.
// 프레임(jpg)은 파일 이름에 찍힌 시각(ms)을 가지고, 이 시각 차이로 재생 시간을 정해 mp4(h264)로 만든다.
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, which, type Env } from "../env/detect.ts";

export interface Frame {
  file: string;
  at: number;
}

/** 프레임 파일 이름: f000001_<epoch ms>.jpg */
export function listFrames(dir: string): Frame[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => ({ n, m: n.match(/^f(\d+)_(\d+)\.jpg$/) }))
    .filter((x) => x.m)
    .map((x) => ({ file: join(dir, x.n), at: Number(x.m![2]), seq: Number(x.m![1]) }))
    .sort((a, b) => a.seq - b.seq)
    .map(({ file, at }) => ({ file, at }));
}

/** ffmpeg concat 목록: 각 프레임을 다음 프레임까지의 시간만큼 보여 준다(마지막은 lastMs). 재생 시간이 실제 시각과 같아진다. */
export function concatList(frames: Frame[], lastMs = 300): string {
  const lines: string[] = [];
  frames.forEach((f, i) => {
    const next = frames[i + 1];
    const dur = Math.max(0.001, ((next ? next.at - f.at : lastMs) as number) / 1000);
    lines.push(`file '${f.file.replace(/'/g, "'\\''")}'`, `duration ${dur.toFixed(3)}`);
  });
  if (frames.length) lines.push(`file '${frames[frames.length - 1]!.file.replace(/'/g, "'\\''")}'`); // concat 은 마지막 file 을 한 번 더 요구한다
  return lines.join("\n") + "\n";
}

/** 프레임들을 mp4(h264)로 만든다. 성공하면 프레임을 지우고 영상 경로를, 못 하면 이유를 돌려준다. */
export async function buildVideoFromFrames(dir: string, out: string, env: Env = process.env): Promise<{ video?: string; frames: number; warn?: string }> {
  const frames = listFrames(dir);
  if (!frames.length) return { frames: 0, warn: "Ego 화면 프레임을 하나도 받지 못해 영상을 만들지 못했습니다." };
  const ffmpeg = which("ffmpeg", env);
  if (!ffmpeg) return { frames: frames.length, warn: "ffmpeg 가 없어 Ego 프레임을 영상으로 만들지 못했습니다(e2e_doctor 로 설치)." };
  const list = join(dir, "frames.txt");
  writeFileSync(list, concatList(frames));
  const r = await run([ffmpeg, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-fps_mode", "passthrough", out], { env, timeoutMs: 300000 });
  if (r.code !== 0 || !existsSync(out)) return { frames: frames.length, warn: `Ego 프레임을 영상으로 만들지 못했습니다: ${r.out.slice(-160)}` };
  if (!process.env.E2E_KEEP_FRAMES) for (const f of frames) rmSync(f.file, { force: true });
  rmSync(list, { force: true });
  return { video: out, frames: frames.length };
}
