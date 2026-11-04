import { mkdirSync, copyFileSync } from "node:fs";
import { PrereqIncomplete, screenMatches } from "./chapter.ts";
import { join, relative } from "node:path";
import type { Case, CaseResult, Config, ReadySignal, StepResult, Step, Verdict } from "./types.ts";
import type { Driver, DPage } from "./drivers/index.ts";
import { Project, expandEnv, nowIso } from "./store.ts";
import { judgeErrors, runProbe, sleep, type ProbePolicy } from "./probes.ts";
import type { EvidenceKit } from "./evidence.ts";
import { ToolError, isBlankActual } from "./toolerror.ts";
import { CLICK_WAIT_MS, PANEL_WAIT_MS, READ_WAIT_MS, enabledStateText, settleList, waitEnabled, waitGone, waitPanelTitle, waitRendered } from "./reads.ts";
import { isToastStep } from "./toast.ts";
import { STOPPED_BY_LABEL, collectRows, perPage } from "./pages.ts";
import { SLICED_EVAL_WARNING, looksTruncated, slicesValue } from "./judge.ts";
import { MAX_WAIT_MS, singleStateWarning, singleEndState, waitEndState } from "./waits.ts";
import { isRowSel, translateSel } from "./rows.ts";
import { LABEL_ONLY_WARNING, describeFound, labelOnly } from "./finders.ts";
import { freezeArm, freezeEnsure, freezeRead, judgeFreeze } from "./freeze.ts";
import { HARD_VALUE_WARNING, datasetConflicts, datasetOf, describeHard, fillDataset, hardValues, hardValuesIn, stepApplies, usesDataset } from "./dataset.ts";
import { basisDiffers, basisText, hasBasis, isExpectation, uncheckedAction } from "./basis.ts";
import { onLoginScreen, unauthorized } from "./authexp.ts";
import { tx } from "./i18n.ts";

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

/** 대상 요소를 누르거나 채우는 동작(누르기 전 대기를 쓸 수 있는 스텝) */
const ACT_OPS = new Set(["click", "dblclick", "hover", "fill", "select", "check", "press"]);
/** 멈춤을 재는 스텝: 화면을 열거나 누르는 동작 */
const MEASURE_OPS = new Set(["goto", "click", "dblclick", "fill", "select", "check", "press"]);

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 80);
/** 영어 글의 개수: 1 row · 2 rows */
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function abs(url: string, base: string) {
  return /^https?:\/\//.test(url) ? url : new URL(url, base).toString();
}

/** 브라우저(또는 Ego 연결)가 사라졌을 때의 오류인가 — 사이트의 결함이 아니라 환경 문제다 */
export const browserGone = (e: any) => /Target page, context or browser has been closed|browser has been closed|Browser closed|Target closed|ECONNREFUSED|fetch failed/i.test(String(e?.message ?? e));

export function describe(s: Step): string {
  const t = (v: unknown) => (v === undefined ? "" : ` ${typeof v === "string" ? v : JSON.stringify(v)}`);
  switch (s.op) {
    case "goto": return tx(`이동${t(s.url)}`, `Go to${t(s.url)}`);
    case "click": return tx(`클릭${t(s.sel)}`, `Click${t(s.sel)}`);
    case "dblclick": return tx(`더블클릭${t(s.sel)}`, `Double-click${t(s.sel)}`);
    case "hover": return tx(`마우스 올림${t(s.sel)}`, `Hover${t(s.sel)}`);
    case "fill": return tx(`입력${t(s.sel)} ← "${s.value}"`, `Fill${t(s.sel)} ← "${s.value}"`);
    case "select": return tx(`선택${t(s.sel)} ← "${s.value}"`, `Select${t(s.sel)} ← "${s.value}"`);
    case "check": return tx(`체크${t(s.sel)} = ${s.checked ?? true}`, `Check${t(s.sel)} = ${s.checked ?? true}`);
    case "press": return tx(`키 ${s.key}${s.sel ? " @" + s.sel : ""}`, `Key ${s.key}${s.sel ? " @" + s.sel : ""}`);
    case "wait": return s.endStates ? tx(`끝 상태 대기 ${Object.keys(s.endStates).join(" · ")}`, `Wait for end states ${Object.keys(s.endStates).join(" · ")}`) : s.sel ? tx(`대기${t(s.sel)} ${s.state ?? "visible"}`, `Wait${t(s.sel)} ${s.state ?? "visible"}`) : tx(`대기 ${s.ms}ms`, `Wait ${s.ms}ms`);
    case "expect": return tx(`확인${t(Object.fromEntries(Object.entries(s).filter(([k]) => k !== "op")))}`, `Expect${t(Object.fromEntries(Object.entries(s).filter(([k]) => k !== "op")))}`);
    case "api": return `API ${s.method ?? "GET"} ${s.url}`;
    case "screenshot": return tx(`스크린샷${t(s.name)}`, `Screenshot${t(s.name)}`);
    case "eval": return tx(`스크립트 실행`, `Run script`);
    case "probe": return tx(`점검(${s.kind}) ${s.label ?? s.sel ?? ""}`, `Probe (${s.kind}) ${s.label ?? s.sel ?? ""}`);
    case "collect": return tx(`여러 쪽 줄 모으기${t(s.sel)}`, `Collect rows from all pages${t(s.sel)}`);
    case "prereq": return tx(`선행 조건 「${s.name ?? "-"}」 확인`, `Check precondition "${s.name ?? "-"}"`);
    case "condition": return tx(`시험 조건 「${s.name ?? "-"}」 확인`, `Check test condition "${s.name ?? "-"}"`);
    case "gate": return tx(`Gate 「${s.name ?? "-"}」 막힘이 정상 → ${s.resolve?.length ? "풀고" : "(사람이 풀기 전)"} 풀린 뒤 PASS 기준 확인`, `Gate "${s.name ?? "-"}": blocked is normal → ${s.resolve?.length ? "open it, then" : "(before a person opens it)"} check the PASS criterion after it opens`);
    default: return s.op;
  }
}

