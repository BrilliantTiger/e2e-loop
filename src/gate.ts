import type { CaseResult, RoundMeta } from "./types.ts";
import { Project, caseHash } from "./store.ts";
import { issuesOf } from "./issues.ts";
import { tx } from "./i18n.ts";

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
  if (!last) return { complete: false, reasons: [tx("끝난 회차가 없음", "No round has finished")], next: tx("e2e_round_start 로 1회차를 시작", "Start round 1 with e2e_round_start") };
  if (last.status !== "finished") reasons.push(tx(`${last.id} 회차가 끝까지 돌지 않음(${last.status}${last.error ? ": " + last.error : ""})`, `Round ${last.id} did not run to the end (${last.status}${last.error ? ": " + last.error : ""})`));
  if (last.scope !== "full") reasons.push(tx(`${last.id} 회차는 일부 케이스만 실행한 부분 회차. 완료는 전체 회차로만 판정함`, `Round ${last.id} is a partial round that ran only some cases. Completion is checked only on a full round`));
  if (last.injected?.length) reasons.push(tx(`${last.id}: “지금 흐름에서 적용”으로 도중에 끼워 넣은 케이스(${last.injected.join(", ")})가 있어 앞서 돈 케이스에는 적용되지 않음 — 새 전체 라운드가 필요`, `${last.id}: cases were inserted midway with "apply in the current flow" (${last.injected.join(", ")}), so the cases that ran before them are not covered — a new full round is needed`));
  const feedback = project.feedback();
  // 케이스를 끼워 넣지 않은 「지금 흐름에서 적용」(설정만 바꾼 요청)도 앞서 돈 케이스에는 적용되지 않았다
  const inFlow = feedback.filter((f) => f.appliesTo === "now-in-flow" && f.appliesFrom === last.id);
  if (inFlow.length && !last.injected?.length) reasons.push(tx(`${last.id}: “지금 흐름에서 적용” 요청(${inFlow.map((f) => f.id).join(", ")})이 라운드 도중에 들어와 앞서 돈 케이스에는 적용되지 않음 — 새 전체 라운드가 필요`, `${last.id}: "apply in the current flow" requests (${inFlow.map((f) => f.id).join(", ")}) came in during the round, so the cases that ran before them are not covered — a new full round is needed`));
  // 다음 라운드부터 적용할 요청이 남아 있으면 끝낼 수 없다(요청이 한 번도 돌지 않은 채 끝남)
  const pending = feedback.filter((f) => f.status === "pending");
  if (pending.length) reasons.push(tx(`반영하지 않은 사용자 요청 ${pending.length}건(${pending.map((f) => f.id).join(", ")}) — 요청대로 케이스·설정을 고치고 e2e_feedback_resolve 로 표시한 뒤 새 전체 라운드가 필요`, `User requests not applied (${pending.length}): ${pending.map((f) => f.id).join(", ")} — change the cases and settings as requested, mark them with e2e_feedback_resolve, then run a new full round`));
  const cfg = project.config();
  const active = project.cases().filter((c) => (c.status ?? "active") === "active");
  if (caseHash(active) !== last.caseHash) reasons.push(tx(`${last.id} 이후 케이스 정의가 바뀜 — 새 전체 회차가 필요`, `The case definitions changed after ${last.id} — a new full round is needed`));
  const results = project.readJson<CaseResult[]>(`rounds/${last.id}/results.json`, []);
  const fails = results.filter((r) => r.status === "FAIL");
  if (fails.length) reasons.push(tx(`실패 ${fails.length}건: ${fails.slice(0, 8).map((r) => r.id).join(", ")}${fails.length > 8 ? " …" : ""}`, `Failed cases (${fails.length}): ${fails.slice(0, 8).map((r) => r.id).join(", ")}${fails.length > 8 ? " …" : ""}`));
  const flaky = results.filter((r) => r.status === "FLAKY");
  if (flaky.length) reasons.push(tx(`불안정(재시도에서 일부만 통과) ${flaky.length}건: ${flaky.slice(0, 8).map((r) => r.id).join(", ")}`, `Flaky cases (${flaky.length}, only some retries passed): ${flaky.slice(0, 8).map((r) => r.id).join(", ")}`));
  const unverified = results.filter((r) => r.status === "BLOCKED" && !cfg.acceptedSkips.includes(r.id));
  if (unverified.length)
    reasons.push(
      tx(
        `검증하지 못한 케이스(BLOCKED) ${unverified.length}건: ${unverified.slice(0, 8).map((r) => r.id).join(", ")} — 근거·환경을 갖춰 다시 돌리거나, 사용자가 근거를 대고 acceptedSkips 로 받아들이거나, 해당 없음(na)이면 사유를 적어 바꿔야 함`,
        `Unverified cases (BLOCKED, ${unverified.length}): ${unverified.slice(0, 8).map((r) => r.id).join(", ")} — run them again with the basis and environment in place, or have the user give a basis and accept them with acceptedSkips, or if they are not applicable (na), change them and write the reason`,
      ),
    );
  // 선행 단계에 막혀 돌지 않은 케이스(H)는 검증되지 않았다. 보통은 선행 챕터의 FAIL 이 함께 있어 이미 막히지만,
  // 「선행 미완료」(목표 화면에 못 들어감)는 선행 챕터에 FAIL 이 없을 수 있어 여기서 막는다. 도구 오류(R 등)는 여기서 세지 않는다
  const heldBack = results.filter((r) => r.status === "NA" && r.blockedBy && !r.toolError);
  if (heldBack.length)
    reasons.push(
      tx(
        `선행 단계에 막혀 실행하지 못한 케이스 ${heldBack.length}건: ${heldBack.slice(0, 8).map((r) => `${r.id}(선행 ${r.blockedBy!.chapter})`).join(", ")} — 선행 단계를 마친 뒤 전체 회차를 다시 돌려야 함`,
        `Cases not run because a prior step blocked them (${heldBack.length}): ${heldBack.slice(0, 8).map((r) => `${r.id} (prior ${r.blockedBy!.chapter})`).join(", ")} — finish the prior step, then run a full round again`,
      ),
    );
  const noReason = results.filter((r) => (r.status === "BLOCKED" || r.status === "NA") && !r.reason);
  if (noReason.length) reasons.push(tx(`사유 없는 BLOCKED/NA ${noReason.length}건`, `BLOCKED/NA without a reason: ${noReason.length}`));
  if (results.length === 0) reasons.push(tx("결과가 비어 있음", "The results are empty"));
  const complete = reasons.length === 0;
  return {
    complete,
    round: last.id,
    reasons,
    next: complete
      ? tx(`${last.id} 전체 회차가 근거 있는 PASS 로 끝남 → 완료 선언 가능. 보고서: ${project.p("rounds", last.id, "report.html")}`, `Full round ${last.id} ended with PASS backed by a basis → completion can be declared. Report: ${project.p("rounds", last.id, "report.html")}`)
      : issuesOf(results, cfg).length
        ? tx("e2e_round_report 로 실패 목록을 보고, 회차가 끝난 상태에서 코드를 고친 뒤 전체 회차를 다시 시작", "See the failure list with e2e_round_report, fix the code while no round is running, then start a full round again")
        : tx("위 사유를 해소하고 전체 회차를 다시 시작", "Resolve the reasons above, then start a full round again"),
  };
}
