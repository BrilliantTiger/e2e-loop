// 오류 N: 같은 탭·같은 Dataset 에서 챕터 두 개가 동시에 돎 — 실행 중 잠금으로 두 번째 챕터를 즉시 거부한다.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.E2E_LOOP_LOCK_DIR = mkdtempSync(join(tmpdir(), "e2e-loop-locks-"));
const { acquire, holderOf, lockKeys, release, releaseAll, lockDir } = await import("../src/locks.ts");
const A = await import("../src/actions.ts");
const { Project } = await import("../src/store.ts");
import type { Case, CaseResult } from "../src/types.ts";

/** 다른 프로세스 흉내: 살아 있는 pid 하나 */
const other = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });
afterAll(() => other.kill());

test("잠금: 다른 살아 있는 프로세스가 잡은 대상은 못 잡고 소유자를 알려 주며, 일부만 잡지도 않는다", () => {
  expect(acquire(["dataset:1"], { chapter: "C11U", round: "R08" }, other.pid).ok).toBe(true);
  const r = acquire(["dataset:9", "dataset:1"], { chapter: "C12", round: "R09" });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.key).toBe("dataset:1");
    expect(r.holder.chapter).toBe("C11U");
    expect(r.holder.pid).toBe(other.pid);
  }
  expect(holderOf("dataset:9")).toBeNull(); // 앞에서 잡은 dataset:9 는 되돌려 놓았다
  release(["dataset:1"], other.pid);
  expect(holderOf("dataset:1")).toBeNull();
});

test("잠금: 잡은 프로세스가 죽으면 풀린 것으로 보고 잡을 수 있다. 같은 프로세스는 넘겨받는다", async () => {
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  expect(acquire(["dataset:2"], { chapter: "C1" }, dead.pid).ok).toBe(true);
  expect(holderOf("dataset:2")).toBeNull();
  expect(acquire(["dataset:2"], { chapter: "C2" }).ok).toBe(true);
  expect(acquire(["dataset:2"], { chapter: "C3" }).ok).toBe(true); // 같은 프로세스의 다음 챕터
  expect(holderOf("dataset:2")?.chapter).toBe("C3");
  releaseAll();
  expect(readdirSync(lockDir()).length).toBe(0);
});

test("잠금 키: 케이스 lock + Ego 드라이버면 공유 탭", () => {
  expect(lockKeys("dataset:1", "playwright+chromium")).toEqual(["dataset:1"]);
  expect(lockKeys(["dataset:1", " ", "dataset:1"], "ego")).toEqual(["dataset:1", "tab:ego"]);
  expect(lockKeys(undefined, "playwright+chrome")).toEqual([]);
});

// ---- 실제 라운드: 다른 프로세스가 같은 Dataset 을 쓰는 중이면 그 챕터는 누르지 않고 NA(N) ----
const port = 4583;
const root = mkdtempSync(join(tmpdir(), "e2e-loop-lk-"));
let server: ReturnType<typeof Bun.spawn>;
beforeAll(async () => {
  writeFileSync(join(root, "bugs.json"), "{}");
  writeFileSync(join(root, "PLAN.md"), "# 기획서\n");
  server = Bun.spawn(["bun", join(import.meta.dir, "../examples/demo-site/server.ts"), root, String(port)], { stdout: "ignore", stderr: "inherit" });
  await Bun.sleep(800);
  const p = new Project(root);
  p.ensure();
  p.saveConfig({ ...p.config(), baseUrl: `http://127.0.0.1:${port}`, driver: "chromium", headless: true, dashboardPort: 7795 });
  A.aPrestart({ project: root, dataPolicy: "keep", maxRounds: 10, login: "none", account: { mode: "none" }, acknowledged: true });
  A.aSourceAdd({ project: root, kind: "plan", title: "기획서", location: join(root, "PLAN.md") });
});
afterAll(() => server?.kill());

test("라운드: 같은 Dataset 을 다른 챕터가 쓰는 중이면 「동시 실행 거부」 NA(N)·소유 챕터 이름을 남기고 누르지 않으며, 다른 대상 챕터는 돌고, 끝나면 잠금이 풀린다", async () => {
  const chk = (id: string, chapter: string, lock?: string): Case => ({ id, title: id, type: "spec", source_ref: "x", screen: "/", feature: chapter, chapter, ...(lock ? { lock } : {}), steps: [{ op: "goto", url: "/" }, { op: "expect", sel: "h1", textContains: "", basis: "POL-1" }] });
  expect(A.aCaseUpsert({ project: root, cases: [chk("T-1", "C12", "dataset:77"), chk("T-2", "C12", "dataset:77"), chk("U-1", "C20", "dataset:88")] }).errors).toEqual([]);
  expect(acquire(["dataset:77"], { chapter: "C11U", round: "R08" }, other.pid).ok).toBe(true);
  const start: any = await A.aRoundStart({ project: root, data: "keep", headless: true });
  expect(start.started).toBe(true);
  let st: any;
  do st = await A.aRoundStatus({ project: root, wait_seconds: 30 });
  while (st.running);
  const p = new Project(root);
  const results = p.readJson<CaseResult[]>(`rounds/${start.round}/results.json`, []);
  const by = (k: string) => results.find((r) => r.id === k)!;
  for (const k of ["T-1", "T-2"]) {
    expect(by(k).status).toBe("NA");
    expect(by(k).toolError?.kind).toBe("N");
    expect(by(k).reason).toContain("동시 실행 거부");
    expect(by(k).reason).toContain("C11U");
    expect(by(k).steps.length).toBe(0);
  }
  expect(by("U-1").status).toBe("PASS");
  const ev = readFileSync(p.p("rounds", start.round, "events.ndjson"), "utf8");
  expect(ev).toContain('"type":"concurrent-reject"');
  expect(ev).toContain('"owner":"C11U"');
  // 다른 프로세스의 잠금은 그대로, 이 라운드가 잡은 dataset:88 은 풀렸다
  expect(holderOf("dataset:77")?.pid).toBe(other.pid);
  expect(holderOf("dataset:88")).toBeNull();
  release(["dataset:77"], other.pid);
}, 120000);
