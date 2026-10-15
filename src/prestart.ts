// 라운드 시작 전 질문(데이터 초기화·라운드 상한·로그인/테스트 계정·화면 노출 안내)과 테스트 계정 기록.
import type { Project } from "./store.ts";
import { nowIso } from "./store.ts";
import type { Step } from "./types.ts";

export const NOTICE = "영상과 스크린샷에 화면이 그대로 남습니다. 테스트 데이터와 테스트 계정만 입력하세요.";

export interface AccountPlan {
  mode: "none" | "provided" | "create";
  /** create 일 때 만드는 방법: 화면 · API · DB 스크립트 */
  method?: "ui" | "api" | "db-script";
  note?: string;
}

export interface Prestart {
  maxRoundsAnswered?: boolean;
  login?: "none" | "provided";
  account?: AccountPlan;
  noticeAcknowledged?: boolean;
  /** 코멘트 자동 응답 질문에 답했는가(꼭 답해야 하는 질문은 아니다) */
  responderAnswered?: boolean;
  updatedAt?: string;
}

export interface TestAccount {
  id: string;
  username?: string;
  note?: string;
  method?: string;
  /** 종료 때 이 셸 명령으로 지운다(환경변수 E2E_ACCOUNT_ID, E2E_ACCOUNT_USERNAME). 없으면 사람이 방법대로 지운다 */
  deleteCommand?: string;
  createdAt: string;
  deletedAt?: string;
}

export const readPrestart = (p: Project) => p.readJson<Prestart>("prestart.json", {});
export const readAccounts = (p: Project) => p.readJson<TestAccount[]>("accounts.json", []);

export interface PrestartAnswers {
  dataPolicy?: "ask" | "reset" | "keep";
  resetCommand?: string;
  resetCwd?: string;
  maxRounds?: number;
  login?: "none" | "provided";
  loginSetupSteps?: Step[];
  loginLocalStorage?: Record<string, string>;
  account?: AccountPlan;
  acknowledged?: boolean;
  /** 현황판 코멘트에 일회용 AI 로 자동 응답할지(기본 off). answer=읽기·코드 분석만, fix=오너가 수정 지시한 것은 코드까지 */
  commentResponder?: "off" | "answer" | "fix";
  responderAgent?: "claude" | "codex";
}

export function prestartStatus(p: Project) {
  const cfg = p.config();
  const st = readPrestart(p);
  const questions: { id: string; ask: string }[] = [];
  if (cfg.data.policy === "ask") questions.push({ id: "data", ask: "데이터를 초기화할까요? 기본은 '안 함'(keep)입니다. 초기화하려면(reset) 초기화 명령을 프로젝트마다 한 번 등록해야 합니다." });
  else if (cfg.data.policy === "reset" && !cfg.data.resetCommand) questions.push({ id: "reset-command", ask: "초기화하기로 했는데 초기화 명령이 없습니다. 실행할 셸 명령을 받아 resetCommand 로 등록하세요." });
  if (!st.maxRoundsAnswered) questions.push({ id: "max-rounds", ask: `라운드 상한은 몇 번으로 할까요? 기본은 10번입니다(현재 ${cfg.maxRounds}). 전체 라운드만 셉니다.` });
  if (!st.login) questions.push({ id: "login", ask: "테스트하려면 로그인이 필요한가요? 필요 없으면 none, 필요하면 provided 로 하고 로그인 방법(스텝 또는 토큰)을 받으세요." });
  else if (st.login === "provided" && !(cfg.auth?.setupSteps?.length || cfg.auth?.localStorage || cfg.auth?.cookies?.length)) questions.push({ id: "login-details", ask: "로그인이 필요하다고 했는데 로그인 방법이 없습니다. 로그인 스텝(loginSetupSteps) 또는 토큰(loginLocalStorage)을 받아 등록하세요. 테스트 계정만 쓰게 하세요." });
  if (!st.account) questions.push({ id: "account", ask: "테스트 계정이 필요한가요? none(필요 없음) / provided(사용자가 줌) / create(만들어 달라고 함). create 면 먼저 만드는 방법(화면·API·DB 스크립트)을 묻고 method 로 기록하세요." });
  else if (st.account.mode === "create" && !st.account.method) questions.push({ id: "account-method", ask: "계정을 만들라고 했습니다. 만드는 방법을 먼저 물으세요: 화면(ui) · API(api) · DB 스크립트(db-script)." });
  if (!st.noticeAcknowledged) questions.push({ id: "notice", ask: `사용자에게 이 안내를 한 뒤 acknowledged=true 로 기록하세요: “${NOTICE}”` });
  // 라운드 시작을 막지는 않지만 시작 전에 한 번 묻는 것(코멘트에 일회용 AI 를 자동으로 실행하는 것이라 켜기 전에 사용자 확인이 필요하다)
  const optional: { id: string; ask: string }[] = [];
  if (!st.responderAnswered) optional.push({ id: "comment-responder", ask: "현황판 코멘트에 AI 가 자동으로 응답하게 할까요? off(기본, 꺼짐) / answer(코드를 읽고 분석해 답만 함, 수정 안 함) / fix(answer + 오너가 현황판에서 '수정 지시'로 보낸 것은 코드까지 고침). 켜면 코멘트가 달릴 때마다 일회용 AI(claude/codex)가 실행되어 사용량이 듭니다(호출 횟수 상한은 없음). 사용자가 켜겠다고 한 경우에만 commentResponder 로 기록하세요." });
  return { ready: questions.length === 0, questions, optional, responder: cfg.responder.mode, notice: NOTICE, answered: { data: cfg.data.policy, resetCommand: cfg.data.resetCommand ?? null, maxRounds: st.maxRoundsAnswered ? cfg.maxRounds : null, login: st.login ?? null, account: st.account ?? null, noticeAcknowledged: !!st.noticeAcknowledged } };
}

