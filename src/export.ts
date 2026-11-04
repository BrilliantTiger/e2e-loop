// 보고서 내보내기: PDF · 엑셀용 CSV · 한 파일 HTML. 현황판 버튼과 MCP 도구(e2e_report_export)·CLI(export)가 같이 쓴다.
// 결과 기록(results.json)으로 다시 그리므로 예전 라운드도 지금 형식(그래프·이슈 목록)으로 나온다.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import type { CaseResult, RoundMeta, Verdict } from "./types.ts";
import type { Project } from "./store.ts";
import { renderHuman, sheetData, type Embed } from "./sheets.ts";
import { NOW_KO, STATUS_KO, issueFlow } from "./charts.ts";

export type ExportFormat = "pdf" | "csv" | "html";
export const EXPORT_FORMATS: readonly ExportFormat[] = ["pdf", "csv", "html"];
/** 한 파일 HTML·PDF 에 넣는 스크린샷 용량 합계 상한 */
export const EMBED_LIMIT = 40 * 1024 * 1024;

export interface ExportResult {
  round: string;
  dir: string;
  files: { pdf?: string; html?: string; csv?: { issues: string; history: string; rounds: string } };
  notes: string[];
}

/** 내보낼 라운드: 주면 그 라운드, 생략하면 마지막으로 끝난 라운드. 진행 중 라운드는 내보내지 않는다 */
export function exportRound(project: Project, round?: string): RoundMeta {
  const rounds = project.rounds();
  const r = round ? rounds.find((x) => x.id === round) : [...rounds].reverse().find((x) => x.status !== "running");
  if (!r) throw new Error(round ? `라운드 ${round} 가 없습니다` : "끝난 라운드가 없습니다");
  if (r.status === "running") throw new Error(`${r.id} 는 아직 진행 중입니다. 라운드가 끝난 뒤 내보내세요`);
  return r;
}

/** 형식 목록 읽기: 배열이나 "pdf,csv" 같은 글자. 생략하면 셋 다 */
export function parseFormats(v: unknown): ExportFormat[] {
  if (v === undefined || v === null || v === true || v === "") return [...EXPORT_FORMATS];
  const list = (Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((x) => !EXPORT_FORMATS.includes(x as ExportFormat));
  if (bad.length) throw new Error(`모르는 내보내기 형식: ${bad.join(", ")} (pdf · csv · html 중에서 고르세요)`);
  return [...new Set(list)] as ExportFormat[];
}

// ---------- CSV ----------

/** 엑셀이 수식으로 읽는 글자(= + - @ 로 시작)는 앞에 ' 를 붙인다 — 사이트에서 읽은 글자가 셀에 들어가므로 수식 주입을 막는다 */
function cell(v: unknown): string {
  let s = v === undefined || v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) && s !== "-") s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** 엑셀에서 한글이 깨지지 않게 UTF-8 BOM 을 붙이고, 줄 끝은 CRLF */
export const toCsv = (rows: unknown[][]) => "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

const ko = (s?: Verdict | string) => (s ? (STATUS_KO[s] ?? s) : "돌리지 않음");

/** summary 가 없는 라운드(중단 등)는 결과에서 센다 */
function withSummary(meta: RoundMeta, results: CaseResult[]): RoundMeta {
  if (meta.summary) return meta;
  const cnt: Record<Verdict, number> = { PASS: 0, FAIL: 0, FLAKY: 0, BLOCKED: 0, SKIP: 0, NA: 0 };
  for (const r of results) cnt[r.status] = (cnt[r.status] ?? 0) + 1;
  return { ...meta, summary: { ...cnt, total: results.length } };
}

// ---------- PDF ----------

let pdfQueue: Promise<unknown> = Promise.resolve();
/** PDF 는 브라우저를 띄우므로 한 번에 하나씩 만든다(현황판에서 여러 번 눌러도) */
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = pdfQueue.then(fn, fn);
  pdfQueue = run.catch(() => {});
  return run;
}

