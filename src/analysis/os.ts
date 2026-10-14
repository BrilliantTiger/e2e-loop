// 브라우저 밖 OS 창(다운로드·파일 선택)을 컴퓨터 제어 도구가 맡는 케이스를 테스트 전에 점검한다.
// Chrome 계열은 Playwright 가 파일 선택·다운로드를 OS 창 없이 직접 처리하므로 해당 없음. Ego 는 OS 창이 뜬다.
import type { Case, DriverName } from "../types.ts";
import type { Project } from "../store.ts";
import { pickDriverName } from "../drivers/index.ts";
import { detectClients } from "../env/clients.ts";
import { macPermissions, type Env } from "../env/detect.ts";

export const OS_SKIP_PREFIX = "[OS 창] ";

export interface OsPolicy {
  decision: "allow" | "skip";
  driver: string;
  decidedAt: string;
  /** auto = 컴퓨터 제어가 동작해서 자동으로 포함 */
  by: "auto" | "user";
}

export const readOsPolicy = (p: Project) => p.readJson<OsPolicy | null>("os-policy.json", null);
export const driverHasFiles = (driver: string) => driver !== "ego";

export const osCases = (p: Project): Case[] => p.cases().filter((c) => (c.status ?? "active") === "active" && (c.needs_os || (c.tags ?? []).includes("os-window")));

/** 정책을 케이스에 반영한다: 스킵이면 skipReason 을 달고, 아니면 우리가 단 skipReason 만 걷는다. */
export function applyOsPolicy(p: Project) {
  const pol = readOsPolicy(p);
  const cases = p.cases();
  let skipped = 0;
  let cleared = 0;
  for (const c of cases) {
    const mine = c.skipReason?.startsWith(OS_SKIP_PREFIX);
    const want = pol?.decision === "skip" && !driverHasFiles(pol.driver) && (c.needs_os || (c.tags ?? []).includes("os-window"));
    if (want && !c.skipReason) {
      c.skipReason = `${OS_SKIP_PREFIX}브라우저 밖 OS 창(다운로드·파일 선택)을 컴퓨터 제어 도구로 처리할 수 없어 사용자가 스킵을 선택함`;
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
export async function osPending(p: Project, want?: DriverName): Promise<{ pending: boolean; driver?: string; count: number }> {
  let driver: string;
  try {
    driver = await pickDriverName(p.config(), want);
  } catch {
    return { pending: false, count: 0 };
  }
  const n = osCases(p).length;
  if (driverHasFiles(driver) || n === 0) return { pending: false, driver, count: n };
  const pol = readOsPolicy(p);
  return { pending: !pol || pol.driver !== driver, driver, count: n };
}

export async function osCheck(p: Project, a: { driver?: DriverName; decision?: "allow" | "skip"; env?: Env; /** 시험용: 설치 여부와 상관없이 이 브라우저로 간주 */ _driver?: string } = {}) {
  const driver = a._driver ?? (await pickDriverName(p.config(), a.driver));
  const cases = osCases(p);
  const list = cases.map((c) => ({ id: c.id, title: c.title, screen: c.screen }));
  if (driverHasFiles(driver) || !cases.length) {
    const old = readOsPolicy(p);
    if (old) {
      p.writeJson("os-policy.json", null);
      applyOsPolicy(p);
    }
    return {
      needed: false, driver, cases: list.length,
      message: cases.length
        ? `${driver} 는 파일 선택·다운로드를 OS 창 없이 직접 처리합니다(Playwright). 컴퓨터 제어 도구는 필요 없습니다. 파일 관련 케이스 ${cases.length}건은 그대로 포함됩니다.`
        : "브라우저 밖 OS 창이 필요한 케이스가 없습니다.",
    };
  }
  const now = new Date().toISOString();
  const save = (decision: "allow" | "skip", by: "auto" | "user") => {
    p.writeJson("os-policy.json", { decision, driver, decidedAt: now, by } satisfies OsPolicy);
    return applyOsPolicy(p);
  };
  const ready = await computerControlReady(a.env);
  if (a.decision) {
    const r = save(a.decision, "user");
    return {
      needed: true, driver, cases: list.length, decision: a.decision, computer_control: ready,
      message: a.decision === "allow" ? `허용: OS 창 케이스 ${list.length}건을 포함해 진행합니다. 컴퓨터 제어 권한이 필요하면 아래 안내대로 허용하세요.` : `스킵: OS 창 케이스 ${r.skipped}건을 SKIP 으로 둡니다(이슈로 세지 않음).`,
      permission_help: a.decision === "allow" && !ready.ready ? ready.why : undefined,
    };
  }
  if (ready.ready) {
    save("allow", "auto");
    return { needed: true, driver, cases: list.length, decision: "allow", computer_control: ready, message: `컴퓨터 제어 도구가 동작합니다(${ready.seenIn.join(", ")}). OS 창 케이스 ${list.length}건을 포함해 진행합니다.` };
  }
  return {
    needed: true, driver, cases: list.slice(0, 20), total: list.length, computer_control: ready,
    needs_decision: true,
    question: `${driver} 로 테스트하면 다운로드·파일 선택 케이스 ${list.length}건이 브라우저 밖 OS 창을 거칩니다. 컴퓨터 제어 도구가 아직 동작하지 않습니다. 권한을 허용하고 포함해 진행할까요, 스킵할까요? (사용자에게 물어보고 e2e_os_check 의 decision 으로 전달)`,
    options: [
      { value: "allow", meaning: "허용: 아래 권한 안내대로 컴퓨터 제어 권한을 허용하고, 이 케이스들을 포함해 진행한다." },
      { value: "skip", meaning: "스킵: 이 케이스들을 SKIP 으로 두고 진행한다. 스킵은 이슈로 세지 않는다." },
    ],
    permission_help: ready.why,
  };
}
