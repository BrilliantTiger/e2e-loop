// 챕터 가드 (오류 F: 앞 단계가 실패했는데 뒤 단계를 계속 누름).
// 챕터 = 같은 화면·같은 기능 단위의 케이스 묶음.
//  - 선행 조건(prereq 스텝)이 실패하면 그 챕터는 「선행 조건 실패 — 도구」 NA 로 끝내고 뒤 케이스를 돌리지 않는다.
//  - 읽기 실패(요소 못 찾음 · undefined · 빈 값)가 연속되면 2번째부터 NA(F), 4번째에서 챕터를 끝낸다.
import type { Case, CaseResult } from "./types.ts";
import { nowIso } from "./store.ts";

/** 연속 읽기 실패가 이 횟수에 닿으면 챕터를 끝낸다 */
export const READ_FAIL_END = 4;
/** 연속 읽기 실패가 이 횟수부터는 FAIL 이 아니라 NA(F) */
export const READ_FAIL_NA_FROM = 2;

const NOT_FOUND = /요소를 찾지 못|waiting for (locator|selector)|Timeout \d+ms exceeded|resolved to 0 elements|보여야 하는데 안 보임|읽기 전에 그려져 있어야|읽지 못함/i;
/** 요소는 있었는데 가려졌거나 꺼져 있어 못 누른 것 — 요소를 못 찾은 읽기 실패가 아니라 사이트의 상태일 수 있다 */
const FOUND_BUT_BLOCKED = /intercepts pointer events|is not enabled|not stable|is disabled|element is not visible/i;
const READ_OPS = new Set(["expect", "eval", "click", "dblclick", "hover", "fill", "select", "check", "press", "wait", "collect"]);

/** 결과가 「읽기 실패」인가: 빈 칸·undefined 로 못 읽었거나(NA D), 요소를 못 찾아 시간이 다 된 FAIL */
export function isReadFailure(r: Pick<CaseResult, "status" | "toolError" | "steps">): boolean {
  if (r.status === "NA" && r.toolError) return r.toolError.kind === "D" && !/예상 못 한 대화상자/.test(r.toolError.detail);
  if (r.status !== "FAIL") return false;
  const failed = r.steps.find((s) => s.status === "fail");
  return !!failed && READ_OPS.has(failed.op) && NOT_FOUND.test(failed.error ?? "") && !FOUND_BUT_BLOCKED.test(failed.error ?? "");
}

export class ChapterGuard {
  private streak = new Map<string, number>();
  private ended = new Map<string, string>();
  private endedKind = new Map<string, "F" | "N">();
  constructor(private keyOf: (c: Case) => string) {}

  /** 사람이 쓴(spec) 활성 케이스만 챕터 가드를 받는다(자동 점검 probe 는 제외) */
  private guarded = (c: Case) => c.type === "spec" && (c.status ?? "active") === "active" && !c.skipReason;

  /** 챕터가 이미 끝났으면 이 케이스를 돌리지 않는 이유 */
  skipReason(c: Case): string | undefined {
    return this.guarded(c) ? this.ended.get(this.keyOf(c)) : undefined;
  }

  /** 첫 시도 결과가 연속 읽기 실패의 2번째 이상이라 재시도 없이 NA(F)로 바꿀 것인가 */
  willConvert(c: Case, r: CaseResult): boolean {
    return this.guarded(c) && isReadFailure(r) && (this.streak.get(this.keyOf(c)) ?? 0) + 1 >= READ_FAIL_NA_FROM;
  }

  /** 결과를 챕터 기록에 반영하고, 필요하면 NA(F)로 바꾼 결과를 돌려준다 */
  settle(c: Case, r: CaseResult): CaseResult {
    if (!this.guarded(c)) return r;
    const key = this.keyOf(c);
    // 시험 조건 불성립은 그 케이스만의 일이라 챕터를 끝내지 않는다(재시험 대기열로 간다)
    if (r.status === "NA" && r.toolError?.kind === "F" && r.toolError.sub === "condition") return r;
    if (r.status === "NA" && r.toolError?.kind === "F") {
      this.ended.set(key, r.toolError.detail);
      return r;
    }
    if (isReadFailure(r)) {
      const n = (this.streak.get(key) ?? 0) + 1;
      this.streak.set(key, n);
      let out = r;
      if (n >= READ_FAIL_NA_FROM) {
        const detail = `읽기 실패 ${n}번 연속 — 앞 읽기가 실패한 뒤에는 판정하지 않음(이 케이스의 원래 결과: ${String(r.reason ?? r.status).slice(0, 160)})`;
        const { retries: _drop, priority: _p, promoted: _q, ...rest } = r;
        out = { ...rest, status: "NA", toolError: { kind: "F", detail }, reason: `도구 판정 불가(F): ${detail}` };
      }
      if (n >= READ_FAIL_END) this.ended.set(key, `읽기 실패 ${n}번 연속 — 챕터를 끝냄`);
      return out;
    }
    if (r.status === "PASS" || r.status === "FAIL" || r.status === "FLAKY") this.streak.set(key, 0);
    return r;
  }

