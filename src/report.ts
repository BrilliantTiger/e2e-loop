import { writeFileSync } from "node:fs";
import type { CaseResult, RoundMeta } from "./types.ts";
import { Project } from "./store.ts";
import { coverage } from "./coverage.ts";
import { blockedCount, toolErrorCount } from "./toolerror.ts";
import { lang, tx } from "./i18n.ts";

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
  // 전체 라운드는 앞 전체 라운드와 비교한다 — 사이의 부분 라운드(수정 확인용)와 비교하면 그 라운드에 없던 케이스의 회귀가 「새 케이스」로 숨는다
  const prev = project
    .rounds()
    .filter((r) => r.n < meta.n && r.status === "finished" && (meta.scope !== "full" || r.scope === "full"))
    .reduce<RoundMeta | undefined>((a, r) => (!a || r.n > a.n ? r : a), undefined);
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

export interface TrendRow { round: string; scope: string; issues: number; toolError: number; blockedByDefect: number; fail: number; flaky: number; blocked: number; skip: number; warn: number; pass: number; total: number }
/** 회차별 이슈 수 추이. 이슈 = 실패 + 불안정 + 검증 못 한 것(BLOCKED). 스킵은 이슈가 아니다. 0 에 수렴하면 끝. */
export function trend(project: Project, upTo?: RoundMeta, upToResults?: CaseResult[]): TrendRow[] {
  const rows: TrendRow[] = [];
  for (const r of project.rounds()) {
    if (r.status === "running" && r.id !== upTo?.id) continue;
    if (upTo && r.n > upTo.n) continue; // 앞 라운드의 보고서를 다시 쓸 때 뒤 라운드가 섞이지 않게
    const res = r.id === upTo?.id && upToResults ? upToResults : project.readJson<CaseResult[]>(`rounds/${r.id}/results.json`, []);
    const cfg = project.config();
    const fail = res.filter((x) => x.status === "FAIL").length;
    const flaky = res.filter((x) => x.status === "FLAKY").length;
    const blocked = res.filter((x) => x.status === "BLOCKED" && !cfg.acceptedSkips.includes(x.id)).length;
    const skip = res.filter((x) => x.status === "SKIP").length;
    rows.push({ round: r.id, scope: r.scope, issues: fail + flaky + blocked, toolError: toolErrorCount(res), blockedByDefect: blockedCount(res), fail, flaky, blocked, skip, warn: res.filter((x) => x.status === "PASS" && x.warnings.length).length, pass: res.filter((x) => x.status === "PASS").length, total: res.length });
  }
  return rows;
}

export function fixHint(r: CaseResult): string {
  const m = r.reason ?? "";
  // 다른 파일(runner·probes·judge)이 만든 사유 글을 읽는다 — 한국어 조각과 영어 조각을 함께 본다(디스크의 예전 한국어 결과도).
  // 영어 조각은 영어 설정에서만 본다: 한국어 사유 속 선택자·사이트 글(#modal 같은)에 걸려 한국어 힌트가 바뀌지 않게
  const en = lang() === "en";
  const has = (ko: RegExp, eng: RegExp) => ko.test(m) || (en && eng.test(m));
  if (has(/Timeout|waiting for|locator|요소를 찾지/i, /element not found/i) && !has(/보여야|보임/, /should be visible|is visible/i)) return tx("선택자가 맞지 않거나 요소가 화면에 없음 → 화면 코드의 해당 요소/라벨/테스트 id 확인 (기획서와 다르게 바뀌었는지 비교)", "The selector does not match, or the element is not on the screen → check the element, label, or test id in the screen code (compare with the plan to see whether it changed)");
  if (has(/JS 오류/, /JS error/i)) return tx("화면 JS 오류 → 콘솔 오류의 파일·줄을 확인", "JS error on the screen → check the file and line of the console error");
  if (has(/서버\/네트워크 오류/, /server\/network error/i)) return tx("서버 5xx 또는 연결 오류 → 해당 API 로그 확인", "Server 5xx or connection error → check the log of that API");
  if (has(/모달/, /modal/i)) return tx("모달 닫기 동작 누락 → Esc·닫기 버튼 처리 확인", "The modal does not close → check the handling of Esc and the close button");
  if (has(/제출이 진행됨/, /submission went through/i)) return tx("필수값 검증 누락 → 폼 검증 로직 확인", "Required-field validation is missing → check the form validation logic");
  if (has(/오류처럼|404/, /looks like an error/i)) return tx("링크 대상 화면이 404/오류 → 링크 주소 또는 해당 라우트 확인", "The link target screen is a 404 or an error → check the link address or that route");
  if (has(/주소|링크 이동/, /address|link navigation/i)) return tx("링크 대상 경로가 다르거나 라우팅 누락", "The link target path differs, or the route is missing");
  if (has(/텍스트|값이 다름|개수/, /text differs|value differs|count differs/i)) return tx("화면 값이 기대와 다름 → 기획서/디자인의 기대값과 실제 데이터를 비교(데이터 상태 영향 가능)", "The screen value differs from the expectation → compare the expected value in the plan or design with the real data (the data state may affect it)");
  return tx("실패 단계와 증거(스크린샷·영상·trace)를 보고 원인 확인", "Look at the failed step and the evidence (screenshot, video, trace) to find the cause");
}

import { writeSheets } from "./sheets.ts";

/** 라운드 결과물을 쓴다: 사람용 report.html, AI용 ai-sheet.md·ai-sheet.json */
export function writeReports(project: Project, meta: RoundMeta, results: CaseResult[]) {
  return writeSheets(project, meta, results);
}
