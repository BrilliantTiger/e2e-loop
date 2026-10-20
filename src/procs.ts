// 브라우저 프로세스 점검 (오류 B/F: 이중 브라우저 프로세스).
// 이전 라운드가 남긴 브라우저가 떠 있는 채로 새 브라우저를 띄우면 두 브라우저가 한 화면을 두고 다툰다.
// 그래서 라운드·챕터를 시작하기 전에 이전 프로세스가 0개인지 확인하고, 끊을 때는 체인 셸만이 아니라
// 노드 스크립트·브라우저 프로세스를 나무째 함께 끊은 뒤 0개를 다시 확인한다.
//
// 이 도구가 띄운 프로세스에만 표지(e2e-loop-owner=<띄운 프로세스 pid>)가 달려 있다
// (Playwright 브라우저의 명령줄 인자, Ego 브리지 스크립트의 주석). 사용자가 평소 쓰는 Chrome 이나
// 다른 도구의 브라우저는 표지가 없어 건드리지 않는다.
export const OWNER_MARK = "e2e-loop-owner";

export interface RawProc {
  pid: number;
  ppid: number;
  command: string;
}

export interface OwnedProc extends RawProc {
  /** 이 프로세스를 띄운 e2e-loop 프로세스의 pid */
  owner: number;
  /** 띄운 프로세스가 아직 살아 있는가 */
  ownerAlive: boolean;
  kind: "ego" | "browser";
}

/** `ps -axo pid=,ppid=,command=` 출력 읽기 */
export function parsePs(out: string): RawProc[] {
  const procs: RawProc[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! });
  }
  return procs;
}

export async function scanProcs(): Promise<RawProc[]> {
  const p = Bun.spawn(["ps", "-axo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return parsePs(out);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
};

/** pid 의 자손 pid 전부(깊은 것부터 끊을 수 있게 깊이 순서로) */
export function descendants(all: RawProc[], root: number): number[] {
  const kids = new Map<number, number[]>();
  for (const p of all) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
  const out: number[] = [];
  const walk = (pid: number) => {
    for (const k of kids.get(pid) ?? []) {
      walk(k);
      out.push(k);
    }
  };
  walk(root);
  return out;
}

/** 표지가 달린 이 도구의 브라우저 프로세스 전부 */
export function ownedProcs(all: RawProc[], isAlive: (pid: number) => boolean = alive): OwnedProc[] {
  const re = new RegExp(`${OWNER_MARK}[=:](\\d+)`);
  return all.flatMap((p) => {
    const m = p.command.match(re);
    if (!m) return [];
    const owner = Number(m[1]);
    return [{ ...p, owner, ownerAlive: isAlive(owner), kind: (/ego-browser|taskSpace/.test(p.command) ? "ego" : "browser") as OwnedProc["kind"] }];
  });
}

/** 이전 라운드가 남긴 것: 표지가 있고 지금 이 프로세스(selfPid)가 띄운 것이 아닌 프로세스 */
export async function staleBrowserProcs(selfPid: number = process.pid, all?: RawProc[]): Promise<OwnedProc[]> {
  const procs = all ?? (await scanProcs());
  const mine = new Set([selfPid, ...descendants(procs, selfPid)]);
  return ownedProcs(procs).filter((p) => p.owner !== selfPid && !mine.has(p.pid));
}

/** 지금 이 프로세스가 띄운 브라우저 프로세스(라운드가 끝난 뒤 남았는지 볼 때 쓴다) */
export async function ownBrowserProcs(selfPid: number = process.pid, all?: RawProc[]): Promise<OwnedProc[]> {
  const procs = all ?? (await scanProcs());
  const mine = new Set(descendants(procs, selfPid));
  return ownedProcs(procs).filter((p) => p.owner === selfPid || mine.has(p.pid));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 프로세스 나무를 통째로 끊는다: 자손부터 SIGTERM, 안 죽으면 SIGKILL. 끊은 pid 목록을 돌려준다. */
export async function killTree(pid: number, graceMs = 1500): Promise<number[]> {
  const all = await scanProcs();
  const tree = [...descendants(all, pid), pid];
  for (const t of tree) {
    try {
      process.kill(t, "SIGTERM");
    } catch {}
  }
  const t0 = Date.now();
  while (Date.now() - t0 < graceMs && tree.some(alive)) await sleep(100);
  for (const t of tree) if (alive(t)) {
    try {
      process.kill(t, "SIGKILL");
    } catch {}
  }
  await sleep(100);
  return tree;
}

/** 이전 프로세스를 나무째 끊고 0개를 다시 확인한다 */
export async function cleanupStale(selfPid: number = process.pid, only: (p: OwnedProc) => boolean = () => true): Promise<{ before: number; killed: number[]; after: OwnedProc[] }> {
  const before = (await staleBrowserProcs(selfPid)).filter(only);
  const killed: number[] = [];
  // 가장 바깥(부모가 목록 안에 없는) 것부터 나무째 끊는다
  const pids = new Set(before.map((p) => p.pid));
  for (const p of before) if (!pids.has(p.ppid) && alive(p.pid)) killed.push(...(await killTree(p.pid)));
  for (const p of before) if (alive(p.pid)) killed.push(...(await killTree(p.pid)));
  return { before: before.length, killed, after: (await staleBrowserProcs(selfPid)).filter(only) };
}

/** 이 프로세스가 띄운 것 중 남은 브라우저를 끊고 0개를 다시 확인한다(라운드가 끝난 뒤) */
export async function cleanupOwn(selfPid: number = process.pid): Promise<{ before: number; after: OwnedProc[] }> {
  const before = await ownBrowserProcs(selfPid);
  for (const p of before) if (alive(p.pid)) await killTree(p.pid);
  return { before: before.length, after: await ownBrowserProcs(selfPid) };
}

/** 이전 프로세스가 0개가 될 때까지 기다린다(앞 챕터의 브라우저가 막 닫히는 중일 수 있다) */
export async function waitNoStale(timeoutMs: number, selfPid: number = process.pid): Promise<OwnedProc[]> {
  const t0 = Date.now();
  for (;;) {
    const s = await staleBrowserProcs(selfPid);
    if (!s.length || Date.now() - t0 >= timeoutMs) return s;
    await sleep(500);
  }
}

export const describeProcs = (list: OwnedProc[]): string =>
  list.slice(0, 6).map((p) => `${p.kind === "ego" ? "Ego" : "브라우저"} pid ${p.pid}(띄운 프로세스 ${p.owner} ${p.ownerAlive ? "살아 있음" : "이미 종료"})`).join(", ") + (list.length > 6 ? ` 외 ${list.length - 6}개` : "");
