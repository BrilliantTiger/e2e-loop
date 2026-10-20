// 재시험 대기열 (사유 R: 선행 챕터가 도구 오류로 끝나 하위 챕터를 돌리지 않음).
// 돌리지 않은 하위 케이스는 대기열(retest.json)에 올리고, 선행 챕터를 다시 시험할 때 함께 돈다(e2e_round_start retest=true).
// 다시 돌아 대기 사유가 풀린 케이스는 대기열에서 빠지고, 또 막히면 새 사유로 남는다.
import type { Case, CaseResult } from "./types.ts";
import { nowIso, type Project } from "./store.ts";

export interface RetestEntry {
  case: string;
  title: string;
  chapter: string;
  /** 먼저 다시 시험할 선행 챕터 */
  after?: string;
  kind: "R";
  reason: string;
  /** 대기열에 오른 라운드 */
  round: string;
  at: string;
}

const FILE = "retest.json";

export const readRetest = (p: Project): RetestEntry[] => p.readJson<RetestEntry[]>(FILE, []);

/** 대기열에 올릴 결과인가 */
export const isQueued = (r: Pick<CaseResult, "status" | "toolError" | "retest">): boolean => r.status === "NA" && r.toolError?.kind === "R" && !!r.retest;

/** 라운드가 끝난 뒤 대기열을 고친다: 이번에 돈 케이스는 빼고, 이번에 막힌 케이스는 새 사유로 넣는다. 돌지 않은 케이스는 그대로 둔다 */
export function updateRetest(p: Project, round: string, results: CaseResult[], chapterOf: (id: string) => string): RetestEntry[] {
  const ran = new Set(results.map((r) => r.id));
  const fresh: RetestEntry[] = results.filter(isQueued).map((r) => ({ case: r.id, title: r.title, chapter: chapterOf(r.id), after: r.retest!.after, kind: "R", reason: String(r.reason ?? ""), round, at: nowIso() }));
  const out = [...readRetest(p).filter((e) => !ran.has(e.case)), ...fresh];
  p.writeJson(FILE, out);
  return out;
}

/** 재시험 라운드에서 돌릴 케이스: 대기열의 케이스와 그것들이 기다리는 선행 챕터의 케이스(원래 순서대로 — 선행이 먼저 돈다) */
export function retestSelection(p: Project, cases: Case[], chapterOf: (c: Case) => string): Case[] {
  const q = readRetest(p);
  const ids = new Set(q.map((e) => e.case));
  const afters = new Set(q.map((e) => e.after).filter(Boolean) as string[]);
  return cases.filter((c) => ids.has(c.id) || afters.has(chapterOf(c)));
}

/** 「C44 2건(선행 C45 재시험 뒤)」 */
export function describeRetest(q: RetestEntry[]): string {
  const g = new Map<string, RetestEntry[]>();
  for (const e of q) g.set(`${e.chapter}|${e.after ?? ""}`, [...(g.get(`${e.chapter}|${e.after ?? ""}`) ?? []), e]);
  return [...g.values()].map((l) => `${l[0]!.chapter} ${l.length}건(${l[0]!.after ? `선행 ${l[0]!.after} 재시험 뒤` : "다음 라운드"})`).join(", ");
}
