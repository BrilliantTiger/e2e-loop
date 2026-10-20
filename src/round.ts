import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Case, CaseResult, DriverName, RoundMeta, Verdict } from "./types.ts";
import { Project, caseHash, nowIso } from "./store.ts";
import { resolveDriver } from "./drivers/index.ts";
import { browserGone, runCase } from "./runner.ts";
import { writeReports } from "./report.ts";
import { evidenceSources } from "./session.ts";
import { sheetGate } from "./sheet.ts";
import { EvidenceKit, evidenceUsage } from "./evidence.ts";
import { issuesOf } from "./issues.ts";
import { toolErrorCount } from "./toolerror.ts";
import { prestartStatus } from "./prestart.ts";
import { ChapterGuard } from "./chapter.ts";
import { cleanupOwn, cleanupStale, describeProcs, staleBrowserProcs, waitNoStale } from "./procs.ts";

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
  /** 같은 이슈가 3라운드 연속이라고 사용자에게 올린 뒤, 사용자가 계속하기로 했을 때 */
  acknowledgeRepeated?: boolean;
  /** 이전 라운드가 남긴 브라우저 프로세스를 사용자 확인 뒤 나무째 끊고 시작한다 */
  cleanupBrowsers?: boolean;
}

/**
 * 라운드 시작 전 점검: 이전 라운드가 남긴 이 도구의 브라우저 프로세스가 0개인가.
 * 남아 있으면 끊을지 사용자에게 묻도록 결정을 돌려주고, 끊기로 했으면(cleanupBrowsers) 나무째 끊은 뒤 0개를 다시 확인한다.
 */
export async function browserPreflight(opts: StartOpts): Promise<{ ok: true; cleaned?: number } | { ok: false; error?: string; decision?: Decision }> {
  const stale = await staleBrowserProcs();
  if (!stale.length) return { ok: true };
  if (!opts.cleanupBrowsers)
    return { ok: false, decision: { needs_decision: true, question: `이전 라운드가 남긴 브라우저 프로세스 ${stale.length}개가 있습니다(${describeProcs(stale)}). 두 브라우저가 겹치면 판정이 어긋나므로 이대로 시작하지 않습니다. 끊고 시작할까요?`, options: [{ value: "cleanup", meaning: "끊고 시작한다: e2e_round_start 를 cleanup_browsers=true 로 다시 호출(노드 스크립트·브라우저 프로세스를 나무째 끊고 0개를 다시 확인)" }, { value: "stop", meaning: "시작하지 않는다(다른 라운드가 아직 돌고 있다면 끝난 뒤에 시작)" }] } };
  const r = await cleanupStale();
  if (r.after.length) return { ok: false, error: `이전 브라우저 프로세스 ${r.after.length}개를 끊지 못했습니다(${describeProcs(r.after)}). 직접 종료한 뒤 다시 시작하세요.` };
  return { ok: true, cleaned: r.before };
}

/** 화면이 있는 환경인가. Linux 에서 DISPLAY·WAYLAND_DISPLAY 가 없으면 화면이 없다. macOS·Windows 는 있다고 본다. */
export const displayAvailable = (env: Record<string, string | undefined> = process.env, platform: string = process.platform) => platform !== "linux" || !!(env.DISPLAY || env.WAYLAND_DISPLAY);

/** 상한·반복 이슈에 세는 라운드: 끝까지 돈 전체 라운드만(중단한 라운드는 세지 않는다) */
const fullRounds = (project: Project) => project.rounds().filter((r) => r.scope === "full" && r.status === "finished");

