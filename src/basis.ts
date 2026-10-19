// 기대의 근거 (오류 E: 시험 기대가 기획서와 다름).
// 케이스의 기대 칸마다 근거(기획서 POL · CCB 번호)를 적는다. 근거가 없는 기대는 시트에서 경고한다.
import type { Case, Step } from "./types.ts";

/** 기대(통과 조건)를 가진 스텝인가 */
export function isExpectation(s: Step): boolean {
  if (s.op === "gate") return true;
  if (s.op === "expect") return ["url", "title", "titleContains", "visible", "hidden", "count", "text", "textContains", "value", "checked", "enabled", "dialog"].some((k) => s[k] !== undefined);
  if (s.op === "api") return s.status !== undefined || s.json !== undefined || s.jsonHas !== undefined || s.jsonArray !== undefined;
  if (s.op === "eval") return s.equals !== undefined;
  return false;
}

export const hasBasis = (s: Step): boolean => typeof s.basis === "string" && s.basis.trim().length > 0;

export interface MissingBasis {
  id: string;
  title: string;
  /** 근거가 없는 기대 칸의 스텝 번호(1부터) */
  steps: number[];
}

/** 사람이 쓴(spec) 활성 케이스 중 기대 칸에 근거가 없는 것. 자동 점검(probe)은 규칙에서 나온 것이라 제외한다. */
export function missingBasis(cases: Case[]): MissingBasis[] {
  const out: MissingBasis[] = [];
  for (const c of cases) {
    if (c.type !== "spec" || (c.status ?? "active") !== "active" || c.skipReason) continue;
    const steps = c.steps.flatMap((s, i) => (isExpectation(s) && !hasBasis(s) ? [i + 1] : []));
    if (steps.length) out.push({ id: c.id, title: c.title, steps });
  }
  return out;
}

export const BASIS_WARNING = (steps: number[]) =>
  `기대 칸 ${steps.map((n) => `#${n}`).join(" ")} 에 근거(basis: 기획서 POL · CCB 번호)가 없음 — 근거 없는 기대는 시트에서 경고됨. 근거를 못 찾으면 기대를 만들지 말고 케이스를 blocked 로 두고 사유를 적을 것(오류 E)`;
