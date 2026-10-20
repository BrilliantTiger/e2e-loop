// 이전 라운드에서 E(기대 오류)로 제외된 케이스의 이월 (오류 E 재발 막기).
// 가장 최근에 이 케이스를 돌린 라운드에서 결과가 NA(E)였고, 그 뒤로 기대·근거(basis)를 고치지 않았으면
// 새 라운드에서는 돌리지 않고 「이전 라운드 E 제외 — 기대 수정 필요」 로 미리 NA(E) 분류한다. 시트에도 표시한다.
import { createHash } from "node:crypto";
import type { Case, CaseResult } from "./types.ts";
import type { Project } from "./store.ts";
import { isExpectation } from "./basis.ts";

/** 기대를 가진 스텝(기대·근거 포함)만의 지문. 이것이 바뀌면 기대를 고친 것으로 본다 */
export const expectationHash = (c: Pick<Case, "steps">) => createHash("sha1").update(JSON.stringify(c.steps.filter(isExpectation))).digest("hex");

export interface CarriedE {
  round: string;
  detail: string;
}

export const CARRIED_E_MARK = "이전 라운드 E 제외 — 기대 수정 필요";

/** 이월할 E 제외 케이스: 케이스 id → 제외됐던 라운드와 그때 사유 */
export function carriedE(project: Project, cases: Case[], skipRound?: string): Map<string, CarriedE> {
  const out = new Map<string, CarriedE>();
  const left = new Map(cases.filter((c) => c.type === "spec").map((c) => [c.id, c]));
  for (const r of [...project.rounds()].reverse()) {
    if (!left.size) break;
    if (r.id === skipRound || r.status === "running") continue;
    const results = project.readJson<CaseResult[]>(`rounds/${r.id}/results.json`, []);
    const snap = new Map(project.readJson<Case[]>(`rounds/${r.id}/cases.json`, []).map((c) => [c.id, c]));
    for (const res of results) {
      const cur = left.get(res.id);
      if (!cur) continue;
      left.delete(res.id); // 가장 최근 라운드의 결과만 본다
      if (res.status !== "NA" || res.toolError?.kind !== "E") continue;
      const then = snap.get(res.id);
      if (then && expectationHash(then) === expectationHash(cur)) out.set(res.id, { round: r.id, detail: res.toolError.detail });
    }
  }
  return out;
}

/** 이월한 케이스의 결과: 누르지 않고 NA(E) */
export function carriedResult(c: Case, e: CarriedE, now: string): CaseResult {
  const detail = `${CARRIED_E_MARK}: ${e.round} 에서 E 로 제외됐고 그 뒤 기대·근거(basis)를 고치지 않아 실행하지 않음(그때 사유: ${e.detail.slice(0, 200)})`;
  return {
    id: c.id, title: c.title, type: c.type, event: c.event, source_ref: c.source_ref, element: c.element, risk: c.risk,
    status: "NA", reason: `도구 판정 불가(E): ${detail}`, toolError: { kind: "E", detail },
    warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: now,
  };
}
