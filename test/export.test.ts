// 보고서 내보내기(PDF · 엑셀용 CSV · 한 파일 HTML) 시험. 임시 프로젝트에 라운드 기록만 흉내 낸다. PDF 는 실제 헤드리스 브라우저로 만든다.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project } from "../src/store.ts";
import { exportReport, exportRound, parseFormats, toCsv } from "../src/export.ts";
import { renderHuman, sheetData, type Embed } from "../src/sheets.ts";
import { lanAddresses, startDashboard } from "../src/dashboard.ts";
import type { CaseResult, RoundMeta } from "../src/types.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");
const res = (id: string, status: CaseResult["status"], over: Partial<CaseResult> = {}): CaseResult => ({ id, title: "제목 " + id, type: "spec", status, warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: "", ...over });
const meta = (id: string, over: Partial<RoundMeta> = {}): RoundMeta => ({ id, n: Number(id.slice(1)), status: "finished", startedAt: "", driver: "t", headless: true, data: { decision: "keep", scope: "round" }, scope: "full", caseHash: "", caseCount: 3, code: {}, baseUrl: "http://x", summary: { PASS: 1, FAIL: 1, FLAKY: 0, BLOCKED: 0, SKIP: 0, NA: 0, total: 2 } as any, ...over });
const PNG = Buffer.from("89504e470d0a1a0a" + "00".repeat(64), "hex");

/** R01: c1·c2 실패 / R02: c1 실패(스크린샷·영상 있음), c2 통과(스크린샷 있음), c3 돌리지 않음 */
function project() {
  const p = new Project(mkdtempSync(join(tmpdir(), "e2e-loop-export-")));
  p.ensure();
  p.saveConfig(p.config());
  p.writeJson("rounds/R01/meta.json", meta("R01"));
  p.writeJson("rounds/R01/results.json", [res("c1", "FAIL"), res("c2", "FAIL"), res("c3", "PASS")]);
  mkdirSync(p.p("rounds/R02/evidence"), { recursive: true });
  writeFileSync(p.p("rounds/R02/evidence/c1-1.png"), PNG);
  writeFileSync(p.p("rounds/R02/evidence/c2-1.png"), PNG);
  writeFileSync(p.p("secret.png"), PNG);
  p.writeJson("rounds/R02/meta.json", meta("R02"));
  p.writeJson("rounds/R02/results.json", [
    res("c1", "FAIL", { reason: "=HYPERLINK(\"http://evil\")", video: "evidence/c1.mp4", steps: [{ i: 0, op: "click", desc: "저장 누름", status: "fail", ms: 5, shot: "evidence/c1-1.png", error: "보여야 함" }, { i: 1, op: "click", desc: "밖 경로", status: "skip", ms: 0, shot: "../../secret.png" }] }),
    res("c2", "PASS", { steps: [{ i: 0, op: "click", desc: "저장 누름", status: "ok", ms: 5, shot: "evidence/c2-1.png" }] }),
  ]);
  return p;
}

test("CSV: 엑셀용 BOM·CRLF, 쉼표·따옴표·줄바꿈은 따옴표로 감싸고, = + - @ 로 시작하는 글자는 수식으로 읽히지 않게 ' 를 붙인다(숫자·「-」는 그대로)", () => {
  const csv = toCsv([["=1+1", "-3", "-", "a,b", 'q"t', "줄\n바꿈", "@x", "+x", 7, undefined]]);
  expect(csv.startsWith("﻿")).toBe(true);
  expect(csv).toBe("﻿'=1+1,-3,-,\"a,b\",\"q\"\"t\",\"줄\n바꿈\",'@x,'+x,7,\r\n");
});

test("형식 읽기: 생략하면 셋 다, 글자(pdf,csv)·배열 모두 받고, 모르는 형식은 거부한다", () => {
  expect(parseFormats(undefined)).toEqual(["pdf", "csv", "html"]);
  expect(parseFormats(true)).toEqual(["pdf", "csv", "html"]);
  expect(parseFormats("PDF, csv")).toEqual(["pdf", "csv"]);
  expect(parseFormats(["html", "html"])).toEqual(["html"]);
  expect(() => parseFormats("xlsx")).toThrow("xlsx");
});

test("내보낼 라운드: 생략하면 마지막으로 끝난 라운드, 진행 중·없는 라운드는 거부한다", () => {
  const p = project();
  p.writeJson("rounds/R03/meta.json", meta("R03", { status: "running" }));
  expect(exportRound(p).id).toBe("R02");
  expect(() => exportRound(p, "R03")).toThrow("진행 중");
  expect(() => exportRound(p, "R09")).toThrow("R09");
});

