import { mkdirSync, copyFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Case, CaseResult, Config, StepResult, Step, Verdict } from "./types.ts";
import type { Driver, DPage } from "./drivers/index.ts";
import { Project, expandEnv, nowIso } from "./store.ts";
import { judgeErrors, runProbe, sleep, type ProbePolicy } from "./probes.ts";
import type { EvidenceKit } from "./evidence.ts";
import { ToolError, isBlankActual } from "./toolerror.ts";
import { READ_WAIT_MS, settleList, waitRendered } from "./reads.ts";
import { SINGLE_STATE_WARNING, singleEndState, waitEndState } from "./waits.ts";
import { isRowSel, translateSel } from "./rows.ts";
import { LABEL_ONLY_WARNING, describeFound, labelOnly } from "./finders.ts";

export interface RunCtx {
  project: Project;
  cfg: Config;
  driver: Driver;
  roundId: string;
  decision: "reset" | "keep" | "manual-reset-done";
  emit: (ev: Record<string, unknown>) => void;
  resetBeforeCase?: () => Promise<void>;
  /** 재시도 번호(0 = 첫 시도). 재시도의 증거는 별도 폴더에 둔다 */
  attempt?: number;
  /** 증거 처리기: 스크린샷에 커밋·시각·케이스 id·해시 도장을 찍는다 */
  kit?: EvidenceKit;
  /** 테스터가 입력해 등록한 값(삭제 허용 판단용) */
  created?: string[];
  onCreated?: (value: string) => void;
  /** 이 라운드에서 이미 찾은 요소(선택자). 처음 쓰는 요소만 찾은 요소의 글자를 로그에 남긴다 */
  seenSels?: Set<string>;
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 80);

function abs(url: string, base: string) {
  return /^https?:\/\//.test(url) ? url : new URL(url, base).toString();
}

