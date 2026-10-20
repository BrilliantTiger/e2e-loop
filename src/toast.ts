// 토스트 (오류 D 추가): 쓰기 동작(삭제·저장) 뒤에는 토스트가 아니라 서버 효과(지운 행 수·파일 정보)로 판정한다.
// 토스트는 금세 사라지거나 늦게 떠서 판정에 쓰면 사이트가 맞아도 어긋난다. 있으면 참고로만 적는다.
import type { Step } from "./types.ts";

const TOAST_SEL = /toast|snackbar|sonner|ant-message|notistack/i;

/** 토스트를 보는 expect 스텝인가: toast:true 를 달았거나, 선택자가 토스트로 읽힌다 */
export const isToastStep = (s: Step): boolean => s.op === "expect" && (s.toast === true || (typeof s.sel === "string" && TOAST_SEL.test(s.sel)));

export const TOAST_WARNING =
  "토스트를 확인하는 expect: 참고로만 기록되고 판정에는 쓰이지 않음 — 쓰기 동작(삭제·저장)은 서버 효과(api 스텝: 지운 행 수·파일 정보 등)로 판정할 것";