  /** 챕터를 시작할 수 없어 끝낸다(예: 이전 브라우저 프로세스가 남아 있음). 뒤 케이스는 누르지 않는다 */
  end(c: Case, why: string, kind: "F" | "N" = "F") {
    this.ended.set(this.keyOf(c), why);
    this.endedKind.set(this.keyOf(c), kind);
  }

  /** 끝난 챕터의 케이스를 누르지 않고 NA(F)로 둔 결과 */
  naResult(c: Case, why: string): CaseResult {
    const kind = this.endedKind.get(this.keyOf(c)) ?? "F";
    const detail = kind === "N" ? `${why}. 눌러 보지 않음` : `이 챕터는 이미 끝남 — ${why}. 뒤 동작을 누르지 않음`;
    return {
      id: c.id, title: c.title, type: c.type, event: c.event, source_ref: c.source_ref, element: c.element, risk: c.risk,
      status: "NA", reason: `도구 판정 불가(${kind}): ${detail}`, toolError: { kind, detail },
      warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: nowIso(),
    };
  }
}

/** 챕터 이름: 케이스에 chapter 를 적었으면 그 이름, 아니면 화면|기능 단위 */
export const chapterName = (c: Case, fallback: (c: Case) => string): string => (c.chapter?.trim() ? c.chapter.trim() : fallback(c));

/** 선행 결함에 막힘의 근거를 사람이 읽는 글로: 「선행 결함에 막힘(C9-03 외 16건, 챕터 C9)」 */
export function blockedLabel(b: { chapter: string; by: string[] }): string {
  if (!b.by.length) return `선행 미완료(챕터 ${b.chapter})`;
  const more = b.by.length > 1 ? ` 외 ${b.by.length - 1}건` : "";
  return `선행 결함에 막힘(${b.by[0] ?? "-"}${more}, 챕터 ${b.chapter})`;
}

/**
 * 챕터 간 의존 (사유 H). 케이스의 requires 가 가리키는 선행 챕터에 제품 FAIL 이 있으면 그 케이스는 돌리지 않는다.
 * 선행 챕터 자신이 막혔으면 뒤 챕터도 같은 뿌리 결함에 막힌 것으로 본다(C9 → C11 → C12 → C44).
 * 선행 챕터가 이번 라운드에 아직 돌지 않았거나 일부 라운드라 없으면 막지 않는다.
 */
export class DefectGuard {
  private failed = new Map<string, string[]>();
  private root = new Map<string, { chapter: string; by: string[] }>();
  /** 선행 챕터의 도구 오류(NA) — 사유 R */
  private toolFailed = new Map<string, string[]>();
  private toolRoot = new Map<string, { chapter: string; by: string[] }>();
  constructor(private nameOf: (c: Case) => string) {}

  private applies = (c: Case) => c.type === "spec" && (c.status ?? "active") === "active" && !c.skipReason;

  /** 이 케이스를 막는 선행 결함. 없으면 undefined */
  blockedBy(c: Case): NonNullable<CaseResult["blockedBy"]> | undefined {
    if (!this.applies(c) || !c.requires?.length) return undefined;
    for (const need of c.requires) {
      const f = this.failed.get(need);
      const by = f?.length ? { chapter: need, by: f } : this.root.get(need);
      if (by) return { chapter: by.chapter, by: by.by, detail: blockedLabel(by) };
    }
    return undefined;
  }

  /** 선행 챕터가 도구 오류(NA)로 끝나 이 케이스를 돌리지 않는가(사유 R). 제품 결함(H)이 먼저다 */
  toolBlockedBy(c: Case): { chapter: string; by: string[] } | undefined {
    if (!this.applies(c) || !c.requires?.length) return undefined;
    for (const need of c.requires) {
      const f = this.toolFailed.get(need);
      const by = f?.length ? { chapter: need, by: f } : this.toolRoot.get(need);
      if (by) return by;
    }
    return undefined;
  }

