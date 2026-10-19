import { writeFileSync } from "node:fs";
import type { CaseResult, RoundMeta } from "./types.ts";
import { Project } from "./store.ts";
import { coverage } from "./coverage.ts";
import { toolErrorCount } from "./toolerror.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface Diff {
  prev?: string;
  fixed: string[];
  regressed: string[];
  stillFailing: string[];
  newFailures: string[];
  newCases: string[];
}

export function diffWithPrevious(project: Project, meta: RoundMeta, results: CaseResult[]): Diff {
  const prev = [...project.rounds()].reverse().find((r) => r.n < meta.n && r.status === "finished");
  const d: Diff = { prev: prev?.id, fixed: [], regressed: [], stillFailing: [], newFailures: [], newCases: [] };
  if (!prev) return d;
  const old = new Map(project.readJson<CaseResult[]>(`rounds/${prev.id}/results.json`, []).map((r) => [r.id, r.status]));
  for (const r of results) {
    const o = old.get(r.id);
    if (o === undefined) {
      d.newCases.push(r.id);
      if (r.status === "FAIL") d.newFailures.push(r.id);
    } else if (o === "FAIL" && r.status === "PASS") d.fixed.push(r.id);
    else if (o === "PASS" && r.status === "FAIL") d.regressed.push(r.id);
    else if (o === "FAIL" && r.status === "FAIL") d.stillFailing.push(r.id);
  }
  return d;
}

export interface TrendRow { round: string; scope: string; issues: number; toolError: number; fail: number; flaky: number; blocked: number; skip: number; warn: number; pass: number; total: number }
/** 회차별 이슈 수 추이. 이슈 = 실패 + 불안정 + 검증 못 한 것(BLOCKED). 스킵은 이슈가 아니다. 0 에 수렴하면 끝. */
export function trend(project: Project, upTo?: RoundMeta, upToResults?: CaseResult[]): TrendRow[] {
  const rows: TrendRow[] = [];
  for (const r of project.rounds()) {
    if (r.status === "running" && r.id !== upTo?.id) continue;
    const res = r.id === upTo?.id && upToResults ? upToResults : project.readJson<CaseResult[]>(`rounds/${r.id}/results.json`, []);
    const cfg = project.config();
    const fail = res.filter((x) => x.status === "FAIL").length;
    const flaky = res.filter((x) => x.status === "FLAKY").length;
    const blocked = res.filter((x) => x.status === "BLOCKED" && !cfg.acceptedSkips.includes(x.id)).length;
    const skip = res.filter((x) => x.status === "SKIP").length;
    rows.push({ round: r.id, scope: r.scope, issues: fail + flaky + blocked, toolError: toolErrorCount(res), fail, flaky, blocked, skip, warn: res.filter((x) => x.status === "PASS" && x.warnings.length).length, pass: res.filter((x) => x.status === "PASS").length, total: res.length });
  }
  return rows;
}

export function fixHint(r: CaseResult): string {
  const m = r.reason ?? "";
  if (/Timeout|waiting for|locator|요소를 찾지/i.test(m) && !/보여야|보임/.test(m)) return "선택자가 맞지 않거나 요소가 화면에 없음 → 화면 코드의 해당 요소/라벨/테스트 id 확인 (기획서와 다르게 바뀌었는지 비교)";
  if (/JS 오류/.test(m)) return "화면 JS 오류 → 콘솔 오류의 파일·줄을 확인";
  if (/서버\/네트워크 오류/.test(m)) return "서버 5xx 또는 연결 오류 → 해당 API 로그 확인";
  if (/모달/.test(m)) return "모달 닫기 동작 누락 → Esc·닫기 버튼 처리 확인";
  if (/제출이 진행됨/.test(m)) return "필수값 검증 누락 → 폼 검증 로직 확인";
  if (/오류처럼|404/.test(m)) return "링크 대상 화면이 404/오류 → 링크 주소 또는 해당 라우트 확인";
  if (/주소|링크 이동/.test(m)) return "링크 대상 경로가 다르거나 라우팅 누락";
  if (/텍스트|값이 다름|개수/.test(m)) return "화면 값이 기대와 다름 → 기획서/디자인의 기대값과 실제 데이터를 비교(데이터 상태 영향 가능)";
  return "실패 단계와 증거(스크린샷·영상·trace)를 보고 원인 확인";
}

import { writeSheets } from "./sheets.ts";

/** 라운드 결과물을 쓴다: 사람용 report.html, AI용 ai-sheet.md·ai-sheet.json */
export function writeReports(project: Project, meta: RoundMeta, results: CaseResult[]) {
  return writeSheets(project, meta, results);
}
