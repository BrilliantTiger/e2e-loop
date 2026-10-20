// 시험 도구(스크립트) 탓에 난 오류는 FAIL 이 아니라 NA(도구 판정 불가)로 둔다.
// NA 는 이슈 시트가 아니라 제외 시트(excluded_issues)로 올리고, 제외 사유는 A~G·L·M·N(도구 오류) 또는 H(선행 결함에 막힘, 도구 오류가 아님) 중 하나로 표시한다.
//   A 오지 않을 상태를 기다림   B 줄 번호 재사용   C 요소 찾는 방법이 화면과 다름
//   D 화면이 그려지기 전에 읽음   E 기대가 기획서와 다름
//   F 앞 단계가 실패했는데 뒤 단계를 계속 누름   G 판정용 문자열을 잘라서 비교
//   N 같은 탭·같은 Dataset 에서 챕터 두 개가 동시에 돎(잠금 소유자가 따로 있음)
//   M 서버 비동기 계산이 안 끝났는데 누름(준비 신호가 상한 안에 안 옴)
//   L 진행 신호가 보이는데 무변화 종료 규칙·상한으로 끝냄(대기 상한이 처리 시간보다 짧음)
//   O 창이 가려진 채 잰 멈춤 측정(측정만 무효 — 기능 판정은 따로 남는다)
//   P 판정식(eval·기대 글) 안에 다른 Dataset 전용 값을 박아, 이 Dataset 의 의도된 동작을 FAIL 로 봄
//   Q Dataset 특성 선언(traits)과 어긋난 기대 — 실행 전에 막는다(누르지 않음)
//   R 선행 챕터가 제품 FAIL 이 아니라 도구 오류(NA)로 끝나 하위 챕터를 돌리지 않음(H 의 변형) — 재시험 대기열로 간다
//   U 화면 열기에서 잰 멈춤이 다시 열면 재현되지 않음(첫 로드 비용·동시 부하 — 판정에서 뺀다)
//   H 선행 챕터의 제품 결함에 막혀 돌리지 않음(도구 오류가 아니라 제품 결함의 여파)
import type { Case, CaseResult, Step, StepResult, ToolErrorKind } from "./types.ts";

export type { ToolErrorKind };

export const TOOL_ERROR_LABEL: Record<ToolErrorKind, string> = {
  A: "오지 않을 상태를 기다림",
  B: "줄 번호 재사용",
  C: "요소 찾는 방법이 화면과 다름",
  D: "화면이 그려지기 전에 읽음",
  E: "기대가 기획서와 다름",
  F: "앞 단계가 실패했는데 뒤 단계를 계속 누름",
  G: "판정용 문자열을 잘라서 비교",
  L: "무변화 종료 규칙이 너무 짧음(진행 중인데 끝냄)",
  M: "선행 계산 미완료(서버 비동기 계산이 안 끝났는데 누름)",
  N: "동시 실행(같은 탭·같은 Dataset 에서 챕터 두 개가 동시에 돎)",
  O: "측정 무효(창 가림 — 가려진 창에서 잰 멈춤 측정)",
  P: "판정식 안의 Dataset 전용 값(다른 Dataset 의 예외 목록을 박아 의도된 동작을 FAIL 로 봄)",
  Q: "Dataset 특성 선언과 어긋난 기대(예: 사전 파일이 없는 Dataset 에 사전 파일 줄을 기대)",
  R: "선행 도구 오류로 미실행(선행 챕터가 도구 오류 NA 로 끝나 하위 증거가 없음)",
  U: "멈춤 미재현(화면 열기의 멈춤이 다시 열면 안 남 — 첫 로드 비용·동시 부하)",
};

