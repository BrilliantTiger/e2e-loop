// 증거 처리: 영상(mp4 h264 + 챕터 파일, 대기 구간 줄이기), 스크린샷·영상에 커밋·시각·케이스 id·해시 기록, 보관 용량.
// ffmpeg 가 텍스트 그리기(drawtext)를 못 하는 빌드일 수 있어, 도장은 Chromium 으로 그린 PNG 를 overlay 로 얹는다.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CaseResult, RoundMeta, StepResult } from "./types.ts";
import type { Project } from "./store.ts";
import { run, which } from "./env/detect.ts";

export const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

export interface Chapter {
  title: string;
  startMs: number;
  endMs: number;
}

export interface FreezeSpan {
  start: number;
  end: number;
}

/** 길게 멈춘 구간(대기)을 앞뒤 keep 초만 남기고 줄인다. 줄여서 버리는 구간 목록을 돌려준다. */
export function dropSpans(freezes: FreezeSpan[], keep = 0.35, minFreeze = 1.2): FreezeSpan[] {
  return freezes.filter((f) => f.end - f.start > minFreeze && f.end - f.start - 2 * keep > 0.05).map((f) => ({ start: f.start + keep, end: f.end - keep }));
}

/** 원본 시각(초) → 줄인 영상의 시각(초) */
export function mapTime(t: number, drops: FreezeSpan[]): number {
  let cut = 0;
  for (const d of drops) {
    if (t >= d.end) cut += d.end - d.start;
    else if (t > d.start) cut += t - d.start;
  }
  return Math.max(0, t - cut);
}

/** 스텝 시작 시각들로 챕터를 만든다(시각은 영상 원본 기준 ms → 줄인 영상 기준으로 바꿔서). */
export function buildChapters(steps: Pick<StepResult, "i" | "desc" | "at">[], durationSec: number, drops: FreezeSpan[], skewMs = 0): Chapter[] {
  const pts = steps.filter((s) => typeof s.at === "number");
  const total = Math.round(mapTime(durationSec, drops) * 1000);
  if (!pts.length) return [{ title: "케이스 전체", startMs: 0, endMs: total }];
  return pts.map((s, k) => {
    const start = Math.round(mapTime(Math.max(0, (s.at! + skewMs) / 1000), drops) * 1000);
    const next = pts[k + 1];
    const end = next ? Math.round(mapTime(Math.max(0, (next.at! + skewMs) / 1000), drops) * 1000) : total;
    return { title: `${s.i + 1}. ${s.desc}`.slice(0, 90), startMs: Math.min(start, total), endMs: Math.max(Math.min(end, total), Math.min(start, total) + 1) };
  });
}