export function aPrestart(p: Project, a: PrestartAnswers) {
  p.ensure();
  const cfg = p.config();
  const st = readPrestart(p);
  const err: string[] = [];
  if (a.dataPolicy) cfg.data.policy = a.dataPolicy;
  if (a.resetCommand !== undefined) cfg.data.resetCommand = a.resetCommand || undefined;
  if (a.resetCwd) cfg.data.resetCwd = a.resetCwd;
  if (a.maxRounds !== undefined) {
    if (!Number.isInteger(a.maxRounds) || a.maxRounds < 1) err.push("maxRounds 는 1 이상의 정수여야 합니다.");
    else {
      cfg.maxRounds = a.maxRounds;
      st.maxRoundsAnswered = true;
    }
  }
  if (a.login) st.login = a.login;
  if (a.loginSetupSteps) cfg.auth = { ...(cfg.auth ?? {}), setupSteps: a.loginSetupSteps };
  if (a.loginLocalStorage) cfg.auth = { ...(cfg.auth ?? {}), localStorage: a.loginLocalStorage };
  if (a.login === "none") st.login = "none";
  if (a.account) st.account = a.account;
  if (a.acknowledged) st.noticeAcknowledged = true;
  if (a.commentResponder) cfg.responder = { ...cfg.responder, mode: a.commentResponder };
  if (a.responderAgent) cfg.responder = { ...cfg.responder, agent: a.responderAgent };
  if (a.commentResponder) st.responderAnswered = true;
  st.updatedAt = nowIso();
  p.saveConfig(cfg);
  p.writeJson("prestart.json", st);
  const s = prestartStatus(p);
  return {
    ...s, errors: err,
    next: s.ready ? "시작 전 질문을 모두 마쳤습니다. e2e_round_start 로 라운드를 시작하세요." : "남은 질문을 사용자에게 한 번에 묻고 답을 e2e_prestart 로 기록하세요.",
  };
}

// ---------- 테스트 계정 ----------

async function sh(cmd: string, env: Record<string, string>, cwd: string) {
  const proc = Bun.spawn(["/bin/sh", "-lc", cmd], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 120000);
  const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out: (o + e).trim().slice(-500) };
}

export async function aAccount(
  p: Project,
  a: { action: "record" | "list" | "cleanup" | "mark_deleted"; account?: { id: string; username?: string; note?: string; deleteCommand?: string }; ids?: string[] },
) {
  p.ensure();
  const list = readAccounts(p);
  const st = readPrestart(p);
  if (a.action === "record") {
    if (!a.account?.id) throw new Error("account.id 가 필요합니다.");
    if (st.account?.mode === "create" && !st.account.method) throw new Error("계정을 만드는 방법(화면·API·DB 스크립트)을 먼저 e2e_prestart 의 account.method 로 기록하세요.");
    if (list.some((x) => x.id === a.account!.id)) throw new Error(`이미 기록된 계정입니다: ${a.account.id}`);
    list.push({ ...a.account, method: st.account?.method, createdAt: nowIso() });
    p.writeJson("accounts.json", list);
    return { recorded: a.account.id, pending_cleanup: list.filter((x) => !x.deletedAt).length, message: "테스트 계정을 기록했습니다. 종료 때 지웁니다." };
  }
  if (a.action === "mark_deleted") {
    const ids = a.ids ?? [];
    for (const x of list) if (ids.includes(x.id) && !x.deletedAt) x.deletedAt = nowIso();
    p.writeJson("accounts.json", list);
    return { marked: ids, pending_cleanup: list.filter((x) => !x.deletedAt).length };
  }
  if (a.action === "cleanup") {
    const done: string[] = [];
    const failed: { id: string; why: string }[] = [];
    const manual: { id: string; username?: string; how: string }[] = [];
    for (const x of list) {
      if (x.deletedAt) continue;
      if (!x.deleteCommand) {
        manual.push({ id: x.id, username: x.username, how: `계정을 만든 방법(${x.method ?? "미기록"})으로 지운 뒤 mark_deleted 로 표시하세요.` });
        continue;
      }
      const r = await sh(x.deleteCommand, { E2E_ACCOUNT_ID: x.id, E2E_ACCOUNT_USERNAME: x.username ?? "" }, p.root);
      if (r.code === 0) {
        x.deletedAt = nowIso();
        done.push(x.id);
      } else failed.push({ id: x.id, why: `종료 코드 ${r.code}: ${r.out}` });
    }
    p.writeJson("accounts.json", list);
    return { deleted: done, failed, manual, pending_cleanup: list.filter((x) => !x.deletedAt).length };
  }
  return { accounts: list.map((x) => ({ id: x.id, username: x.username, method: x.method, createdAt: x.createdAt, deleted: !!x.deletedAt })), pending_cleanup: list.filter((x) => !x.deletedAt).length };
}
