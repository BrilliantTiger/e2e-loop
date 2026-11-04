// 사용자의 E2E 관련 요청 처리 규칙
//  - 기본: 지금 돌고 있는 회차는 건드리지 않고 "다음 회차"부터 적용한다.
//  - "지금 회차부터 적용"이라고 하면: 처음부터 다시 돌릴지, 지금 흐름에서 적용할지 먼저 묻고(mode) 그대로 적용한다.
import type { Case, Feedback } from "./types.ts";
import { Project, nowIso } from "./store.ts";
import { runningRound, stopRound } from "./round.ts";
import { checkCases } from "./actions.ts";
import { tx } from "./i18n.ts";

export type FeedbackResult =
  | { ok: true; feedback: Feedback; message: string; warns?: string[] }
  | { ok: false; needs_decision: true; question: string; options: { value: string; meaning: string }[] };

export function addFeedback(
  project: Project,
  a: { text: string; apply?: "next" | "now"; mode?: "restart" | "in-flow" | "next"; cases?: Case[] },
): FeedbackResult {
  const running = runningRound(project);
  const list = project.feedback();
  const nextId = running ? "R" + String(running.n + 1).padStart(2, "0") : "R" + String(project.nextRoundId().n).padStart(2, "0");
  const id = "FB" + String(list.length + 1).padStart(3, "0");
  const base = { id, text: a.text, createdAt: nowIso(), duringRound: running?.id, status: "pending" as const };

  const save = (f: Feedback) => {
    project.writeJson("feedback.json", [...list, f]);
    return f;
  };

  // 질문의 선택지 「다음 회차부터」(next)를 고른 경우도 다음 회차 적용이다
  if (!running || a.apply !== "now" || a.mode === "next") {
    const f = save({ ...base, appliesTo: "next-round", appliesFrom: nextId });
    return {
      ok: true,
      feedback: f,
      message: running
        ? tx(`${running.id} 회차는 그대로 두고 ${nextId} 회차부터 적용합니다. ${running.id} 가 끝나면 이 요청대로 케이스·설정을 고친 뒤(e2e_case_upsert 등) e2e_feedback_resolve 로 표시하세요.`, `Round ${running.id} is left as it is, and the request applies from round ${nextId}. When ${running.id} ends, change the cases and settings as requested (e2e_case_upsert etc.), then mark it with e2e_feedback_resolve.`)
        : tx(`진행 중인 회차가 없으므로 ${nextId} 회차부터 적용합니다. 케이스·설정을 고친 뒤 e2e_feedback_resolve 로 표시하세요.`, `No round is running, so the request applies from round ${nextId}. Change the cases and settings, then mark it with e2e_feedback_resolve.`),
    };
  }

  // 지금 회차부터 적용하라는 요청 → 방식을 먼저 확인
  if (!a.mode)
    return {
      ok: false,
      needs_decision: true,
      question: tx(`${running.id} 회차가 진행 중입니다. "지금 회차부터 적용"을 어떻게 할까요? (사용자에게 물어보고 mode 로 전달)`, `Round ${running.id} is running. How should "apply from the current round" work? (Ask the user and pass the answer as mode)`),
      options: [
        { value: "restart", meaning: tx(`${running.id} 를 중단하고 처음부터 다시 돌림. 요청이 처음부터 모두 반영되어 결과가 깨끗하다. (이미 돈 만큼의 시간은 버려짐)`, `Stop ${running.id} and start over. The request applies to everything from the start, so the result is clean. (The time already spent is lost)`) },
        { value: "in-flow", meaning: tx(`${running.id} 를 계속 돌리면서 요청을 지금 흐름에 끼워 넣음. 빠르지만 앞서 돈 케이스에는 적용되지 않으므로 이 회차는 완료 근거가 못 되고, 완료하려면 새 전체 회차가 한 번 더 필요하다.`, `Keep ${running.id} running and insert the request into the current flow. It is fast, but it does not apply to the cases that already ran, so this round cannot back the completion check. One more full round is needed to complete.`) },
        { value: "next", meaning: tx("(기본) 다음 회차부터 적용", "(default) Apply from the next round") },
      ],
    };

  if (a.mode === "restart") {
    const f = save({ ...base, appliesTo: "now-restart", appliesFrom: nextId });
    stopRound(project);
    return { ok: true, feedback: f, message: tx(`${running.id} 중단을 요청했습니다(진행 중인 케이스가 끝나면 멈춤). 멈춘 뒤 요청대로 케이스·설정을 고치고 e2e_round_start 로 처음부터 다시 시작하세요.`, `Asked ${running.id} to stop (it stops when the running case ends). After it stops, change the cases and settings as requested and start over with e2e_round_start.`) };
  }

  if (a.mode !== "in-flow") throw new Error(tx(`mode 는 restart·in-flow·next 중 하나여야 합니다(받은 값: ${a.mode}).`, `mode must be one of restart, in-flow, next (received: ${a.mode}).`));

  // 끼워 넣을 케이스는 e2e_case_upsert 와 같은 검사를 거치고 저장된 정의(파괴적 표시·챕터·선행·잠금 등)와 합친다.
  // 하나라도 틀리면 요청도 케이스도 기록하지 않는다.
  const checked = a.cases?.length ? checkCases(project, a.cases) : undefined;
  if (checked?.errors.length) throw new Error(tx(`끼워 넣을 케이스에 오류가 있어 요청을 기록하지 않았습니다: ${checked.errors.join(" / ")}`, `The cases to insert have errors, so the request was not recorded: ${checked.errors.join(" / ")}`));
  const f = save({ ...base, appliesTo: "now-in-flow", appliesFrom: running.id });
  if (checked) {
    project.saveCases([...checked.byId.values()]);
    // 실행기가 아직 읽지 않은 앞선 요청의 케이스는 남기고 뒤에 붙인다(같은 id 는 새 정의로)
    const add = a.cases!.map((c) => checked.byId.get(c.id)!);
    const ids = new Set(add.map((c) => c.id));
    project.writeJson("inject.json", [...project.readJson<Case[]>("inject.json", []).filter((c) => !ids.has(c.id)), ...add]);
  }
  return {
    ok: true,
    feedback: f,
    warns: checked?.warns.length ? checked.warns : undefined,
    message: tx(
      `${running.id} 의 지금 흐름에 적용합니다.${a.cases?.length ? ` 케이스 ${a.cases.length}건을 뒤에 끼워 넣어 이어서 실행합니다.` : " (케이스 변경이 없으면 설정 변경만 기록됨)"} 이 회차는 완료 근거가 되지 않으므로 끝난 뒤 전체 회차를 한 번 더 돌려야 합니다.`,
      `Applied in the current flow of ${running.id}.${a.cases?.length ? ` Cases inserted at the end and run next: ${a.cases.length}.` : " (With no case change, only the settings change is recorded)"} This round cannot back the completion check, so run one more full round after it ends.`,
    ),
  };
}

export function resolveFeedback(project: Project, ids: string[], note?: string) {
  const list = project.feedback().map((f) => (ids.includes(f.id) ? { ...f, status: "done" as const, resolvedAt: nowIso(), note } : f));
  project.writeJson("feedback.json", list);
  return list.filter((f) => ids.includes(f.id));
}