test("CSV 세 파일: 이번 라운드 이슈 목록(재현 단계·근거), 이슈별 라운드 이력(돌리지 않음 표시), 라운드별 수(고쳐짐·새로 생김 포함)", async () => {
  const p = project();
  const r = await exportReport(p, { formats: ["csv"] });
  expect(r.round).toBe("R02");
  expect(r.files.pdf).toBeUndefined();
  expect(r.files.html).toBeUndefined();
  const issues = readFileSync(r.files.csv!.issues, "utf8");
  expect(issues.startsWith("﻿순위,상태,케이스,제목")).toBe(true);
  expect(issues).toContain("실패,c1,제목 c1");
  expect(issues).toContain("1. "); // 재현 단계
  const history = readFileSync(r.files.csv!.history, "utf8").split("\r\n");
  expect(history[0]).toBe("﻿케이스,제목,지금,처음 이슈가 된 라운드,고쳐진 라운드,이슈 횟수,R01,R02");
  expect(history).toContain("c1,제목 c1,남음,R01,,2,실패,실패");
  expect(history).toContain("c2,제목 c2,고쳐짐,R01,R02,1,실패,통과");
  const rounds = readFileSync(r.files.csv!.rounds, "utf8").split("\r\n");
  expect(rounds[2]).toBe("R02,전체,끝남,R01,1,1,0,0,1,1,0,0,0,0,0,1,2");
  expect(r.dir).toBe(p.p("rounds", "R02", "export"));
});

test("한 파일 HTML: 이슈 케이스의 스크린샷만 파일 안에 넣고, 라운드 폴더 밖 경로는 넣지 않으며, 영상은 빼고 위치만 적는다. 그래프도 들어간다", async () => {
  const p = project();
  const r = await exportReport(p, { formats: ["html"] });
  const html = readFileSync(r.files.html!, "utf8");
  expect(html.match(/<img src="data:image\/png;base64,/g)!.length).toBe(1); // c1 의 스크린샷 한 장만(c2 는 통과, 밖 경로는 거부)
  expect(html).toContain("../../secret.png</span>");
  expect(html).not.toContain("<video");
  expect(html).toContain("영상: evidence/c1.mp4 (내보낸 파일에는 넣지 않음");
  expect(html).toContain("<svg");
  expect(html).toContain("내보낸 시각");
  expect(r.notes.join(" ")).toContain("영상은 넣지 않았습니다");
});

test("한 파일 HTML: 스크린샷 용량이 상한을 넘으면 넘는 것은 빼고 몇 장 뺐는지 적는다", () => {
  const p = project();
  const m = p.rounds().find((x) => x.id === "R02")!;
  const results = p.readJson<CaseResult[]>("rounds/R02/results.json", []);
  const d = sheetData(p, m, results);
  const embed: Embed = { limit: 10, used: 0, skipped: 0 };
  const html = renderHuman(p, m, d.verdict, d.applied, results, d.cases, d.issues, d.tasks, d.tr, d.diff, d.excluded, { embed });
  expect(embed.skipped).toBe(1);
  expect(html).not.toContain("data:image/png");
  expect(html).toContain("스크린샷 1장은 뺐습니다");
});

test("PDF: 헤드리스 브라우저로 A4 PDF 를 만든다(그래프·이슈 목록·이슈 스크린샷 포함)", async () => {
  const p = project();
  const r = await exportReport(p, { formats: ["pdf"] });
  const buf = readFileSync(r.files.pdf!);
  expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(buf.length).toBeGreaterThan(5000);
}, 60_000);

test("CLI export: --format 으로 고른 형식만 내보내고 파일 경로를 알려 준다", async () => {
  const p = project();
  const proc = Bun.spawn([process.execPath, CLI, "export", "--project", p.root, "--round", "R01", "--format", "csv,html"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  const j = JSON.parse(out);
  expect(j.round).toBe("R01");
  expect(existsSync(j.files.csv.issues)).toBe(true);
  expect(existsSync(j.files.html)).toBe(true);
  expect(j.files.pdf).toBeUndefined();
});

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));
test.skipIf(!lanAddresses().length)("현황판 내보내기: 토큰이 있어야 하고, 형식별 파일을 첨부로 내려 주며, 잘못된 형식·진행 중 라운드는 400", async () => {
  const p = project();
  p.writeJson("rounds/R03/meta.json", meta("R03", { status: "running" }));
  const d = startDashboard(p, 7960);
  stops.push(d.stop);
  const h = { authorization: `Bearer ${d.token}` };
  expect((await fetch(d.url + "/api/export?round=R02&format=issues")).status).toBe(401);
  const csv = await fetch(d.url + "/api/export?round=R02&format=history", { headers: h });
  expect(csv.status).toBe(200);
  expect(csv.headers.get("content-type")).toContain("text/csv");
  expect(csv.headers.get("content-disposition")).toBe('attachment; filename="history-R02.csv"');
  expect(await csv.text()).toContain("c1,제목 c1,남음");
  const html = await fetch(d.url + "/api/export?round=R02&format=html", { headers: h });
  expect(html.headers.get("content-disposition")).toBe('attachment; filename="report-R02.html"');
  expect((await fetch(d.url + "/api/export?round=R02&format=xlsx", { headers: h })).status).toBe(400);
  const run = await fetch(d.url + "/api/export?round=R03&format=issues", { headers: h });
  expect(run.status).toBe(400);
  expect((await run.json()).error).toContain("진행 중");
  const page = await (await fetch(d.url + "/", { headers: h })).text();
  expect(page).toContain('data-x="pdf"');
  expect(page).toContain('data-x="history"');
});