/** 요소가 입력 칸이면 그 값, 아니면 안에 든 입력 칸(input·textarea·select)의 값. 입력 칸 값은 innerText 에 실리지 않는다(오류 W) */
async function fieldValues(p: DPage, sel: string): Promise<string[]> {
  return p
    .evaluate<string[]>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; if (!e) return []; const isF = (x) => /^(INPUT|TEXTAREA|SELECT)$/.test(x.tagName) && !['hidden', 'password', 'button', 'submit', 'reset'].includes(x.type); const val = (x) => x.tagName === 'SELECT' ? (x.selectedOptions[0] ? x.selectedOptions[0].text : '') : (x.type === 'checkbox' || x.type === 'radio' ? '' : x.value); const fs = isF(e) ? [e] : [...e.querySelectorAll('input,textarea,select')].filter(isF); return fs.map((x) => String(val(x) ?? '').trim()).filter(Boolean); })()`)
    .then((v) => (Array.isArray(v) ? v.map(String) : []))
    .catch(() => []);
}
const fieldNote = (f: string[]) =>
  tx(
    `입력 칸 값으로 확인(${f.slice(0, 3).map((v) => `「${v.slice(0, 40)}」`).join(" ")}) — 입력 칸 값은 화면 글(innerText)에 안 실림`,
    `checked by field value (${f.slice(0, 3).map((v) => `"${v.slice(0, 40)}"`).join(" ")}) — field values are not part of the screen text (innerText)`,
  );
/** 어긋난 칸 뒤에 붙이는 입력 칸 값 */
const fieldTail = (f: string[]) => (f.length ? tx(` · 입력 칸 값 ${f.map((v) => `「${v}」`).join(" ")}`, ` · field values ${f.map((v) => `"${v}"`).join(" ")}`) : "");

async function runExpect(p: DPage, s: Step, base: string): Promise<string[]> {
  const notes: string[] = [];
  const errs: string[] = [];
  /** 실제 칸이 비었거나 undefined·NaN — 사이트의 결함이 아니라 도구가 화면을 못 읽은 것(D) */
  const blanks: string[] = [];
  /** 기대한 글이 잘린 글(…로 끝남)이라 어긋난 것 — 판정용 값을 자른 것이라 도구 탓(G) */
  const truncs: string[] = [];
  const sel: string | undefined = s.sel;
  const lab: string | undefined = s.selLabel ?? sel;
  const mismatch = (expected: unknown, actual: string, msg: string) => {
    if (isBlankActual(actual) && !isBlankActual(expected)) blanks.push(msg);
    else if (looksTruncated(expected)) truncs.push(msg);
    else errs.push(msg);
  };
  if (s.url !== undefined) {
    const u = await p.url();
    const ok = typeof s.url === "string" && (s.url.startsWith("^") ? new RegExp(s.url).test(u) : u.includes(s.url));
    if (!ok) errs.push(tx(`주소가 다름: 기대 ${s.url} / 실제 ${u}`, `Address differs: expected ${s.url} / actual ${u}`));
  }
  if (s.title !== undefined && (await p.title()) !== s.title) {
    const got = await p.title();
    errs.push(tx(`제목이 다름: 기대 "${s.title}" / 실제 "${got}"`, `Title differs: expected "${s.title}" / actual "${got}"`));
  }
  if (s.titleContains !== undefined && !(await p.title()).includes(s.titleContains)) {
    const got = await p.title();
    errs.push(tx(`제목에 "${s.titleContains}" 없음: "${got}"`, `Title does not contain "${s.titleContains}": "${got}"`));
  }
  if (sel) {
    // 읽기 전에 목록·패널이 그려졌는지 먼저 기다린다(그리기 전에 읽으면 빈 칸·undefined 가 나온다)
    const reads = s.text !== undefined || s.textContains !== undefined || s.value !== undefined || s.checked !== undefined || s.enabled !== undefined;
    if (s.count !== undefined) await waitRendered(p, sel, s.timeout ?? READ_WAIT_MS, s.count);
    else if (reads) await waitRendered(p, sel, s.timeout ?? READ_WAIT_MS);
    if (s.visible === true) {
      try { await p.waitFor(sel, "visible", s.timeout ?? 3000); } catch { errs.push(tx(`보여야 하는데 안 보임: ${lab}`, `Should be visible but is not: ${lab}`)); }
    }
    if (s.hidden === true || s.visible === false) {
      try { await p.waitFor(sel, "hidden", s.timeout ?? 3000); } catch { errs.push(tx(`안 보여야 하는데 보임: ${lab}`, `Should be hidden but is visible: ${lab}`)); }
    }
    if (s.count !== undefined) {
      const n = await p.count(sel);
      if (n !== s.count) errs.push(tx(`개수가 다름: 기대 ${s.count} / 실제 ${n} (${lab})`, `Count differs: expected ${s.count} / actual ${n} (${lab})`));
    }
    if (s.text !== undefined) {
      const t = await p.text(sel).catch((e) => `<<${e}>>`);
      if (t !== s.text) {
        const f = await fieldValues(p, sel);
        if (f.some((v) => v === s.text)) notes.push(fieldNote(f));
        else mismatch(s.text, t, tx(`텍스트가 다름: 기대 "${s.text}" / 실제 "${t}"${fieldTail(f)} (${lab})`, `Text differs: expected "${s.text}" / actual "${t}"${fieldTail(f)} (${lab})`));
      }
    }
    if (s.textContains !== undefined) {
      const t = await p.text(sel).catch((e) => `<<${e}>>`);
      if (!t.includes(s.textContains)) {
        const f = await fieldValues(p, sel);
        if (f.some((v) => v.includes(s.textContains))) notes.push(fieldNote(f));
        else mismatch(s.textContains, t, tx(`텍스트에 "${s.textContains}" 없음: "${t.slice(0, 80)}"${fieldTail(f)} (${lab})`, `Text differs: does not contain "${s.textContains}": "${t.slice(0, 80)}"${fieldTail(f)} (${lab})`));
      }
    }
    if (s.value !== undefined) {
      const v = await p.value(sel).catch((e) => `<<${e}>>`);
      if (v !== s.value) mismatch(s.value, v, tx(`값이 다름: 기대 "${s.value}" / 실제 "${v}" (${lab})`, `Value differs: expected "${s.value}" / actual "${v}" (${lab})`));
    }
    if (s.checked !== undefined) {
      const c = await p.evaluate<boolean | null>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; return e ? (typeof e.checked === 'boolean' ? e.checked : e.getAttribute('aria-checked') === 'true') : null; })()`);
      if (c !== s.checked) errs.push(tx(`체크 상태가 다름: 기대 ${s.checked} / 실제 ${c} (${lab})`, `Checked state differs: expected ${s.checked} / actual ${c} (${lab})`));
    }
    if (s.enabled !== undefined) {
      const d = await p.evaluate<boolean>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; return !!e && !e.disabled && e.getAttribute('aria-disabled') !== 'true'; })()`);
      if (d !== s.enabled) errs.push(tx(`활성 상태가 다름: 기대 ${s.enabled ? "활성" : "비활성"} (${lab})`, `Enabled state differs: expected ${s.enabled ? "enabled" : "disabled"} (${lab})`));
    }
  }
  if (s.dialog !== undefined) {
    const n = await p.evaluate<number>(`window.__e2e.dialogs().length`);
    if (s.dialog === true && n === 0) errs.push(tx("모달/대화상자가 떠야 하는데 없음", "A modal/dialog should be open but there is none"));
    if (s.dialog === false && n > 0) errs.push(tx("모달/대화상자가 없어야 하는데 떠 있음", "No modal/dialog should be open but one is"));
  }
  if (errs.length) throw new Error(errs.join(" | "));
  if (blanks.length) throw new ToolError("D", tx(`실제 값을 읽지 못함(빈 칸·undefined·NaN) — ${blanks.join(" | ")}`, `Could not read the actual value (blank, undefined, or NaN) — ${blanks.join(" | ")}`));
  if (truncs.length) throw new ToolError("G", tx(`기대한 글이 잘린 글(…)이라 전체 글과 비교할 수 없음 — ${truncs.join(" | ")}`, `The expected text is cut (…), so it cannot be compared with the whole text — ${truncs.join(" | ")}`));
  return notes;
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

/** 준비 신호의 이름(사람이 읽는 글) */
export function readyLabel(r: ReadySignal): string {
  if (r.name) return r.name;
  if (r.api) return `API ${String(r.api.method ?? "GET").toUpperCase()} ${r.api.url}${r.api.json ? " " + JSON.stringify(r.api.json) : ""}`;
  return `${r.sel}${r.text !== undefined ? ` = "${r.text}"` : r.textContains !== undefined ? tx(` 에 "${r.textContains}"`, ` contains "${r.textContains}"`) : tx(" 보임", " visible")}`;
}

/** 준비 신호가 지금 왔는가. now 는 지금 값(로그용) */
async function readyNow(page: DPage, cfg: Config, r: ReadySignal): Promise<{ ok: boolean; now: string }> {
  try {
    if (r.api) {
      const method = String(r.api.method ?? "GET").toUpperCase();
      const url = abs(r.api.url, cfg.baseUrl);
      let status: number;
      let text: string;
      if (r.api.via === "page") {
        const got = await page.evaluate<{ status: number; text: string }>(`(async () => { const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, credentials: 'include' }); const t = await r.text(); return { status: r.status, text: t.slice(0, 200000) }; })()`);
        status = got.status;
        text = got.text;
      } else {
        const res = await fetch(url, { method, signal: AbortSignal.timeout(15000) });
        status = res.status;
        text = await res.text();
      }
      const statusOk = r.api.status === undefined ? status < 400 : statusMatches(status, r.api.status);
      if (!statusOk) return { ok: false, now: tx(`상태코드 ${status}`, `status ${status}`) };
      if (!r.api.json) return { ok: true, now: tx(`상태코드 ${status}`, `status ${status}`) };
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, now: tx(`JSON 아님: ${text.slice(0, 60)}`, `not JSON: ${text.slice(0, 60)}`) };
      }
      const now = Object.keys(r.api.json).map((k) => `${k}=${JSON.stringify(jsonPath(body, k))}`).join(" ");
      return { ok: Object.entries(r.api.json).every(([k, v]) => JSON.stringify(jsonPath(body, k)) === JSON.stringify(v)), now };
    }
    const sel = translateSel(String(r.sel));
    if (!((await page.count(sel).catch(() => 0)) > 0 && (await page.isVisible(sel).catch(() => false)))) return { ok: false, now: tx("안 보임", "not visible") };
    if (r.text === undefined && r.textContains === undefined) return { ok: true, now: tx("보임", "visible") };
    const t = String((await page.text(sel).catch(() => "")) ?? "").trim();
    return { ok: r.text !== undefined ? t === r.text : t.includes(String(r.textContains)), now: tx(`「${t.slice(0, 60)}」`, `"${t.slice(0, 60)}"`) };
  } catch (e: any) {
    return { ok: false, now: tx(`읽지 못함: ${String(e?.message ?? e).slice(0, 60)}`, `could not read: ${String(e?.message ?? e).slice(0, 60)}`) };
  }
}

/** 준비 신호가 모두 올 때까지 기다린다. 상한 안에 안 오면 ToolError(M) — 사이트의 결함이 아니라 서버 계산이 덜 끝난 채 누를 뻔한 것 */
export async function waitReady(page: DPage, cfg: Config, c: Pick<Case, "ready" | "maxWaitSec">, onLog?: (line: string) => void): Promise<string> {
  const list = ([] as ReadySignal[]).concat(c.ready ?? []);
  const t0 = Date.now();
  for (const r of list) {
    // 상한은 신호마다 센다: 앞 신호를 기다린 시간이 뒤 신호의 상한을 먹지 않는다
    const t1 = Date.now();
    const cap = (r.timeoutSec ?? c.maxWaitSec ?? MAX_WAIT_MS / 1000) * 1000;
    const poll = r.pollMs ?? 2000;
    let lastLog = Date.now();
    for (;;) {
      const got = await readyNow(page, cfg, r);
      if (got.ok) break;
      if (Date.now() - t1 >= cap) throw new ToolError("M", tx(`선행 계산 미완료: 준비 신호 「${readyLabel(r)}」 가 ${Math.round(cap / 1000)}초 안에 오지 않음(지금 ${got.now}) — 서버 계산이 끝나기 전에는 누르지 않음`, `Server computation not finished: ready signal "${readyLabel(r)}" did not come within ${Math.round(cap / 1000)}s (now ${got.now}) — nothing is pressed before the server computation ends`), readyLabel(r));
      if (Date.now() - lastLog >= 15000) {
        lastLog = Date.now();
        const sec = Math.round((Date.now() - t1) / 1000);
        onLog?.(tx(`준비 신호 「${readyLabel(r)}」 기다리는 중 ${sec}초 — 지금 ${got.now}`, `Waiting for ready signal "${readyLabel(r)}": ${sec}s — now ${got.now}`));
      }
      await new Promise((res) => setTimeout(res, poll));
    }
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  return tx(`준비 신호 ${list.map((r) => `「${readyLabel(r)}」`).join(" ")} 확인(${sec}초)`, `ready signal ${list.map((r) => `"${readyLabel(r)}"`).join(" ")} confirmed (${sec}s)`);
}

/** 대화상자 안쪽에 있는 요소인가를 가리는 CSS (inpage dialogs 와 같은 범위) */
const DIALOG_CLOSEST = "dialog,[role=dialog],[role=alertdialog],[aria-modal=true],.modal,.ant-modal,.MuiDialog-root";

/**
 * 실패한 단계에서, 케이스가 예상하지 못한 대화상자가 떠 있으면 그 글자를 돌려준다.
 * 예상한 경우: 케이스가 dialog:true 를 기대하거나, 실패한 단계의 요소가 대화상자 안쪽에 있다.
 */
async function unexpectedDialog(p: DPage, failed: Step, all: Step[]): Promise<string | null> {
  try {
    if (failed.op === "probe") return null; // 점검(probe)은 모달을 스스로 열고 닫아 보므로 예상한 대화상자다
    if (failed.op === "expect" && failed.dialog === true) return null;
    if (all.some((x) => x.op === "expect" && x.dialog === true)) return null;
    const texts = await p.evaluate<string[]>(`window.__e2e.dialogs().map((d) => window.__e2e.norm(d.el.innerText || d.el.textContent || '').slice(0, 300))`);
    if (!texts?.length) return null;
    if (typeof failed.sel === "string") {
      const sel = isRowSel(failed.sel) ? translateSel(failed.sel) : failed.sel;
      const inside = await p.evaluate<boolean>(`(() => { try { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; return !!e && !!e.closest(${JSON.stringify(DIALOG_CLOSEST)}); } catch (x) { return false; } })()`).catch(() => false);
      if (inside) return null;
    }
    return texts.filter(Boolean).join(" / ") || tx("(글자 없는 대화상자)", "(dialog without text)");
  } catch {
    return null;
  }
}

/** Gate 를 푸는 동작(resolve)에 쓰는 단순 스텝 실행기 */
async function execSimple(p: DPage, st: Step, cfg: Config): Promise<void> {
  const sel = typeof st.sel === "string" ? translateSel(st.sel) : undefined;
  switch (st.op) {
    case "click": await p.click(sel!); break;
    case "dblclick": await p.dblclick(sel!); break;
    case "hover": await p.hover(sel!); break;
    case "fill": await p.fill(sel!, expandEnv(String(st.value ?? ""))); break;
    case "select": await p.selectOption(sel!, String(st.value)); break;
    case "check": await p.check(sel!, st.checked ?? true); break;
    case "press": await p.press(sel ?? null, st.key); break;
    case "wait":
      if (sel) await p.waitFor(sel, st.state ?? "visible", st.timeout ?? cfg.stepTimeoutMs);
      else await sleep(Number(st.ms ?? 500));
      break;
    default: throw new Error(tx(`Gate 의 resolve 에서 쓸 수 없는 스텝: ${st.op} (click·dblclick·hover·fill·select·check·press·wait 만 가능)`, `Step not allowed in a Gate resolve: ${st.op} (only click, dblclick, hover, fill, select, check, press, wait)`));
  }
}

/** expect 스텝의 선택자가 줄 도우미면 xpath 로 바꾼 사본 */
const withSel = (st: Step): Step => (typeof st.sel === "string" && isRowSel(st.sel) ? { ...st, sel: translateSel(st.sel), selLabel: st.sel } : st);

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
    res.reason = c.reason ?? tx("(사유 없음)", "(no reason)");
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
    res.reason = tx("그 밖의 파괴적 동작이라 데이터를 초기화하지 않는 회차에서는 실행하지 않음 — 규칙에 따른 스킵이며 이슈가 아님", "Another destructive action, so it is not run in a round that does not reset data — a skip by rule, not an issue");
    return res;
  }
  // Dataset 특성 선언과 어긋난 기대는 누르기 전에 막는다(오류 Q)
  const conflicts = datasetConflicts(c, cfg.datasets, isExpectation);
  if (conflicts.length) {
    const detail = tx(`Dataset 특성 선언과 어긋난 기대 — ${conflicts.join(" / ")}. 실행하지 않음`, `Expectation contradicts the dataset trait declaration — ${conflicts.join(" / ")}. Not run`);
    res.status = "NA";
    res.toolError = { kind: "Q", detail };
    res.reason = tx(`도구 판정 불가(Q): ${detail}`, `Tool error (Q): ${detail}`);
    return res;
  }
  if (ctx.resetBeforeCase) await ctx.resetBeforeCase();

  const session = await ctx.driver.newSession(edir);
  const t0 = Date.now(); // 영상 챕터의 기준 시각
  const page = session.page;
  const policy: ProbePolicy = { ownDataOnly: ctx.decision === "keep", created: ctx.created ?? [], onCreated: ctx.onCreated };
  const allowErrors = (c.tags ?? []).includes("allow-errors");
  const steps: Step[] = [...(cfg.auth?.setupSteps ?? []), ...c.steps];
  /** 로그인 스텝(같은 객체를 로그아웃 뒤 다시 로그인할 때도 끼워 넣는다) */
  const setupSet = new Set<Step>(cfg.auth?.setupSteps ?? []);
  const keepAllShots = !ctx.driver.capabilities.video;
  let failedAt = -1;
  let osBlocked: string | undefined;
  let toolErr: { kind: ToolError["kind"]; detail: string; evidenceText?: string; sub?: "condition" } | undefined;
  let skipped: string | undefined;
  let prereqIncomplete: CaseResult["blockedBy"];
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

  // 멈춤 측정: 누르는 스텝마다 잰다(기능 판정과 따로). 누른 뒤 이어지는 처리까지 담도록 다음 스텝을 시작하기 전에 읽는다
  const measuring = (cfg.freeze?.mode ?? "on") === "on";
  const limitMs = cfg.freeze?.limitMs ?? 1000;
  let open: { sr: StepResult; step: Step } | undefined;
  /** 화면 열기를 그 자리에서 다시 열어 다시 잰다(다시 열어도 상태가 바뀌지 않는다) */
  const remeasureGoto = async (step: Step): Promise<ReturnType<typeof judgeFreeze> | string | null> => {
    try {
      await page.goto(abs(step.url, cfg.baseUrl));
    } catch (e: any) {
      if (browserGone(e)) throw e;
      return tx(`다시 열다 실패: ${String(e?.message ?? e).slice(0, 120)}`, `Failed while opening again: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    await freezeEnsure(page);
    await sleep(1500);
    const again = await freezeRead(page);
    return again ? judgeFreeze(again, limitMs) : null;
  };
  const freezeWarn = (why: string | undefined, desc: string, summary: string, tag = "") => res.warnings.push(tx(`측정${tag}: ${why} — ${desc}: ${summary} (기능 판정과 따로)`, `Measurement${tag}: ${why} — ${desc}: ${summary} (separate from the functional verdict)`));
  const closeMeasure = async () => {
    if (!open) return;
    const { sr, step } = open;
    open = undefined;
    const raw = await freezeRead(page);
    if (!raw) return; // 문서가 바뀌어(다른 화면으로 이동) 잰 것이 없다
    const j = judgeFreeze(raw, limitMs);
    const m: NonNullable<StepResult["measure"]> = (sr.measure = { verdict: j.verdict, summary: j.summary, why: j.why });
    if (j.verdict === "ok") return;
    if (j.verdict === "freeze") {
      // 화면 열기의 멈춤은 한 번 더 열어 재현되는지 본다. 재현되지 않으면 첫 로드 비용·동시 부하로 보고 판정에서 뺀다(오류 U)
      if (step.op !== "goto") {
        m.why = tx(`${j.why} — 이 동작은 다시 누르지 않아 재현은 확인하지 않음`, `${j.why} — this action is not pressed again, so reproduction is not checked`);
        freezeWarn(m.why, sr.desc, j.summary);
        return;
      }
      const j2 = await remeasureGoto(step);
      if (j2 && typeof j2 !== "string" && j2.verdict === "ok") {
        m.verdict = "unconfirmed";
        m.why = tx(`${j.why} — 다시 열었을 때는 멈추지 않음(미재현: 첫 로드 비용·동시 부하로 보임)`, `${j.why} — no freeze when opened again (not reproduced: looks like first-load cost or other load)`);
        m.remeasured = tx(`멈춤 없음 — ${j2.summary}`, `no freeze — ${j2.summary}`);
        ctx.emit({ type: "freeze-unconfirmed", case: c.id, i: sr.i });
        return;
      }
      m.remeasured = typeof j2 === "string" ? j2 : j2 ? `${j2.verdict === "freeze" ? tx(`재현됨 — ${j2.why}`, `reproduced — ${j2.why}`) : tx(`무효(${j2.why})`, `invalid (${j2.why})`)} — ${j2.summary}` : undefined;
      if (j2 && typeof j2 !== "string" && j2.verdict === "freeze") m.why = tx(`${j.why} — 다시 열어도 멈춤(재현됨)`, `${j.why} — froze again when opened again (reproduced)`);
      freezeWarn(m.why, sr.desc, j.summary);
      return;
    }
    // 창이 가려진 채 잰 것이라 무효다(오류 O): 측정만 NA 로 두고 다음 라운드에 보이는 창에서 다시 잰다.
    // 시험 창을 앞으로 끌어오지 않는다 — 사용자의 마우스·포커스를 뺏는다(Round 12 사용자 쪽 지시)
    ctx.emit({ type: "measure-invalid", case: c.id, i: sr.i, why: j.why });
    m.why = tx(`${j.why} — 시험 창을 앞으로 끌어오지 않음(사용자 포커스를 뺏지 않음). 창이 보일 때 다음 라운드에 재측정`, `${j.why} — the test window is not pulled to the front (that would take focus from the user). Measured again in the next round while the window is visible`);
  };

  let readyDone = !c.ready;
  for (let i = 0; i < steps.length; i++) {
    await closeMeasure();
    const s0 = steps[i]!;
    // 이 Dataset 의 특성에 맞지 않는 기대(when)는 건너뛴다
    if (s0.when) {
      const ap = stepApplies(s0, datasetOf(cfg, c));
      if (!ap.ok) {
        res.steps.push({ i, op: s0.op, desc: tx(`${describe(s0)} — 건너뜀: Dataset 「${c.dataset ?? "-"}」 은 ${ap.why ?? "특성이 다름"}`, `${describe(s0)} — skipped: dataset "${c.dataset ?? "-"}" has ${ap.why ?? "different traits"}`), status: "skip", ms: 0 });
        continue;
      }
    }
    let s: Step = s0;
    const sr: StepResult = { i, op: s0.op, desc: describe(s0), status: "ok", ms: 0, at: Date.now() - t0 };
    const tStep = Date.now();
    const rowStep = typeof s0.sel === "string" && isRowSel(s0.sel);
    try {
      // 준비 신호: 첫 동작(이동이 아닌 스텝) 전에 서버 계산이 끝났다는 신호가 올 때까지 누르지 않고 기다린다(오류 M)
      if (!readyDone && s0.op !== "goto" && i >= (cfg.auth?.setupSteps?.length ?? 0)) {
        readyDone = true;
        sr.desc = `${await waitReady(page, cfg, c, (line) => ctx.emit({ type: "wait-log", case: c.id, i, line }))} → ${sr.desc}`;
      }
      // Dataset 전용 값은 판정식에 박지 않고 설정에서 읽는다: {{dataset.<이름>}} 을 이 케이스 Dataset 의 값으로 바꾼다(오류 P)
      if (usesDataset(s0)) {
        const f = fillDataset(s0, datasetOf(cfg, c));
        if (f.missing.length) throw new ToolError("P", tx(`Dataset ${c.dataset ? `「${c.dataset}」` : "(케이스에 dataset 없음)"} 설정에 값 ${f.missing.map((x) => `「${x}」`).join(" ")} 이 없어 판정식을 채우지 못함 — e2e_dataset 의 values 에 적을 것`, `The settings of dataset ${c.dataset ? `"${c.dataset}"` : "(the case has no dataset)"} have no value ${f.missing.map((x) => `"${x}"`).join(" ")}, so the judgement could not be filled in — add it to e2e_dataset values`));
        s = f.step;
      }
      // 줄 도우미(row=… · cell[…])는 번호가 아니라 컬럼 이름·글자로 찾는 xpath 로 바꿔 쓴다
      if (rowStep) s = { ...s, sel: translateSel(s.sel), selLabel: s.sel };
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
      // 패널·모달은 제목에 대상이 뜰 때까지 기다린 뒤 읽는다(늦게 그려지는 패널 때문에 버튼을 못 찾는 문제)
      if (s.panelTitle !== undefined) {
        const target = String(s.panelTitle);
        const wt = Number(s.panelTimeout ?? PANEL_WAIT_MS);
        const got = await waitPanelTitle(page, target, wt, typeof s.panel === "string" ? translateSel(s.panel) : undefined);
        if (!got.ok) throw new Error(tx(`패널 제목에 「${target}」 가 ${Math.round(wt / 1000)}초 안에 안 뜸 — 지금 뜬 패널 제목: ${got.titles.length ? got.titles.map((t) => `「${t.slice(0, 80)}」`).join(" ") : "(패널 없음)"}`, `Panel title "${target}" did not appear within ${Math.round(wt / 1000)}s — panel titles shown now: ${got.titles.length ? got.titles.map((t) => `"${t.slice(0, 80)}"`).join(" ") : "(no panel)"}`));
        sr.desc += tx(` — 패널 제목 「${target}」 확인`, ` — panel title "${target}" confirmed`);
      }
      // 누르기 전에: 「세는 중」 같은 표시가 사라지고(waitGone), 단추가 있고 켜질 때까지(waitEnabled) 기다린다
      if (ACT_OPS.has(s.op) && typeof s.sel === "string" && (s.waitGone !== undefined || s.waitEnabled === true)) {
        const wt = Number(s.waitTimeout ?? CLICK_WAIT_MS);
        if (s.waitGone !== undefined) {
          const g = await waitGone(page, s.waitGone, wt);
          if (!g.ok) throw new Error(tx(`${Math.round(wt / 1000)}초가 지나도 사라지지 않음: ${g.remaining.map((x) => `「${x}」`).join(" ")} — 그 표시가 사라진 뒤에 눌러야 함`, `Still shown after ${Math.round(wt / 1000)}s: ${g.remaining.map((x) => `"${x}"`).join(" ")} — press only after it disappears`));
          sr.desc += tx(` — ${([] as string[]).concat(s.waitGone).join("·")} 사라짐 확인`, ` — ${([] as string[]).concat(s.waitGone).join(", ")} gone, confirmed`);
        }
        if (s.waitEnabled === true) {
          const w = await waitEnabled(page, s.sel, wt);
          if (!w.ok) throw new Error(tx(`${Math.round(wt / 1000)}초 안에 켜지지 않음: ${s.sel} ${w.state}${w.text ? ` 글자 「${w.text}」` : ""}`, `Not enabled within ${Math.round(wt / 1000)}s: ${s.sel} ${enabledStateText(w.state)}${w.text ? ` text "${w.text}"` : ""}`));
          sr.desc += tx(` — 켜짐 확인: 「${w.text ?? ""}」`, ` — enabled, confirmed: "${w.text ?? ""}"`);
          if (!sr.found) sr.found = tx(`글자 「${w.text ?? ""}」 (켜진 뒤에 누름)`, `text "${w.text ?? ""}" (pressed after it was enabled)`);
        }
      }
      const measureThis = measuring && MEASURE_OPS.has(s.op);
      if (measureThis && s.op !== "goto") await freezeArm(page);
      switch (s.op) {
        case "goto": {
          await page.goto(abs(s.url, cfg.baseUrl));
          // 손으로 쓴 케이스가 없는 주소(404)로 갔으면 사이트 결함이 아니라 케이스 주소가 틀린 것이다(오류 C). 404 를 기대하는 스텝(status: 404)은 그대로 둔다
          if (c.type === "spec" && s.status !== 404 && !allowErrors) {
            const code = await page.evaluate<number | undefined>(`(() => { const n = performance.getEntriesByType('navigation')[0]; return n && n.responseStatus; })()`).catch(() => undefined);
            if (code === 404) throw new ToolError("C", tx(`없는 주소로 감(404): ${s.url} — 케이스의 주소가 화면 주소와 다름. 화면 목록(기획서·코드의 경로)과 맞춰 고칠 것`, `Went to an address that does not exist (404): ${s.url} — the case address differs from the screen address. Fix it to match the screen list (routes in the plan or the code)`));
          }
          // 로그인 화면으로 튕겼으면 로그인이 만료된 것이다 — 그 화면에서 읽지 않는다(오류 V)
          if (cfg.auth?.loginPath) {
            const at = new URL(await page.url(), cfg.baseUrl).pathname;
            if (onLoginScreen(cfg, at, new URL(abs(s.url, cfg.baseUrl)).pathname)) throw new ToolError("V", tx(`로그인 화면(${at})으로 튕김 — ${s.url} 로 갔는데 로그인이 만료돼 판정하지 않음`, `Sent back to the login screen (${at}) — went to ${s.url}, but the login expired, so it is not judged`));
          }
          // 선행 챕터에 기대는 케이스가 목표 화면으로 갔는데 다른 화면(예: 선행 단계 화면)에 머물면 선행 단계가 안 끝난 것이다.
          // 그 화면에서 읽기를 60초씩 기다리지 않고 바로 「선행 미완료」 NA(H)로 끝낸다
          if (c.requires?.length && c.screen && screenMatches(new URL(abs(s.url, cfg.baseUrl)).pathname, c.screen)) {
            const at = new URL(await page.url(), cfg.baseUrl).pathname;
            if (!screenMatches(at, c.screen)) throw new PrereqIncomplete(c.requires[0]!, tx(`선행 미완료: 목표 화면(${c.screen})으로 갔는데 ${at} 에 머묾 — 선행 챕터(${c.requires.join(", ")})가 끝나지 않은 것으로 보고 읽지 않음`, `Prerequisite not finished: went to the target screen (${c.screen}) but stayed on ${at} — the prior chapter (${c.requires.join(", ")}) looks unfinished, so nothing is read`));
          }
          break;
        }
        case "click": await page.click(s.sel); break;
        case "dblclick": await page.dblclick(s.sel); break;
        case "hover": await page.hover(s.sel); break;
        case "fill": {
          const v = expandEnv(String(s.value ?? ""));
          // 로그인 스텝에서 친 아이디·비밀번호는 테스터가 등록한 데이터가 아니다 — 남기면 keep 회차의 삭제 점검이 그 계정 이름이 보이는 실데이터 줄을 지우고, 비밀번호가 created.json 에 남는다
          if (v.length >= 4 && !setupSet.has(s0)) ctx.onCreated?.(v);
          await page.fill(s.sel, v);
          break;
        }
        case "select": await page.selectOption(s.sel, String(s.value)); break;
        case "check": await page.check(s.sel, s.checked ?? true); break;
        case "press": await page.press(s.sel ?? null, s.key); break;
        case "wait":
          if (s.endStates) {
            // 끝 상태 집합 대기: 어느 끝 상태든 도착하면 끝낸다. 15초마다 로그, 60초 무변화면 대기 실패(도구 판정 불가)
            if (singleEndState(s as any)) res.warnings.push(singleStateWarning());
            // 케이스의 maxWaitSec 이 있으면 그것이 전체 상한(긴 계산). 스텝의 timeout 이 더 우선한다
            const long = c.maxWaitSec !== undefined && s.idleMs === undefined;
            const spec = c.maxWaitSec !== undefined && s.timeout === undefined ? { ...s, timeout: c.maxWaitSec * 1000 } : s;
            const got = await waitEndState(page, spec as any, { longWait: long, onLog: (line) => ctx.emit({ type: "wait-log", case: c.id, i, line }) });
            sr.desc += tx(` — 도착: 「${got.state}」 (${(got.ms / 1000).toFixed(1)}초)`, ` — reached: "${got.state}" (${(got.ms / 1000).toFixed(1)}s)`);
          } else if (s.sel) {
            res.warnings.push(tx(`끝 상태를 하나만 받는 대기(${s.sel} ${s.state ?? "visible"}): 그 상태가 오지 않으면 실패로 끝남. 화면의 모든 끝 상태를 endStates 로 넣을 것(오류 A)`, `A wait that accepts only one end state (${s.sel} ${s.state ?? "visible"}): if that state never comes, it ends as a failure. Put every end state of the screen in endStates (error A)`));
            await page.waitFor(s.sel, s.state ?? "visible", s.timeout ?? cfg.stepTimeoutMs);
          } else if (s.panelTitle === undefined || s.ms !== undefined) await sleep(Number(s.ms ?? 500));
          break;
        case "expect":
          if (isToastStep(s)) {
            // 토스트는 참고로만 적는다: 있어도 없어도 판정하지 않는다(쓰기 동작은 서버 효과로 판정)
            try {
              await runExpect(page, s, cfg.baseUrl);
              sr.desc += tx(" — 토스트 확인됨(참고)", " — toast seen (reference)");
            } catch (e: any) {
              sr.desc += tx(" — 토스트 참고만(판정 안 함)", " — toast is a reference only (not judged)");
              res.warnings.push(tx(`토스트 참고(판정 아님): ${String(e?.message ?? e).slice(0, 160)}`, `Toast reference (not a verdict): ${String(e?.message ?? e).slice(0, 160)}`));
            }
          } else {
            const notes = await runExpect(page, s, cfg.baseUrl);
            if (notes.length) sr.desc += ` — ${notes.join("; ")}`;
          }
          break;
        case "collect": {
          // 목록이 여러 쪽이면 모든 쪽을 돌며 같은 이름 줄을 모은다(첫 줄·pop() 으로 읽지 않는다)
          const wantRows = s.count !== undefined ? s.count > 0 : s.atLeast !== undefined ? s.atLeast > 0 : s.contains !== undefined;
          const got = await collectRows(page, { sel: s.sel, next: s.next, first: s.first, maxPages: s.maxPages, expectRows: wantRows }, s.timeout ?? READ_WAIT_MS);
          sr.desc += tx(` — ${got.pages}쪽에서 ${got.rows.length}줄 모음(${STOPPED_BY_LABEL[got.stoppedBy]})`, ` — collected ${plural(got.rows.length, "row")} from ${plural(got.pages, "page")} (${STOPPED_BY_LABEL[got.stoppedBy]})`);
          sr.found = `${perPage(got)}: ${got.rows.slice(0, 6).map((r) => tx(`「${r.text.slice(0, 40)}」`, `"${r.text.slice(0, 40)}"`)).join(" ")}${got.rows.length > 6 ? " …" : ""}`;
          if (!s.next) res.warnings.push(tx(`여러 쪽 줄 모으기에 next(다음 쪽 단추)가 없어 한 쪽만 읽음: ${s.sel}`, `Collect rows has no next (next-page button), so only one page was read: ${s.sel}`));
          if (got.stoppedBy === "max") res.warnings.push(tx(`여러 쪽 줄 모으기가 쪽 상한(${s.maxPages ?? 50}쪽)에서 멈춤 — 남은 쪽의 줄은 모으지 못했을 수 있음`, `Collect rows stopped at the page limit (${s.maxPages ?? 50} pages) — rows on the remaining pages may be missing`));
          const errs: string[] = [];
          if (s.count !== undefined && got.rows.length !== s.count) errs.push(tx(`모든 쪽에서 모은 줄 개수가 다름: 기대 ${s.count} / 실제 ${got.rows.length}`, `Row count differs across all pages: expected ${s.count} / actual ${got.rows.length}`));
          if (s.atLeast !== undefined && got.rows.length < s.atLeast) errs.push(tx(`모든 쪽에서 모은 줄이 적음: 기대 ${s.atLeast}줄 이상 / 실제 ${got.rows.length}`, `Too few rows across all pages: expected at least ${s.atLeast} / actual ${got.rows.length}`));
          for (const t of ([] as string[]).concat(s.contains ?? [])) if (!got.rows.some((r) => r.text.includes(t))) errs.push(tx(`모은 줄 중에 「${t}」 가 있는 줄이 없음`, `No collected row contains "${t}"`));
          if (errs.length) throw new Error(`${errs.join(" | ")} (${perPage(got)}, ${s.sel})`);
          break;
        }
        case "prereq": {
          // 챕터의 선행 조건(예: 대상 줄을 찾았다). 못 채우면 이 챕터는 「선행 조건 실패 — 도구」 NA 로 끝나고 뒤 동작을 누르지 않는다
          const { op: _op, name: _n, basis: _b, ...cond } = s;
          try {
            await runExpect(page, withSel({ op: "expect", ...cond }), cfg.baseUrl);
          } catch (e: any) {
            // 앞머리(실제 값을 읽지 못함 …)는 떼고 붙인다. 이 도구가 쓴 글이라 한국어·영어 둘 다 뗀다
            const why = String(e?.message ?? e).replace(/^(실제 값을 읽지 못함\(빈 칸·undefined·NaN\)|Could not read the actual value \(blank, undefined, or NaN\)) — /i, "");
            throw new ToolError("F", tx(`선행 조건 실패 — 도구: 「${s.name ?? "-"}」 ${why}`, `Precondition failed - tool: "${s.name ?? "-"}" ${why}`));
          }
          break;
        }
        case "condition": {
          // 시험 조건: 실패·중지·장애를 일부러 만드는 케이스는 그 장애가 실제로 생기는 조건인지 먼저 확인한다(예: 파일 내용이 바뀌어 장애 난 API 를 부르는 경로인가).
          // 안 서면 FAIL 이 아니라 「시험 조건 불성립」 NA(F 의 하위 항목)로 두고 재시험 대기열에 올린다
          const got = await readyNow(page, cfg, { name: s.name, api: s.api, sel: typeof s.sel === "string" ? s.sel : undefined, text: s.text, textContains: s.textContains });
          if (!got.ok) throw new ToolError("F", tx(`시험 조건 불성립: 「${s.name ?? "-"}」 — 지금 ${got.now}. 일부러 만드는 실패·장애가 이 조건에서는 생기지 않으므로 판정하지 않음(재시험 대기열)`, `Test condition not met: "${s.name ?? "-"}" — now ${got.now}. The failure the case makes on purpose does not happen under this condition, so it is not judged (retest queue)`), undefined, "condition");
          sr.desc += tx(` — 성립(${got.now})`, ` — holds (${got.now})`);
          break;
        }
        case "gate": {
          // 사람 결정이 필요한 Gate: 풀기 전에는 막혀 있는 것이 정상이고, 풀린 뒤가 PASS 기준이다
          const name = s.name ?? "-";
          const why = hasBasis(s) ? tx(` (근거 ${basisText(s.basis)})`, ` (basis ${basisText(s.basis)})`) : "";
          try {
            await runExpect(page, withSel({ op: "expect", ...(s.blocked ?? {}) }), cfg.baseUrl);
          } catch (e: any) {
            if (e?.name === "ToolError") throw e;
            throw new Error(tx(`Gate 「${name}」: 풀기 전에는 막혀 있어야 정상인데${why} 막히지 않음 — ${e?.message ?? e}`, `Gate "${name}": it should be blocked before it opens${why}, but it is not blocked — ${e?.message ?? e}`));
          }
          if (s.resolve?.length) {
            for (const rs of s.resolve as Step[]) await execSimple(page, rs, cfg);
            try {
              await runExpect(page, withSel({ op: "expect", ...(s.passed ?? {}) }), cfg.baseUrl);
            } catch (e: any) {
              if (e?.name === "ToolError") throw e;
              throw new Error(tx(`Gate 「${name}」: 풀린 뒤 PASS 기준과 다름${why} — ${e?.message ?? e}`, `Gate "${name}": after it opens, it differs from the PASS criterion${why} — ${e?.message ?? e}`));
            }
          } else res.warnings.push(tx(`Gate 「${name}」: 사람이 풀기 전이라 풀린 뒤 PASS 기준은 확인하지 못함${why}`, `Gate "${name}": a person has not opened it yet, so the PASS criterion after it opens was not checked${why}`));
          break;
        }
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
            if (status >= 400) throw new Error(tx(`API 상태코드 ${status}: ${text.slice(0, 120)}`, `API status ${status}: ${text.slice(0, 120)}`));
          } else if (!statusMatches(status, exp)) throw new Error(tx(`API 상태코드 ${status} (기대 ${JSON.stringify(exp)}): ${text.slice(0, 120)}`, `API status ${status} (expected ${JSON.stringify(exp)}): ${text.slice(0, 120)}`));
          if (s.json || s.jsonHas || s.jsonArray !== undefined) {
            let body: any;
            try {
              body = JSON.parse(text);
            } catch {
              throw new Error(tx(`API 응답이 JSON 이 아님: ${text.slice(0, 80)}`, `API response is not JSON: ${text.slice(0, 80)}`));
            }
            if (s.jsonArray !== undefined && Array.isArray(body) !== s.jsonArray) throw new Error(tx(`API 응답 형태가 다름: 기대 ${s.jsonArray ? "배열" : "객체"} / 실제 ${Array.isArray(body) ? "배열" : typeof body}`, `API response shape differs: expected ${s.jsonArray ? "array" : "object"} / actual ${Array.isArray(body) ? "array" : typeof body}`));
            for (const k of s.jsonHas ?? []) if (jsonPath(body, k) === undefined) throw new Error(tx(`API 응답에 ${k} 가 없음: ${text.slice(0, 120)}`, `API response has no ${k}: ${text.slice(0, 120)}`));
            for (const [k, v] of Object.entries(s.json ?? {})) if (JSON.stringify(jsonPath(body, k)) !== JSON.stringify(v)) throw new Error(tx(`API 응답 ${k} 가 다름: 기대 ${JSON.stringify(v)} / 실제 ${JSON.stringify(jsonPath(body, k))}`, `API response ${k} differs: expected ${JSON.stringify(v)} / actual ${JSON.stringify(jsonPath(body, k))}`));
          }
          break;
        }
        case "screenshot": sr.shot = await shot(safe(s.name ?? `step${i}`)); break;
        case "eval": {
          // waitFor: 스크립트가 읽기 전에 그려져 있어야 하는 목록·패널 선택자(하나 또는 배열)
          for (const w of ([] as string[]).concat(s.waitFor ?? [])) {
            const wt = s.timeout ?? READ_WAIT_MS;
            if (!(await waitRendered(page, w, wt))) throw new ToolError("D", tx(`읽기 전에 그려져 있어야 하는 ${w} 가 ${wt}ms 안에 나타나지 않음`, `${w} must be drawn before reading, but it did not appear within ${wt}ms`));
          }
          if (s.equals !== undefined && slicesValue(s.script)) res.warnings.push(SLICED_EVAL_WARNING("eval"));
          const v = await page.evaluate(s.script);
          if (s.equals !== undefined && JSON.stringify(v) !== JSON.stringify(s.equals)) {
            const msg = tx(`스크립트 결과가 다름: 기대 ${JSON.stringify(s.equals)} / 실제 ${JSON.stringify(v)}`, `Script result differs: expected ${JSON.stringify(s.equals)} / actual ${JSON.stringify(v)}`);
            // 스크립트가 글자를 잘라 비교했다면 이 어긋남은 사이트의 결함인지 가릴 수 없다(오류 G)
            if (slicesValue(s.script)) throw new ToolError("G", tx(`판정용 값을 slice·substring 으로 잘라 비교함 — 자르지 않은 전체로 비교해야 판정할 수 있음. ${msg}`, `The judged value is cut with slice or substring before comparing — compare the whole value to judge. ${msg}`));
            throw new Error(msg);
          }
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
              pr.notes.push(tx("로그인 스텝으로 다시 로그인", "logged in again with the login steps"));
            } else pr.notes.push(tx("로그인 설정(auth.setupSteps)이 없어 다시 로그인은 생략", "no login settings (auth.setupSteps), so logging in again was skipped"));
          }
          res.warnings.push(...pr.warns);
          if (pr.notes.length) sr.desc += " — " + pr.notes.join("; ");
          break;
        }
        default:
          throw new Error(tx(`알 수 없는 스텝: ${s.op}`, `Unknown step: ${s.op}`));
      }
      if (measureThis) {
        if (s.op === "goto") await freezeEnsure(page); // 새 문서: 시작될 때 심은 측정기가 있으면 로드 중부터, 없으면 열린 뒤부터 잰다
        open = { sr, step: s };
      }
    } catch (e: any) {
      if (browserGone(e)) throw e; // 라운드가 브라우저를 다시 띄워 이 케이스를 한 번 더 돌린다
      sr.status = "fail";
      sr.error = String(e?.message ?? e).replace(/\n\s+/g, " ").slice(0, 600);
      failedAt = i;
      if (e?.name === "OsWindowRequired") osBlocked = String(e.message);
      if (e?.name === "PrereqIncomplete") prereqIncomplete = { chapter: e.chapter, by: [], detail: String(e.message) };
      if (e?.name === "ToolError") toolErr = { kind: e.kind, detail: String(e.message), evidenceText: e.evidenceText, ...(e.sub ? { sub: e.sub } : {}) };
      else if (!osBlocked && !skipped && !prereqIncomplete) {
        // 케이스가 예상하지 못한 대화상자가 먼저 떠서 막힌 것(예: 확인 모달)이면 사이트 결함이 아니라 NA — 모달 글자를 증거로 남긴다
        const dlg = await unexpectedDialog(page, s, steps);
        if (dlg) {
          toolErr = { kind: "D", detail: tx(`예상 못 한 대화상자가 떠 있어 이 단계를 판정하지 못함 — 대화상자: 「${dlg}」`, `An unexpected dialog is open, so this step could not be judged — dialog: "${dlg}"`), evidenceText: tx(`대화상자 글자: 「${dlg}」`, `Dialog text: "${dlg}"`) };
          sr.error = tx(`${sr.error} | 예상 못 한 대화상자: 「${dlg}」`, `${sr.error} | unexpected dialog: "${dlg}"`).slice(0, 900);
        }
      }
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

  await closeMeasure().catch(() => {});
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
  // 실패한 뒤 화면이 로그인 화면이거나 401 을 받았다면 시험 도중 로그인이 만료된 것이다 — 결함으로 세지 않는다(오류 V)
  // 튕긴 화면에서 값을 못 읽은 것(D)도 로그인 만료 탓이다
  if (failedAt >= 0 && (!toolErr || toolErr.kind === "D") && !osBlocked && !skipped && cfg.auth) {
    const at = await page.url().then((u) => new URL(u, cfg.baseUrl).pathname).catch(() => "");
    const u401 = unauthorized(d.failedRequests);
    if ((at && onLoginScreen(cfg, at)) || u401.length) {
      const login = !!at && onLoginScreen(cfg, at);
      const err = String(res.steps[failedAt]?.error ?? "").slice(0, 160);
      toolErr = {
        kind: "V",
        detail: tx(
          `로그인 만료 — ${login ? `로그인 화면(${at})으로 튕김` : ""}${u401.length ? `${login ? " · " : ""}401 받음: ${u401.slice(0, 3).join(", ")}` : ""}. 판정하지 않음: ${err}`,
          `Login expired — ${login ? `sent back to the login screen (${at})` : ""}${u401.length ? `${login ? " · " : ""}got 401: ${u401.slice(0, 3).join(", ")}` : ""}. Not judged: ${err}`,
        ),
      };
      prereqIncomplete = undefined;
    }
  }
  // 판정식에 다른 Dataset 전용 값(예: 다른 Dataset 의 「안 보냄」 표 목록)을 박았다면 이 Dataset 의 의도된 동작을 FAIL 로 본 것일 수 있다(오류 P)
  const hard = hardValues(c, cfg.datasets);
  if (hard.own.length) res.warnings.push(HARD_VALUE_WARNING(hard.own, true));
  if (failedAt >= 0 && !toolErr && !osBlocked && !skipped && !prereqIncomplete) {
    const hv = hardValuesIn(steps[failedAt]!, cfg.datasets).filter((h) => h.dataset !== c.dataset);
    if (hv.length) toolErr = { kind: "P", detail: tx(`판정식에 다른 Dataset 전용 값이 박혀 있음(${describeHard(hv)}) — 이 케이스의 Dataset ${c.dataset ? `「${c.dataset}」` : "(미지정)"} 에서는 의도된 동작이 FAIL 로 나올 수 있어 판정하지 않음`, `A value of another dataset is written into the judgement (${describeHard(hv)}) — in the dataset of this case (${c.dataset ? `"${c.dataset}"` : "not set"}), the intended behavior can come out as FAIL, so it is not judged`) };
  }
  // 기획서와 화면설계서가 다르다고 적은 기대가 어긋났으면 어느 쪽이 맞는지 정해지지 않은 것이다 — 결함으로 세지 않는다(오류 S)
  if (failedAt >= 0 && !toolErr && !osBlocked && !skipped && !prereqIncomplete && basisDiffers(steps[failedAt])) {
    const err = String(res.steps[failedAt]?.error ?? "").slice(0, 200);
    toolErr = { kind: "S", detail: tx(`근거가 서로 다른 기대가 어긋남(${basisText(steps[failedAt]!.basis)}) — 어느 쪽을 따를지 정해지지 않아 판정하지 않음: ${err}`, `An expectation whose bases disagree did not match (${basisText(steps[failedAt]!.basis)}) — nobody has decided which document to follow, so it is not judged: ${err}`) };
  }
  // 마지막 동작 뒤에 결과 기대가 없으면 「오류 없음」만으로는 통과가 아니다 — 고른 값이 틀려도 PASS 로 남는다(오류 X)
  if (c.type === "spec" && failedAt < 0 && !toolErr && !osBlocked && !skipped && res.status === "PASS") {
    // 로그인 스텝(auth.setupSteps — 로그아웃 뒤 다시 로그인한 것 포함)은 케이스의 동작이 아니다
    const ran = res.steps.filter((x) => x.status === "ok").map((x) => steps[x.i]!).filter((x) => !setupSet.has(x));
    const k = uncheckedAction(ran);
    if (k !== undefined) toolErr = { kind: "X", detail: tx(`확인 없는 통과 — 마지막 동작(${describe(ran[k]!)}) 뒤에 결과 기대가 없어 「오류 없음」만으로는 통과로 보지 않음. 고른 값·저장된 결과를 근거와 대조하는 기대를 넣을 것`, `Pass with nothing checked — there is no result expectation after the last action (${describe(ran[k]!)}), so "no errors" alone is not a pass. Add an expectation that checks the chosen value or the saved result against the basis`) };
  }
  // 화면 글이 빈 것이 사이트의 JS 오류·서버 5xx 와 함께 나왔다면 도구 탓이 아니라 사이트의 결함이다 — FAIL 로 둔다
  const siteFault = res.pageErrors.length > 0 || res.failedRequests.some((r) => /^(5\d\d|ERR)\b/.test(r));
  // 실패한 단계가 있을 때만 FAIL 로 돌린다. 실패 없이 생긴 도구 오류(X)를 지우면 FAIL 이 아니라 PASS 로 남는다
  if (toolErr && siteFault && failedAt >= 0) toolErr = undefined;
  if (prereqIncomplete) {
    // 선행 단계가 끝나지 않아 목표 화면에 못 들어감 — 도구 오류도 제품 FAIL 도 아니라 「선행 결함에 막힘」(H)
    res.status = "NA";
    res.blockedBy = prereqIncomplete;
    res.reason = tx(`${prereqIncomplete.detail} (도구 오류 아님, 선행 단계를 마친 뒤 다시 실행)`, `${prereqIncomplete.detail} (not a tool error; finish the prior step, then run again)`);
    toolErr = undefined;
  }
  if (toolErr) {
    // 시험 도구 탓에 판정하지 못한 것이지 사이트의 결함이 아니다 — FAIL 이 아니라 NA, 이슈가 아니라 제외 시트로 간다
    res.status = "NA";
    res.toolError = toolErr;
    res.reason = tx(`도구 판정 불가(${toolErr.kind}): ${toolErr.detail}`, `Tool error (${toolErr.kind}): ${toolErr.detail}`);
  }
  res.warnings = [...new Set(res.warnings)].slice(0, 12);
  if (res.status === "PASS") {
    // 사용자가 이슈로 승격한 경고가 나왔으면 실패로 본다
    const hit = cfg.promotedWarnings.find((pw) => (!pw.case || pw.case === c.id) && res.warnings.some((w) => w.includes(pw.match)));
    if (hit) {
      res.status = "FAIL";
      res.promoted = true;
      const w = res.warnings.find((x) => x.includes(hit.match));
      res.reason = tx(`사용자가 이슈로 승격한 경고: ${w}`, `Warning the user promoted to an issue: ${w}`);
    }
  }
  const ev = await session.finish(res.status !== "FAIL" && !res.toolError);
  if (ev.warn) res.warnings.push(ev.warn);
  if (ev.video) res.video = rel(ev.video);
  if (ev.trace) res.trace = rel(ev.trace);
  res.warnings = [...new Set(res.warnings)].slice(0, 12);
  if (res.status === "FAIL") {
    const hard = res.pageErrors.length > 0 || res.failedRequests.some((r) => /^(5\d\d|ERR)\b/.test(r)) || /처리 안 된 JS 오류|서버\/네트워크 오류|unhandled JS error|server\/network error/i.test(res.reason ?? ""); // 이 도구(probes)가 쓴 글. 한국어·영어 둘 다 본다
    const failedOp = failedAt >= 0 ? steps[failedAt]!.op : "";
    // P1: 사용자가 못 쓰는 수준(JS 예외·서버 5xx·페이지 자체가 안 열림). 나머지는 P2.
    res.priority = hard || failedOp === "goto" ? "P1" : "P2";
  }
  res.durationMs = Date.now() - started;
  return res as CaseResult & { status: Verdict };
}
