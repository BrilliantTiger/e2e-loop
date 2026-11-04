// 여러 쪽 줄 모으기 (오류 C 추가: 쪽 넘김).
// 목록이 여러 쪽이면 같은 이름 줄이 쪽마다 흩어져 있다. 첫 줄만 쓰거나 pop() 으로 마지막 줄만 읽으면 엇나가므로,
// 다음 쪽 단추를 따라 모든 쪽을 돌며 줄 글자를 모은다.
import { langTable, tx } from "./i18n.ts";
import type { DPage } from "./drivers/index.ts";
import { READ_WAIT_MS, settleList, waitRendered } from "./reads.ts";

export interface CollectOpts {
  /** 줄을 찾는 선택자 (row=<줄 글자> · cell[col][row] · CSS · xpath). 러너가 줄 도우미를 xpath 로 바꿔 넘긴다 */
  sel: string;
  /** 다음 쪽으로 가는 단추 선택자. 없으면 한 쪽만 읽는다 */
  next?: string;
  /** 모으기 전에 첫 쪽으로 가는 단추 선택자(목록이 첫 쪽이 아닐 수 있을 때) */
  first?: string;
  /** 돌 쪽 수 상한. 기본 50 */
  maxPages?: number;
  /** 첫 쪽에서 줄이 그려지기를 기다릴 때 줄이 하나는 있어야 하는가(기대가 있을 때 true) */
  expectRows?: boolean;
}

export interface Collected {
  pages: number;
  rows: { page: number; text: string }[];
  /** 왜 멈췄는가(언어와 무관한 코드. 보여 줄 글은 STOPPED_BY_LABEL) */
  stoppedBy: StopReason;
}

/** 멈춘 까닭: single=단일 쪽 · last=마지막 쪽 · no-next=다음 단추 없음 · unchanged=쪽이 안 바뀜 · repeat=같은 쪽 반복 · max=쪽 상한 */
export type StopReason = "single" | "last" | "no-next" | "unchanged" | "repeat" | "max";

/** 멈춘 까닭을 사람이 읽는 글로 */
export const STOPPED_BY_LABEL = langTable<Record<StopReason, string>>({
  ko: { single: "단일 쪽", last: "마지막 쪽", "no-next": "다음 단추 없음", unchanged: "쪽이 안 바뀜", repeat: "같은 쪽 반복", max: "쪽 상한" },
  en: { single: "single page", last: "last page", "no-next": "no next button", unchanged: "page did not change", repeat: "same page again", max: "page limit" },
});

export const MAX_PAGES = 50;

const ROWS = (sel: string) => `(() => window.__e2e.resolve(${JSON.stringify(sel)}).map((e) => window.__e2e.norm(e.innerText || e.textContent || '')))()`;
const NEXT = (sel: string) => `(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; if (!e) return 'none'; if (!window.__e2e.vis(e)) return 'hidden'; return (e.disabled || e.getAttribute('aria-disabled') === 'true' || /(^|\\s)(disabled|is-disabled)(\\s|$)/.test(e.className || '')) ? 'disabled' : 'ok'; })()`;
const SIG = `(() => { const t = (document.body && document.body.innerText) || ''; let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return location.pathname + location.search + '|' + t.length + '|' + h; })()`;

/** 모든 쪽을 돌며 줄 글자를 모은다. 각 줄이 몇 쪽에 있었는지 함께 돌려준다. */
export async function collectRows(p: DPage, o: CollectOpts, timeoutMs: number = READ_WAIT_MS): Promise<Collected> {
  const max = o.maxPages ?? MAX_PAGES;
  if (o.first && (await p.evaluate<string>(NEXT(o.first)).catch(() => "none")) === "ok") {
    await p.click(o.first);
    await settleList(p);
  }
  if (o.expectRows) await waitRendered(p, o.sel, timeoutMs);
  const rows: Collected["rows"] = [];
  const seen = new Set<string>();
  let page = 0;
  for (;;) {
    page++;
    await settleList(p);
    const sig = await p.evaluate<string>(SIG).catch(() => "");
    if (seen.has(sig)) return { pages: page - 1, rows, stoppedBy: "repeat" };
    seen.add(sig);
    for (const text of (await p.evaluate<string[]>(ROWS(o.sel)).catch(() => [])) ?? []) rows.push({ page, text });
    if (!o.next) return { pages: page, rows, stoppedBy: "single" };
    const st = await p.evaluate<string>(NEXT(o.next)).catch(() => "none");
    if (st === "none" || st === "hidden") return { pages: page, rows, stoppedBy: "no-next" };
    if (st === "disabled") return { pages: page, rows, stoppedBy: "last" };
    if (page >= max) return { pages: page, rows, stoppedBy: "max" };
    await p.click(o.next);
    await settleList(p);
    if ((await p.evaluate<string>(SIG).catch(() => "")) === sig) return { pages: page, rows, stoppedBy: "unchanged" };
  }
}

/** 쪽별로 몇 줄이었는지 한 줄로 */
export const perPage = (c: Collected): string => {
  const n = new Map<number, number>();
  for (const r of c.rows) n.set(r.page, (n.get(r.page) ?? 0) + 1);
  return Array.from({ length: c.pages }, (_, i) => {
    const k = n.get(i + 1) ?? 0;
    return tx(`${i + 1}쪽 ${k}줄`, `page ${i + 1}: ${k} ${k === 1 ? "row" : "rows"}`);
  }).join(" · ");
};