/** 브라우저(또는 Ego 연결)가 사라졌을 때의 오류인가 — 사이트의 결함이 아니라 환경 문제다 */
export const browserGone = (e: any) => /Target page, context or browser has been closed|browser has been closed|Browser closed|Target closed|ECONNREFUSED|fetch failed/i.test(String(e?.message ?? e));

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
    case "wait": return s.endStates ? `끝 상태 대기 ${Object.keys(s.endStates).join(" · ")}` : s.sel ? `대기${t(s.sel)} ${s.state ?? "visible"}` : `대기 ${s.ms}ms`;
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
  /** 실제 칸이 비었거나 undefined·NaN — 사이트의 결함이 아니라 도구가 화면을 못 읽은 것(D) */
  const blanks: string[] = [];
  const sel: string | undefined = s.sel;
  const lab: string | undefined = s.selLabel ?? sel;
  const mismatch = (expected: unknown, actual: string, msg: string) => {
    if (isBlankActual(actual) && !isBlankActual(expected)) blanks.push(msg);
    else errs.push(msg);
  };
  if (s.url !== undefined) {
    const u = await p.url();
    const ok = typeof s.url === "string" && (s.url.startsWith("^") ? new RegExp(s.url).test(u) : u.includes(s.url));
    if (!ok) errs.push(`주소가 다름: 기대 ${s.url} / 실제 ${u}`);
  }
  if (s.title !== undefined && (await p.title()) !== s.title) errs.push(`제목이 다름: 기대 "${s.title}" / 실제 "${await p.title()}"`);
  if (s.titleContains !== undefined && !(await p.title()).includes(s.titleContains)) errs.push(`제목에 "${s.titleContains}" 없음: "${await p.title()}"`);
  if (sel) {
    // 읽기 전에 목록·패널이 그려졌는지 먼저 기다린다(그리기 전에 읽으면 빈 칸·undefined 가 나온다)
    const reads = s.text !== undefined || s.textContains !== undefined || s.value !== undefined || s.checked !== undefined || s.enabled !== undefined;
    if (s.count !== undefined) await waitRendered(p, sel, s.timeout ?? READ_WAIT_MS, s.count);
    else if (reads) await waitRendered(p, sel, s.timeout ?? READ_WAIT_MS);
    if (s.visible === true) {
      try { await p.waitFor(sel, "visible", s.timeout ?? 3000); } catch { errs.push(`보여야 하는데 안 보임: ${lab}`); }
    }
    if (s.hidden === true || s.visible === false) {
      try { await p.waitFor(sel, "hidden", s.timeout ?? 3000); } catch { errs.push(`안 보여야 하는데 보임: ${lab}`); }
    }
    if (s.count !== undefined) {
      const n = await p.count(sel);
      if (n !== s.count) errs.push(`개수가 다름: 기대 ${s.count} / 실제 ${n} (${lab})`);
    }
    if (s.text !== undefined) {
      const t = await p.text(sel).catch((e) => `<<${e}>>`);
      if (t !== s.text) mismatch(s.text, t, `텍스트가 다름: 기대 "${s.text}" / 실제 "${t}" (${lab})`);
    }
    if (s.textContains !== undefined) {
      const t = await p.text(sel).catch((e) => `<<${e}>>`);
      if (!t.includes(s.textContains)) mismatch(s.textContains, t, `텍스트에 "${s.textContains}" 없음: "${t.slice(0, 80)}" (${lab})`);
    }
    if (s.value !== undefined) {
      const v = await p.value(sel).catch((e) => `<<${e}>>`);
      if (v !== s.value) mismatch(s.value, v, `값이 다름: 기대 "${s.value}" / 실제 "${v}" (${lab})`);
    }
    if (s.checked !== undefined) {
      const c = await p.evaluate<boolean | null>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; return e ? (typeof e.checked === 'boolean' ? e.checked : e.getAttribute('aria-checked') === 'true') : null; })()`);
      if (c !== s.checked) errs.push(`체크 상태가 다름: 기대 ${s.checked} / 실제 ${c} (${lab})`);
    }
    if (s.enabled !== undefined) {
      const d = await p.evaluate<boolean>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; return !!e && !e.disabled && e.getAttribute('aria-disabled') !== 'true'; })()`);
      if (d !== s.enabled) errs.push(`활성 상태가 다름: 기대 ${s.enabled ? "활성" : "비활성"} (${lab})`);
    }
  }
  if (s.dialog !== undefined) {
    const n = await p.evaluate<number>(`window.__e2e.dialogs().length`);
    if (s.dialog === true && n === 0) errs.push("모달/대화상자가 떠야 하는데 없음");
    if (s.dialog === false && n > 0) errs.push("모달/대화상자가 없어야 하는데 떠 있음");
  }
  if (errs.length) throw new Error(errs.join(" | "));
  if (blanks.length) throw new ToolError("D", `실제 값을 읽지 못함(빈 칸·undefined·NaN) — ${blanks.join(" | ")}`);
}

