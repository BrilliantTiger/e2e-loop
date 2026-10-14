// MCP 와 CLI 가 함께 쓰는 동작 모음. 반환값은 JSON 으로 직렬화되는 평범한 객체.
import { existsSync, readFileSync } from "node:fs";
import type { Case, Config, DriverName, Source, Step } from "./types.ts";
import { Project, nowIso } from "./store.ts";
import { doctor } from "./doctor.ts";
import { discover, mergeProbeCases, probeCases } from "./discover.ts";
import { coverage } from "./coverage.ts";
import { precheck, runningRound, startRound, stopRound, type StartOpts } from "./round.ts";
import { completeCheck } from "./gate.ts";
import { startDashboard } from "./dashboard.ts";
import { addFeedback, resolveFeedback } from "./feedback.ts";
import { trend } from "./report.ts";

export const proj = (p?: string) => new Project(p ?? process.env.E2E_PROJECT ?? process.cwd());

const OPS = new Set(["goto", "click", "dblclick", "hover", "fill", "select", "check", "press", "wait", "expect", "api", "screenshot", "eval", "probe"]);
const NEEDS_SEL = new Set(["click", "dblclick", "hover", "fill", "select", "check"]);

const dashboards = new Map<string, { url: string; stop: () => void }>();
const liveRounds = new Map<string, Promise<unknown>>();

export function ensureDashboard(p: Project) {
  let d = dashboards.get(p.root);
  if (!d) {
    d = startDashboard(p);
    dashboards.set(p.root, d);
  }
  return d;
}

export async function aDoctor(a: { fix?: boolean; confirm?: string[]; dryRun?: boolean }) {
  return doctor({ fix: a.fix, confirm: a.confirm, dryRun: a.dryRun });
}

export async function aInit(a: {
  project?: string; baseUrl?: string; driver?: DriverName; headless?: boolean; dataPolicy?: "ask" | "reset" | "keep";
  resetCommand?: string; resetCwd?: string; resetScope?: "round" | "case"; codeRoot?: string;
  authLocalStorage?: Record<string, string>; authSetupSteps?: Step[]; destructivePattern?: string; acceptedSkips?: string[];
  crawl?: Partial<Config["crawl"]>; probes?: "auto" | "off"; dashboardPort?: number; viewport?: { width: number; height: number };
}) {
  const p = proj(a.project);
  const first = !p.initialized;
  const c = p.config();
  if (a.baseUrl) c.baseUrl = a.baseUrl;
  if (a.driver) c.driver = a.driver;
  if (a.headless !== undefined) c.headless = a.headless;
  if (a.dataPolicy) c.data.policy = a.dataPolicy;
  if (a.resetCommand !== undefined) c.data.resetCommand = a.resetCommand || undefined;
  if (a.resetCwd) c.data.resetCwd = a.resetCwd;
  if (a.resetScope) c.data.resetScope = a.resetScope;
  if (a.codeRoot) c.codeRoot = a.codeRoot;
  if (a.authLocalStorage) c.auth = { ...(c.auth ?? {}), localStorage: a.authLocalStorage };
  if (a.authSetupSteps) c.auth = { ...(c.auth ?? {}), setupSteps: a.authSetupSteps };
  if (a.destructivePattern) c.destructivePattern = a.destructivePattern;
  if (a.acceptedSkips) c.acceptedSkips = a.acceptedSkips;
  if (a.crawl) c.crawl = { ...c.crawl, ...a.crawl };
  if (a.probes) c.probes = a.probes;
  if (a.dashboardPort) c.dashboardPort = a.dashboardPort;
  if (a.viewport) c.viewport = a.viewport;
  p.ensure();
  p.saveConfig(c);
  const d = await doctor();
  const ask: string[] = [];
  if (first && !a.driver && d.driver_choices.filter((x) => x.available).length > 1)
    ask.push(`브라우저를 고르게 하세요: ${d.driver_choices.filter((x) => x.available).map((x) => x.value).join(" / ")} (현재 auto → ${d.auto_would_use}). 바꾸려면 e2e_init 의 driver 로 지정.`);
  if (first && !a.dataPolicy) ask.push("데이터 정책을 정하세요: ask(회차마다 묻기, 기본) / reset(항상 초기화) / keep(항상 유지). 초기화하려면 resetCommand 도 필요합니다.");
  if (!p.sources().length) ask.push("기획서·디자인·기능정의서 중 있는 것을 알려 달라고 하세요. 하나도 없으면 개발된 사이트(live-site)를 근거로 씁니다.");
  return { project: p.root, config: c, available_drivers: d.driver_choices, ask_user: ask };
}

