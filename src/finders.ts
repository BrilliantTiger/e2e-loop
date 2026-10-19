// 요소 찾기 (오류 C: 요소를 찾는 방법이 화면과 다름).
// 요소는 data-testid · 역할 · 값으로 찾는다. 라벨 글자만으로 찾으면 화면의 글자와 요소의 값이 달라 엇나갈 수 있다
// (예: 「트랙」 글자로 칸을 찾았는데 칸에는 고른 값 IRB/DRB 만 있음).
import type { DPage } from "./drivers/index.ts";

/** 글자 말고 안정적인 식별 수단(id · data-testid · name · aria-label · role · 값)이 하나라도 있는가 */
const STABLE = /\[(data-(?:testid|test|cy|qa))\s*[~^$*|]?=|(^|[\s>+~(,])#[\w-]|\[(id|name|aria-label|aria-labelledby|placeholder|value|href|type|for)\s*[~^$*|]?=|^role=|^xpath=|^row=|^cell\[|\[role\s*=/i;

/** 라벨 글자만으로 요소를 찾는 선택자인가 */
export function labelOnly(sel: string | undefined): boolean {
  if (!sel) return false;
  const s = sel.trim();
  if (STABLE.test(s)) return false;
  return /^text=/i.test(s) || /:(text-is|has-text|text)\(/i.test(s);
}

export const LABEL_ONLY_WARNING = (sel: string) =>
  `라벨 글자만으로 찾는 선택자(${sel}): 화면의 글자와 요소의 값이 다를 수 있음. data-testid · 역할(role=button[name="…"]) · 값으로 찾을 것(오류 C)`;

/** 찾은 요소를 사람이 눈으로 확인할 한 줄로 적는다. 못 찾았거나 읽지 못하면 undefined. */
export async function describeFound(p: DPage, sel: string): Promise<string | undefined> {
  try {
    const r = await p.evaluate<{ n: number; tag: string; text: string; value?: string; testid?: string; role?: string; id?: string } | null>(
      `(() => { const all = window.__e2e.resolve(${JSON.stringify(sel)}); if (!all.length) return null; const e = all[0]; const t = window.__e2e.textOf(e).slice(0, 60); return { n: all.length, tag: e.tagName.toLowerCase(), text: t, value: typeof e.value === 'string' ? e.value.slice(0, 60) : undefined, testid: e.getAttribute('data-testid') || undefined, role: e.getAttribute('role') || undefined, id: e.id || undefined }; })()`,
    );
    if (!r) return undefined;
    const attrs = [r.testid && `data-testid=${r.testid}`, r.role && `role=${r.role}`, r.id && `id=${r.id}`].filter(Boolean).join(" ");
    return `<${r.tag}> 글자 「${r.text}」${r.value !== undefined && r.value !== r.text ? ` 값 「${r.value}」` : ""}${attrs ? ` (${attrs})` : ""}${r.n > 1 ? ` — 일치 ${r.n}개 중 첫 번째` : ""}`;
  } catch {
    return undefined;
  }
}
