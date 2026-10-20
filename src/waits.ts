// 끝 상태 집합 대기 (오류 A: 오지 않을 상태를 기다림).
// 화면이 갈 수 있는 끝 상태(완료 · 확인 필요 · 막힘 · 오류 · 비활성 사유)를 모두 받아, 어느 하나가 보이면 끝낸다.
// 15초마다 현재 상태를 로그에 남기고, 60초 동안 화면이 안 바뀌면 현재 상태를 남기고 대기 실패(도구 판정 불가)로 끝낸다.
import type { DPage } from "./drivers/index.ts";
import { sleep } from "./probes.ts";
import { ToolError } from "./toolerror.ts";

export interface EndStateWait {
  /** 상태 이름 → 그 상태일 때 보이는 요소의 선택자. 예: { "완료": "[data-testid=done]", "확인 필요": "[data-testid=review]" } */
  endStates: Record<string, string | string[]>;
  /** 이 끝 상태여야 통과. 다른 끝 상태가 오면 실패. 없으면 어느 끝 상태든 도착하면 통과(어느 쪽인지는 기록) */
  expectState?: string | string[];
  /** 화면이 이 시간 동안 안 바뀌면 대기 실패(ms). 기본 60000 */
  idleMs?: number;
  /** 전체 상한(ms). 기본 600000 */
  timeout?: number;
}

export interface EndStateOpts {
  /** 로그를 남기는 주기(ms). 기본 15000 */
  logEveryMs?: number;
  /** 상태를 읽는 간격(ms). 기본 500 */
  pollMs?: number;
  /** 긴 계산 대기: 화면이 idleMs 동안 안 바뀌어도 실패로 끝내지 않고 현재 화면 글자를 로그에 남기며 상한까지 기다린다 */
  longWait?: boolean;
  onLog?: (line: string) => void;
}

export const IDLE_MS = 60000;
export const LOG_EVERY_MS = 15000;
export const MAX_WAIT_MS = 600000;

/** 화면 서명: 주소 + 본문 글자 수 + 간단한 해시. 이 값이 그대로면 화면이 안 바뀐 것이다. */
const SIGNATURE = `(() => { const t = (document.body && document.body.innerText) || ''; let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return location.pathname + location.search + '|' + t.length + '|' + h + '|' + document.getElementsByTagName('*').length; })()`;
const SAMPLE = `(() => ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim().slice(0, 160))()`;

export const endStateNames = (w: Pick<EndStateWait, "endStates">) => Object.keys(w.endStates ?? {});

/** 끝 상태가 하나뿐인 대기인가 — 오지 않을 상태를 기다릴 수 있다 */
export const singleEndState = (w: Pick<EndStateWait, "endStates">) => endStateNames(w).length < 2;

export const SINGLE_STATE_WARNING = "끝 상태가 하나뿐인 대기: 그 상태가 오지 않으면 끝없이 기다릴 수 있음(오류 A). 완료 · 확인 필요 · 막힘 · 오류 · 비활성 사유 등 화면의 모든 끝 상태를 넣을 것";

async function visibleState(p: DPage, w: EndStateWait): Promise<string | null> {
  for (const [name, sel] of Object.entries(w.endStates)) {
    for (const one of ([] as string[]).concat(sel)) {
      if ((await p.count(one).catch(() => 0)) > 0 && (await p.isVisible(one).catch(() => false))) return name;
    }
  }
  return null;
}

/**
 * 끝 상태 중 하나가 보일 때까지 기다린다. 도착한 상태 이름과 걸린 시간을 돌려준다.
 * - 화면이 idleMs 동안 안 바뀌면 ToolError(A): 현재 상태를 메시지에 담는다.
 * - 전체 상한을 넘어도 ToolError(A).
 * - expectState 가 있는데 다른 끝 상태가 오면 그냥 Error(기대와 다른 끝 상태 = 실패).
 */
export async function waitEndState(p: DPage, w: EndStateWait, o: EndStateOpts = {}): Promise<{ state: string; ms: number }> {
  const names = endStateNames(w);
  if (!names.length) throw new Error("wait.endStates 에 끝 상태가 하나도 없음");
  const idleMs = w.idleMs ?? IDLE_MS;
  const cap = w.timeout ?? MAX_WAIT_MS;
  const every = o.logEveryMs ?? LOG_EVERY_MS;
  const poll = o.pollMs ?? 500;
  const t0 = Date.now();
  let sig = await p.evaluate<string>(SIGNATURE).catch(() => "");
  let changedAt = t0;
  let lastLog = t0;
  const sample = async () => String(await p.evaluate<string>(SAMPLE).catch(() => "")).slice(0, 160);
  for (;;) {
    const state = await visibleState(p, w);
    const now = Date.now();
    if (state) {
      const want = w.expectState === undefined ? null : ([] as string[]).concat(w.expectState);
      if (want && !want.includes(state)) throw new Error(`기대한 끝 상태(${want.join(" 또는 ")})가 아니라 「${state}」 상태가 나타남 (${((now - t0) / 1000).toFixed(1)}초)`);
      return { state, ms: now - t0 };
    }
    const cur = await p.evaluate<string>(SIGNATURE).catch(() => sig);
    if (cur !== sig) {
      sig = cur;
      changedAt = now;
    }
    if (now - lastLog >= every) {
      lastLog = now;
      o.onLog?.(`대기 중 ${Math.round((now - t0) / 1000)}초 — 끝 상태(${names.join(" · ")}) 아직 없음. 화면: ${await sample()}`);
    }
    if (o.longWait && now - changedAt >= idleMs) {
      // 긴 계산: 무변화는 실패가 아니다. 현재 화면 글자를 남기고 다음 무변화 구간을 다시 센다
      o.onLog?.(`화면이 ${Math.round(idleMs / 1000)}초 동안 안 바뀜(긴 계산 대기, 상한 ${Math.round(cap / 1000)}초까지 계속) — 현재 화면: ${await sample()}`);
      changedAt = now;
    }
    if (!o.longWait && now - changedAt >= idleMs) {
      const msg = `화면이 ${Math.round(idleMs / 1000)}초 동안 안 바뀜 — 끝 상태(${names.join(" · ")}) 중 어느 것도 안 나타남. 현재 화면: ${await sample()}`;
      o.onLog?.(`대기 실패(도구 판정 불가): ${msg}`);
      throw new ToolError("A", msg);
    }
    if (now - t0 >= cap) {
      const msg = `${Math.round(cap / 1000)}초 상한 안에 끝 상태(${names.join(" · ")})가 안 나타남. 현재 화면: ${await sample()}`;
      o.onLog?.(`대기 실패(도구 판정 불가): ${msg}`);
      throw new ToolError("A", msg);
    }
    await sleep(poll);
  }
}