export function chaptersFile(meta: { title: string; comment: string }, chapters: Chapter[]): string {
  const esc = (s: string) => s.replace(/([=;#\\\n])/g, "\\$1");
  const out = [";FFMETADATA1", `title=${esc(meta.title)}`, `comment=${esc(meta.comment)}`];
  for (const c of chapters) out.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${c.startMs}`, `END=${c.endMs}`, `title=${esc(c.title)}`);
  return out.join("\n") + "\n";
}



export interface KitOpts {
  project: Project;
  roundId: string;
  commit?: string;
}

/** 한 회차의 증거 처리기. 도장 이미지를 그리려고 Chromium 을 한 번만 띄워 재사용한다. */
export class EvidenceKit {
  readonly ffmpeg = which("ffmpeg");
  readonly ffprobe = which("ffprobe");
  warnings: string[] = [];
  manifest: { case: string; file: string; kind: "screenshot" | "video"; sha256: string; rawSha256: string; commit: string; at: string }[] = [];
  private browser?: import("playwright").Browser;
  private page?: import("playwright").Page;
  private stampCache = new Map<string, string>();
  private stampBroken = false;
  constructor(private o: KitOpts) {
    if (!this.ffmpeg) this.warnings.push("ffmpeg 가 없어 영상을 mp4 로 바꾸지 못하고 스크린샷에 도장을 찍지 못했습니다(원본 그대로 보관). e2e_doctor 로 설치하세요.");
  }
  get commit() {
    return this.o.commit ?? "no-git";
  }
  private dir() {
    const d = join(this.o.project.roundDir(this.o.roundId), "_stamps");
    mkdirSync(d, { recursive: true });
    return d;
  }

  /** 도장 PNG: "커밋 | 시각 | 케이스 id | 해시" 한 줄 */
  async stampPng(text: string): Promise<string | null> {
    if (this.stampBroken) return null;
    const cached = this.stampCache.get(text);
    if (cached) return cached;
    try {
      if (!this.page) {
        const { chromium } = await import("playwright");
        this.browser = await chromium.launch({ headless: true });
        this.page = await this.browser.newPage({ viewport: { width: 1400, height: 60 } });
      }
      const esc = text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
      await this.page.setContent(`<body style="margin:0;background:transparent"><span id="s" style="display:inline-block;font:12px/18px ui-monospace,Menlo,monospace;color:#fff;background:rgba(0,0,0,.78);padding:2px 8px;white-space:nowrap">${esc}</span></body>`);
      const out = join(this.dir(), `stamp-${createHash("sha1").update(text).digest("hex").slice(0, 10)}.png`);
      await this.page.locator("#s").screenshot({ path: out, omitBackground: true });
      this.stampCache.set(text, out);
      return out;
    } catch (e: any) {
      this.stampBroken = true;
      this.warnings.push(`도장 이미지를 만들지 못해 커밋·시각 표시 없이 보관합니다(Playwright Chromium 필요): ${String(e?.message ?? e).slice(0, 120)}`);
      return null;
    }
  }

  stampLine(caseId: string, rawSha: string, at = new Date().toISOString()) {
    return `${this.commit.slice(0, 7)} | ${at} | ${caseId} | sha256:${rawSha.slice(0, 10)}`;
  }

  /** 스크린샷 왼쪽 아래에 도장을 찍는다. 도장의 해시는 찍기 전 원본의 sha256. */
  async stampImage(file: string, caseId: string): Promise<{ sha256: string; rawSha256: string } | null> {
    if (!existsSync(file)) return null;
    const raw = sha256File(file);
    const at = new Date().toISOString();
    let final = raw;
    if (this.ffmpeg) {
      const png = await this.stampPng(this.stampLine(caseId, raw, at));
      if (png) {
        const tmp = file.replace(/\.png$/, ".stamped.png");
        const r = await run([this.ffmpeg, "-y", "-loglevel", "error", "-i", file, "-i", png, "-filter_complex", "overlay=0:main_h-overlay_h", "-frames:v", "1", tmp], { timeoutMs: 30000 });
        if (r.code === 0 && existsSync(tmp)) {
          renameSync(tmp, file);
          final = sha256File(file);
        } else rmSync(tmp, { force: true });
      }
    }
    this.manifest.push({ case: caseId, file: this.rel(file), kind: "screenshot", sha256: final, rawSha256: raw, commit: this.commit, at });
    return { sha256: final, rawSha256: raw };
  }

  private rel(p: string) {
    return p.startsWith(this.o.project.roundDir(this.o.roundId)) ? p.slice(this.o.project.roundDir(this.o.roundId).length + 1) : p;
  }

  /** 영상 하나를 mp4(h264)로 바꾸고 대기 구간을 줄이고 도장·챕터를 넣는다. 실패하면 원본을 그대로 둔다. */
  async processVideo(rawPath: string, result: Pick<CaseResult, "id" | "title" | "steps" | "startedAt">, opts: { skewMs?: number } = {}): Promise<{ video: string; chapters?: string } | null> {
    if (!existsSync(rawPath)) return null;
    const rawSha = sha256File(rawPath);
    if (!this.ffmpeg || !this.ffprobe) return { video: rawPath };
    const base = rawPath.replace(/\.[^.]+$/, "");
    const mp4 = rawPath.endsWith(".mp4") ? base + ".out.mp4" : base + ".mp4"; // 입력과 같은 이름으로는 쓸 수 없다
    const meta = base + ".chapters.txt";
    try {
      const dur = parseFloat((await run([this.ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", rawPath], { timeoutMs: 30000 })).out);
      if (!(dur > 0)) throw new Error("영상 길이를 읽지 못함");
      // 1) 멈춘(대기) 구간 찾기
      const fz = await run([this.ffmpeg, "-hide_banner", "-nostats", "-i", rawPath, "-vf", "freezedetect=n=-55dB:d=1.2", "-an", "-f", "null", "-"], { timeoutMs: 120000 });
      const spans: FreezeSpan[] = [];
      let cur: number | null = null;
      for (const ln of fz.out.split("\n")) {
        const s = ln.match(/freeze_start:\s*([\d.]+)/);
        const e = ln.match(/freeze_end:\s*([\d.]+)/);
        if (s) cur = parseFloat(s[1]!);
        if (e && cur !== null) {
          spans.push({ start: cur, end: parseFloat(e[1]!) });
          cur = null;
        }
      }
      if (cur !== null) spans.push({ start: cur, end: dur });
      const drops = dropSpans(spans);
      // 2) 남길 구간을 이어 붙이고 도장을 얹는다
      const keeps: FreezeSpan[] = [];
      let p = 0;
      for (const d of drops) {
        if (d.start > p) keeps.push({ start: p, end: d.start });
        p = d.end;
      }
      if (p < dur) keeps.push({ start: p, end: dur });
      const parts = keeps.map((k, i) => `[0:v]trim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
      const concat = keeps.length > 1 ? `${keeps.map((_, i) => `[v${i}]`).join("")}concat=n=${keeps.length}:v=1:a=0[cat]` : `[v0]null[cat]`;
      const stampTxt = this.stampLine(result.id, rawSha, result.startedAt);
      const png = await this.stampPng(stampTxt);
      const graph = [...parts, concat, png ? `[cat][1:v]overlay=0:main_h-overlay_h[out]` : `[cat]null[out]`].join(";");
      const chapters = buildChapters(result.steps, dur, drops, opts.skewMs ?? 0);
      writeFileSync(meta, chaptersFile({ title: `${result.id} ${result.title}`, comment: `commit=${this.commit};time=${result.startedAt};case=${result.id};rawsha256=${rawSha}` }, chapters));
      writeFileSync(base + ".chapters.json", JSON.stringify({ case: result.id, commit: this.commit, startedAt: result.startedAt, rawSha256: rawSha, droppedIdleSeconds: Math.round(drops.reduce((a, d) => a + d.end - d.start, 0) * 10) / 10, chapters }, null, 1));
      const args = [this.ffmpeg, "-y", "-loglevel", "error", "-i", rawPath, ...(png ? ["-i", png] : []), "-i", meta, "-filter_complex", graph, "-map", "[out]", "-map_metadata", String(png ? 2 : 1), "-map_chapters", String(png ? 2 : 1), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-preset", "veryfast", "-movflags", "+faststart", mp4];
      const r = await run(args, { timeoutMs: 300000 });
      if (r.code !== 0 || !existsSync(mp4)) throw new Error(r.out.slice(-200) || "ffmpeg 실패");
      rmSync(rawPath, { force: true });
      this.manifest.push({ case: result.id, file: this.rel(mp4), kind: "video", sha256: sha256File(mp4), rawSha256: rawSha, commit: this.commit, at: result.startedAt });
      return { video: mp4, chapters: meta };
    } catch (e: any) {
      this.warnings.push(`영상 변환 실패(${result.id}), 원본을 그대로 보관합니다: ${String(e?.message ?? e).slice(0, 160)}`);
      rmSync(mp4, { force: true });
      return { video: rawPath };
    }
  }

  writeManifest() {
    const dir = this.o.project.roundDir(this.o.roundId);
    writeFileSync(join(dir, "evidence.json"), JSON.stringify({ round: this.o.roundId, commit: this.commit, files: this.manifest }, null, 1));
    rmSync(join(dir, "_stamps"), { recursive: true, force: true });
  }

  async close() {
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
    this.page = undefined;
  }
}

// ---------- 보관 용량 ----------

export function dirSize(dir: string): number {
  let n = 0;
  const rec = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) rec(p);
        else n += st.size;
      } catch {}
    }
  };
  rec(dir);
  return n;
}

