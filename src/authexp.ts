// 오류 V: 로그인 만료 — 남은 토큰을 다시 써서 시험 도중 토큰이 만료돼 로그인 화면으로 튕김.
// 시작 전에 심을 토큰(auth.localStorage·cookies)의 남은 시간을 읽어 짧으면 시작하지 않고,
// 시험 도중 로그인 화면으로 튕기거나(auth.loginPath) 401 을 받고 실패한 케이스는 FAIL 이 아니라 NA(V)로 둔다.
import type { Config } from "./types.ts";
import { expandEnv } from "./store.ts";

/** 남은 시간이 이보다 짧으면 시작하지 않는다(분). 기본 4시간 */
export const MIN_REMAINING_MIN = 240;

const JWT = /eyJ[\w-]+\.(eyJ[\w-]+)\.[\w-]*/;

/** 글 안의 JWT 에서 만료 시각(ms)을 읽는다. JWT 가 없거나 exp 가 없으면 undefined */
export function jwtExp(v: string): number | undefined {
  const m = JWT.exec(v);
  if (!m) return undefined;
  try {
    const p = JSON.parse(Buffer.from(m[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof p.exp === "number" ? p.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export interface TokenLeft {
  where: string;
  expiresAt: number;
  leftMin: number;
}

/** 심을 토큰마다 남은 시간 */
export function tokensLeft(cfg: Pick<Config, "auth">, now = Date.now()): TokenLeft[] {
  const vals: [string, string][] = [
    ...Object.entries(cfg.auth?.localStorage ?? {}).map(([k, v]) => [`localStorage ${k}`, v] as [string, string]),
    ...(cfg.auth?.cookies ?? []).map((c) => [`cookie ${c.name}`, c.value] as [string, string]),
  ];
  const out: TokenLeft[] = [];
  for (const [where, raw] of vals) {
    const exp = jwtExp(expandEnv(raw));
    if (exp !== undefined) out.push({ where, expiresAt: exp, leftMin: Math.floor((exp - now) / 60000) });
  }
  return out;
}

const kst = (ms: number) => new Date(ms + 9 * 3600000).toISOString().replace("T", " ").slice(0, 16) + " KST";

/** 시작 전 점검: 남은 시간이 짧거나 이미 만료된 토큰이 있으면 그 사유 */
export function tokenProblem(cfg: Pick<Config, "auth">, now = Date.now()): string | undefined {
  const min = cfg.auth?.minRemainingMin ?? MIN_REMAINING_MIN;
  const bad = tokensLeft(cfg, now).filter((t) => t.leftMin < min);
  if (!bad.length) return undefined;
  const list = bad.map((t) => `${t.where} ${t.leftMin <= 0 ? `만료됨(${kst(t.expiresAt)})` : `남은 ${t.leftMin}분(${kst(t.expiresAt)} 만료)`}`).join(", ");
  return `로그인 토큰의 남은 시간이 ${min}분보다 짧습니다: ${list}. 남은 토큰을 그대로 쓰면 시험 도중 만료돼 로그인 화면으로 튕깁니다(오류 V). 브라우저에서 새로 로그인해 토큰을 바꾼 뒤(e2e_init authLocalStorage) 시작하세요.`;
}

/** 지금 화면이 로그인 화면인가(auth.loginPath 정규식). 로그인 화면으로 간 것이 목표였으면 튕김이 아니다 */
export function onLoginScreen(cfg: Pick<Config, "auth">, path: string, target?: string): boolean {
  const lp = cfg.auth?.loginPath;
  if (!lp) return false;
  const re = new RegExp(lp);
  return re.test(path) && !(target !== undefined && re.test(target));
}

/** 받은 401(인증 만료) 요청 */
export const unauthorized = (failedRequests: string[]): string[] => failedRequests.filter((r) => /^401\b/.test(r));
