// 테스터 세션: 세션 시작(새 세션 / 여기서), 한 세션 유지, 최소 진행 조건 검사.
// 상태는 .e2e/session.json, .e2e/intake.json 에 둔다.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Source } from "./types.ts";
import { Project, nowIso } from "./store.ts";
import { run, which, type Env } from "./env/detect.ts";
import { detectClients } from "./env/clients.ts";

export type AgentName = "claude" | "codex";
export type MaterialKind = "plan" | "design" | "feature-spec" | "code";

export interface Material {
  kind: MaterialKind;
  /** 파일·폴더 경로 또는 URL(Figma 등) */
  location: string;
  title?: string;
  sections?: string[];
}

export interface LaunchRecord {
  via: "orca" | "manual";
  agent: AgentName;
  command: string;
  at: string;
  terminal?: string;
}

export interface SessionState {
  mode: "here" | "new";
  createdAt: string;
  launch?: LaunchRecord;
  /** 새 세션을 다시 띄우기 전의 기록 */
  history: LaunchRecord[];
}

export interface IntakeState {
  baseUrl?: string;
  /** 사용자가 시트를 확인한 뒤 시작하기를 원하면 true (기본은 한 번 보여 주고 바로 시작) */
  sheetConfirm?: boolean;
  updatedAt: string;
}

const KIND_LABEL: Record<MaterialKind, string> = { plan: "기획서", design: "디자인", "feature-spec": "기능정의서", code: "코드" };
const EVIDENCE_KINDS = new Set<string>(["plan", "design", "feature-spec", "code"]);

export const readSession = (p: Project) => p.readJson<SessionState | null>("session.json", null);
export const readIntake = (p: Project) => p.readJson<IntakeState>("intake.json", { updatedAt: "" });

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ---------- 웹 주소 / 근거 ----------

export interface UrlCheck {
  value?: string;
  ok: boolean;
  status?: number;
  reason?: string;
}

