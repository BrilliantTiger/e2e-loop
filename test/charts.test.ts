// 이슈 흐름(라운드별 새로 생김·계속 남음·다시 생김·고쳐짐)과 이슈별 이력, 그 그래프가 보고서·현황판에 실리는지 확인한다. 브라우저 없이 라운드 기록만 흉내 낸다.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project } from "../src/store.ts";
import { flowChartSvg, issueFlow, issueHistoryHtml } from "../src/charts.ts";
import { writeSheets } from "../src/sheets.ts";
import { lanAddresses, startDashboard } from "../src/dashboard.ts";
import type { CaseResult, RoundMeta } from "../src/types.ts";

const tmpProject = () => {
  const p = new Project(mkdtempSync(join(tmpdir(), "e2e-loop-charts-")));
  p.ensure();
  p.saveConfig(p.config());
  return p;
};
const res = (id: string, status: CaseResult["status"], over: Partial<CaseResult> = {}): CaseResult => ({ id, title: "제목 " + id, type: "spec", status, warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: "", ...over });
const meta = (id: string, scope: RoundMeta["scope"], over: Partial<RoundMeta> = {}): RoundMeta => ({ id, n: Number(id.slice(1)), status: "finished", startedAt: "", driver: "t", headless: true, data: { decision: "keep", scope: "round" }, scope, caseHash: "", caseCount: 3, code: {}, baseUrl: "http://x", ...over });
const round = (p: Project, m: RoundMeta, results: CaseResult[]) => {
  p.writeJson(`rounds/${m.id}/meta.json`, m);
  p.writeJson(`rounds/${m.id}/results.json`, results);
};

/** R01 전체: c1·c2 실패 / R02 전체: c1 통과, c2 실패, c3 실패 / R03 부분: c2 통과 / R04 전체: c1 다시 실패, c2·c3 통과 */
function fourRounds() {
  const p = tmpProject();
  round(p, meta("R01", "full"), [res("c1", "FAIL"), res("c2", "FAIL"), res("c3", "PASS")]);
  round(p, meta("R02", "full"), [res("c1", "PASS"), res("c2", "FAIL"), res("c3", "FAIL")]);
  round(p, meta("R03", "partial"), [res("c2", "PASS")]);
  round(p, meta("R04", "full"), [res("c1", "FAIL"), res("c2", "PASS"), res("c3", "PASS")]);
  return p;
}

test("이슈 흐름: 라운드마다 계속 남음·새로 생김·다시 생김(고쳐졌다가 다시 깨짐)·고쳐짐을 센다 — 전체 라운드는 앞 전체 라운드와, 부분 라운드는 바로 앞 라운드와 비교", () => {
  const f = issueFlow(fourRounds());
  const pick = (r: any) => ({ round: r.round, prev: r.prev, issues: r.issues, still: r.still, added: r.added, reopened: r.reopened, fixed: r.fixed });
  expect(f.rounds.map(pick)).toEqual([
    { round: "R01", prev: undefined, issues: 2, still: 0, added: 2, reopened: 0, fixed: 0 },
    { round: "R02", prev: "R01", issues: 2, still: 1, added: 1, reopened: 0, fixed: 1 },
    { round: "R03", prev: "R02", issues: 0, still: 0, added: 0, reopened: 0, fixed: 1 },
    // R04 는 사이의 부분 라운드(R03)가 아니라 앞 전체 라운드(R02)와 비교한다: c2·c3 고쳐짐, c1 은 R01 에 이슈였으니 다시 생김
    { round: "R04", prev: "R02", issues: 1, still: 0, added: 0, reopened: 1, fixed: 2 },
  ]);
  for (const r of f.rounds) expect(r.still + r.added + r.reopened).toBe(r.issues);
});

test("이슈별 이력: 라운드별 상태 칸, 처음 이슈가 된 라운드, 이슈 횟수, 지금 상태, 고쳐진 라운드 — 남은 이슈가 먼저 온다", () => {
  const f = issueFlow(fourRounds());
  expect(f.issues.map((i) => [i.id, i.now, i.first, i.times, i.fixedIn])).toEqual([
    ["c1", "open", "R01", 2, undefined],
    ["c2", "fixed", "R01", 2, "R03"],
    ["c3", "fixed", "R02", 1, "R04"],
  ]);
  expect(f.issues[0]!.cells.map((c) => c.status ?? "-")).toEqual(["FAIL", "PASS", "-", "FAIL"]);
  expect(f.issues[0]!.title).toBe("제목 c1");
});

