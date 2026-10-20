// 기대의 근거 (오류 E: 시험 기대가 기획서와 다름 · 오류 S: 근거가 기획서가 아니라 화면설계서).
// 케이스의 기대 칸마다 근거(기획서 POL · CCB 번호 또는 화면설계서 번호)를 적는다. 근거가 없는 기대는 시트에서 경고한다.
// 근거는 글 하나이거나 { plan, design, differs } 이다. 기획서와 화면설계서가 다르면 둘 다 적고 differs 에 무엇이 다른지 쓴다.
import type { Case, Step } from "./types.ts";
import { isToastStep } from "./toast.ts";

/** 기대(통과 조건)를 가진 스텝인가 */
export function isExpectation(s: Step): boolean {
  if (s.op === "gate") return true;
  if (s.op === "expect") return !isToastStep(s) && ["url", "title", "titleContains", "visible", "hidden", "count", "text", "textContains", "value", "checked", "enabled", "dialog"].some((k) => s[k] !== undefined);
  if (s.op === "collect") return ["count", "atLeast", "contains"].some((k) => s[k] !== undefined);
  if (s.op === "api") return s.status !== undefined || s.json !== undefined || s.jsonHas !== undefined || s.jsonArray !== undefined;
  if (s.op === "eval") return s.equals !== undefined;
  return false;
}

/** 근거: 글 하나(기획서 번호 또는 화면설계서 번호) 또는 { plan: 기획서, design: 화면설계서, differs: 둘이 다를 때 무엇이 다른지 } */
export type Basis = string | { plan?: string; design?: string; differs?: string };

const DESIGN_DOC = /화면\s*설계서|화면설계|screen\s*design|wireframe|storyboard/i;

/** 근거를 기획서·화면설계서로 나눈다. 글 하나면 화면설계서를 가리키는지 글로 가린다 */
export function basisParts(b: unknown): { plan?: string; design?: string; differs?: string } {
  if (typeof b === "string") return b.trim() ? (DESIGN_DOC.test(b) ? { design: b.trim() } : { plan: b.trim() }) : {};
  if (!b || typeof b !== "object") return {};
  const o = b as Record<string, unknown>;
  const t = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return { plan: t(o.plan), design: t(o.design), differs: t(o.differs) };
}

export const hasBasis = (s: Step): boolean => {
  const p = basisParts(s.basis);
  return !!(p.plan || p.design);
};

/** 근거를 사람이 읽는 글로: 「기획서 CCB-1940 · 화면설계서 08-common CCB-1940 Description 1 — 기획서와 화면설계서가 다름: …」 */
export function basisText(b: unknown): string {
  const p = basisParts(b);
  const parts = [p.plan && (typeof b === "string" ? p.plan : `기획서 ${p.plan}`), p.design && (typeof b === "string" ? p.design : `화면설계서 ${p.design}`)].filter(Boolean);
  return parts.join(" · ") + (p.differs ? ` — 기획서와 화면설계서가 다름: ${p.differs}` : "");
}

/** 기획서와 화면설계서가 다르다고 적은 근거인가(오류 S) */
export const basisDiffers = (s: Step | undefined): boolean => !!s && !!basisParts(s.basis).differs;

/** 근거 칸의 잘못: 다르다고 적었는데 둘 중 하나가 없음 */
export function basisProblem(b: unknown): string | undefined {
  const p = basisParts(b);
  if (p.differs && !(p.plan && p.design)) return "기획서와 화면설계서가 다르면(differs) 둘 다 적을 것 — basis: { plan: 기획서 번호, design: 화면설계서 번호, differs: 무엇이 다른지 }";
  if (b && typeof b === "object" && !p.plan && !p.design) return "basis 에 plan(기획서 번호)이나 design(화면설계서 번호)이 없음";
  return undefined;
}

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
  `기대 칸 ${steps.map((n) => `#${n}`).join(" ")} 에 근거(basis: 기획서 POL · CCB 번호 또는 화면설계서 번호)가 없음 — 근거 없는 기대는 시트에서 경고됨. 근거를 못 찾으면 기대를 만들지 말고 케이스를 blocked 로 두고 사유를 적을 것(오류 E)`;
