import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Case, CaseResult, DriverName, RoundMeta, Verdict } from "./types.ts";
import { Project, caseHash, nowIso } from "./store.ts";
import { resolveDriver } from "./drivers/index.ts";
import { runCase } from "./runner.ts";
import { writeReports } from "./report.ts";

async function sh(cmd: string, cwd: string, timeoutMs = 600000): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["/bin/sh", "-lc", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out: (o + e).trim().slice(-2000) };
}

/** 회차 도중 코드가 바뀌었는지 알아내기 위한 지문(.e2e 는 제외) */
export async function codeFingerprint(root: string): Promise<{ head?: string; dirtyHash?: string }> {
  const git = async (a: string) => (await sh(`git -C ${JSON.stringify(root)} ${a}`, root, 30000));
  const head = await git("rev-parse HEAD");
  if (head.code !== 0) return {};
  const st = await git(`status --porcelain -- . ':(exclude).e2e'`);
  const df = await git(`diff HEAD --no-color -- . ':(exclude).e2e'`);
  return { head: head.out.slice(0, 12), dirtyHash: createHash("sha1").update(st.out + "\n" + df.out).digest("hex").slice(0, 10) };
}

export interface StartOpts {
  data?: "reset" | "keep" | "manual-reset-done";
  driver?: DriverName;
  headless?: boolean;
  only?: string[]; // 케이스 id 목록(부분 실행)
  onlyFailed?: boolean; // 직전 회차에서 FAIL 이었던 것만 다시
}

export interface Decision {
  needs_decision: true;
  question: string;
  options: { value: string; meaning: string }[];
}

/** 시작 전 점검. 막히면 사용자에게 물어야 할 내용을 돌려준다. */
export function precheck(project: Project, opts: StartOpts): { ok: true; decision: "reset" | "keep" | "manual-reset-done" } | { ok: false; error?: string; decision?: Decision } {
  const cfg = project.config();
  if (!project.initialized) return { ok: false, error: "프로젝트가 초기화되지 않았습니다. e2e_init 먼저." };
  const sources = project.sources();
  const cases = project.cases().filter((c) => (c.status ?? "active") === "active");
  if (!sources.length) return { ok: false, error: "근거 자료가 없습니다. 기획서·디자인·기능정의서 중 하나를 e2e_source_add 로 등록하세요. 아무것도 없으면 개발된 사이트를 live-site 로 등록하고 e2e_discover 를 실행합니다." };
  if (!cases.length) return { ok: false, error: "실행할 케이스가 없습니다. e2e_discover 로 자동 점검 케이스를 만들거나 e2e_case_upsert 로 기획서의 케이스를 등록하세요." };
  let d = opts.data;
  if (!d && cfg.data.policy !== "ask") d = cfg.data.policy;
  if (!d)
    return {
      ok: false,
      decision: {
        needs_decision: true,
        question: "이번 회차를 시작하기 전에 데이터를 초기화할까요, 그대로 진행할까요? (사용자에게 물어보고 e2e_round_start 의 data 로 전달)",
        options: [
          { value: "reset", meaning: `데이터 초기화 후 시작${cfg.data.resetCommand ? ` (실행: ${cfg.data.resetCommand})` : " — 초기화 명령이 설정돼 있지 않음. e2e_init 의 resetCommand 를 먼저 정하거나 manual-reset-done 을 쓰세요"}. 삭제·로그아웃 같은 파괴적 동작도 점검한다.` },
          { value: "keep", meaning: "지금 데이터 그대로 진행. 파괴적 동작은 건너뛰고(SKIP), 등록·수정 같은 쓰기 동작은 실제로 실행되어 데이터가 남는다." },
          { value: "manual-reset-done", meaning: "사용자가 이미 직접 초기화를 마쳤음. 이 도구는 초기화를 실행하지 않고 파괴적 동작도 점검한다." },
        ],
      },
    };
  if (d === "reset" && !cfg.data.resetCommand) return { ok: false, error: "data=reset 인데 resetCommand 가 없습니다. e2e_init 으로 초기화 명령을 설정하거나, 직접 초기화했다면 manual-reset-done 으로 시작하세요." };
  return { ok: true, decision: d };
}

export function runningRound(project: Project): RoundMeta | null {
  const lock = project.p("running.json");
  if (!existsSync(lock)) return null;
  try {
    const l = JSON.parse(readFileSync(lock, "utf8"));
    try {
      process.kill(l.pid, 0);
    } catch {
      rmSync(lock, { force: true });
      return null;
    }
    return project.rounds().find((r) => r.id === l.round) ?? null;
  } catch {
    return null;
  }
}

