// 오류 E 재발 막기: 이전 라운드에서 E(기대 오류)로 제외된 케이스는 기대·근거를 고치기 전에는 실행하지 않고, 같은 자리의 제외가 라운드를 넘어 반복되면 「n회째」.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project } from "../src/store.ts";
import { CARRIED_E_MARK, carriedE, carriedResult } from "../src/carry.ts";
import { buildSheet, renderSheetMd } from "../src/sheet.ts";
import { excludedRows, excludedTsv, markRepeats } from "../src/toolerror.ts";
import type { Case, CaseResult } from "../src/types.ts";

const kc = (expectText: string, basis = "POL-1"): Case => ({ id: "K-1", title: "사전 파일 줄", type: "spec", source_ref: "x", screen: "/keys", feature: "Key 목록", steps: [{ op: "goto", url: "/keys" }, { op: "expect", sel: "row=_columns", visible: true, text: expectText, basis }] });
const naE = (id: string): CaseResult => ({ id, title: id, type: "spec", status: "NA", toolError: { kind: "E", detail: "기대가 데이터와 다름: 사전 파일 없음" }, warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: "" });
const project = () => {
  const p = new Project(mkdtempSync(join(tmpdir(), "e2e-loop-carry-")));
  p.ensure();
  return p;
};
const addRound = (p: Project, n: number, cases: Case[], results: CaseResult[]) => {
  const id = `R0${n}`;
  p.writeJson(`rounds/${id}/meta.json`, { id, n, status: "finished", startedAt: "", driver: "t", headless: true, data: { decision: "keep", scope: "round" }, scope: "full", caseHash: "", caseCount: cases.length, code: {}, baseUrl: "http://x" });
  p.writeJson(`rounds/${id}/cases.json`, cases);
  p.writeJson(`rounds/${id}/results.json`, results);
};

test("이전 라운드 E 제외이고 기대를 안 고쳤으면 이월(돌리지 않음), 기대·근거를 고쳤거나 마지막 결과가 E 가 아니면 이월하지 않는다", () => {
  const p = project();
  const c = kc("적용 완료");
  p.saveCases([c]);
  addRound(p, 7, [c], [naE("K-1")]);
  expect(carriedE(p, [c]).get("K-1")?.round).toBe("R07");
  // 근거만 고쳐도 고친 것으로 본다
  expect(carriedE(p, [kc("적용 완료", "POL-2 사전 파일 있는 표만")]).size).toBe(0);
  expect(carriedE(p, [kc("사전 파일 없음")]).size).toBe(0);
  // 더 최근 라운드에서 통과했으면 이월하지 않는다
  addRound(p, 8, [c], [{ ...naE("K-1"), status: "PASS", toolError: undefined }]);
  expect(carriedE(p, [c]).size).toBe(0);
});

test("이월한 케이스의 결과는 누르지 않은 NA(E)이고 「이전 라운드 E 제외 — 기대 수정 필요」 를 단다. 시트에도 표시된다", () => {
  const p = project();
  const c = kc("적용 완료");
  p.saveCases([c]);
  addRound(p, 7, [c], [naE("K-1")]);
  const r = carriedResult(c, carriedE(p, [c]).get("K-1")!, "");
  expect(r.status).toBe("NA");
  expect(r.toolError?.kind).toBe("E");
  expect(r.reason).toContain(CARRIED_E_MARK);
  expect(r.reason).toContain("R07");
  expect(r.steps.length).toBe(0);
  const sheet = buildSheet(p);
  expect(sheet.gaps.carriedE.map((x) => x.id)).toEqual(["K-1"]);
  const md = renderSheetMd(sheet, { full: true });
  expect(md).toContain(`[${CARRIED_E_MARK}(R07)]`);
  expect(md).toContain(`${CARRIED_E_MARK} 1건`);
});

