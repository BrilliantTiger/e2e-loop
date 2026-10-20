// 멈춤 측정 (오류 O: 창이 가려진 채 잰 측정은 무효).
// 누르는 스텝(이동·클릭·입력 등)마다 화면이 멈췄는지 잰다: Long Task · 클릭→첫 변화 · 이벤트 처리(입력 지연) · 프레임 간격.
// 측정 판정은 기능 판정과 따로 남긴다(기능이 통과해도 멈춤은 경고로, 측정이 무효여도 기능 판정은 그대로).
//
// 창이 다른 창에 가려지거나(visibilityState=hidden) 포커스를 잃으면 브라우저가 타이머·그리기를 1초 간격으로 늦춘다.
// 그러면 프레임 간격이 1000ms 근처에 몰려 「1초 넘게 멈춤」처럼 보인다. 이 서명을 보이면 측정을 NA(O, 도구 측정 무효)로 두고,
// 창을 앞으로 가져와 보이게 된 뒤 다시 잰다(이동은 그 자리에서 다시 재고, 다른 동작은 다음 스텝부터 보이는 창에서 잰다).
import type { DPage } from "./drivers/index.ts";

/** 페이지 안 측정기. 이미 있으면 그대로 둔다(문서가 바뀌면 새로 단다) */
const INSTALL = `(() => {
  const w = window;
  if (w.__e2eFz) return true;
  const now = () => performance.now();
  const z = w.__e2eFz = { t0: now(), armed: now(), lt: [], ev: [], gaps: [], tgaps: [], hid: document.visibilityState === 'hidden', blur: !document.hasFocus(), first: null, lastRaf: now(), lastTick: now() };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) z.lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: false }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) z.ev.push([e.startTime, e.duration, e.processingStart - e.startTime]); }).observe({ type: 'event', durationThreshold: 16, buffered: false }); } catch (e) {}
  const raf = (t) => { const g = t - z.lastRaf; if (g > 100) z.gaps.push([z.lastRaf, g]); z.lastRaf = t; requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  const tick = () => { const n = now(); const g = n - z.lastTick; if (g > 150) z.tgaps.push([z.lastTick, g]); z.lastTick = n; setTimeout(tick, 50); };
  setTimeout(tick, 50);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') z.hid = true; });
  w.addEventListener('blur', () => { z.blur = true; });
  try { new MutationObserver(() => { if (z.first === null) z.first = now() - z.armed; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); } catch (e) {}
  return true;
})()`;

/** 지금부터 잰다(앞서 모은 것은 버린다) */
const ARM = `(() => {
  ${INSTALL};
  const z = window.__e2eFz, n = performance.now();
  z.armed = n; z.lt = []; z.ev = []; z.gaps = []; z.tgaps = []; z.first = null; z.lastRaf = n; z.lastTick = n;
  z.hid = document.visibilityState === 'hidden'; z.blur = !document.hasFocus();
  return true;
})()`;

/** 잰 것을 읽는다. 측정기가 없으면(문서가 바뀜) null */
const READ = `(() => {
  const z = window.__e2eFz;
  if (!z) return null;
  const n = performance.now();
  const gaps = z.gaps.slice(), tgaps = z.tgaps.slice();
  // 아직 끝나지 않은 간격(그리기가 멈춰 있는 중)도 센다
  if (n - z.lastRaf > 100) gaps.push([z.lastRaf, n - z.lastRaf]);
  if (n - z.lastTick > 150) tgaps.push([z.lastTick, n - z.lastTick]);
  return { ms: n - z.armed, lt: z.lt.slice(), ev: z.ev.slice(), gaps, tgaps, first: z.first, hidden: z.hid || document.visibilityState === 'hidden', blur: z.blur || !document.hasFocus(), visible: document.visibilityState === 'visible', focus: document.hasFocus() };
})()`;

/** [시작 시각, 길이] */
type Span = [number, number];

export interface FreezeRaw {
  /** 잰 시간(ms) */
  ms: number;
  /** Long Task */
  lt: Span[];
  /** 이벤트 처리: [시작, 처리 시간, 입력 지연] */
  ev: [number, number, number][];
  /** 그리기(프레임) 간격 중 100ms 넘는 것 */
  gaps: Span[];
  /** 타이머 간격 중 150ms 넘는 것 */
  tgaps: Span[];
  /** 누른 뒤 화면(DOM)이 처음 바뀐 시각(ms). 안 바뀌었으면 null */
  first: number | null;
  /** 재는 동안 창이 가려진 적이 있나(visibilityState=hidden) */
  hidden: boolean;
  /** 재는 동안 창이 포커스를 잃은 적이 있나 */
  blur: boolean;
  visible?: boolean;
  focus?: boolean;
}

export interface FreezeStats {
  longTasks: { n: number; sum: number; max: number };
  firstChangeMs: number | null;
  eventMax: number;
  inputDelayMax: number;
  frameGapMax: number;
}

export interface FreezeJudge {
  verdict: "ok" | "freeze" | "invalid";
  summary: string;
  /** invalid·freeze 의 까닭 */
  why?: string;
}

const r0 = (n: number) => Math.round(n);

