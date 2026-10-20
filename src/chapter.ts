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
  end(c: Case, why: string) {
    this.ended.set(this.keyOf(c), why);
  }

  /** 끝난 챕터의 케이스를 누르지 않고 NA(F)로 둔 결과 */
  naResult(c: Case, why: string): CaseResult {
    const detail = `이 챕터는 이미 끝남 — ${why}. 뒤 동작을 누르지 않음`;
    return {
      id: c.id, title: c.title, type: c.type, event: c.event, source_ref: c.source_ref, element: c.element, risk: c.risk,
      status: "NA", reason: `도구 판정 불가(F): ${detail}`, toolError: { kind: "F", detail },
      warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: nowIso(),
    };
  }
}
