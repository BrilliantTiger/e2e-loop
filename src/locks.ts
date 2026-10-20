// 실행 중 잠금 (오류 N: 같은 브라우저 탭·같은 Dataset 에서 챕터 두 개가 동시에 돎).
// 챕터가 시작할 때 그 챕터가 쓰는 대상(케이스 필드 lock 의 키, 예: "dataset:123", Ego 면 "tab:ego")을 잠그고,
// 다른 프로세스가 같은 대상을 잠그고 있으면 그 챕터는 누르지 않고 「동시 실행 거부」 NA(N)로 둔다.
// 잠금은 파일 하나(키마다)이고, 잠근 프로세스가 죽었으면 풀린 것으로 본다. 여러 프로젝트·세션이 함께 보도록 홈 아래에 둔다.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LockInfo {
  key: string;
  pid: number;
  chapter: string;
  round?: string;
  project?: string;
  at: string;
}

export const lockDir = () => process.env.E2E_LOOP_LOCK_DIR ?? join(homedir(), ".e2e-loop", "locks");
const fileOf = (key: string) => join(lockDir(), createHash("sha1").update(key).digest("hex").slice(0, 16) + ".json");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
};

const read = (f: string): LockInfo | null => {
  try {
    return JSON.parse(readFileSync(f, "utf8")) as LockInfo;
  } catch {
    return null;
  }
};

/** 지금 그 대상을 잠근 쪽(살아 있는 프로세스만). 없으면 null */
export function holderOf(key: string): LockInfo | null {
  const h = read(fileOf(key));
  return h && alive(h.pid) ? h : null;
}

/**
 * 키를 모두 잠근다. 다른 살아 있는 프로세스가 하나라도 잡고 있으면 아무것도 잠그지 않고 그 소유자를 돌려준다.
 * 같은 프로세스가 잡은 잠금은 넘겨받는다(챕터가 바뀔 때). 죽은 프로세스의 잠금은 지우고 잡는다.
 */
export function acquire(keys: string[], owner: Omit<LockInfo, "key" | "pid" | "at">, pid: number = process.pid): { ok: true } | { ok: false; key: string; holder: LockInfo } {
  mkdirSync(lockDir(), { recursive: true });
  const got: string[] = [];
  for (const key of keys) {
    const f = fileOf(key);
    const info: LockInfo = { key, pid, ...owner, at: new Date().toISOString() };
    for (let attempt = 0; ; attempt++) {
      try {
        writeFileSync(f, JSON.stringify(info), { flag: "wx" });
        got.push(key);
        break;
      } catch (e: any) {
        if (e?.code !== "EEXIST" || attempt > 2) throw e;
        const h = read(f);
        if (h && h.pid !== pid && alive(h.pid)) {
          for (const k of got) release([k], pid);
          return { ok: false, key, holder: h };
        }
        rmSync(f, { force: true }); // 내 잠금(넘겨받기)이거나 죽은 프로세스의 잠금
      }
    }
  }
  return { ok: true };
}

/** 이 프로세스가 잡은 잠금만 푼다 */
export function release(keys: string[], pid: number = process.pid) {
  for (const key of keys) {
    const f = fileOf(key);
    if (read(f)?.pid === pid) rmSync(f, { force: true });
  }
}

/** 이 프로세스가 잡은 잠금을 모두 푼다(라운드가 끝날 때) */
export function releaseAll(pid: number = process.pid) {
  if (!existsSync(lockDir())) return;
  for (const n of readdirSync(lockDir())) {
    const f = join(lockDir(), n);
    if (read(f)?.pid === pid) rmSync(f, { force: true });
  }
}

/** 케이스가 쓰는 잠금 키: 케이스 필드 lock(글자 또는 배열) + Ego 처럼 탭을 여러 프로세스가 함께 쓰는 드라이버면 그 탭 */
export const lockKeys = (lock: string | string[] | undefined, driver: string): string[] => [...new Set([...([] as string[]).concat(lock ?? []).map((x) => x.trim()).filter(Boolean), ...(/^ego/.test(driver) ? ["tab:ego"] : [])])];
