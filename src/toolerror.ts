// 시험 도구(스크립트) 탓에 난 오류는 FAIL 이 아니라 NA(도구 판정 불가)로 둔다.
// NA 는 이슈 시트가 아니라 제외 시트(excluded_issues)로 올리고, 제외 사유는 A~E 중 하나로 표시한다.
//   A 오지 않을 상태를 기다림   B 줄 번호 재사용   C 요소 찾는 방법이 화면과 다름
//   D 화면이 그려지기 전에 읽음   E 기대가 기획서와 다름
import type { Case, CaseResult, Step, ToolErrorKind } from "./types.ts";

export type { ToolErrorKind };

export const TOOL_ERROR_LABEL: Record<ToolErrorKind, string> = {
  A: "오지 않을 상태를 기다림",
  B: "줄 번호 재사용",
  C: "요소 찾는 방법이 화면과 다름",
  D: "화면이 그려지기 전에 읽음",
  E: "기대가 기획서와 다름",
};

const TOOL_ERROR_ACTION: Record<ToolErrorKind, string> = {
  A: "대기 조건에 화면의 모든 끝 상태(완료·확인 필요·막힘·오류·비활성 사유)를 넣어 다시 실행",
  B: "줄을 번호가 아니라 컬럼 이름·글자로 찾도록 고쳐 다시 실행",
  C: "요소를 data-testid·역할·값으로 찾도록 고쳐 다시 실행",
  D: "목록·패널이 그려진 뒤 읽도록 고쳐 다시 실행",
  E: "기획서 근거(POL·CCB 번호)에 맞게 기대를 고쳐 다시 실행",
};

/** 스텝이 던지면 케이스가 FAIL 이 아니라 NA(도구 판정 불가)로 끝난다. */
export class ToolError extends Error {
  kind: ToolErrorKind;
  /** 증거로 남길 글자(예: 예상 못 한 대화상자의 글자) */
  evidenceText?: string;
  constructor(kind: ToolErrorKind, msg: string, evidenceText?: string) {
    super(msg);
    this.name = "ToolError";
    this.kind = kind;
    this.evidenceText = evidenceText;
  }
}

/** 실제 칸이 비었거나 undefined · NaN · null 이면 화면 읽기 실패로 본다(사이트의 결함이 아니라 도구 판정 불가). */
export function isBlankActual(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "number") return Number.isNaN(v);
  const s = String(v).trim();
  return s === "" || s === "null" || /(^|[^\w])(undefined|NaN)([^\w]|$)/.test(s);
}

const VERB: Record<string, string> = {
  goto: "이동", click: "클릭", dblclick: "더블클릭", hover: "마우스 올림", fill: "입력", select: "선택", check: "체크",
  press: "키 입력", wait: "대기", expect: "확인", api: "API 호출", screenshot: "스크린샷", eval: "스크립트 실행", probe: "점검",
};

/** 이슈 「현상」 칸: 「<화면>에서 「<요소>」에 대해 「<동작>」 했더니 「<실제>」 가 나왔다. 기대는 <기대>」 */
export function symptomSentence(p: { screen: string; element: string; action: string; actual: string; expected: string }): string {
  const one = (s: string, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  return `${one(p.screen, 80)}에서 「${one(p.element, 120)}」에 대해 「${one(p.action, 60)}」 했더니 「${one(p.actual)}」 가 나왔다. 기대는 ${one(p.expected)}`;
}

/** 스텝의 동작 이름(한국어 동사). */
export const verbOf = (step: Step | undefined): string => (step ? (VERB[step.op] ?? step.op) : "실행");

/** 스텝이 가리키는 요소(선택자·주소·점검 라벨). 없으면 케이스 제목. */
export const elementOf = (step: Step | undefined, c: Pick<Case, "title"> | undefined, fallback: string): string => {
  if (step?.sel) return String(step.sel);
  if (step?.url) return String(step.url);
  if (step?.label) return String(step.label);
  return c?.title ?? fallback;
};

export interface ExcludedRow {
  id: string;
  title: string;
  kind: ToolErrorKind;
  symptom: string;
  reason: string;
  action: string;
  note: string;
  evidence?: string;
}

const isToolNa = (r: Pick<CaseResult, "status" | "toolError">) => r.status === "NA" && !!r.toolError;

/** 도구 오류(NA)로 제외된 결과의 수. 「해당 없음」(케이스 status:"na")은 세지 않는다. */
export const toolErrorCount = (results: Pick<CaseResult, "status" | "toolError">[]): number => results.filter(isToolNa).length;

/** 제외 시트의 줄. symptomOf 는 결과 하나의 「현상」 문장을 만들어 주는 함수. */
export function excludedRows(results: CaseResult[], symptomOf: (r: CaseResult) => string): ExcludedRow[] {
  return results.filter(isToolNa).map((r) => {
    const kind = r.toolError!.kind;
    const shot = [...r.steps].reverse().find((s) => s.status === "fail" && s.shot)?.shot ?? r.steps.map((s) => s.shot).filter(Boolean).at(-1);
    return {
      id: r.id,
      title: r.title,
      kind,
      symptom: symptomOf(r),
      reason: `${kind} ${TOOL_ERROR_LABEL[kind]}: ${r.toolError!.detail}`,
      action: TOOL_ERROR_ACTION[kind],
      note: "도구 판정 불가",
      evidence: [shot, r.toolError!.evidenceText].filter(Boolean).join(" · ") || undefined,
    };
  });
}

const cell = (v: unknown) => String(v ?? "").replace(/[\t\r\n]+/g, " ");

/** 제외 시트(탭 구분). 열: 케이스 · 현상 · 제외 사유 · 처리 · 비고 · 증거 */
export function excludedTsv(rows: ExcludedRow[]): string {
  const head = ["케이스", "현상", "제외 사유", "처리", "비고", "증거"].join("\t");
  return [head, ...rows.map((x) => [x.id, x.symptom, x.reason, x.action, x.note, x.evidence ?? ""].map(cell).join("\t"))].join("\n") + "\n";
}