async function launchForPdf(): Promise<Browser> {
  const errs: string[] = [];
  // Playwright 의 Chromium 이 없으면 설치된 Chrome·Edge 로 만든다
  for (const channel of [undefined, "chrome", "msedge"] as const) {
    try {
      return await chromium.launch({ headless: true, channel });
    } catch (e: any) {
      errs.push(`${channel ?? "chromium"}: ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
  throw new Error(`PDF 를 만들 브라우저를 띄우지 못했습니다(Playwright Chromium·Chrome·Edge 모두 실패). sh install.sh 로 Playwright 브라우저를 설치하세요 — ${errs.join(" / ")}`);
}

async function htmlToPdf(html: string, out: string, round: string) {
  const browser = await launchForPdf();
  try {
    const page = await browser.newPage();
    await page.emulateMedia({ media: "print", colorScheme: "light" });
    await page.setContent(html, { waitUntil: "load", timeout: 120_000 });
    await page.pdf({
      path: out,
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "14mm", left: "10mm", right: "10mm" },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="font-size:8px;width:100%;text-align:center;color:#888">E2E ${round} · <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- 진입점 ----------

/** 라운드 보고서를 rounds/<라운드>/export/ 에 내보낸다 */
export async function exportReport(project: Project, opts: { round?: string; formats?: unknown } = {}): Promise<ExportResult> {
  const formats = parseFormats(opts.formats);
  const m0 = exportRound(project, opts.round);
  const results = project.readJson<CaseResult[]>(`rounds/${m0.id}/results.json`, []);
  if (!results.length) throw new Error(`${m0.id} 에 결과가 없습니다`);
  const meta = withSummary(m0, results);
  const d = sheetData(project, meta, results);
  const dir = join(d.dir, "export");
  mkdirSync(dir, { recursive: true });
  const out: ExportResult = { round: meta.id, dir, files: {}, notes: [] };

  if (formats.includes("csv")) {
    const flow = issueFlow(project, meta, results);
    const issues = toCsv([
      ["순위", "상태", "케이스", "제목", "화면", "기능", "근거", "증상", "재현 단계", "기대", "실제", "힌트", "스크린샷", "영상", "영상 위치"],
      ...d.issues.map((i) => [i.priority ?? "", ko(i.status), i.id, i.title, i.screen ?? "", i.feature ?? "", i.source_ref ?? "", i.symptom, i.reproduction.map((x) => `${x.n}. ${x.action} → ${x.result}`).join("\n"), i.expected, i.actual, i.hint, i.evidence.screenshot ?? "", i.evidence.video ?? "", i.evidence.videoAt ? `${i.evidence.videoAt.chapter} ${i.evidence.videoAt.at}` : ""]),
    ]);
    const rounds = flow.rounds.map((r) => r.round);
    const history = toCsv([
      ["케이스", "제목", "지금", "처음 이슈가 된 라운드", "고쳐진 라운드", "이슈 횟수", ...rounds],
      ...flow.issues.map((i) => [i.id, i.title, NOW_KO[i.now], i.first, i.fixedIn ?? "", i.times, ...i.cells.map((c) => ko(c.status))]),
    ]);
    const byRound = new Map(flow.rounds.map((r) => [r.round, r]));
    const roundRows = toCsv([
      ["라운드", "종류", "상태", "비교한 앞 라운드", "이슈", "계속 남음", "새로 생김", "다시 생김", "고쳐짐", "실패", "불안정", "검증 못 함", "스킵", "도구 오류(NA)", "선행 결함에 막힘(H)", "통과", "전체"],
      ...d.tr.map((t) => {
        const f = byRound.get(t.round);
        const status = project.rounds().find((r) => r.id === t.round)?.status;
        return [t.round, t.scope === "full" ? "전체" : "부분", status === "finished" ? "끝남" : status === "aborted" ? "중단" : (status ?? ""), f?.prev ?? "", t.issues, f?.still ?? "", f?.added ?? "", f?.reopened ?? "", f?.fixed ?? "", t.fail, t.flaky, t.blocked, t.skip, t.toolError, t.blockedByDefect, t.pass, t.total];
      }),
    ]);
    out.files.csv = { issues: join(dir, `issues-${meta.id}.csv`), history: join(dir, `history-${meta.id}.csv`), rounds: join(dir, `rounds-${meta.id}.csv`) };
    writeFileSync(out.files.csv.issues, issues);
    writeFileSync(out.files.csv.history, history);
    writeFileSync(out.files.csv.rounds, roundRows);
  }

  if (formats.includes("html") || formats.includes("pdf")) {
    const embed: Embed = { limit: EMBED_LIMIT, used: 0, skipped: 0 };
    const html = renderHuman(project, meta, d.verdict, d.applied, results, d.cases, d.issues, d.tasks, d.tr, d.diff, d.excluded, { embed });
    if (embed.skipped) out.notes.push(`스크린샷 용량이 상한(${Math.round(EMBED_LIMIT / 1048576)}MB)을 넘어 ${embed.skipped}장은 넣지 않았습니다(라운드 폴더에 있음)`);
    out.notes.push("스크린샷은 이슈 케이스 것만 넣었고, 영상은 넣지 않았습니다(라운드 폴더에 있음)");
    if (formats.includes("html")) {
      out.files.html = join(dir, `report-${meta.id}.html`);
      writeFileSync(out.files.html, html);
    }
    if (formats.includes("pdf")) {
      const pdf = join(dir, `report-${meta.id}.pdf`);
      await queued(() => htmlToPdf(html, pdf, meta.id));
      out.files.pdf = pdf;
    }
  }
  return out;
}
