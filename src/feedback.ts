// 사용자의 E2E 관련 요청 처리 규칙
//  - 기본: 지금 돌고 있는 회차는 건드리지 않고 "다음 회차"부터 적용한다.
//  - "지금 회차부터 적용"이라고 하면: 처음부터 다시 돌릴지, 지금 흐름에서 적용할지 먼저 묻고(mode) 그대로 적용한다.
import { writeFileSync } from "node:fs";
import type { Case, Feedback } from "./types.ts";
import { Project, nowIso } from "./store.ts";
import { runningRound, stopRound } from "./round.ts";

export type FeedbackResult =
  | { ok: true; feedback: Feedback; message: string }
  | { ok: false; needs_decision: true; question: string; options: { value: string; meaning: string }[] };

export function addFeedback(
  project: Project,
  a: { text: string; apply?: "next" | "now"; mode?: "restart" | "in-flow"; cases?: Case[] },
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

  if (!running || a.apply !== "now") {
    const f = save({ ...base, appliesTo: "next-round", appliesFrom: nextId });
    return {
      ok: true,
      feedback: f,
      message: running
        ? `${running.id} 회차는 그대로 두고 ${nextId} 회차부터 적용합니다. ${running.id} 가 끝나면 이 요청대로 케이스·설정을 고친 뒤(e2e_case_upsert 등) e2e_feedback_resolve 로 표시하세요.`
        : `진행 중인 회차가 없으므로 ${nextId} 회차부터 적용합니다. 케이스·설정을 고친 뒤 e2e_feedback_resolve 로 표시하세요.`,
    };
  }

  // 지금 회차부터 적용하라는 요청 → 방식을 먼저 확인
  if (!a.mode)
    return {
      ok: false,
      needs_decision: true,
      question: `${running.id} 회차가 진행 중입니다. "지금 회차부터 적용"을 어떻게 할까요? (사용자에게 물어보고 mode 로 전달)`,
      options: [
        { value: "restart", meaning: `${running.id} 를 중단하고 처음부터 다시 돌림. 요청이 처음부터 모두 반영되어 결과가 깨끗하다. (이미 돈 만큼의 시간은 버려짐)` },
        { value: "in-flow", meaning: `${running.id} 를 계속 돌리면서 요청을 지금 흐름에 끼워 넣음. 빠르지만 앞서 돈 케이스에는 적용되지 않으므로 이 회차는 완료 근거가 못 되고, 완료하려면 새 전체 회차가 한 번 더 필요하다.` },
        { value: "next", meaning: "(기본) 다음 회차부터 적용" },
      ],
    };

  if (a.mode === "restart") {
    const f = save({ ...base, appliesTo: "now-restart", appliesFrom: nextId });
    stopRound(project);
    return { ok: true, feedback: f, message: `${running.id} 중단을 요청했습니다(진행 중인 케이스가 끝나면 멈춤). 멈춘 뒤 요청대로 케이스·설정을 고치고 e2e_round_start 로 처음부터 다시 시작하세요.` };
  }

  const f = save({ ...base, appliesTo: "now-in-flow", appliesFrom: running.id });
  if (a.cases?.length) {
    const all = project.cases();
    const byId = new Map(all.map((c) => [c.id, c]));
    for (const c of a.cases) byId.set(c.id, { ...c, type: c.type ?? "spec" });
    project.saveCases([...byId.values()]);
    writeFileSync(project.p("inject.json"), JSON.stringify(a.cases.map((c) => ({ ...c, type: c.type ?? "spec" }))));
  }
  return { ok: true, feedback: f, message: `${running.id} 의 지금 흐름에 적용합니다.${a.cases?.length ? ` 케이스 ${a.cases.length}건을 뒤에 끼워 넣어 이어서 실행합니다.` : " (케이스 변경이 없으면 설정 변경만 기록됨)"} 이 회차는 완료 근거가 되지 않으므로 끝난 뒤 전체 회차를 한 번 더 돌려야 합니다.` };
}

export function resolveFeedback(project: Project, ids: string[], note?: string) {
  const list = project.feedback().map((f) => (ids.includes(f.id) ? { ...f, status: "done" as const, resolvedAt: nowIso(), note } : f));
  project.writeJson("feedback.json", list);
  return list.filter((f) => ids.includes(f.id));
}