const TOOL_ERROR_ACTION: Record<ToolErrorKind, string> = {
  A: "대기 조건에 화면의 모든 끝 상태(완료·확인 필요·막힘·오류·비활성 사유)를 넣어 다시 실행",
  B: "줄을 번호가 아니라 컬럼 이름·글자로 찾도록 고쳐 다시 실행",
  C: "요소를 data-testid·역할·값으로 찾도록 고쳐 다시 실행",
  D: "목록·패널이 그려진 뒤 읽도록 고쳐 다시 실행",
  E: "기획서 근거(POL·CCB 번호)에 맞게 기대를 고쳐 다시 실행",
  F: "챕터에 선행 조건(prereq)을 선언하고, 앞 읽기가 실패한 원인(줄·요소 찾기)을 고쳐 다시 실행",
  G: "판정용 값은 자르지 않고 전체로 비교하도록 고쳐 다시 실행(자르는 것은 로그에만)",
  L: "케이스 maxWaitSec 를 서버 처리 시간보다 길게 정하고, 진행 신호를 wait.progress 로 적어 다시 실행",
  M: "서버 계산이 끝날 때까지 기다린 뒤 다시 실행(준비 신호 ready 의 상한 timeoutSec 를 늘리거나 선행 계산을 먼저 끝냄)",
  N: "같은 대상을 쓰는 앞 챕터(잠금 소유자)가 끝난 뒤 다시 실행 — 같은 탭·Dataset 을 쓰는 라운드를 동시에 돌리지 않음",
  O: "창이 보이게 된 뒤 재측정 — 시험 창을 다른 창으로 가리지 않음(기능 판정은 그대로)",
  P: "Dataset 전용 값을 e2e_dataset 의 values 에 두고(근거: 기획서 규칙) 스텝에서 {{dataset.<이름>}} 으로 읽도록 고쳐 다시 실행",
  Q: "Dataset 특성(e2e_dataset 의 traits)에 맞게 기대를 when 으로 가르거나 고쳐 다시 등록 — 고치기 전에는 실행하지 않음",
  R: "선행 챕터의 도구 오류(시험)를 고쳐 그 챕터를 다시 시험한 뒤 재시험 대기열로 실행(e2e_round_start retest=true)",
  U: "판정에서 뺌(제품 결함 아님) — 다음 라운드에도 멈추면 그때 멈춤으로 본다",
};

/** F 의 하위 항목: 일부러 만드는 실패·중지·장애의 조건이 이번에는 성립하지 않음 */
export const CONDITION_LABEL = "시험 조건 불성립(일부러 만드는 실패·장애의 조건이 안 섬 — F 의 하위 항목)";
const CONDITION_ACTION = "조건이 서도록 시험 데이터·절차를 바꿔(예: 내용이 바뀐 파일) 다음 라운드에 재시험 — 재시험 대기열(e2e_round_start retest=true)";