  /** 결과를 기록한다. 제품 FAIL(도구 오류가 아닌 FAIL)이면 챕터의 결함으로, 막힌 NA(H)면 뿌리 결함을 이어 받는다 */
  record(c: Case, r: CaseResult) {
    if (!this.applies(c)) return;
    const name = this.nameOf(c);
    if (r.status === "FAIL" && !r.toolError) {
      this.failed.set(name, [...(this.failed.get(name) ?? []), c.id]);
    } else if (r.blockedBy && !this.root.has(name)) {
      this.root.set(name, { chapter: r.blockedBy.chapter, by: r.blockedBy.by });
    } else if (r.retest) {
      if (!this.toolRoot.has(name)) this.toolRoot.set(name, { chapter: r.retest.after, by: r.retest.by });
    } else if (r.status === "NA" && r.toolError) {
      this.toolFailed.set(name, [...(this.toolFailed.get(name) ?? []), c.id]);
    }
  }

  /** 선행 도구 오류로 돌리지 않은 케이스의 결과: 누르지 않고 NA(R), 재시험 대기열로 간다 */
  toolNaResult(c: Case, b: { chapter: string; by: string[] }): CaseResult {
    const more = b.by.length > 1 ? ` 외 ${b.by.length - 1}건` : "";
    const detail = `선행 도구 오류로 미실행(${b.by[0] ?? "-"}${more}, 챕터 ${b.chapter}) — 선행 챕터가 도구 오류(NA)로 끝나 이 챕터의 증거가 생기지 않음. 선행 챕터를 다시 시험한 뒤 재시험 대기열로 실행`;
    return {
      id: c.id, title: c.title, type: c.type, event: c.event, source_ref: c.source_ref, element: c.element, risk: c.risk,
      status: "NA", reason: `도구 판정 불가(R): ${detail}`, toolError: { kind: "R", detail }, retest: { after: b.chapter, by: b.by },
      warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: nowIso(),
    };
  }

  /** 막힌 케이스의 결과: 누르지 않고 NA(H) 로 둔다 */
  naResult(c: Case, b: NonNullable<CaseResult["blockedBy"]>): CaseResult {
    return {
      id: c.id, title: c.title, type: c.type, event: c.event, source_ref: c.source_ref, element: c.element, risk: c.risk,
      status: "NA", reason: `${b.detail} — 이 케이스는 돌리지 않음(도구 오류 아님, 선행 결함을 고친 뒤 다시 실행)`, blockedBy: b,
      warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: nowIso(),
    };
  }
}

/** 챕터 의존(requires)이 돌고 도는지 찾는다. 돌면 그 고리(예: ["C9","C11K","C9"]), 아니면 undefined */
export function requiresCycle(cases: Pick<Case, "chapter" | "requires">[]): string[] | undefined {
  const edges = new Map<string, Set<string>>();
  for (const c of cases) {
    const name = c.chapter?.trim();
    if (!name || !c.requires?.length) continue;
    const set = edges.get(name) ?? new Set<string>();
    for (const r of c.requires) set.add(r.trim());
    edges.set(name, set);
  }
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (n: string): string[] | undefined => {
    if (state.get(n) === 2) return undefined;
    if (state.get(n) === 1) return [...path.slice(path.indexOf(n)), n];
    state.set(n, 1);
    path.push(n);
    for (const m of edges.get(n) ?? []) {
      const hit = visit(m);
      if (hit) return hit;
    }
    path.pop();
    state.set(n, 2);
    return undefined;
  };
  for (const n of edges.keys()) {
    const hit = visit(n);
    if (hit) return hit;
  }
  return undefined;
}

/** 화면 경로가 목표 화면에 맞는가. 목표의 <id>·:id·* 조각은 아무 조각이나 받는다 */
export function screenMatches(path: string, screen: string): boolean {
  const norm = (x: string) => x.replace(/[?#].*$/, "").replace(/\/+$/, "") || "/";
  const a = norm(path).split("/");
  const b = norm(screen).split("/");
  if (a.length !== b.length) return false;
  return b.every((seg, i) => seg === a[i] || /^(<[^>]+>|:[^/]+|\*)$/.test(seg));
}

/** 선행 단계가 끝나지 않아 목표 화면으로 못 들어간 것(사유 H). 러너가 기다리지 않고 바로 NA 로 끝낸다 */
export class PrereqIncomplete extends Error {
  constructor(public chapter: string, msg: string) {
    super(msg);
    this.name = "PrereqIncomplete";
  }
}
