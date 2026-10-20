// 읽기 도우미: 화면을 읽기 전에 목록·패널이 그려졌는지 먼저 기다린다(오류 D: 화면이 그려지기 전에 읽음).
import type { DPage } from "./drivers/index.ts";
import { sleep } from "./probes.ts";

/** 읽기 전 기본 대기(ms). 케이스의 timeout 으로 바꾼다 */
export const READ_WAIT_MS = 3000;
/** 패널·모달 제목이 뜨기를 기다리는 기본 시간(ms). 스텝의 panelTimeout 으로 바꾼다 */
export const PANEL_WAIT_MS = 10000;

/**
 * sel 이 화면에 나타날 때까지 기다린다. 개수(expectCount)를 주면 그 개수가 될 때까지 기다린다(0 포함).
 * 나타났으면 true, 시간이 다 되도록 안 나타났으면 false. 드라이버(Playwright·Ego)와 무관하게 개수를 되풀이해 읽는다.
 */
export async function waitRendered(p: DPage, sel: string, timeoutMs: number = READ_WAIT_MS, expectCount?: number): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    const n = await p.count(sel).catch(() => 0);
    if (expectCount !== undefined ? n === expectCount : n > 0) return true;
    if (Date.now() - t0 >= timeoutMs) return false;
    await sleep(120);
  }
}

/** 화면(주소·본문 글자)이 두 번 연달아 같을 때까지 기다린다. 줄을 바꾼 뒤 목록이 다시 그려지는 것을 기다리는 데 쓴다. */
export async function settleList(p: DPage, maxMs = 1500, gapMs = 150): Promise<void> {
  const read = () => p.evaluate<string>(`(() => { const t = (document.body && document.body.innerText) || ''; let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return location.pathname + '|' + t.length + '|' + h; })()`).catch(() => "");
  const t0 = Date.now();
  let prev = await read();
  while (Date.now() - t0 < maxMs) {
    await sleep(gapMs);
    const cur = await read();
    if (cur === prev) return;
    prev = cur;
  }
}

/** 지금 떠 있는 대화상자(또는 panel 선택자의 요소)의 제목 글자들. 자르지 않은 전체 글자다. */
const PANEL_TITLES = (panel?: string) => `(() => {
  const E = window.__e2e; const els = ${panel ? `E.resolve(${JSON.stringify(panel)})` : `E.dialogs().map((d) => d.el)`};
  return els.map((el) => {
    const parts = [el.getAttribute && el.getAttribute('aria-label')];
    for (const h of el.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],[class*=title],[class*=Title]')) parts.push(h.innerText || h.textContent);
    return E.norm(parts.filter(Boolean).join(' '));
  }).filter(Boolean);
})()`;

/**
 * 패널·모달의 제목에 target 글자가 뜰 때까지 기다린다(늦게 그려지는 패널을 읽기 전에 쓴다).
 * 떴으면 ok, 시간이 다 되면 지금 뜬 제목들을 돌려준다.
 */
export async function waitPanelTitle(p: DPage, target: string, timeoutMs: number = PANEL_WAIT_MS, panel?: string): Promise<{ ok: boolean; titles: string[] }> {
  const t0 = Date.now();
  let titles: string[] = [];
  for (;;) {
    titles = (await p.evaluate<string[]>(PANEL_TITLES(panel)).catch(() => [])) ?? [];
    if (titles.some((t) => t.includes(target))) return { ok: true, titles };
    if (Date.now() - t0 >= timeoutMs) return { ok: false, titles };
    await sleep(120);
  }
}