/** 웹 주소가 실제로 열리는지 확인한다. 응답 코드가 400 미만이거나 로그인 필요(401·403)면 열리는 것으로 본다. */
export async function checkWebUrl(raw: string | undefined, timeoutMs = 8000): Promise<UrlCheck> {
  if (!raw) return { ok: false, reason: "웹 주소가 없습니다." };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { value: raw, ok: false, reason: "주소 형식이 올바르지 않습니다(예: http://localhost:3000)." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { value: raw, ok: false, reason: "http 또는 https 주소만 쓸 수 있습니다." };
  try {
    const res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    if (res.status < 400 || res.status === 401 || res.status === 403) return { value: raw, ok: true, status: res.status };
    return { value: raw, ok: false, status: res.status, reason: `응답 코드 ${res.status} — 주소가 틀렸거나 사이트가 정상이 아닙니다.` };
  } catch (e: any) {
    return { value: raw, ok: false, reason: `열리지 않습니다(${e?.name === "TimeoutError" ? `${Math.round(timeoutMs / 1000)}초 안에 응답 없음` : (e?.cause?.code ?? e?.message ?? "연결 실패")}). 사이트를 실행했는지 확인하세요.` };
  }
}

const expandPath = (loc: string, root: string) => {
  const t = loc.startsWith("~/") ? resolve(homedir(), loc.slice(2)) : loc;
  return isAbsolute(t) ? t : resolve(root, t);
};

/** 근거가 쓸 수 있는지: URL 이면 형식만, 경로면 실제로 있는지. */
export function checkMaterial(m: Material, root: string): { ok: boolean; location: string; reason?: string } {
  if (!EVIDENCE_KINDS.has(m.kind)) return { ok: false, location: m.location, reason: `종류는 plan·design·feature-spec·code 중 하나여야 합니다(받은 값: ${m.kind}).` };
  if (!m.location?.trim()) return { ok: false, location: m.location ?? "", reason: "위치(경로 또는 URL)가 비어 있습니다." };
  if (/^https?:\/\//i.test(m.location)) {
    try {
      new URL(m.location);
      return { ok: true, location: m.location };
    } catch {
      return { ok: false, location: m.location, reason: "URL 형식이 올바르지 않습니다." };
    }
  }
  const abs = expandPath(m.location, root);
  if (!existsSync(abs)) return { ok: false, location: abs, reason: `이 경로에 없습니다: ${abs}` };
  return { ok: true, location: abs };
}

/** 근거로 칠 수 있는 자료(기획서·디자인·기능정의서·코드). 개발된 사이트(live-site)는 웹 주소로 이미 받으므로 근거에 세지 않는다. */
export function evidenceSources(p: Project): Source[] {
  return p.sources().filter((s) => EVIDENCE_KINDS.has(s.kind) && checkMaterial({ kind: s.kind as MaterialKind, location: s.location }, p.root).ok);
}

export interface IntakeResult {
  can_start: boolean;
  base_url: UrlCheck;
  evidence: { usable: { id: string; kind: string; title: string; location: string }[]; rejected: { kind: string; location: string; reason: string }[] };
  /** 못 채운 최소 조건 */
  missing: string[];
  /** 사용자에게 물어볼 것(필수) */
  ask_user: string[];
  /** 있으면 받아 두면 좋은 것 */
  ask_optional: string[];
  next: string;
}

/** 웹 주소와 근거를 받아 저장하고 최소 진행 조건(실행되는 웹 주소 + 근거 하나 이상)을 검사한다. */
export async function intake(p: Project, a: { baseUrl?: string; materials?: Material[]; urlTimeoutMs?: number }): Promise<IntakeResult> {
  p.ensure();
  const st = readIntake(p);
  if (a.baseUrl) {
    st.baseUrl = a.baseUrl.trim();
    st.updatedAt = nowIso();
    p.writeJson("intake.json", st);
    const cfg = p.config();
    cfg.baseUrl = st.baseUrl;
    p.saveConfig(cfg);
  }

  const rejected: IntakeResult["evidence"]["rejected"] = [];
  if (a.materials?.length) {
    const list = p.sources();
    for (const m of a.materials) {
      const c = checkMaterial(m, p.root);
      if (!c.ok) {
        rejected.push({ kind: m.kind, location: c.location, reason: c.reason! });
        continue;
      }
      if (list.some((s) => s.location === c.location && s.kind === m.kind)) continue;
      list.push({ id: "S" + String(list.length + 1).padStart(2, "0"), kind: m.kind, title: m.title ?? `${KIND_LABEL[m.kind]} ${c.location}`, location: c.location, sections: m.sections, addedAt: nowIso() });
    }
    p.writeJson("sources.json", list);
  }

  const base_url = await checkWebUrl(st.baseUrl, a.urlTimeoutMs);
  const usable = evidenceSources(p).map((s) => ({ id: s.id, kind: s.kind, title: s.title, location: s.location }));
  const missing: string[] = [];
  const ask_user: string[] = [];
  if (!base_url.value) {
    missing.push("웹 주소");
    ask_user.push("테스트할 웹 주소(실행 중인 사이트)를 알려 달라고 하세요. 필수입니다.");
  } else if (!base_url.ok) {
    missing.push("열리는 웹 주소");
    ask_user.push(`웹 주소 ${base_url.value} 를 쓸 수 없습니다. ${base_url.reason} 사이트를 실행한 뒤 맞는 주소를 다시 알려 달라고 하세요.`);
  }
  if (!usable.length) {
    missing.push("근거 자료 1개 이상");
    ask_user.push("기획서·디자인(Figma 등)·기능정의서·코드 중 하나 이상을 달라고 하세요(경로 또는 URL). 우선순위는 기획서·디자인 → 기능정의서 → 코드입니다. 하나도 없으면 시작하지 않습니다.");
  }
  const have = new Set(usable.map((u) => u.kind));
  const ask_optional = (["plan", "design", "feature-spec", "code"] as MaterialKind[]).filter((k) => !have.has(k)).map((k) => `${KIND_LABEL[k]}가 있으면 받으세요(없으면 건너뜀).`);
  for (const r of rejected) ask_user.push(`${KIND_LABEL[r.kind as MaterialKind] ?? r.kind} 를 쓸 수 없습니다: ${r.reason} 맞는 위치를 다시 받으세요.`);

  const can_start = missing.length === 0;
  return {
    can_start, base_url, evidence: { usable, rejected }, missing, ask_user, ask_optional,
    next: can_start
      ? "최소 진행 조건을 채웠습니다. 남은 자료가 있으면 한 번 더 받고, 분석과 시트 작성으로 넘어가세요."
      : "최소 진행 조건을 못 채웠습니다. 시작하지 말고 ask_user 를 사용자에게 물은 뒤 e2e_intake 를 다시 호출하세요.",
  };
}

// ---------- 테스터 세션 ----------

export interface OrcaState {
  bin: string | null;
  ready: boolean;
}

export async function orcaState(env: Env = process.env): Promise<OrcaState> {
  const bin = which("orca", env);
  if (!bin) return { bin: null, ready: false };
  const r = await run([bin, "status", "--json"], { env, timeoutMs: 15000 });
  if (r.code !== 0) return { bin, ready: false };
  try {
    return { bin, ready: JSON.parse(r.out)?.result?.runtime?.reachable === true };
  } catch {
    return { bin, ready: /reachable:\s*true/i.test(r.out) };
  }
}

/** 새 세션에서 AI 를 띄우는 명령. 프로젝트 폴더로 이동한 뒤 스킬을 따르라는 첫 지시와 함께 실행한다. */
export function agentCommand(agent: AgentName, root: string): string {
  const prompt = `e2e-loop 스킬을 따라 E2E 테스터로 일해. 대상 프로젝트: ${root}. 먼저 e2e_status 도구로 상태를 확인하고 이어서 진행해.`;
  return `cd ${q(root)} && ${agent} ${q(prompt)}`;
}

const findHandle = (v: unknown): string | undefined => {
  if (typeof v === "string") return /^term_/.test(v) ? v : undefined;
  if (v && typeof v === "object") for (const x of Object.values(v)) {
    const h = findHandle(x);
    if (h) return h;
  }
  return undefined;
};

async function pickAgent(want: AgentName | undefined, env: Env): Promise<{ agent: AgentName; warn: string[] }> {
  const clients = await detectClients(env);
  const warn: string[] = [];
  const usable = clients.filter((c) => c.bin);
  const chosen = (want && usable.find((c) => c.id === want)) || usable[0];
  if (want && !usable.find((c) => c.id === want)) warn.push(`${want} 가 설치되어 있지 않아 ${chosen ? chosen.id : "claude"} 로 대신합니다.`);
  if (!chosen) {
    warn.push("Claude Code 도 Codex 도 찾지 못했습니다. claude 를 쓴다고 보고 명령만 만듭니다.");
    return { agent: "claude", warn };
  }
  if (!chosen.registered) warn.push(`${chosen.name} 에 e2e-loop MCP 가 등록되어 있지 않습니다. 새 세션에서 e2e_* 도구가 안 보이면 'sh install.sh' 를 먼저 실행하세요.`);
  return { agent: chosen.id, warn };
}

export interface SessionStartOpts {
  mode?: "here" | "new";
  agent?: AgentName;
  /** 사용자가 새 세션을 명시했을 때만 true. 이미 세션이 있으면 기본은 그 세션을 유지한다. */
  new_session?: boolean;
  baseUrl?: string;
  materials?: Material[];
  /** true 면 Orca 로 실제로 띄우지 않고 명령만 만든다 */
  dryRun?: boolean;
  env?: Env;
  urlTimeoutMs?: number;
}

export async function sessionStart(p: Project, a: SessionStartOpts = {}) {
  const env = a.env ?? process.env;
  p.ensure();
  const existing = readSession(p);
  const withIntake = () => intake(p, { baseUrl: a.baseUrl, materials: a.materials, urlTimeoutMs: a.urlTimeoutMs });

  if (existing && !a.new_session) {
    return {
      reused: true,
      session: existing,
      message: `이미 테스터 세션이 있어 그대로 유지합니다(${existing.mode === "here" ? "이 세션" : "새 세션으로 띄운 세션"}). 새로 띄우려면 사용자가 새 세션을 명시했을 때 new_session=true 로 부르세요.`,
      intake: await withIntake(),
    };
  }

  let mode = a.mode;
  const orca = await orcaState(env);
  if (!mode) {
    if (orca.ready) mode = "new";
    else
      return {
        needs_decision: true,
        question: "테스터를 새 세션으로 띄울까요, 지금 이 세션에서 바로 진행할까요? (사용자에게 물어보고 e2e_session_start 의 mode 로 전달)",
        options: [
          { value: "new", meaning: "새 세션: MCP 가 붙은 AI 를 새 터미널에서 실행하는 명령을 드립니다. 개발 에이전트와 테스터가 분리됩니다." },
          { value: "here", meaning: "여기서: 이 세션이 테스터가 되어 바로 진행합니다." },
        ],
        orca: "Orca 를 쓸 수 없어 직접 고르게 합니다.",
      };
  }

  const now = nowIso();
  if (mode === "here") {
    const s: SessionState = { mode: "here", createdAt: existing?.createdAt ?? now, history: existing?.launch ? [...existing.history, existing.launch] : (existing?.history ?? []) };
    p.writeJson("session.json", s);
    return { started: true, mode: "here", session: s, message: "이 세션이 테스터입니다. e2e-loop 스킬의 절차를 그대로 따르세요.", intake: await withIntake() };
  }

  // 새 세션
  const intakeResult = await withIntake();
  const { agent, warn } = await pickAgent(a.agent, env);
  const command = agentCommand(agent, p.root);
  const history = existing ? [...existing.history, ...(existing.launch ? [existing.launch] : [])] : [];
  let launch: LaunchRecord;
  let launched = false;
  let message: string;
  if (orca.ready && orca.bin && !a.dryRun) {
    const base = ["terminal", "create", "--title", "e2e-loop 테스터", "--command", command, "--focus", "--json"];
    let r = await run([orca.bin, ...base, "--worktree", `path:${p.root}`], { env, timeoutMs: 30000 });
    if (r.code !== 0) r = await run([orca.bin, ...base], { env, timeoutMs: 30000 });
    if (r.code !== 0) {
      warn.push(`Orca 로 새 터미널을 만들지 못했습니다: ${r.out.slice(-200)}`);
      launch = { via: "manual", agent, command, at: now };
      message = "Orca 실행에 실패했습니다. 아래 명령을 새 터미널에서 직접 실행하게 하세요.";
    } else {
      let terminal: string | undefined;
      try {
        terminal = findHandle(JSON.parse(r.out));
      } catch {}
      launch = { via: "orca", agent, command, at: now, terminal };
      launched = true;
      message = `Orca 새 터미널에서 ${agent} 테스터 세션을 띄웠습니다. 사용자는 그 터미널에서 진행합니다. 이 세션은 개발을 맡습니다.`;
    }
  } else {
    launch = { via: "manual", agent, command, at: now };
    message = a.dryRun ? "dryRun: 실행하지 않고 명령만 만들었습니다." : `Orca 를 쓸 수 없어 명령만 드립니다. 사용자가 새 터미널에서 아래 명령을 실행하게 하세요.`;
  }
  const s: SessionState = { mode: "new", createdAt: existing?.createdAt ?? now, launch, history };
  if (!a.dryRun) p.writeJson("session.json", s);
  return { started: true, mode: "new", launched, session: s, command, message, warn, intake: intakeResult };
}