test("이슈 흐름: 진행 중 라운드는 빼고, 중단된 라운드는 비교 기준으로 쓰지 않으며, 받아들인 BLOCKED(acceptedSkips)는 이슈가 아니다", () => {
  const p = tmpProject();
  p.saveConfig({ ...p.config(), acceptedSkips: ["b1"] });
  round(p, meta("R01", "full"), [res("c1", "FAIL"), res("b1", "BLOCKED"), res("b2", "BLOCKED")]);
  round(p, meta("R02", "full", { status: "aborted" }), [res("c1", "PASS")]);
  round(p, meta("R03", "full"), [res("c1", "PASS"), res("b2", "FLAKY")]);
  round(p, meta("R04", "full", { status: "running" }), [res("c1", "FAIL")]);
  const f = issueFlow(p);
  expect(f.rounds.map((r) => r.round)).toEqual(["R01", "R02", "R03"]);
  expect(f.rounds[0]!.issues).toBe(2); // c1 · b2 (b1 은 받아들인 BLOCKED)
  expect(f.rounds[2]).toMatchObject({ prev: "R01", fixed: 1, still: 1 });
  expect(f.issues.map((i) => i.id).sort()).toEqual(["b2", "c1"]);
});

test("이슈 흐름: 앞 라운드의 보고서를 다시 쓸 때는 그 라운드까지만 보고, 그 라운드의 결과는 넘겨준 것을 쓴다", () => {
  const p = fourRounds();
  const f = issueFlow(p, meta("R02", "full"), [res("c1", "PASS"), res("c2", "PASS"), res("c3", "PASS")]);
  expect(f.rounds.map((r) => r.round)).toEqual(["R01", "R02"]);
  expect(f.rounds[1]).toMatchObject({ issues: 0, fixed: 2 });
});

test("그래프 SVG: 라운드마다 막대와 이슈 수·고쳐짐(✓) 글자, 부분 라운드 표시, 마우스를 올리면 보이는 설명. 라운드가 없으면 안내 글", () => {
  const f = issueFlow(fourRounds());
  const svg = flowChartSvg(f.rounds);
  expect(svg).toContain("<svg");
  for (const r of ["R01", "R02", "R03", "R04"]) expect(svg).toContain(`>${r}</text>`);
  expect(svg).toContain("✓2");
  expect(svg).toContain('class="partial"');
  expect(svg).toContain("R04 — 이슈 1건: 계속 남음 0 · 새로 생김 0 · 다시 생김 1 / 고쳐짐 2 (R02 와 비교)");
  expect(svg.match(/<rect class="f-fixed"/g)!.length).toBe(3); // R02·R03·R04 에 고쳐짐 막대
  expect(svg).toContain("고쳐짐(축 아래)"); // 범례
  expect(flowChartSvg([])).toContain("아직 끝난 라운드가 없습니다");
});

test("이슈 목록 표: 케이스 제목은 이스케이프하고, 라운드가 많으면 최근 라운드만 열로 두고 생략을 알린다", () => {
  const p = tmpProject();
  for (let n = 1; n <= 14; n++) round(p, meta("R" + String(n).padStart(2, "0"), "full"), [res("x", n % 2 ? "FAIL" : "PASS", { title: "<script>alert(1)</script>" })]);
  const html = issueHistoryHtml(issueFlow(p));
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("앞 2개 라운드는 열에서 생략");
  expect(html).not.toContain(">R01</th>");
  expect(html).toContain(">R14</th>");
  expect(issueHistoryHtml({ rounds: [], issues: [] })).toContain("이슈였던 케이스가 없습니다");
});

test("사람용 보고서(report.html)에 이슈 흐름 그래프와 이슈 목록(라운드별 이력)이 실린다", () => {
  const p = fourRounds();
  const m = meta("R04", "full", { summary: { PASS: 2, FAIL: 1, FLAKY: 0, BLOCKED: 0, SKIP: 0, NA: 0, total: 3 } as any });
  const out = writeSheets(p, m, p.readJson<CaseResult[]>("rounds/R04/results.json", []));
  const html = readFileSync(out.files.human, "utf8");
  expect(html).toContain("<svg");
  expect(html).toContain("이슈 목록 — 라운드별 이력");
  expect(html).toContain('class="hn-open"');
  expect(html).toContain("✓2");
});

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));
test.skipIf(!lanAddresses().length)("현황판: 상태에 이슈 흐름 그래프와 이슈 목록이 실리고, 화면에 두 칸이 있다", async () => {
  const p = fourRounds();
  const d = startDashboard(p, 7890);
  stops.push(d.stop);
  const h = { authorization: `Bearer ${d.token}` };
  const st: any = await (await fetch(d.url + "/api/state", { headers: h })).json();
  expect(st.flow.chart).toContain("<svg");
  expect(st.flow.history).toContain("제목 c1");
  const page = await (await fetch(d.url + "/", { headers: h })).text();
  expect(page).toContain('id="hist"');
  expect(page).toContain("이슈 흐름");
  expect(page).toContain(".f-fixed{fill:#1a7f4b}");
});
