import { mkdirSync, copyFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Case, CaseResult, Config, StepResult, Step, Verdict } from "./types.ts";
import type { Driver, DPage } from "./drivers/index.ts";
import { Project, expandEnv, nowIso } from "./store.ts";
import { judgeErrors, runProbe, sleep } from "./probes.ts";

export interface RunCtx {
  project: Project;
  cfg: Config;
  driver: Driver;
  roundId: string;
  decision: "reset" | "keep" | "manual-reset-done";
  emit: (ev: Record<string, unknown>) => void;
  resetBeforeCase?: () => Promise<void>;
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 80);

function abs(url: string, base: string) {
  return /^https?:\/\//.test(url) ? url : new URL(url, base).toString();
}

export function describe(s: Step): string {
  const t = (v: unknown) => (v === undefined ? "" : ` ${typeof v === "string" ? v : JSON.stringify(v)}`);
  switch (s.op) {
    case "goto": return `이동${t(s.url)}`;
    case "click": return `클릭${t(s.sel)}`;
    case "dblclick": return `더블클릭${t(s.sel)}`;
    case "hover": return `마우스 올림${t(s.sel)}`;
    case "fill": return `입력${t(s.sel)} ← "${s.value}"`;
    case "select": return `선택${t(s.sel)} ← "${s.value}"`;
    case "check": return `체크${t(s.sel)} = ${s.checked ?? true}`;
    case "press": return `키 ${s.key}${s.sel ? " @" + s.sel : ""}`;
    case "wait": return s.sel ? `대기${t(s.sel)} ${s.state ?? "visible"}` : `대기 ${s.ms}ms`;
    case "expect": return `확인${t(Object.fromEntries(Object.entries(s).filter(([k]) => k !== "op")))}`;
    case "api": return `API ${s.method ?? "GET"} ${s.url}`;
    case "screenshot": return `스크린샷${t(s.name)}`;
    case "eval": return `스크립트 실행`;
    case "probe": return `점검(${s.kind}) ${s.label ?? s.sel ?? ""}`;
    default: return s.op;
  }
}

async function runExpect(p: DPage, s: Step, base: string) {
  const errs: string[] = [];
  const sel: string | undefined = s.sel;
  if (s.url !== undefined) {
    const u = await p.url();
    const ok = typeof s.url === "string" && (s.url.startsWith("^") ? new RegExp(s.url).test(u) : u.includes(s.url));
    if (!ok) errs.push(`주소가 다름: 기대 ${s.url} / 실제 ${u}`);
  }
  if (s.title !== undefined && (await p.title()) !== s.title) errs.push(`제목이 다름: 기대 "${s.title}" / 실제 "${await p.title()}"`);
  if (s.titleContains !== undefined && !(await p.title()).includes(s.titleContains)) errs.push(`제목에 "${s.titleContains}" 없음: "${await p.title()}"`);
  if (sel) {
    if (s.visible === true) {
      try { await p.waitFor(sel, "visible", s.timeout ?? 3000); } catch { errs.push(`보여야 하는데 안 보임: ${sel}`); }
    }
    if (s.hidden === true || s.visible === false) {
      try { await p.waitFor(sel, "hidden", s.timeout ?? 3000); } catch { errs.push(`안 보여야 하는데 보임: ${sel}`); }
    }
    if (s.count !== undefined) {
      const n = await p.count(sel);
      if (n !== s.count) errs.push(`개수가 다름: 기대 ${s.count} / 실제 ${n} (${sel})`);
    }
    if (s.text !== undefined) {
      const t = await p.text(sel).catch((e) => `<<${e}>>`);
      if (t !== s.text) errs.push(`텍스트가 다름: 기대 "${s.text}" / 실제 "${t}" (${sel})`);
    }
    if (s.textContains !== undefined) {
      const t = await p.text(sel).catch((e) => `<<${e}>>`);
      if (!t.includes(s.textContains)) errs.push(`텍스트에 "${s.textContains}" 없음: "${t.slice(0, 80)}" (${sel})`);
    }
    if (s.value !== undefined) {
      const v = await p.value(sel).catch((e) => `<<${e}>>`);
      if (v !== s.value) errs.push(`값이 다름: 기대 "${s.value}" / 실제 "${v}" (${sel})`);
    }
    if (s.checked !== undefined) {
      const c = await p.evaluate<boolean | null>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; return e ? (typeof e.checked === 'boolean' ? e.checked : e.getAttribute('aria-checked') === 'true') : null; })()`);
      if (c !== s.checked) errs.push(`체크 상태가 다름: 기대 ${s.checked} / 실제 ${c} (${sel})`);
    }
    if (s.enabled !== undefined) {
      const d = await p.evaluate<boolean>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; return !!e && !e.disabled && e.getAttribute('aria-disabled') !== 'true'; })()`);
      if (d !== s.enabled) errs.push(`활성 상태가 다름: 기대 ${s.enabled ? "활성" : "비활성"} (${sel})`);
    }
  }
  if (s.dialog !== undefined) {
    const n = await p.evaluate<number>(`window.__e2e.dialogs().length`);
    if (s.dialog === true && n === 0) errs.push("모달/대화상자가 떠야 하는데 없음");
    if (s.dialog === false && n > 0) errs.push("모달/대화상자가 없어야 하는데 떠 있음");
  }
  if (errs.length) throw new Error(errs.join(" | "));
}

