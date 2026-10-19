// 표 줄 도우미 (오류 B: 줄 번호 재사용).
// 줄은 번호(row-3, :nth-child(3))가 아니라 컬럼 이름 · 글자로 찾는다. 줄 하나를 바꾸면 목록이 다시 정렬될 수 있어서 번호는 믿을 수 없다.
//   row=<줄 글자>                       줄 글자(부분 일치)를 가진 줄. row="정확한 칸 글자" 는 그 글자가 칸 하나와 정확히 같은 줄
//   cell[col="컬럼 이름"][row="줄 글자"]  컬럼 이름의 머리글 아래, 줄 글자를 가진 줄의 칸 (col 만 쓰면 그 컬럼의 모든 칸)
//   위 둘 뒤에 " >> button" 처럼 단순 CSS(태그·#id·.class·[속성])를 붙이면 그 줄 안의 요소
// 모두 xpath 로 바꿔 Playwright 와 Ego 가 똑같이 쓴다.

const lit = (s: string): string => {
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return "concat(" + s.split('"').map((p) => `"${p}"`).join(`, '"', `) + ")";
};

const ROW = `*[self::tr or @role="row"]`;
const CELL = `*[self::td or self::th or @role="cell" or @role="gridcell" or @role="columnheader" or @role="rowheader"]`;

/** 머리글이 아닌 데이터 칸 */
const DATA_CELL = `*[self::td or @role="cell" or @role="gridcell"]`;

const rowCond = (text: string, exact: boolean) =>
  exact ? `.//${CELL}[normalize-space(.)=${lit(text.trim())}]` : `contains(normalize-space(.), ${lit(text.trim())})`;

/** 가장 안쪽 줄만(표 안의 표에서 바깥 줄이 같이 걸리지 않게) */
const rowPath = (text: string, exact: boolean, dataOnly = false): string => {
  const c = rowCond(text, exact);
  return `//${ROW}${dataOnly ? `[./${DATA_CELL}]` : ""}[${c}][not(.//${ROW}[${c}])]`;
};

const unq = (v: string) => {
  const m = v.match(/^(["'])([\s\S]*)\1$/);
  return m ? { text: m[2]!, quoted: true } : { text: v, quoted: false };
};

/** 단순 CSS(태그·#id·.class·[속성]) 하나 → xpath 의 자손 조건. 복잡한 CSS 는 지원하지 않는다. */
function cssToXpath(css: string): string {
  const m = css.trim().match(/^([a-zA-Z][\w-]*|\*)?((?:[#.][\w-]+|\[[^\]]+\])*)$/);
  if (!m || (!m[1] && !m[2])) throw new Error(`줄 안쪽 요소는 단순 CSS(태그·#id·.class·[속성])만 쓸 수 있음: ${css}`);
  const conds: string[] = [];
  for (const part of m[2]!.match(/[#.][\w-]+|\[[^\]]+\]/g) ?? []) {
    if (part[0] === "#") conds.push(`@id=${lit(part.slice(1))}`);
    else if (part[0] === ".") conds.push(`contains(concat(" ", normalize-space(@class), " "), ${lit(" " + part.slice(1) + " ")})`);
    else {
      const a = part.slice(1, -1).match(/^([\w:-]+)(?:\s*(\^=|\$=|\*=|=)\s*(["']?)([\s\S]*?)\3)?$/);
      if (!a) throw new Error(`속성 선택자를 읽지 못함: ${part}`);
      const [, name, op, , val] = a;
      if (!op) conds.push(`@${name}`);
      else if (op === "=") conds.push(`@${name}=${lit(val!)}`);
      else if (op === "^=") conds.push(`starts-with(@${name}, ${lit(val!)})`);
      else if (op === "*=") conds.push(`contains(@${name}, ${lit(val!)})`);
      else conds.push(`substring(@${name}, string-length(@${name}) - string-length(${lit(val!)}) + 1)=${lit(val!)}`);
    }
  }
  return `.//${m[1] || "*"}${conds.map((c) => `[${c}]`).join("")}`;
}

/** 줄 도우미 선택자인가 */
export const isRowSel = (sel: string): boolean => /^row=/.test(sel) || /^cell\[/.test(sel);

/** 줄 도우미 선택자를 xpath 선택자로 바꾼다. 줄 도우미가 아니면 그대로. 읽지 못하면 오류. */
export function translateSel(sel: string): string {
  if (!isRowSel(sel)) return sel;
  const [head, ...rest] = sel.split(/\s+>>\s+/);
  let xp: string;
  if (head!.startsWith("row=")) {
    const { text, quoted } = unq(head!.slice(4));
    if (!text.trim()) throw new Error("row= 뒤에 줄 글자가 없음");
    xp = rowPath(text, quoted);
  } else {
    const attrs = new Map<string, string>();
    const m = head!.match(/^cell((?:\[(?:col|row)=(?:"[^"]*"|'[^']*')\])+)$/);
    if (!m) throw new Error(`cell[col="컬럼 이름"][row="줄 글자"] 모양이어야 함: ${head}`);
    for (const a of m[1]!.matchAll(/\[(col|row)=("[^"]*"|'[^']*')\]/g)) attrs.set(a[1]!, unq(a[2]!).text);
    const col = attrs.get("col");
    const row = attrs.get("row");
    if (!col) throw new Error(`cell 에는 col(컬럼 이름)이 필요함: ${head}`);
    const hdr = `(ancestor::table[1]//th[contains(normalize-space(.), ${lit(col)})] | ancestor::*[@role="table" or @role="grid" or @role="treegrid"][1]//*[@role="columnheader"][contains(normalize-space(.), ${lit(col)})])[1]`;
    // 머리글 줄은 빼고 데이터 줄만, 그리고 그 컬럼 머리글이 실제로 있는 표에서만 찾는다
    const rowStep = row ? rowPath(row, false, true) : `//${ROW}[./${DATA_CELL}]`;
    xp = `${rowStep}/${CELL}[count(${hdr}) = 1 and position() = count(${hdr}/preceding-sibling::*) + 1]`;
  }
  for (const r of rest) xp += "/" + cssToXpath(r).replace(/^\.\/\//, "/");
  return `xpath=${xp}`;
}

/**
 * 줄을 번호로 찾는 선택자인가 — 있으면 이유를 돌려준다.
 * row-3 · row_3 · rowIndex · tr:nth-child(3) · [role=row]:nth-of-type(2) · nth=2 처럼 줄 번호에 기대는 것.
 */
export function rowByNumber(sel: string): string | null {
  if (isRowSel(sel)) return null;
  if (/(^|[^a-z0-9])row[-_]?\d+(?![a-z0-9])/i.test(sel)) return "줄 번호(row-N)로 찾음";
  if (/\b(tr|li)\b[^,>+~]*:nth-(child|of-type|last-child|last-of-type)\(\s*\d+\s*\)/i.test(sel) || /\[role=["']?row["']?\][^,>+~]*:nth-/i.test(sel)) return "줄 순서(:nth-child 등)로 찾음";
  if (/(^|>>\s*)nth=-?\d+/i.test(sel) && /\b(tr|row)\b/i.test(sel)) return "줄 순서(nth=)로 찾음";
  return null;
}

export const ROW_BY_NUMBER_HELP = '줄은 번호가 아니라 컬럼 이름·글자로 찾을 것 — row=<줄 글자> 또는 cell[col="컬럼 이름"][row="줄 글자"] (줄 하나를 바꾸면 목록이 다시 정렬돼 번호가 달라짐, 오류 B)';