/** 같은 이슈가 마지막 repeatLimit(기본 3)개 전체 라운드에서 연속으로 나왔는지 */
export function repeatedIssues(project: Project): string[] {
  const cfg = project.config();
  const limit = Math.max(2, cfg.repeatLimit ?? 3);
  const last = fullRounds(project).slice(-limit);
  if (last.length < limit) return [];
  const sets = last.map((r) => new Set(issuesOf(project.readJson<CaseResult[]>(`rounds/${r.id}/results.json`, []), cfg).map((x) => x.id)));
  return [...sets[0]!].filter((id) => sets.every((s) => s.has(id))).sort();
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
  if (!sources.length || !evidenceSources(project).length) return { ok: false, error: "최소 진행 조건을 못 채웠습니다. 기획서·디자인·기능정의서·코드 중 하나 이상이 근거로 필요합니다. 사용자에게 받아 e2e_intake 로 등록하세요." };
  if (!cases.length) return { ok: false, error: "실행할 케이스가 없습니다. e2e_discover 로 자동 점검 케이스를 만들거나 e2e_case_upsert 로 기획서의 케이스를 등록하세요." };
  const sg = sheetGate(project);
  if (!sg.ok) return { ok: false, error: sg.error };
  const ps = prestartStatus(project);
  const dataOnlyQ = ps.questions.filter((q) => q.id !== "data");
  if (dataOnlyQ.length)
    return { ok: false, decision: { needs_decision: true, question: `라운드를 시작하기 전에 사용자에게 물을 것이 남아 있습니다. 한 번에 묻고 e2e_prestart 로 기록하세요: ${dataOnlyQ.map((q) => q.ask).join(" / ")}`, options: [{ value: "e2e_prestart", meaning: "시작 전 질문(데이터 초기화·라운드 상한·로그인·테스트 계정·화면 노출 안내)을 기록한다" }] } };
  // 사이에 사용자가 한 말(요청)은 다음 라운드를 시작하기 전에 케이스·설정에 반영하고 done 으로 표시해야 한다
  const pendingFb = project.feedback().filter((f) => f.status === "pending");
  if (pendingFb.length)
    return { ok: false, error: `아직 반영하지 않은 사용자 요청 ${pendingFb.length}건이 있습니다: ${pendingFb.map((f) => `${f.id} “${f.text.slice(0, 50)}”`).join(" / ")}. 요청대로 케이스·설정을 고친 뒤(e2e_case_upsert·e2e_prestart 등) e2e_feedback_resolve 로 표시하고 라운드를 시작하세요. 요청이 E2E 와 무관하거나 바꿀 것이 없으면 그 사유를 note 에 적어 표시하면 됩니다.` };
  const isFull = !opts.only?.length && !opts.onlyFailed;
  if (isFull && fullRounds(project).length >= cfg.maxRounds)
    return { ok: false, decision: { needs_decision: true, question: `라운드 상한 ${cfg.maxRounds}번에 닿았습니다(전체 라운드 ${fullRounds(project).length}번). 사용자에게 올려 더 돌릴지 정하세요.`, options: [{ value: "raise", meaning: "상한을 올린다: e2e_prestart 의 maxRounds 를 더 큰 값으로 기록한 뒤 다시 시작" }, { value: "stop", meaning: "여기서 멈추고 남은 이슈를 사용자에게 보고한다" }] } };
  const rep = repeatedIssues(project);
  if (rep.length) {
    const key = rep.join(",");
    const ack = project.readJson<{ key?: string }>("escalation.json", {});
    if (opts.acknowledgeRepeated) project.writeJson("escalation.json", { key, at: nowIso() });
    else if (ack.key !== key)
      return { ok: false, decision: { needs_decision: true, question: `같은 이슈가 ${cfg.repeatLimit ?? 3}라운드 연속 나왔습니다(${rep.slice(0, 8).join(", ")}${rep.length > 8 ? " …" : ""}). 사용자에게 올려 어떻게 할지 정하세요.`, options: [{ value: "continue", meaning: "계속한다: e2e_round_start 를 acknowledge_repeated=true 로 다시 호출" }, { value: "stop", meaning: "멈추고 이 이슈를 개발 쪽에 따로 넘긴다" }, { value: "na", meaning: "기대값이 틀렸다면 e2e_case_set_status 로 해당 없음(na) 처리하고 사유를 적는다" }] } };
  }
  const headless = opts.headless ?? cfg.headless;
  if (!headless && !displayAvailable())
    return { ok: false, decision: { needs_decision: true, question: "화면이 없는 환경입니다(DISPLAY 없음). 기본인 Headed 로는 돌릴 수 없습니다. 자동으로 바꾸지 않으니 사용자에게 물으세요.", options: [{ value: "headless", meaning: "Headless 로 돌린다: e2e_round_start 를 headless=true 로 다시 호출" }, { value: "display", meaning: "화면을 준비한다(예: xvfb-run 으로 실행, 원격 데스크톱) 후 다시 시작" }] } };
  const usage = evidenceUsage(project);
  if (usage.level === "over")
    return { ok: false, decision: { needs_decision: true, question: `증거(영상·스크린샷) 보관 용량이 상한을 넘었습니다(${usage.usedMB}MB / ${usage.limitMB}MB). 사용자에게 정리할지 상한을 올릴지 물으세요.`, options: [{ value: "prune", meaning: "오래된 회차의 증거만 지운다: e2e_evidence action=prune keepLast=N (결과·보고서는 남음)" }, { value: "raise", meaning: "상한을 올린다: e2e_init 의 evidenceLimitMB" }] } };
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
  const pf = await browserPreflight(opts);
  if (!pf.ok) throw new Error(pf.error ?? JSON.stringify(pf.decision));
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
  const codeFp = await codeFingerprint(cfg.codeRoot ?? project.root);
  const kit = new EvidenceKit({ project, roundId: id, commit: codeFp.head });
  const createdSet = new Set(project.readJson<string[]>("created.json", []));
  const seenSels = new Set<string>();
  const reportedFeatures = new Set<string>();
  const guard = new ChapterGuard(featureKey);
  let lastChapter = "";
  const meta: RoundMeta = {
    id, n, status: "running", startedAt: nowIso(), driver: driver.name, headless: cfg.headless,
    data: { decision: pre.decision, scope: cfg.data.resetScope },
    scope, only: opts.only, caseHash: caseHash(active), caseCount: selected.length,
    code: codeFp, baseUrl: cfg.baseUrl,
    pendingFeedback: project.feedback().filter((f) => f.status === "pending").map((f) => ({ id: f.id, text: f.text })),
  };
  project.writeJson(`rounds/${id}/meta.json`, meta);
  project.writeJson(`rounds/${id}/cases.json`, selected); // 이 라운드가 돌린 케이스 정의(결과물의 기대값 설명용)
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
            project.writeJson(`rounds/${id}/cases.json`, selected);
            emit({ type: "inject", ids: fresh.map((a) => a.id), total: selected.length });
          } catch {}
        }
        const c = selected[i]!;
        emit({ type: "case-start", case: c.id, title: c.title, index: i + 1, total: selected.length });
        const runOne = (attempt: number) => runCase({ project, cfg, driver, roundId: id, decision: pre.decision, emit, resetBeforeCase, attempt, kit, created: [...createdSet], onCreated: (v) => createdSet.add(v), seenSels }, c);
        // 브라우저가 중간에 죽으면(충돌·강제 종료) 새로 띄워 한 번 더 시도한다. 도구의 문제를 사이트의 결함으로 세지 않기 위해서다.
        const mk = async (attempt: number) => {
          try {
            return await runOne(attempt);
          } catch (e: any) {
            if (!browserGone(e)) throw e;
            emit({ type: "browser-relaunch", case: c.id, why: String(e?.message ?? e).slice(0, 120) });
            await driver.close().catch(() => {});
            await driver.open();
            return await runOne(attempt);
          }
        };
        let r: CaseResult;
        // 챕터를 시작하기 전: 이전 라운드가 남긴 브라우저 프로세스가 0개인가(막 닫히는 중일 수 있어 잠깐 기다린다)
        if (c.type === "spec" && featureKey(c) !== lastChapter) {
          lastChapter = featureKey(c);
          if (!guard.skipReason(c)) {
            const left = await waitNoStale(8000);
            if (left.length) {
              guard.end(c, `이전 브라우저 프로세스 ${left.length}개가 남아 있어 두 브라우저가 겹침(${describeProcs(left)})`);
              emit({ type: "stale-browsers", chapter: featureKey(c), count: left.length });
            }
          }
        }
        const endedWhy = guard.skipReason(c);
        if (endedWhy) {
          // 챕터가 이미 끝났다(선행 조건 실패 · 읽기 실패 연속): 뒤 동작을 누르지 않고 NA(F)로 둔다
          r = guard.naResult(c, endedWhy);
          emit({ type: "chapter-skip", case: c.id, why: endedWhy.slice(0, 200) });
        } else {
          try {
            r = await mk(0);
            // 연속 읽기 실패의 2번째부터는 NA(F)로 바뀌므로 재시도하지 않는다
            if (r.status === "FAIL" && !r.promoted && !guard.willConvert(c, r)) r = await retryFailed(r, mk, emit, c.id);
          } catch (e: any) {
            const gone = browserGone(e);
            // 브라우저를 다시 띄워도 안 되면 사이트의 결함이 아니라 환경 문제 → 검증 못 한 것(BLOCKED)
            r = { id: c.id, title: c.title, type: c.type, status: gone ? "BLOCKED" : "FAIL", reason: gone ? `브라우저가 죽어 판정하지 못함(다시 띄웠지만 실패): ${String(e?.message ?? e).slice(0, 200)}` : `실행기 오류: ${String(e?.message ?? e).slice(0, 300)}`, warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: nowIso(), ...(gone ? {} : { priority: "P1" as const }) };
          }
          r = guard.settle(c, r);
          if (r.toolError?.kind === "F") emit({ type: "chapter-na", case: c.id, why: r.toolError.detail.slice(0, 200) });
        }
        results.push(r);
        project.writeJson(`rounds/${id}/results.json`, results);
        emit({ type: "case-end", case: c.id, status: r.status, reason: r.reason, warnings: r.warnings.length, ms: r.durationMs, video: r.video });
        // 기능 단위의 케이스가 모두 통과하면 그때그때 보고한다(보고할 것은 e2e_round_status 가 한 번씩 돌려준다)
        const done = featureDone(selected, results, reportedFeatures);
        if (done) {
          emit({ type: "feature-pass", screen: done.screen, feature: done.feature, cases: done.cases, titles: done.titles });
          project.writeJson(`rounds/${id}/features.json`, [...project.readJson<any[]>(`rounds/${id}/features.json`, []), { ...done, at: nowIso(), reported: false }]);
        }
      }
      if (meta.status === "running") meta.status = "finished";
    } catch (e: any) {
      meta.status = "aborted";
      meta.error = String(e?.message ?? e).slice(0, 500);
    } finally {
      await driver.close().catch(() => {});
      // 닫은 뒤에도 이 도구가 띄운 브라우저 프로세스가 남았는지 확인하고, 남았으면 나무째 끊고 0개를 다시 확인한다
      const leftover = await cleanupOwn().catch(() => null);
      if (leftover?.before) kit.warnings.push(leftover.after.length ? `라운드가 끝난 뒤 브라우저 프로세스 ${leftover.after.length}개를 끊지 못함(${describeProcs(leftover.after)})` : `라운드가 끝난 뒤 남은 브라우저 프로세스 ${leftover.before}개를 끊음`);
      meta.finishedAt = nowIso();
      const cnt: Record<string, number> = { PASS: 0, FAIL: 0, FLAKY: 0, BLOCKED: 0, NA: 0, SKIP: 0 };
      for (const r of results) cnt[r.status] = (cnt[r.status] ?? 0) + 1;
      meta.summary = { ...(cnt as Record<Verdict, number>), total: results.length, toolError: toolErrorCount(results) };
      try {
        await finalizeEvidence(project, id, kit, results);
        meta.evidenceWarnings = kit.warnings.length ? kit.warnings : undefined;
        project.writeJson("created.json", [...createdSet].slice(-500));
      } catch (e: any) {
        meta.evidenceWarnings = [...kit.warnings, `증거 정리 오류: ${String(e?.message ?? e).slice(0, 200)}`];
      } finally {
        await kit.close();
      }
      project.writeJson(`rounds/${id}/meta.json`, meta);
      rmSync(project.p("running.json"), { force: true });
      try {
        writeReports(project, meta, results);
      } catch (e: any) {
        meta.error = (meta.error ?? "") + ` 보고서 생성 오류: ${e?.message}`;
        project.writeJson(`rounds/${id}/meta.json`, meta);
      }
      emit({ type: "round-end", round: id, status: meta.status, summary: meta.summary });
    }
    return meta;
  })();
  return { id, done };
}