export function aSourceAdd(a: { project?: string; kind: Source["kind"]; title: string; location: string; sections?: string[] }) {
  const p = proj(a.project);
  const list = p.sources();
  const id = "S" + String(list.length + 1).padStart(2, "0");
  const warn: string[] = [];
  if (a.kind !== "live-site" && !/^https?:\/\//.test(a.location) && !existsSync(a.location)) warn.push(`파일이 이 경로에 없습니다: ${a.location}`);
  const s: Source = { id, kind: a.kind, title: a.title, location: a.location, sections: a.sections, addedAt: nowIso() };
  p.writeJson("sources.json", [...list, s]);
  const order = { plan: 1, design: 1, "feature-spec": 2, "live-site": 3 } as const;
  return { added: s, sources: list.length + 1, basis_priority: "기획서/디자인 > 기능정의서 > 라이브 사이트(요소 전수 탐색)", lowest_basis_only: order[a.kind] === 3 && list.every((x) => x.kind === "live-site"), warn };
}

export async function aDiscover(a: { project?: string; seeds?: string[]; maxPages?: number; reveal?: boolean; driver?: DriverName }) {
  const p = proj(a.project);
  const cfg = p.config();
  const inv = await discover(p, a);
  const probes = cfg.probes === "off" ? [] : probeCases(cfg, inv);
  const merged = mergeProbeCases(p.cases(), probes);
  p.saveCases(merged.cases);
  if (!p.sources().some((s) => s.kind === "live-site")) p.writeJson("sources.json", [...p.sources(), { id: "S" + String(p.sources().length + 1).padStart(2, "0"), kind: "live-site", title: "개발된 사이트 " + cfg.baseUrl, location: cfg.baseUrl, addedAt: nowIso() } satisfies Source]);
  const byKind: Record<string, number> = {};
  for (const e of inv.elements) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  const risky = inv.elements.filter((e) => e.risk !== "safe");
  return {
    pages: inv.pages.map((x) => `${x.path} (${x.elements}개${x.error ? ", 오류: " + x.error : ""})`),
    elements: { total: inv.elements.length, byKind, modalOpeners: inv.elements.filter((e) => e.opensModal).length, inModal: inv.elements.filter((e) => e.layer !== "page").length },
    risky: { destructive: risky.filter((e) => e.risk === "destructive").map((e) => `${e.page} “${e.label}”`), mutating: risky.filter((e) => e.risk === "mutating").length },
    probe_cases: { added: merged.added, removed: merged.removed, specKept: merged.kept, total: probes.length },
    skipped: inv.skipped.slice(0, 10),
    next: "기획서/디자인이 있으면 그 문서의 기대 동작을 e2e_case_upsert 로 spec 케이스로 옮기고, e2e_coverage 로 빠진 곳을 확인한 뒤 e2e_round_start 하세요.",
  };
}

export function aCaseUpsert(a: { project?: string; cases: Partial<Case>[] }) {
  const p = proj(a.project);
  const byId = new Map(p.cases().map((c) => [c.id, c]));
  const errors: string[] = [];
  const warns: string[] = [];
  let added = 0;
  let updated = 0;
  for (const c of a.cases) {
    if (!c.id || !c.title || !Array.isArray(c.steps) || !c.steps.length) {
      errors.push(`${c.id ?? "(id 없음)"}: id/title/steps 필수`);
      continue;
    }
    const bad = c.steps.map((s, i) => ({ s, i })).filter(({ s }) => !OPS.has(s.op) || (NEEDS_SEL.has(s.op) && typeof s.sel !== "string") || (s.op === "goto" && typeof s.url !== "string"));
    if (bad.length) {
      errors.push(`${c.id}: 잘못된 스텝 ${bad.map(({ s, i }) => `#${i + 1}(${s.op})`).join(", ")} — 허용: ${[...OPS].join(" ")}, click/fill/select/check 등은 sel 필수, goto 는 url 필수`);
      continue;
    }
    if (c.steps[0]!.op !== "goto" && !c.steps.some((s) => s.op === "goto")) warns.push(`${c.id}: goto 스텝이 없습니다. 케이스는 매번 새 브라우저에서 시작하므로 첫 스텝에서 이동해야 합니다.`);
    if ((c.type ?? "spec") === "spec" && !c.source_ref) warns.push(`${c.id}: source_ref(근거 위치)가 없습니다. 기획서의 어느 절/디자인의 어느 프레임인지 적어 두세요.`);
    if (!c.steps.some((s) => s.op === "expect" || s.op === "probe" || s.op === "api")) warns.push(`${c.id}: 기대값을 확인하는 expect 스텝이 없어 “화면이 열린다” 이상을 검증하지 못합니다.`);
    byId.has(c.id) ? updated++ : added++;
    byId.set(c.id, { type: "spec", status: "active", risk: "safe", ...byId.get(c.id), ...c } as Case);
  }
  if (!errors.length || added + updated) p.saveCases([...byId.values()]);
  return { added, updated, total: byId.size, errors, warns };
}

export function aCaseList(a: { project?: string; type?: "spec" | "probe"; status?: string; area?: string; limit?: number }) {
  const p = proj(a.project);
  let l = p.cases();
  if (a.type) l = l.filter((c) => c.type === a.type);
  if (a.status) l = l.filter((c) => (c.status ?? "active") === a.status);
  if (a.area) l = l.filter((c) => (c.area ?? "").includes(a.area!));
  return { total: l.length, cases: l.slice(0, a.limit ?? 50).map((c) => ({ id: c.id, type: c.type, event: c.event, status: c.status ?? "active", risk: c.risk, title: c.title, source_ref: c.source_ref, steps: c.steps.length })) };
}

export function aCaseSetStatus(a: { project?: string; ids: string[]; status: "active" | "blocked" | "na"; reason?: string }) {
  const p = proj(a.project);
  if (a.status !== "active" && !a.reason) throw new Error("blocked/na 로 바꾸려면 reason(근거)이 필요합니다.");
  const all = p.cases().map((c) => (a.ids.includes(c.id) ? { ...c, status: a.status, reason: a.status === "active" ? undefined : a.reason } : c));
  p.saveCases(all);
  return { changed: all.filter((c) => a.ids.includes(c.id)).map((c) => c.id) };
}

export const aCoverage = (a: { project?: string }) => coverage(proj(a.project));

export async function aRoundStart(a: StartOpts & { project?: string; open?: boolean }) {
  const p = proj(a.project);
  const pre = precheck(p, a);
  if (!pre.ok) return pre.decision ? pre.decision : { error: pre.error };
  const dash = ensureDashboard(p);
  const { id, done } = await startRound(p, a);
  liveRounds.set(p.root + id, done.catch(() => {}));
  if (a.open) Bun.spawn(["open", dash.url], { stdout: "ignore", stderr: "ignore" });
  const m = p.rounds().find((r) => r.id === id)!;
  return {
    round: id, started: true, scope: m.scope, cases: m.caseCount, driver: m.driver, data: m.data.decision,
    dashboard: dash.url,
    pending_feedback: m.pendingFeedback ?? [],
    message: `${id} 시작. 진행은 e2e_round_status 로 확인(실시간 화면: ${dash.url}). 회차가 끝나기 전에는 앱 코드·테스트 케이스를 고치지 마세요 — 사용자 요청은 e2e_feedback 으로 받아 다음 회차에 적용합니다.`,
  };
}

export async function aRoundStatus(a: { project?: string; wait_seconds?: number }) {
  const p = proj(a.project);
  const deadline = Date.now() + Math.min(a.wait_seconds ?? 0, 90) * 1000;
  let run = runningRound(p);
  while (run && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    run = runningRound(p);
  }
  const rounds = p.rounds();
  const cur = run ?? rounds[rounds.length - 1];
  if (!cur) return { round: null, message: "회차가 없습니다." };
  const results = p.readJson<any[]>(`rounds/${cur.id}/results.json`, []);
  const cnt: Record<string, number> = {};
  for (const r of results) cnt[r.status] = (cnt[r.status] ?? 0) + 1;
  let events: any[] = [];
  try {
    events = readFileSync(p.p("rounds", cur.id, "events.ndjson"), "utf8").trim().split("\n").slice(-6).map((l) => JSON.parse(l));
  } catch {}
  return {
    round: cur.id, status: cur.status, running: !!run, done: results.length, total: cur.caseCount, counts: cnt,
    failing_so_far: results.filter((r) => r.status === "FAIL").slice(0, 8).map((r) => `${r.id}: ${String(r.reason).slice(0, 100)}`),
    last_events: events.map((e) => `${e.type}${e.case ? " " + e.case : ""}${e.status ? " " + e.status : ""}`),
    dashboard: dashboards.get(p.root)?.url,
    tainted: cur.tainted, error: cur.error,
    next: run ? "진행 중 — 회차가 끝날 때까지 코드/케이스 수정 금지" : "끝났습니다 → e2e_round_report 로 결과 확인",
  };
}

export function aRoundStop(a: { project?: string }) {
  const p = proj(a.project);
  if (!runningRound(p)) return { stopped: false, message: "진행 중인 회차가 없습니다." };
  stopRound(p);
  return { stopped: true, message: "중단을 요청했습니다. 진행 중인 케이스가 끝나면 멈춥니다." };
}

export function aRoundReport(a: { project?: string; round?: string; format?: "md" | "json" | "paths" }) {
  const p = proj(a.project);
  const rounds = p.rounds().filter((r) => r.status !== "running");
  const r = a.round ? rounds.find((x) => x.id === a.round) : rounds[rounds.length - 1];
  if (!r) return { error: "끝난 회차가 없습니다." };
  const paths = { html: p.p("rounds", r.id, "report.html"), md: p.p("rounds", r.id, "report.md"), json: p.p("rounds", r.id, "report.json"), dashboard: dashboards.get(p.root)?.url };
  if (a.format === "paths") return { round: r.id, ...paths, human: "사람용: report.html (영상·스크린샷 포함, 브라우저로 열기)", ai: "AI용: report.md(요약)·report.json(전체)" };
  if (a.format === "json") return JSON.parse(readFileSync(paths.json, "utf8"));
  return { round: r.id, markdown: readFileSync(paths.md, "utf8"), human_report: paths.html };
}

export const aCompleteCheck = (a: { project?: string }) => completeCheck(proj(a.project));

export const aFeedback = (a: { project?: string; text: string; apply?: "next" | "now"; mode?: "restart" | "in-flow"; cases?: Case[] }) => addFeedback(proj(a.project), a);
export const aFeedbackResolve = (a: { project?: string; ids: string[]; note?: string }) => ({ resolved: resolveFeedback(proj(a.project), a.ids, a.note).map((f) => f.id) });

export function aDashboard(a: { project?: string; open?: boolean }) {
  const p = proj(a.project);
  const d = ensureDashboard(p);
  if (a.open) Bun.spawn(["open", d.url], { stdout: "ignore", stderr: "ignore" });
  return { url: d.url };
}

export function aStatus(a: { project?: string }) {
  const p = proj(a.project);
  if (!p.initialized) return { initialized: false, next: "e2e_doctor → e2e_init 부터 시작" };
  const cfg = p.config();
  const cases = p.cases();
  const run = runningRound(p);
  const rounds = p.rounds();
  const gate = completeCheck(p);
  const pending = p.feedback().filter((f) => f.status === "pending");
  const noSource = p.sources().length === 0;
  let next: string;
  if (noSource) next = "근거 자료 등록: 기획서/디자인/기능정의서(e2e_source_add). 없으면 사이트를 live-site 로 등록하고 e2e_discover";
  else if (!cases.length) next = "케이스 만들기: e2e_discover(사이트 전수 탐색) 및/또는 e2e_case_upsert(문서 기반)";
  else if (run) next = `${run.id} 진행 중 — e2e_round_status. 수정 금지`;
  else if (!rounds.length) next = "e2e_round_start 로 1회차 시작(데이터 초기화 여부를 사용자에게 먼저 확인)";
  else if (gate.complete) next = "완료 — 모든 이슈 0";
  else next = gate.next;
  return {
    initialized: true, baseUrl: cfg.baseUrl, driver: cfg.driver, dataPolicy: cfg.data.policy,
    sources: p.sources().map((s) => `${s.id} ${s.kind} ${s.title}`),
    cases: { total: cases.length, spec: cases.filter((c) => c.type === "spec").length, probe: cases.filter((c) => c.type === "probe").length },
    rounds: rounds.length, running: run?.id ?? null, trend: trend(p).map((t) => `${t.round}:${t.issues}`).join(" → "),
    pending_feedback: pending.map((f) => `${f.id} (${f.appliesFrom}부터) ${f.text.slice(0, 60)}`),
    complete: gate.complete, next,
  };
}
