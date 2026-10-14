// 브라우저 밖 OS 창(인쇄 창, API 로 가로챌 수 없는 파일 선택 창 등)을 컴퓨터 제어 도구가 맡는 케이스를 테스트 전에 점검한다.
// 다운로드와 파일 올리기는 Playwright 와 Ego 의 API 가 OS 창 없이 직접 처리하므로 보통 해당 없다.
// 테스터가 케이스에 태그 os-window 를 단 것만 이 점검의 대상이다.
import type { Case } from "../types.ts";
import type { Project } from "../store.ts";
import { detectClients } from "../env/clients.ts";
import { macPermissions, type Env } from "../env/detect.ts";

export const OS_SKIP_PREFIX = "[OS 창] ";

export interface OsPolicy {
  decision: "allow" | "skip";
  decidedAt: string;
  /** auto = 컴퓨터 제어가 동작해서 자동으로 포함 */
  by: "auto" | "user";
}

export const readOsPolicy = (p: Project) => p.readJson<OsPolicy | null>("os-policy.json", null);
export const isOsCase = (c: Case) => (c.tags ?? []).includes("os-window");
export const osCases = (p: Project): Case[] => p.cases().filter((c) => (c.status ?? "active") === "active" && isOsCase(c));

/** 정책을 케이스에 반영한다: 스킵이면 skipReason 을 달고, 아니면 우리가 단 skipReason 만 걷는다. */
export function applyOsPolicy(p: Project) {
  const pol = readOsPolicy(p);
  const cases = p.cases();
  let skipped = 0;
  let cleared = 0;
  for (const c of cases) {
    const mine = c.skipReason?.startsWith(OS_SKIP_PREFIX);
    const want = pol?.decision === "skip" && isOsCase(c);
    if (want && !c.skipReason) {
      c.skipReason = `${OS_SKIP_PREFIX}브라우저 밖 OS 창을 컴퓨터 제어 도구로 처리할 수 없어 사용자가 스킵을 선택함`;
      skipped++;
    } else if (!want && mine) {
      delete c.skipReason;
      cleared++;
    }
  }
  if (skipped || cleared) p.saveCases(cases);
  return { skipped, cleared };
}

export async function computerControlReady(env: Env = process.env): Promise<{ ready: boolean; seenIn: string[]; accessibility: boolean | null; why: string[] }> {
  const clients = await detectClients(env);
  const seenIn = clients.filter((c) => c.computerUse === true).map((c) => c.name);
  const perm = await macPermissions(env);
  const why: string[] = [];
  if (!seenIn.length) why.push("클라이언트(Claude Code, Codex)의 도구 목록에서 컴퓨터 제어를 확인하지 못함");
  if (perm.accessibility === false) why.push("macOS 접근성 권한이 허용되지 않음 (시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용)");
  if (perm.screenRecording === false) why.push("macOS 화면 녹화 권한이 허용되지 않음 (시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음)");
  return { ready: why.length === 0, seenIn, accessibility: perm.accessibility, why };
}

/** 라운드를 시작하기 전에 OS 창 결정이 남아 있는지 */
export async function osPending(p: Project): Promise<{ pending: boolean; count: number }> {
  const n = osCases(p).length;
  return { pending: n > 0 && !readOsPolicy(p), count: n };
}

export async function osCheck(p: Project, a: { decision?: "allow" | "skip"; env?: Env } = {}) {
  const cases = osCases(p);
  const list = cases.map((c) => ({ id: c.id, title: c.title, screen: c.screen }));
  if (!cases.length) {
    if (readOsPolicy(p)) {
      p.writeJson("os-policy.json", null);
      applyOsPolicy(p);
    }
    return { needed: false, cases: 0, message: "브라우저 밖 OS 창을 거치는 케이스(태그 os-window)가 없습니다. 다운로드·파일 올리기는 브라우저 API 가 직접 처리하므로 컴퓨터 제어 도구는 필요 없습니다." };
  }
  const save = (decision: "allow" | "skip", by: "auto" | "user") => {
    p.writeJson("os-policy.json", { decision, decidedAt: new Date().toISOString(), by } satisfies OsPolicy);
    return applyOsPolicy(p);
  };
  const ready = await computerControlReady(a.env);
  if (a.decision) {
    const r = save(a.decision, "user");
    return {
      needed: true, cases: list.length, decision: a.decision, computer_control: ready,
      message: a.decision === "allow" ? `허용: OS 창 케이스 ${list.length}건을 포함해 진행합니다. 컴퓨터 제어 권한이 필요하면 아래 안내대로 허용하세요.` : `스킵: OS 창 케이스 ${r.skipped}건을 SKIP 으로 둡니다(이슈로 세지 않음).`,
      permission_help: a.decision === "allow" && !ready.ready ? ready.why : undefined,
    };
  }
  if (ready.ready) {
    save("allow", "auto");
    return { needed: true, cases: list.length, decision: "allow", computer_control: ready, message: `컴퓨터 제어 도구가 동작합니다(${ready.seenIn.join(", ")}). OS 창 케이스 ${list.length}건을 포함해 진행합니다.` };
  }
  return {
    needed: true, cases: list.slice(0, 20), total: list.length, computer_control: ready,
    needs_decision: true,
    question: `브라우저 밖 OS 창을 거치는 케이스 ${list.length}건이 있습니다. 컴퓨터 제어 도구가 아직 동작하지 않습니다. 권한을 허용하고 포함해 진행할까요, 스킵할까요? (사용자에게 물어보고 e2e_os_check 의 decision 으로 전달)`,
    options: [
      { value: "allow", meaning: "허용: 아래 권한 안내대로 컴퓨터 제어 권한을 허용하고, 이 케이스들을 포함해 진행한다." },
      { value: "skip", meaning: "스킵: 이 케이스들을 SKIP 으로 두고 진행한다. 스킵은 이슈로 세지 않는다." },
    ],
    permission_help: ready.why,
  };
}