const probesOff = (p: string) => p === "off";

const featureKey = (c: Case) => `${c.screen ?? screenFromSteps(c)}|${c.feature ?? c.source_ref ?? "(기능 미지정)"}`;
const screenFromSteps = (c: Case) => {
  const g = c.steps.find((x) => x.op === "goto" && typeof x.url === "string");
  try {
    return g ? new URL(g.url, "http://x").pathname : "(화면 미지정)";
  } catch {
    return "(화면 미지정)";
  }
};

/** 방금 끝난 케이스로 어떤 기능 단위가 "모두 통과"가 됐으면 그 기능을 돌려준다(한 기능은 한 번만). 스킵·해당 없음은 통과를 막지 않는다. */
export function featureDone(selected: Case[], results: CaseResult[], reported: Set<string>): { screen: string; feature: string; cases: number; titles: string[] } | null {
  const last = results[results.length - 1];
  const lastCase = last && selected.find((c) => c.id === last.id);
  if (!lastCase) return null;
  const key = featureKey(lastCase);
  if (reported.has(key)) return null;
  const group = selected.filter((c) => featureKey(c) === key);
  const res = group.map((c) => results.find((r) => r.id === c.id));
  if (res.some((r) => !r)) return null; // 아직 안 돈 케이스가 있다
  if (!res.some((r) => r!.status === "PASS")) return null;
  if (res.some((r) => !["PASS", "SKIP", "NA"].includes(r!.status))) return null;
  if (res.some((r) => r!.toolError)) return null; // 도구 오류로 판정하지 못한 케이스가 있으면 통과로 보고하지 않는다
  reported.add(key);
  const [screen, feature] = key.split("|") as [string, string];
  return { screen, feature, cases: group.length, titles: group.slice(0, 5).map((c) => c.title) };
}