test("같은 (화면, 요소, 동작)이 앞 라운드들에서도 제외됐으면 제외 시트에 「n회째」", () => {
  const info = () => ({ chapter: "Key", screen: "/keys", element: "row=_columns", verb: "확인" });
  const r6 = excludedRows([naE("K-1")], () => "현상", { round: "R06", info });
  const r7 = excludedRows([naE("K-1")], () => "현상", { round: "R07", info });
  const r8 = markRepeats(excludedRows([naE("K-1"), { ...naE("K-2"), toolError: { kind: "D", detail: "x" } }], () => "현상", { round: "R08", info: (r) => (r.id === "K-2" ? { ...info(), element: "#other" } : info()) }), [{ round: "R06", rows: r6 }, { round: "R07", rows: r7 }]);
  expect(r8[0]!.nth).toBe(3);
  expect(r8[1]!.nth).toBeUndefined();
  expect(excludedTsv(r8).split("\n")[1]!.split("\t")[4]).toBe("3회째");
});

// ---- 실제 라운드: 이월한 케이스는 누르지 않고, 기대를 고치면 다시 돈다 ----
import { afterAll, beforeAll } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import * as A from "../src/actions.ts";
const port = 4584;
const root = mkdtempSync(join(tmpdir(), "e2e-loop-carry-run-"));
let server: ReturnType<typeof Bun.spawn>;
beforeAll(async () => {
  writeFileSync(join(root, "bugs.json"), "{}");
  writeFileSync(join(root, "PLAN.md"), "# 기획서\n");
  server = Bun.spawn(["bun", join(import.meta.dir, "../examples/demo-site/server.ts"), root, String(port)], { stdout: "ignore", stderr: "inherit" });
  await Bun.sleep(800);
  const p = new Project(root);
  p.ensure();
  p.saveConfig({ ...p.config(), baseUrl: `http://127.0.0.1:${port}`, driver: "chromium", headless: true, dashboardPort: 7796 });
  A.aPrestart({ project: root, dataPolicy: "keep", maxRounds: 10, login: "none", account: { mode: "none" }, acknowledged: true });
  A.aSourceAdd({ project: root, kind: "plan", title: "기획서", location: join(root, "PLAN.md") });
});
afterAll(() => server?.kill());

const runRound = async () => {
  const start: any = await A.aRoundStart({ project: root, data: "keep", headless: true });
  expect(start.started).toBe(true);
  let st: any;
  do st = await A.aRoundStatus({ project: root, wait_seconds: 30 });
  while (st.running);
  return start.round as string;
};

test("라운드: 앞 라운드 E 제외 케이스는 누르지 않고 NA(E)·carried-e 로그, 기대를 고쳐 다시 등록하면 돈다", async () => {
  const p = new Project(root);
  const c: Case = { id: "K-9", title: "제목", type: "spec", source_ref: "x", screen: "/", feature: "홈", steps: [{ op: "goto", url: "/" }, { op: "expect", sel: "h1", text: "없는 제목", basis: "POL-1" }] };
  expect(A.aCaseUpsert({ project: root, cases: [c] }).errors).toEqual([]);
  addRound(p, 1, [c], [naE("K-9")]); // 앞 라운드에서 E 로 제외됨
  const r2 = await runRound();
  const res2 = p.readJson<CaseResult[]>(`rounds/${r2}/results.json`, []);
  expect(res2[0]!.status).toBe("NA");
  expect(res2[0]!.toolError?.kind).toBe("E");
  expect(res2[0]!.reason).toContain(CARRIED_E_MARK);
  expect(res2[0]!.steps.length).toBe(0);
  expect(readFileSync(p.p("rounds", r2, "events.ndjson"), "utf8")).toContain('"type":"carried-e"');
  // 기대를 고친다 → 실행된다
  A.aCaseUpsert({ project: root, cases: [{ ...c, steps: [{ op: "goto", url: "/" }, { op: "expect", sel: "h1", textContains: "", basis: "POL-1 고침" }] }] });
  const r3 = await runRound();
  expect(p.readJson<CaseResult[]>(`rounds/${r3}/results.json`, [])[0]!.status).toBe("PASS");
}, 120000);
