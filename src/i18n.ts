// 출력 언어: 한국어(ko, 기본)와 영어(en).
// 정하는 순서: 프로젝트 설정 lang(e2e_init·e2e_prestart 의 lang) → 환경변수 E2E_LOOP_LANG → 설치 폴더의 .lang 파일(sh install.sh --lang en 이 씀) → 한국어.
// 시스템 로캘(LANG)로는 정하지 않는다 — 한국어 사용자도 LANG=en_US 인 경우가 흔하다.
//
// 쓰는 법: 사람·AI 가 읽는 글은 tx("한국어", "English") 로 쓴다. 모듈을 읽을 때 한 번 만드는 표(라벨 묶음)는 byLang({ ko: …, en: … }) 로
// 감싸 쓸 때마다 고르게 한다. 진입점(actions 의 proj, 현황판 요청, 라운드)이 setLang 으로 그 프로젝트의 언어를 고른다.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Lang = "ko" | "en";
export const LANGS: readonly Lang[] = ["ko", "en"];
/** sh install.sh --lang en(setup --lang en)이 쓰는 파일. MCP 도구 설명처럼 프로젝트를 모를 때의 기본 언어 */
export const LANG_FILE = join(import.meta.dir, "..", ".lang");

const norm = (v: unknown): Lang | undefined => {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "ko" || s === "en" ? s : undefined;
};

let fallback: Lang | undefined;
/** 프로젝트를 모를 때의 언어: E2E_LOOP_LANG → .lang 파일 → 한국어 (한 번 읽고 기억한다) */
export function defaultLang(): Lang {
  if (fallback) return fallback;
  let f: Lang | undefined = norm(process.env.E2E_LOOP_LANG);
  if (!f) {
    try {
      f = norm(readFileSync(LANG_FILE, "utf8"));
    } catch {}
  }
  return (fallback = f ?? "ko");
}
/** 기억한 기본 언어를 버린다(시험·설정을 바꾼 뒤) */
export function resetDefaultLang() {
  fallback = undefined;
}

// 언어는 호출마다 따로 둔다: MCP 도구 호출·현황판 요청은 inLangScope 안에서 돌고, 그 안의 setLang 은 그 호출(과 그 호출이 띄운
// 라운드·타이머)에만 닿는다. 서로 다른 프로젝트의 호출이 동시에 돌아도(한쪽이 await 하는 사이 다른 쪽이 언어를 바꿔도) 섞이지 않는다.
// 범위 밖(CLI·시험의 직접 호출)에서는 프로세스 하나의 값을 쓴다
const scope = new AsyncLocalStorage<{ lang?: Lang }>();
let current: Lang | undefined;
/** 지금 다루는 프로젝트의 언어로 바꾼다. 값이 없거나 모르는 값이면 기본 언어를 쓴다 */
export function setLang(l?: unknown) {
  const st = scope.getStore();
  if (st) st.lang = norm(l);
  else current = norm(l);
}
export const lang = (): Lang => {
  const st = scope.getStore();
  return (st ? st.lang : current) ?? defaultLang();
};
/** fn 을 자기 언어 칸 안에서 돌린다(처음엔 기본 언어). MCP 도구 호출·현황판 요청마다 쓴다 */
export const inLangScope = <T>(fn: () => T): T => scope.run({}, fn);
/** 지금 언어의 글을 고른다 */
export const tx = (ko: string, en: string): string => (lang() === "en" ? en : ko);
/** 언어별 표를 쓸 때마다 고른다(모듈을 읽을 때 언어가 정해져 있지 않으므로) */
export const byLang = <T>(t: Record<Lang, T>) => (): T => t[lang()];

/** 설정 값 검사: ko · en 만 받는다 */
export function parseLang(v: unknown): Lang {
  const l = norm(v);
  if (!l) throw new Error(tx(`lang 은 ko 또는 en 이어야 합니다: ${v}`, `lang must be ko or en: ${v}`));
  return l;
}

/**
 * 언어별 표를 객체 하나처럼 쓴다. 속성을 읽을 때마다 지금 언어의 값을 고르므로, 내보낸 표(TABLE[key])를 쓰는 쪽을 바꾸지 않아도 된다.
 * Object.keys·entries·in 도 지금 언어의 표를 따른다
 */
export function langTable<T extends object>(t: Record<Lang, T>): T {
  const cur = () => t[lang()] as any;
  return new Proxy({} as T, {
    get: (_o, k) => cur()[k],
    has: (_o, k) => k in cur(),
    ownKeys: () => Reflect.ownKeys(cur()),
    getOwnPropertyDescriptor: (_o, k) => {
      const d = Reflect.getOwnPropertyDescriptor(cur(), k);
      return d ? { ...d, configurable: true } : undefined;
    },
  });
}