/** 스텝이 던지면 케이스가 FAIL 이 아니라 NA(도구 판정 불가)로 끝난다. */
export class ToolError extends Error {
  kind: ToolErrorKind;
  /** 증거로 남길 글자(예: 예상 못 한 대화상자의 글자) */
  evidenceText?: string;
  /** F 의 하위 항목(condition = 시험 조건 불성립) */
  sub?: "condition";
  constructor(kind: ToolErrorKind, msg: string, evidenceText?: string, sub?: "condition") {
    super(msg);
    this.name = "ToolError";
    this.kind = kind;
    this.evidenceText = evidenceText;
    this.sub = sub;
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

/** 제외 사유: 도구 오류 A~G 와 선행 결함에 막힘 H */
export type ExcludedKind = ToolErrorKind | "H";
export const EXCLUDED_LABEL: Record<ExcludedKind, string> = { ...TOOL_ERROR_LABEL, H: "선행 결함에 막힘" };
const EXCLUDED_ACTION: Record<ExcludedKind, string> = { ...TOOL_ERROR_ACTION, H: "시험은 고치지 말고 선행 챕터의 제품 결함을 고친 뒤 다시 실행" };

export interface ExcludedRow {
  /** 제외 번호: <라운드>-X-<NN> (예: R07-X-03). 코멘트·추적에 쓴다 */
  no: string;
  /** 첫 케이스 id */
  id: string;
  /** 합쳐진 모든 케이스 id */
  cases: string[];
  /** 같은 (챕터, 화면, 요소, 동작, 사유)를 한 줄로 합친 횟수 */
  count: number;
  /** 같은 (화면, 요소, 동작)이 앞 라운드들에서도 제외됐으면 몇 번째 라운드인가(2 이상일 때만) */
  nth?: number;
  title: string;
  chapter: string;
  screen: string;
  element: string;
  /** 동작(한국어 동사) */
  verb: string;
  kind: ExcludedKind;
  /** 합치는 기준: 챕터·화면·요소·동작·사유 */
  key: string;
  symptom: string;
  reason: string;
  action: string;
  note: string;
  evidence?: string;
}

const isToolNa = (r: Pick<CaseResult, "status" | "toolError">) => r.status === "NA" && !!r.toolError;
const isBlockedNa = (r: Pick<CaseResult, "status" | "blockedBy">) => r.status === "NA" && !!r.blockedBy;
const isExcludedNa = (r: Pick<CaseResult, "status" | "toolError" | "blockedBy">) => isToolNa(r) || isBlockedNa(r);

/** 도구 오류(NA A~G)로 제외된 결과의 수. 「해당 없음」(케이스 status:"na")과 선행 결함에 막힌 것(H)은 세지 않는다. */
export const toolErrorCount = (results: Pick<CaseResult, "status" | "toolError">[]): number => results.filter(isToolNa).length;
/** 창이 가려진 채 재서 무효가 된 멈춤 측정의 수(O). 케이스의 기능 판정과 따로 센다 */
export const measureInvalidCount = (results: Pick<CaseResult, "steps">[]): number => results.reduce((n, r) => n + r.steps.filter((s) => s.measure?.verdict === "invalid").length, 0);
/** 화면 열기의 멈춤이 다시 열면 재현되지 않아 판정에서 뺀 측정의 수(U) */
export const freezeUnconfirmedCount = (results: Pick<CaseResult, "steps">[]): number => results.reduce((n, r) => n + r.steps.filter((s) => s.measure?.verdict === "unconfirmed").length, 0);
/** 선행 챕터의 제품 결함에 막혀 돌리지 않은 결과의 수(H). 도구 오류가 아니다. */
export const blockedCount = (results: Pick<CaseResult, "status" | "blockedBy">[]): number => results.filter(isBlockedNa).length;

export interface ExcludedInfo {
  chapter?: string;
  screen?: string;
  element?: string;
  verb?: string;
}

/**
 * 제외 시트의 줄. symptomOf 는 결과 하나의 「현상」 문장을 만들어 주는 함수.
 * 같은 (챕터, 화면, 요소, 동작, 사유)는 한 줄로 합치고 횟수를 센다. 줄마다 <라운드>-X-<NN> 번호를 붙인다.
 */
export function excludedRows(results: CaseResult[], symptomOf: (r: CaseResult) => string, ctx: { round?: string; info?: (r: CaseResult) => ExcludedInfo; /** 측정 무효(O) 줄의 자리: 그 스텝의 화면·요소·동작 */ stepInfo?: (r: CaseResult, s: StepResult) => ExcludedInfo } = {}): ExcludedRow[] {
  const round = ctx.round ?? "R00";
  const rows: ExcludedRow[] = [];
  const byKey = new Map<string, ExcludedRow>();
  for (const r of results.filter(isExcludedNa)) {
    const kind: ExcludedKind = r.blockedBy ? "H" : r.toolError!.kind;
    const info = ctx.info?.(r) ?? {};
    const chapter = info.chapter ?? "";
    const screen = info.screen ?? "";
    const element = info.element ?? r.title;
    const verb = info.verb ?? "실행";
    // M(선행 계산 미완료)은 같은 준비 신호를 기다린 줄이면 요소·동작이 달라도 한 원인이라 한 줄로 합친다
    const key = kind === "M" ? [chapter, screen, "M", r.toolError!.evidenceText ?? ""].join("\u0001") : [chapter, screen, element, verb, kind === "H" ? `H:${r.blockedBy!.chapter}` : kind].join("\u0001");
    const hit = byKey.get(key);
    if (hit) {
      hit.count++;
      hit.cases.push(r.id);
      continue;
    }
    const shot = [...r.steps].reverse().find((s) => s.status === "fail" && s.shot)?.shot ?? r.steps.map((s) => s.shot).filter(Boolean).at(-1);
    const row: ExcludedRow = {
      no: `${round}-X-${String(rows.length + 1).padStart(2, "0")}`,
      id: r.id,
      cases: [r.id],
      count: 1,
      title: r.title,
      chapter, screen, element, verb, kind, key,
      symptom: symptomOf(r),
      reason: kind === "H" ? `H ${EXCLUDED_LABEL.H}: ${r.blockedBy!.detail}` : `${kind} ${r.toolError?.sub === "condition" ? CONDITION_LABEL : TOOL_ERROR_LABEL[kind]}: ${r.toolError!.detail}`,
      action: r.toolError?.sub === "condition" ? CONDITION_ACTION : EXCLUDED_ACTION[kind],
      note: kind === "H" ? "도구 오류 아님 — 선행 챕터의 제품 결함에 막혀 돌리지 않음" : "도구 판정 불가",
      evidence: [shot, r.toolError?.evidenceText].filter(Boolean).join(" · ") || undefined,
    };
    byKey.set(key, row);
    rows.push(row);
  }
  // 측정 무효(O)·멈춤 미재현(U): 기능 판정과 따로, 그 스텝을 줄로 올린다(그 케이스의 기능 판정은 그대로)
  for (const r of results) {
    for (const s of r.steps) {
      if (s.measure?.verdict !== "invalid" && s.measure?.verdict !== "unconfirmed") continue;
      const mk: ExcludedKind = s.measure.verdict === "invalid" ? "O" : "U";
      const info = ctx.stepInfo?.(r, s) ?? {};
      const chapter = info.chapter ?? "";
      const screen = info.screen ?? "";
      const element = info.element ?? s.desc;
      const verb = info.verb ?? "실행";
      const key = [chapter, screen, element, verb, mk].join("\u0001");
      const hit = byKey.get(key);
      if (hit) {
        hit.count++;
        if (!hit.cases.includes(r.id)) hit.cases.push(r.id);
        continue;
      }
      const row: ExcludedRow = {
        no: `${round}-X-${String(rows.length + 1).padStart(2, "0")}`,
        id: r.id,
        cases: [r.id],
        count: 1,
        title: r.title,
        chapter, screen, element, verb, kind: mk, key,
        symptom: `${screen}에서 「${element}」 「${verb}」 중 멈춤 측정 — ${s.measure.summary}`,
        reason: `${mk} ${TOOL_ERROR_LABEL[mk]}: ${s.measure.why ?? "-"}`,
        action: EXCLUDED_ACTION[mk],
        note: `${mk === "O" ? "측정만 무효" : "제품 결함 아님(미재현)"} — 기능 판정은 ${r.status}(따로 남음)${s.measure.remeasured ? ` · 재측정: ${s.measure.remeasured}` : ""}`,
        evidence: s.shot,
      };
      byKey.set(key, row);
      rows.push(row);
    }
  }
  return rows;
}

/** (화면, 요소, 동작) 키: 라운드를 넘어 같은 자리의 반복을 셀 때 쓴다 */
const placeKey = (x: Pick<ExcludedRow, "screen" | "element" | "verb">) => [x.screen, x.element, x.verb].join("\u0001");

/** 앞 라운드들의 제외 줄을 보고, 같은 (화면, 요소, 동작)이 몇 번째 라운드에 다시 나왔는지 nth 를 붙인다 */
export function markRepeats(rows: ExcludedRow[], prior: { round: string; rows: ExcludedRow[] }[]): ExcludedRow[] {
  const seen = new Map<string, Set<string>>();
  for (const { round, rows: pr } of prior) for (const x of pr) if (x.screen !== undefined) seen.set(placeKey(x), (seen.get(placeKey(x)) ?? new Set()).add(round));
  for (const x of rows) {
    const n = seen.get(placeKey(x))?.size ?? 0;
    if (n > 0) x.nth = n + 1;
  }
  return rows;
}

const cell = (v: unknown) => String(v ?? "").replace(/[\t\r\n]+/g, " ");

/** 제외 시트(탭 구분). 열: 번호 · 케이스 · 챕터 · 횟수 · 반복 · 현상 · 제외 사유 · 처리 · 비고 · 증거 */
export function excludedTsv(rows: ExcludedRow[]): string {
  const head = ["번호", "케이스", "챕터", "횟수", "반복", "현상", "제외 사유", "처리", "비고", "증거"].join("\t");
  return [head, ...rows.map((x) => [x.no, x.cases.join(", "), x.chapter, x.count, x.nth ? `${x.nth}회째` : "", x.symptom, x.reason, x.action, x.note, x.evidence ?? ""].map(cell).join("\t"))].join("\n") + "\n";
}

/** 여러 라운드에 걸쳐 합친 제외 줄: 같은 줄이 다시 돌 때마다 새로 쌓이지 않고 횟수만 늘어난다 */
export interface ExcludedAllRow extends ExcludedRow {
  /** 이 줄이 나온 라운드들 */
  rounds: string[];
  /** 가장 최근에 나온 라운드 */
  lastRound: string;
}

/** 라운드별 제외 줄(오래된 라운드부터)을 같은 key 끼리 합친다. 번호는 처음 나온 번호를 유지하고 횟수는 더한다. */
export function mergeExcludedAcross(perRound: { round: string; rows: ExcludedRow[] }[]): ExcludedAllRow[] {
  const out = new Map<string, ExcludedAllRow>();
  for (const { round, rows } of perRound) {
    for (const x of rows) {
      if (!x.key) continue; // key 가 없는 옛 형식 줄은 합치지 않는다
      const hit = out.get(x.key);
      if (hit) {
        hit.count += x.count;
        hit.cases = [...new Set([...hit.cases, ...x.cases])];
        if (!hit.rounds.includes(round)) hit.rounds.push(round);
        hit.lastRound = round;
        hit.symptom = x.symptom;
        hit.reason = x.reason;
        hit.evidence = x.evidence ?? hit.evidence;
      } else {
        out.set(x.key, { ...x, cases: [...x.cases], rounds: [round], lastRound: round });
      }
    }
  }
  return [...out.values()];
}

/** 합친 제외 시트(탭 구분). 열: 번호 · 케이스 · 챕터 · 횟수 · 나온 라운드 · 현상 · 제외 사유 · 처리 · 비고 · 증거 */
export function excludedAllTsv(rows: ExcludedAllRow[]): string {
  const head = ["번호", "케이스", "챕터", "횟수", "나온 라운드", "현상", "제외 사유", "처리", "비고", "증거"].join("\t");
  return [head, ...rows.map((x) => [x.no, x.cases.join(", "), x.chapter, x.count, x.rounds.join(","), x.symptom, x.reason, x.action, x.note, x.evidence ?? ""].map(cell).join("\t"))].join("\n") + "\n";
}