export function freezeStats(m: FreezeRaw): FreezeStats {
  return {
    longTasks: { n: m.lt.length, sum: r0(m.lt.reduce((a, [, d]) => a + d, 0)), max: r0(Math.max(0, ...m.lt.map(([, d]) => d))) },
    firstChangeMs: m.first === null ? null : r0(m.first),
    eventMax: r0(Math.max(0, ...m.ev.map(([, d]) => d))),
    inputDelayMax: r0(Math.max(0, ...m.ev.map(([, , q]) => q))),
    frameGapMax: r0(Math.max(0, ...m.gaps.map(([, g]) => g))),
  };
}

/** 「Long Task 4건 합 505ms 최대 197ms · 클릭→첫 변화 54ms · 이벤트 처리 최대 1008ms(입력 지연 1007ms) · 프레임 간격 최대 1083ms」 */
export function freezeSummary(m: FreezeRaw): string {
  const s = freezeStats(m);
  return `Long Task ${s.longTasks.n}건 합 ${s.longTasks.sum}ms 최대 ${s.longTasks.max}ms · 클릭→첫 변화 ${s.firstChangeMs === null ? "없음" : `${s.firstChangeMs}ms`} · 이벤트 처리 최대 ${s.eventMax}ms(입력 지연 ${s.inputDelayMax}ms) · 프레임 간격 최대 ${s.frameGapMax}ms`;
}

/** 가려진 창에서 브라우저가 늦춘 간격의 범위(1초 간격 근처) */
export const THROTTLE_MIN = 900;
export const THROTTLE_MAX = 1200;

/** 간격 하나가 Long Task 로 설명되는가(겹친 길이가 간격의 절반 이상) */
const covered = ([s, g]: Span, lt: Span[]) => lt.reduce((a, [ls, ld]) => a + Math.max(0, Math.min(s + g, ls + ld) - Math.max(s, ls)), 0) >= g / 2;

/**
 * 측정 판정. limitMs(기본 1000) 넘게 멈췄으면 freeze, 창이 가려진 서명을 보이면 invalid(O).
 * 가려진 창 서명: 재는 동안 visibilityState=hidden 이었다 / Long Task 로 설명되지 않는 1초 근처 간격이 2번 이상 /
 * 포커스를 잃은 채 Long Task 로 설명되지 않는 1초 넘는 간격이 있다.
 */
export function judgeFreeze(m: FreezeRaw, limitMs = 1000): FreezeJudge {
  const summary = freezeSummary(m);
  const s = freezeStats(m);
  if (m.hidden) return { verdict: "invalid", summary, why: "재는 동안 창이 가려짐(visibilityState=hidden)" };
  const loose = [...m.gaps, ...m.tgaps].filter((g) => g[1] >= THROTTLE_MIN && !covered(g, m.lt));
  const near = loose.filter(([, g]) => g <= THROTTLE_MAX);
  if (near.length >= 2) return { verdict: "invalid", summary, why: `Long Task 없이 간격이 1000ms 근처에 몰림(${near.slice(0, 4).map(([, g]) => `${r0(g)}ms`).join(", ")}) — 가려진 창에서 브라우저가 늦춘 서명${m.blur ? ", 창 포커스 없음" : ""}` };
  if (m.blur && loose.length) return { verdict: "invalid", summary, why: `창 포커스가 없는 채 Long Task 없이 ${r0(loose[0]![1])}ms 간격 — 가려진 창 서명` };
  const worst = Math.max(s.frameGapMax, s.eventMax, s.longTasks.max);
  if (worst >= limitMs) return { verdict: "freeze", summary, why: `화면이 ${limitMs / 1000}초 넘게 멈춤(최대 ${worst}ms)` };
  return { verdict: "ok", summary };
}

/** 지금부터 잰다. 실패해도 동작을 막지 않는다 */
export async function freezeArm(page: DPage): Promise<boolean> {
  try {
    return !!(await page.evaluate<boolean>(ARM));
  } catch {
    return false;
  }
}

/** 측정기가 돌려준 모양인가(아니면 잰 것이 없는 것으로 본다) */
const isRaw = (v: any): v is FreezeRaw => !!v && typeof v === "object" && ["lt", "ev", "gaps", "tgaps"].every((k) => Array.isArray(v[k])) && typeof v.ms === "number";

export async function freezeRead(page: DPage): Promise<FreezeRaw | null> {
  try {
    const v = await page.evaluate<unknown>(READ);
    return isRaw(v) ? v : null;
  } catch {
    return null;
  }
}

/** 창을 앞으로 가져와 보이고 포커스를 받을 때까지(최대 waitMs) 기다린다. 보이게 됐으면 true */
export async function bringVisible(page: DPage, waitMs = 5000): Promise<boolean> {
  await page.front?.().catch(() => {});
  const t0 = Date.now();
  for (;;) {
    const st = await page.evaluate<{ v: boolean; f: boolean }>(`({ v: document.visibilityState === 'visible', f: document.hasFocus() })`).catch(() => ({ v: false, f: false }));
    if (st.v && st.f) return true;
    if (Date.now() - t0 >= waitMs) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}
