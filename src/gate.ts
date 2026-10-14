import type { CaseResult, RoundMeta } from "./types.ts";
import { Project, caseHash } from "./store.ts";

export interface GateResult {
  complete: boolean;
  round?: string;
  reasons: string[];
  next: string;
}

/** "모든 E2E 가 통과했는가"를 판정한다. 말이 아니라 기록으로만 판정한다. */
export function completeCheck(project: Project): GateResult {
  const reasons: string[] = [];
  const rounds = project.rounds();
  const last = [...rounds].reverse().find((r) => r.status !== "running");
  if (!last) return { complete: false, reasons: ["끝난 회차가 없음"], next: "e2e_round_start 로 1회차를 시작" };
  if (last.status !== "finished") reasons.push(`${last.id} 회차가 끝까지 돌지 않음(${last.status}${last.error ? ": " + last.error : ""})`);
  if (last.scope !== "full") reasons.push(`${last.id} 회차는 일부 케이스만 실행한 부분 회차. 완료는 전체 회차로만 판정함`);
  if (last.tainted) reasons.push(`${last.id}: ${last.tainted}`);
  const cfg = project.config();
  const active = project.cases().filter((c) => (c.status ?? "active") === "active");
  if (caseHash(active) !== last.caseHash) reasons.push(`${last.id} 이후 케이스 정의가 바뀜 — 새 전체 회차가 필요`);
  const results = project.readJson<CaseResult[]>(`rounds/${last.id}/results.json`, []);
  const fails = results.filter((r) => r.status === "FAIL");
  if (fails.length) reasons.push(`실패 ${fails.length}건: ${fails.slice(0, 8).map((r) => r.id).join(", ")}${fails.length > 8 ? " …" : ""}`);
  const skips = results.filter((r) => r.status === "SKIP" && !cfg.acceptedSkips.includes(r.id));
  if (skips.length) reasons.push(`검증하지 못한 케이스(SKIP) ${skips.length}건 — 데이터 초기화 회차에서 실행하거나 사용자가 근거를 대고 acceptedSkips 로 받아들여야 함`);
  const noReason = results.filter((r) => (r.status === "BLOCKED" || r.status === "NA") && !r.reason);
  if (noReason.length) reasons.push(`사유 없는 BLOCKED/NA ${noReason.length}건`);
  if (results.length === 0) reasons.push("결과가 비어 있음");
  const complete = reasons.length === 0;
  return {
    complete,
    round: last.id,
    reasons,
    next: complete
      ? `${last.id} 전체 회차가 근거 있는 PASS 로 끝남 → 완료 선언 가능. 보고서: ${project.p("rounds", last.id, "report.html")}`
      : fails.length
        ? "e2e_round_report 로 실패 목록을 보고, 회차가 끝난 상태에서 코드를 고친 뒤 전체 회차를 다시 시작"
        : "위 사유를 해소하고 전체 회차를 다시 시작",
  };
}