/** 실패한 케이스를 3번 다시 돌려 불안정(flaky)인지 가린다: 모두 통과=통과, 일부만=불안정, 모두 실패=실패 */
async function retryFailed(first: CaseResult, mk: (attempt: number) => Promise<CaseResult>, emit: (ev: Record<string, unknown>) => void, caseId: string): Promise<CaseResult> {
  const retries = { n: 0, pass: 0, fail: 0, reasons: [] as string[] };
  let lastPass: CaseResult | undefined;
  for (let i = 1; i <= 3; i++) {
    emit({ type: "retry", case: caseId, attempt: i });
    const rr = await mk(i);
    retries.n++;
    if (rr.status === "PASS") {
      retries.pass++;
      lastPass = rr;
    } else {
      retries.fail++;
      retries.reasons.push(String(rr.reason ?? rr.status).slice(0, 160));
    }
    if (retries.pass > 0 && retries.fail > 0) break; // 일부만 통과 — 불안정으로 확정
  }
  if (retries.pass === retries.n && lastPass) return { ...lastPass, retries, warnings: [`첫 시도는 실패(${String(first.reason).slice(0, 100)})했지만 재시도 ${retries.n}번이 모두 통과함`, ...lastPass.warnings] };
  if (retries.pass > 0) return { ...first, status: "FLAKY", reason: `불안정: 첫 시도 실패 뒤 재시도 ${retries.n}번 중 ${retries.pass}번 통과 — 첫 실패: ${first.reason}`, retries };
  return { ...first, retries };
}

/** 회차가 끝난 뒤 영상을 mp4+챕터로 바꾸고 증거 기록(evidence.json)을 쓴다. */
async function finalizeEvidence(project: Project, roundId: string, kit: EvidenceKit, results: CaseResult[]) {
  const rdir = project.roundDir(roundId);
  for (const r of results) {
    if (!r.video) continue;
    const out = await kit.processVideo(join(rdir, r.video), r);
    if (!out) continue;
    r.video = out.video.slice(rdir.length + 1);
    if (out.chapters) r.chapters = out.chapters.slice(rdir.length + 1);
  }
  project.writeJson(`rounds/${roundId}/results.json`, results);
  kit.writeManifest();
}

export function stopRound(project: Project) {
  writeFileSync(project.p("stop"), "1");
}