export async function startRound(project: Project, opts: StartOpts, onEvent?: (ev: any) => void): Promise<{ id: string; done: Promise<RoundMeta> }> {
  const pre = precheck(project, opts);
  if (!pre.ok) throw new Error(pre.error ?? JSON.stringify(pre.decision));
  if (runningRound(project)) throw new Error("이미 진행 중인 회차가 있습니다. e2e_round_status 로 확인하거나 e2e_round_stop 으로 중단하세요.");
  const cfg = project.config();
  if (opts.headless !== undefined) cfg.headless = opts.headless;
  let cases = project.cases();
  const active = cases.filter((c) => (c.status ?? "active") === "active");
  let selected: Case[] = cases;
  let scope: "full" | "partial" = "full";
  if (opts.only?.length) {
    selected = cases.filter((c) => opts.only!.includes(c.id));
    scope = "partial";
  } else if (opts.onlyFailed) {
    const prev = [...project.rounds()].reverse().find((r) => r.status === "finished");
    const failed = prev ? (project.readJson<CaseResult[]>(`rounds/${prev.id}/results.json`, [])).filter((r) => r.status === "FAIL").map((r) => r.id) : [];
    selected = cases.filter((c) => failed.includes(c.id));
    scope = "partial";
  }
  if (probesOff(cfg.probes)) selected = selected.filter((c) => c.type !== "probe");

  const { id, n } = project.nextRoundId();
  const rdir = project.roundDir(id);
  mkdirSync(join(rdir, "evidence"), { recursive: true });
  const driver = await resolveDriver(cfg, opts.driver);
  const meta: RoundMeta = {
    id, n, status: "running", startedAt: nowIso(), driver: driver.name, headless: cfg.headless,
    data: { decision: pre.decision, scope: cfg.data.resetScope },
    scope, only: opts.only, caseHash: caseHash(active), caseCount: selected.length,
    code: await codeFingerprint(cfg.codeRoot ?? project.root), baseUrl: cfg.baseUrl,
    pendingFeedback: project.feedback().filter((f) => f.status === "pending").map((f) => ({ id: f.id, text: f.text })),
  };
  project.writeJson(`rounds/${id}/meta.json`, meta);
  writeFileSync(project.p("running.json"), JSON.stringify({ pid: process.pid, round: id }));
  rmSync(project.p("stop"), { force: true });
  const emit = (ev: Record<string, unknown>) => {
    project.appendEvent(id, ev);
    onEvent?.(ev);
  };
  emit({ type: "round-start", round: id, total: selected.length, driver: driver.name, data: pre.decision });

  const done = (async (): Promise<RoundMeta> => {
    const results: CaseResult[] = [];
    try {
      if (pre.decision === "reset" && cfg.data.resetScope === "round") {
        emit({ type: "reset-start" });
        const r = await sh(cfg.data.resetCommand!, cfg.data.resetCwd ?? project.root);
        meta.data.resetOutput = r.out;
        if (r.code !== 0) throw new Error(`데이터 초기화 실패(종료 코드 ${r.code}): ${r.out.slice(-300)}`);
        emit({ type: "reset-done" });
      }
      await driver.open();
      const resetBeforeCase =
        pre.decision === "reset" && cfg.data.resetScope === "case"
          ? async () => {
              const r = await sh(cfg.data.resetCommand!, cfg.data.resetCwd ?? project.root);
              if (r.code !== 0) throw new Error(`케이스 전 초기화 실패: ${r.out.slice(-200)}`);
            }
          : undefined;
      for (let i = 0; i < selected.length; i++) {
        if (existsSync(project.p("stop"))) {
          meta.status = "aborted";
          meta.error = "사용자 요청으로 중단";
          break;
        }
        // 사용자가 '지금 흐름에서 적용'을 고른 경우: 끼워 넣은 케이스를 뒤에 붙여 이어서 실행
        const injectFile = project.p("inject.json");
        if (existsSync(injectFile)) {
          try {
            const add = JSON.parse(readFileSync(injectFile, "utf8")) as Case[];
            rmSync(injectFile, { force: true });
            const fresh = add.filter((a) => !selected.some((s) => s.id === a.id));
            selected.push(...fresh);
            meta.injected = [...(meta.injected ?? []), ...fresh.map((a) => a.id)];
            meta.caseCount = selected.length;
            project.writeJson(`rounds/${id}/meta.json`, meta);
            emit({ type: "inject", ids: fresh.map((a) => a.id), total: selected.length });
          } catch {}
        }
        const c = selected[i]!;
        emit({ type: "case-start", case: c.id, title: c.title, index: i + 1, total: selected.length });
        let r: CaseResult;
        try {
          r = await runCase({ project, cfg, driver, roundId: id, decision: pre.decision, emit, resetBeforeCase }, c);
        } catch (e: any) {
          r = { id: c.id, title: c.title, type: c.type, status: "FAIL", reason: `실행기 오류: ${String(e?.message ?? e).slice(0, 300)}`, warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: nowIso(), priority: "P1" };
        }
        results.push(r);
        project.writeJson(`rounds/${id}/results.json`, results);
        emit({ type: "case-end", case: c.id, status: r.status, reason: r.reason, warnings: r.warnings.length, ms: r.durationMs, video: r.video });
      }
      if (meta.status === "running") meta.status = "finished";
    } catch (e: any) {
      meta.status = "aborted";
      meta.error = String(e?.message ?? e).slice(0, 500);
    } finally {
      await driver.close().catch(() => {});
      meta.finishedAt = nowIso();
      const cnt: Record<string, number> = { PASS: 0, FAIL: 0, BLOCKED: 0, NA: 0, SKIP: 0 };
      for (const r of results) cnt[r.status] = (cnt[r.status] ?? 0) + 1;
      meta.summary = { ...(cnt as Record<Verdict, number>), total: results.length };
      const after = await codeFingerprint(cfg.codeRoot ?? project.root);
      if (after.head !== meta.code.head || after.dirtyHash !== meta.code.dirtyHash) meta.tainted = "회차 도중 코드가 바뀜(커밋 또는 작업 트리 변경). 이 회차는 완료 근거로 쓸 수 없음 — 수정은 회차가 끝난 뒤에 하고 새 회차로 다시 돌려야 함";
      project.writeJson(`rounds/${id}/meta.json`, meta);
      rmSync(project.p("running.json"), { force: true });
      try {
        writeReports(project, meta, results);
      } catch (e: any) {
        meta.error = (meta.error ?? "") + ` 보고서 생성 오류: ${e?.message}`;
        project.writeJson(`rounds/${id}/meta.json`, meta);
      }
      emit({ type: "round-end", round: id, status: meta.status, summary: meta.summary, tainted: meta.tainted });
    }
    return meta;
  })();
  return { id, done };
}

const probesOff = (p: string) => p === "off";

export function stopRound(project: Project) {
  writeFileSync(project.p("stop"), "1");
}