/** 상태코드 기대값: 숫자, 숫자 배열, "2xx" "3xx", "<400" */
export function statusMatches(status: number, exp: unknown): boolean {
  if (typeof exp === "number") return status === exp;
  if (Array.isArray(exp)) return exp.some((e) => statusMatches(status, e));
  if (typeof exp === "string") {
    const m1 = exp.match(/^([1-5])xx$/i);
    if (m1) return Math.floor(status / 100) === Number(m1[1]);
    const m2 = exp.match(/^<\s*(\d{3})$/);
    if (m2) return status < Number(m2[1]);
    return String(status) === exp;
  }
  return false;
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
  const edir = join(rdir, "evidence", safe(c.id) + (ctx.attempt ? `.retry${ctx.attempt}` : ""));
  mkdirSync(edir, { recursive: true });
  const rel = (p: string) => relative(rdir, p);

  // 정책에 따른 건너뜀
  const st = c.status ?? "active";
  if (st === "blocked" || st === "na") {
    res.status = st === "blocked" ? "BLOCKED" : "NA";
    res.reason = c.reason ?? "(사유 없음)";
    return res;
  }
  if (c.skipReason) {
    res.status = "SKIP";
    res.reason = c.skipReason;
    return res;
  }
  if (c.risk === "destructive" && ctx.decision === "keep") {
    // 삭제·로그아웃은 별도 규칙(probe)으로 다룬다. 그 밖의 파괴적 동작은 스킵이며 이슈가 아니다.
    res.status = "SKIP";
    res.reason = "그 밖의 파괴적 동작이라 데이터를 초기화하지 않는 회차에서는 실행하지 않음 — 규칙에 따른 스킵이며 이슈가 아님";
    return res;
  }
  if (ctx.resetBeforeCase) await ctx.resetBeforeCase();

  const session = await ctx.driver.newSession(edir);
  const t0 = Date.now(); // 영상 챕터의 기준 시각
  const page = session.page;
  const policy: ProbePolicy = { ownDataOnly: ctx.decision === "keep", created: ctx.created ?? [], onCreated: ctx.onCreated };
  const allowErrors = (c.tags ?? []).includes("allow-errors");
  const steps: Step[] = [...(cfg.auth?.setupSteps ?? []), ...c.steps];
  const keepAllShots = !ctx.driver.capabilities.video;
  let failedAt = -1;
  let osBlocked: string | undefined;
  let toolErr: { kind: ToolError["kind"]; detail: string; evidenceText?: string } | undefined;
  let skipped: string | undefined;
  const shot = async (name: string): Promise<string | undefined> => {
    const p = join(edir, name + ".png");
    try {
      await page.screenshot(p);
      await ctx.kit?.stampImage(p, c.id).catch(() => {});
      return rel(p);
    } catch {
      return undefined;
    }
  };

  for (let i = 0; i < steps.length; i++) {
    const s0 = steps[i]!;
    let s: Step = s0;
    const sr: StepResult = { i, op: s0.op, desc: describe(s0), status: "ok", ms: 0, at: Date.now() - t0 };
    const tStep = Date.now();
    const rowStep = typeof s0.sel === "string" && isRowSel(s0.sel);
    try {
      // 줄 도우미(row=… · cell[…])는 번호가 아니라 컬럼 이름·글자로 찾는 xpath 로 바꿔 쓴다
      if (rowStep) s = { ...s0, sel: translateSel(s0.sel), selLabel: s0.sel };
      if (typeof s0.sel === "string") {
        // 사람이 쓴 케이스의 라벨 글자만으로 찾는 호출은 경고한다(자동 점검 케이스는 제외)
        if (c.type === "spec" && labelOnly(s0.sel)) res.warnings.push(LABEL_ONLY_WARNING(s0.sel));
        // 처음 쓰는 요소는 찾은 요소의 글자를 남겨 눈으로 확인하게 한다
        if (ctx.seenSels && !ctx.seenSels.has(s0.sel) && ["click", "dblclick", "hover", "fill", "select", "check", "press", "expect"].includes(s0.op)) {
          ctx.seenSels.add(s0.sel);
          const found = await describeFound(page, s.sel);
          if (found) {
            sr.found = found;
            ctx.emit({ type: "element-found", case: c.id, i, sel: s0.sel, found });
          }
        }
      }
      switch (s.op) {
        case "goto": await page.goto(abs(s.url, cfg.baseUrl)); break;
        case "click": await page.click(s.sel); break;
        case "dblclick": await page.dblclick(s.sel); break;
        case "hover": await page.hover(s.sel); break;
        case "fill": { const v = expandEnv(String(s.value ?? "")); if (v.length >= 4) ctx.onCreated?.(v); await page.fill(s.sel, v); break; }
        case "select": await page.selectOption(s.sel, String(s.value)); break;
        case "check": await page.check(s.sel, s.checked ?? true); break;
        case "press": await page.press(s.sel ?? null, s.key); break;
        case "wait":
          if (s.endStates) {
            // 끝 상태 집합 대기: 어느 끝 상태든 도착하면 끝낸다. 15초마다 로그, 60초 무변화면 대기 실패(도구 판정 불가)
            if (singleEndState(s as any)) res.warnings.push(SINGLE_STATE_WARNING);
            const got = await waitEndState(page, s as any, { onLog: (line) => ctx.emit({ type: "wait-log", case: c.id, i, line }) });
            sr.desc += ` — 도착: 「${got.state}」 (${(got.ms / 1000).toFixed(1)}초)`;
          } else if (s.sel) {
            res.warnings.push(`끝 상태를 하나만 받는 대기(${s.sel} ${s.state ?? "visible"}): 그 상태가 오지 않으면 실패로 끝남. 화면의 모든 끝 상태를 endStates 로 넣을 것(오류 A)`);
            await page.waitFor(s.sel, s.state ?? "visible", s.timeout ?? cfg.stepTimeoutMs);
          } else await sleep(Number(s.ms ?? 500));
          break;
        case "expect": await runExpect(page, s, cfg.baseUrl); break;
        case "api": {
          const method = String(s.method ?? "GET").toUpperCase();
          const url = abs(s.url, cfg.baseUrl);
          const reqBody = s.body === undefined ? undefined : typeof s.body === "string" ? s.body : JSON.stringify(s.body);
          const headers = { "content-type": "application/json", ...(s.headers ?? {}) };
          let status: number;
          let text: string;
          sr.api = { method, url, requestBody: reqBody?.slice(0, 2000), via: s.via === "page" ? "page" : "server" };
          if (s.via === "page") {
            // 브라우저 안에서 보낸다: 로그인 쿠키·세션이 그대로 실린다
            const r = await page.evaluate<{ status: number; text: string }>(
              `(async () => { const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers)}, body: ${JSON.stringify(reqBody ?? null)} === null ? undefined : ${JSON.stringify(reqBody ?? null)}, credentials: 'include' }); const t = await r.text(); return { status: r.status, text: t.slice(0, 200000) }; })()`,
            );
            status = r.status;
            text = r.text;
          } else {
            const r = await fetch(url, { method, headers, body: reqBody, signal: AbortSignal.timeout(15000) });
            text = await r.text();
            status = r.status;
          }
          sr.api.status = status;
          sr.api.responseBody = text.slice(0, 2000);
          const exp = s.status;
          if (exp === undefined) {
            if (status >= 400) throw new Error(`API 상태코드 ${status}: ${text.slice(0, 120)}`);
          } else if (!statusMatches(status, exp)) throw new Error(`API 상태코드 ${status} (기대 ${JSON.stringify(exp)}): ${text.slice(0, 120)}`);
          if (s.json || s.jsonHas || s.jsonArray !== undefined) {
            let body: any;
            try {
              body = JSON.parse(text);
            } catch {
              throw new Error(`API 응답이 JSON 이 아님: ${text.slice(0, 80)}`);
            }
            if (s.jsonArray !== undefined && Array.isArray(body) !== s.jsonArray) throw new Error(`API 응답 형태가 다름: 기대 ${s.jsonArray ? "배열" : "객체"} / 실제 ${Array.isArray(body) ? "배열" : typeof body}`);
            for (const k of s.jsonHas ?? []) if (jsonPath(body, k) === undefined) throw new Error(`API 응답에 ${k} 가 없음: ${text.slice(0, 120)}`);
            for (const [k, v] of Object.entries(s.json ?? {})) if (JSON.stringify(jsonPath(body, k)) !== JSON.stringify(v)) throw new Error(`API 응답 ${k} 가 다름: 기대 ${JSON.stringify(v)} / 실제 ${JSON.stringify(jsonPath(body, k))}`);
          }
          break;
        }
        case "screenshot": sr.shot = await shot(safe(s.name ?? `step${i}`)); break;
        case "eval": {
          // waitFor: 스크립트가 읽기 전에 그려져 있어야 하는 목록·패널 선택자(하나 또는 배열)
          for (const w of ([] as string[]).concat(s.waitFor ?? [])) {
            const wt = s.timeout ?? READ_WAIT_MS;
            if (!(await waitRendered(page, w, wt))) throw new ToolError("D", `읽기 전에 그려져 있어야 하는 ${w} 가 ${wt}ms 안에 나타나지 않음`);
          }
          const v = await page.evaluate(s.script);
          if (s.equals !== undefined && JSON.stringify(v) !== JSON.stringify(s.equals)) throw new Error(`스크립트 결과가 다름: 기대 ${JSON.stringify(s.equals)} / 실제 ${JSON.stringify(v)}`);
          break;
        }
        case "probe": {
          const pr = await runProbe(page, s, () => page.drain(), cfg.baseUrl, allowErrors, edir, policy);
          if (s.kind === "logout") {
            // 로그아웃은 테스트한 뒤 다시 로그인한다: 로그인 스텝을 이어 붙이고 로그인 상태가 돌아왔는지 확인한다
            const setup = cfg.auth?.setupSteps ?? [];
            if (setup.length) {
              const back: Step[] = [{ op: "goto", url: steps.slice(0, i).reverse().find((x) => x.op === "goto")?.url ?? "/" }, ...setup, { op: "probe", kind: "relogin-check", sel: s.sel }];
              steps.splice(i + 1, 0, ...back);
              pr.notes.push("로그인 스텝으로 다시 로그인");
            } else pr.notes.push("로그인 설정(auth.setupSteps)이 없어 다시 로그인은 생략");
          }
          res.warnings.push(...pr.warns);
          if (pr.notes.length) sr.desc += " — " + pr.notes.join("; ");
          break;
        }
        default:
          throw new Error(`알 수 없는 스텝: ${s.op}`);
      }
    } catch (e: any) {
      if (browserGone(e)) throw e; // 라운드가 브라우저를 다시 띄워 이 케이스를 한 번 더 돌린다
      sr.status = "fail";
      sr.error = String(e?.message ?? e).replace(/\n\s+/g, " ").slice(0, 600);
      failedAt = i;
      if (e?.name === "OsWindowRequired") osBlocked = String(e.message);
      if (e?.name === "ToolError") toolErr = { kind: e.kind, detail: String(e.message), evidenceText: e.evidenceText };
      if (e?.name === "SkipCase") skipped = String(e.message);
    }
    // 줄 하나를 바꾸면 목록이 다시 정렬·다시 그려질 수 있다 — 다음 동작 전에 목록이 가라앉기를 기다려 다시 읽게 한다
    if (rowStep && sr.status === "ok" && ["click", "dblclick", "fill", "select", "check", "press"].includes(s0.op)) await settleList(page);
    sr.ms = Date.now() - tStep;
    const isLast = i === steps.length - 1;
    if (sr.status === "fail" || keepAllShots || isLast) sr.shot = sr.shot ?? (await shot(`s${String(i).padStart(2, "0")}${sr.status === "fail" ? "_FAIL" : ""}`));
    // 실시간 대시보드용 최신 화면
    try {
      if (sr.shot) copyFileSync(join(rdir, sr.shot), join(rdir, "live.png"));
      else await page.screenshot(join(rdir, "live.png"));
    } catch {}
    res.steps.push(sr);
    ctx.emit({ type: "step", case: c.id, i, status: sr.status, desc: sr.desc, error: sr.error, shot: sr.shot, found: sr.found });
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
  if (skipped) {
    res.status = "SKIP";
    res.reason = skipped;
  }
  if (osBlocked) {
    // 도구가 할 수 없는 일이지 사이트의 결함이 아니다 — 검증하지 못한 것으로 둔다
    res.status = "BLOCKED";
    res.reason = osBlocked;
  }
  // 화면 글이 빈 것이 사이트의 JS 오류·서버 5xx 와 함께 나왔다면 도구 탓이 아니라 사이트의 결함이다 — FAIL 로 둔다
  const siteFault = res.pageErrors.length > 0 || res.failedRequests.some((r) => /^(5\d\d|ERR)\b/.test(r));
  if (toolErr && siteFault) toolErr = undefined;
  if (toolErr) {
    // 시험 도구 탓에 판정하지 못한 것이지 사이트의 결함이 아니다 — FAIL 이 아니라 NA, 이슈가 아니라 제외 시트로 간다
    res.status = "NA";
    res.toolError = toolErr;
    res.reason = `도구 판정 불가(${toolErr.kind}): ${toolErr.detail}`;
  }
  res.warnings = [...new Set(res.warnings)].slice(0, 12);
  if (res.status === "PASS") {
    // 사용자가 이슈로 승격한 경고가 나왔으면 실패로 본다
    const hit = cfg.promotedWarnings.find((pw) => (!pw.case || pw.case === c.id) && res.warnings.some((w) => w.includes(pw.match)));
    if (hit) {
      res.status = "FAIL";
      res.promoted = true;
      res.reason = `사용자가 이슈로 승격한 경고: ${res.warnings.find((w) => w.includes(hit.match))}`;
    }
  }
  const ev = await session.finish(res.status !== "FAIL" && !res.toolError);
  if (ev.warn) res.warnings.push(ev.warn);
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
