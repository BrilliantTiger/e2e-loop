// 이슈의 정의(확정 요구사항): 이슈 = 실패 + 검증 못 한 것 + 사용자가 승격한 경고. 스킵은 이슈가 아니다.
//   FAIL    실패(승격한 경고 포함)
//   FLAKY   불안정: 실패 뒤 3번 재시도에서 일부만 통과
//   BLOCKED 돌리려 했으나 환경·차단으로 판정하지 못함(검증 못 한 것). 사용자가 근거를 대고 받아들인 것(acceptedSkips)은 제외
//   SKIP    규칙이나 사용자 선택으로 일부러 돌리지 않음 → 이슈 아님
//   NA      해당 없음(사유 필수) → 이슈 아님
import type { CaseResult, Config } from "./types.ts";

export const isIssue = (r: Pick<CaseResult, "id" | "status">, cfg: Pick<Config, "acceptedSkips">): boolean => {
  if (r.status === "FAIL" || r.status === "FLAKY") return true;
  if (r.status === "BLOCKED") return !cfg.acceptedSkips.includes(r.id);
  return false;
};

export const issuesOf = (results: CaseResult[], cfg: Pick<Config, "acceptedSkips">) => results.filter((r) => isIssue(r, cfg));