export interface Usage {
  usedMB: number;
  limitMB: number;
  percent: number;
  perRound: { round: string; mb: number }[];
  level: "ok" | "warn" | "over";
}

export function evidenceUsage(project: Project): Usage {
  const limitMB = project.config().evidenceLimitMB;
  const perRound = project.rounds().map((r) => ({ round: r.id, mb: Math.round((dirSize(project.roundDir(r.id)) / 1e6) * 10) / 10 }));
  const usedMB = Math.round(perRound.reduce((a, r) => a + r.mb, 0) * 10) / 10;
  const percent = Math.round((usedMB / limitMB) * 100);
  return { usedMB, limitMB, percent, perRound, level: usedMB >= limitMB ? "over" : percent >= 80 ? "warn" : "ok" };
}

/** 오래된 회차의 증거(영상·스크린샷·trace)만 지운다. 결과·보고서·메타는 남긴다. */
export function pruneEvidence(project: Project, keepLast: number): { pruned: string[]; freedMB: number } {
  const finished = project.rounds().filter((r) => r.status !== "running");
  const targets = finished.slice(0, Math.max(0, finished.length - keepLast));
  let freed = 0;
  const pruned: string[] = [];
  for (const r of targets) {
    const ev = join(project.roundDir(r.id), "evidence");
    if (!existsSync(ev)) continue;
    freed += dirSize(ev);
    rmSync(ev, { recursive: true, force: true });
    writeFileSync(join(project.roundDir(r.id), "evidence-pruned.txt"), `증거(영상·스크린샷)를 ${new Date().toISOString()} 에 지웠습니다. 결과·보고서는 남아 있습니다.\n`);
    pruned.push(r.id);
  }
  return { pruned, freedMB: Math.round((freed / 1e6) * 10) / 10 };
}

