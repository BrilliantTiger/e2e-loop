// 읽기 도우미: 화면을 읽기 전에 목록·패널이 그려졌는지 먼저 기다린다(오류 D: 화면이 그려지기 전에 읽음).
import type { DPage } from "./drivers/index.ts";
import { sleep } from "./probes.ts";

/** 읽기 전 기본 대기(ms). 케이스의 timeout 으로 바꾼다 */
export const READ_WAIT_MS = 3000;

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
