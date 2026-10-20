// 판정용 문자열 (오류 G: 판정용 문자열을 잘라서 비교).
// 판정용 값은 자르지 않고 전체로 비교한다. 자르는 것은 로그에 쓸 때만 한다.
// 잘린 글자(…로 끝나는 기대 · 스크립트 안에서 slice/substring 으로 자른 값)로 비교하면 사이트가 맞아도 어긋나므로 판정 불가(NA G)로 둔다.

/** 스크립트가 글자를 slice·substring·substr 로 자르는가 */
export const slicesValue = (script: unknown): boolean => typeof script === "string" && /\.(slice|substring|substr)\s*\(/.test(script);

/** 기대한 글이 말줄임표(… 또는 ...)로 끝나 잘린 글처럼 보이는가 */
export const looksTruncated = (v: unknown): boolean => typeof v === "string" && /(…|\.\.\.)\s*$/.test(v.trim());

export const TRUNCATED_EXPECT_WARNING = (what: string) =>
  `${what}: 기대한 글이 말줄임표(…)로 끝나 잘린 글로 보임 — 판정용 값은 자르지 않고 전체로 비교할 것(자르는 것은 로그에만, 오류 G). 어긋나면 NA(G)로 처리됨`;

export const SLICED_EVAL_WARNING = (what: string) =>
  `${what}: 스크립트가 slice·substring 으로 글자를 잘라 equals 로 비교함 — 판정용 값은 자르지 않고 전체로 비교할 것(오류 G). 어긋나면 NA(G)로 처리됨`;