function jsonPath(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export async function runCase(ctx: RunCtx, c: Case): Promise<CaseResult> {
  const { cfg, project, roundId } = ctx;
  const started = Date.now();
  const res: CaseResult = {
    id: c.id, title: c.title, type: c.type, event: c.event, source_ref: c.source_ref, element: c.element, risk: c.risk,
    status: "PASS", warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 0, startedAt: nowIso(),
  };
  const rdir = project.roundDir(roundId);
  const edir = join(rdir, "evidence", safe(c.id));
  mkdirSync(edir, { recursive: true });
  const rel = (p: string) => relative(rdir, p);

  // 정책에 따른 건너뜀
  const st = c.status ?? "active";
  if (st === "blocked" || st === "na") {
    res.status = st === "blocked" ? "BLOCKED" : "NA";
    res.reason = c.reason ?? "(사유 없음)";
    return res;
  }
  if (c.risk === "destructive" && ctx.decision === "keep") {
    res.status = "SKIP";
    res.reason = "데이터 유지 모드라 파괴적 동작(삭제·로그아웃 등)은 실행하지 않음 — 데이터 초기화 회차에서 확인 필요";
    return res;
  }
  if (ctx.resetBeforeCase) await ctx.resetBeforeCase();

  const session = await ctx.driver.newSession(edir);
  const page = session.page;
  const allowErrors = (c.tags ?? []).includes("allow-errors");
  const steps: Step[] = [...(cfg.auth?.setupSteps ?? []), ...c.steps];
  const keepAllShots = !ctx.driver.capabilities.video;
  let failedAt = -1;
  const shot = async (name: string): Promise<string | undefined> => {
    const p = join(edir, name + ".png");
    try {
      await page.screenshot(p);
      return rel(p);
    } catch {
      return undefined;
    }
  };

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const sr: StepResult = { i, op: s.op, desc: describe(s), status: "ok", ms: 0 };
    const t0 = Date.now();
    try {
      switch (s.op) {
        case "goto": await page.goto(abs(s.url, cfg.baseUrl)); break;
        case "click": await page.click(s.sel); break;
        case "dblclick": await page.dblclick(s.sel); break;
        case "hover": await page.hover(s.sel); break;
        case "fill": await page.fill(s.sel, expandEnv(String(s.value ?? ""))); break;
        case "select": await page.selectOption(s.sel, String(s.value)); break;
        case "check": await page.check(s.sel, s.checked ?? true); break;
        case "press": await page.press(s.sel ?? null, s.key); break;
        case "wait":
          if (s.sel) await page.waitFor(s.sel, s.state ?? "visible", s.timeout ?? cfg.stepTimeoutMs);
          else await sleep(Number(s.ms ?? 500));
          break;
        case "expect": await runExpect(page, s, cfg.baseUrl); break;
        case "api": {
          const r = await fetch(abs(s.url, cfg.baseUrl), {
            method: s.method ?? "GET",
            headers: { "content-type": "application/json", ...(s.headers ?? {}) },
            body: s.body === undefined ? undefined : typeof s.body === "string" ? s.body : JSON.stringify(s.body),
            signal: AbortSignal.timeout(15000),
          });
          const text = await r.text();
          if (s.status !== undefined && r.status !== s.status) throw new Error(`API 상태코드 ${r.status} (기대 ${s.status}): ${text.slice(0, 120)}`);
          if (s.status === undefined && r.status >= 400) throw new Error(`API 상태코드 ${r.status}: ${text.slice(0, 120)}`);
          if (s.json) {
            const body = JSON.parse(text);
            for (const [k, v] of Object.entries(s.json)) if (JSON.stringify(jsonPath(body, k)) !== JSON.stringify(v)) throw new Error(`API 응답 ${k} 가 다름: 기대 ${JSON.stringify(v)} / 실제 ${JSON.stringify(jsonPath(body, k))}`);
          }
          break;
        }
        case "screenshot": sr.shot = await shot(safe(s.name ?? `step${i}`)); break;
        case "eval": {
          const v = await page.evaluate(s.script);
          if (s.equals !== undefined && JSON.stringify(v) !== JSON.stringify(s.equals)) throw new Error(`스크립트 결과가 다름: 기대 ${JSON.stringify(s.equals)} / 실제 ${JSON.stringify(v)}`);
          break;
        }
        case "probe": {
          const pr = await runProbe(page, s, () => page.drain(), cfg.baseUrl, allowErrors);
          res.warnings.push(...pr.warns);
          if (pr.notes.length) sr.desc += " — " + pr.notes.join("; ");
          break;
        }
        default:
          throw new Error(`알 수 없는 스텝: ${s.op}`);
      }
    } catch (e: any) {
      sr.status = "fail";
      sr.error = String(e?.message ?? e).replace(/\n\s+/g, " ").slice(0, 600);
      failedAt = i;
    }
    sr.ms = Date.now() - t0;
    const isLast = i === steps.length - 1;
    if (sr.status === "fail" || keepAllShots || isLast) sr.shot = sr.shot ?? (await shot(`s${String(i).padStart(2, "0")}${sr.status === "fail" ? "_FAIL" : ""}`));
    // 실시간 대시보드용 최신 화면
    try {
      if (sr.shot) copyFileSync(join(rdir, sr.shot), join(rdir, "live.png"));
      else await page.screenshot(join(rdir, "live.png"));
    } catch {}
    res.steps.push(sr);
    ctx.emit({ type: "step", case: c.id, i, status: sr.status, desc: sr.desc, error: sr.error, shot: sr.shot });
    if (sr.status === "fail") {
      for (let j = i + 1; j < steps.length; j++) res.steps.push({ i: j, op: steps[j]!.op, desc: describe(steps[j]!), status: "skip", ms: 0 });
      break;
    }
  }

  // 케이스가 끝났을 때 남은 오류 신호
  const d = await page.drain().catch(() => ({ console: [], pageErrors: [], failedRequests: [] }));
  res.console = d.console;
  res.pageErrors = d.pageErrors;
  res.failedRequests = d.failedRequests;
  if (failedAt < 0) {
    const j = judgeErrors(d, allowErrors);
    if (j.fails.length) {
      res.status = "FAIL";
      res.reason = j.fails.join(" / ");
    }
    res.warnings.push(...j.warns);
  }
  if (failedAt >= 0) {
    res.status = "FAIL";
    res.reason = res.steps[failedAt]!.error;
  }
  const ev = await session.finish(res.status !== "FAIL");
  if (ev.video) res.video = rel(ev.video);
  if (ev.trace) res.trace = rel(ev.trace);
  res.warnings = [...new Set(res.warnings)].slice(0, 12);
  if (res.status === "FAIL") {
    const hard = res.pageErrors.length > 0 || res.failedRequests.some((r) => /^(5\d\d|ERR)\b/.test(r)) || /처리 안 된 JS 오류|서버\/네트워크 오류/.test(res.reason ?? "");
    const failedOp = failedAt >= 0 ? steps[failedAt]!.op : "";
    // P1: 사용자가 못 쓰는 수준(JS 예외·서버 5xx·페이지 자체가 안 열림). 나머지는 P2.
    res.priority = hard || failedOp === "goto" ? "P1" : "P2";
  }
  res.durationMs = Date.now() - started;
  return res as CaseResult & { status: Verdict };
}
