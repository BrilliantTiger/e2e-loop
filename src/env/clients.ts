// MCP 클라이언트(Claude Code, Codex 등) 감지와 e2e-loop 자동 등록.
import { join } from "node:path";
import { run, which, type Env } from "./detect.ts";
import { tx } from "../i18n.ts";

export type ClientId = "claude" | "codex";

export interface ClientState {
  id: ClientId;
  name: string;
  bin: string | null;
  registered: boolean | null;
  /** 등록돼 있으면 그 명령과 인자(`mcp get` 의 command·args 줄). 읽지 못하면 없음 */
  registeredCommand?: string;
  /** 컴퓨터 제어 MCP 가 목록에 보이면 true. 안 보이면 null(내장 기능은 목록에 안 나올 수 있어 "없음"으로 단정하지 않는다) */
  computerUse: boolean | null;
}

export interface RegisterResult {
  client: ClientId;
  action: "added" | "updated" | "already" | "skipped" | "planned" | "failed";
  command?: string[];
  detail: string;
}

export const SERVER_NAME = "e2e-loop";

/** MCP 서버를 실행하는 명령: bun <패키지>/src/mcp.ts */
export function serverCommand(): string[] {
  const bun = Bun.which("bun") ?? process.execPath;
  return [bun, join(import.meta.dir, "../mcp.ts")];
}

/** `claude mcp get`(Command:/Args:)·`codex mcp get`(command:/args:) 출력에서 등록된 명령과 인자를 읽는다 */
export function registeredCommandOf(out: string): string | undefined {
  const cmd = /^\s*command:[ \t]*(.+)$/im.exec(out)?.[1]?.trim();
  if (!cmd) return undefined;
  const args = /^\s*args:[ \t]*(.*)$/im.exec(out)?.[1]?.trim() ?? "";
  return [cmd, args].filter(Boolean).join(" ");
}

export async function detectClients(env: Env = process.env): Promise<ClientState[]> {
  const out: ClientState[] = [];
  const claude = which("claude", env);
  if (claude) {
    const got = await run([claude, "mcp", "get", SERVER_NAME], { env, timeoutMs: 30000 });
    const list = await run([claude, "mcp", "list"], { env, timeoutMs: 60000 });
    out.push({ id: "claude", name: "Claude Code", bin: claude, registered: got.code === 0, registeredCommand: got.code === 0 ? registeredCommandOf(got.out) : undefined, computerUse: list.code === 0 && /computer-use/i.test(list.out) ? true : null });
  } else out.push({ id: "claude", name: "Claude Code", bin: null, registered: null, computerUse: null });

  const codex = which("codex", env);
  if (codex) {
    const got = await run([codex, "mcp", "get", SERVER_NAME], { env, timeoutMs: 30000 });
    const list = await run([codex, "mcp", "list"], { env, timeoutMs: 30000 });
    out.push({ id: "codex", name: "Codex", bin: codex, registered: got.code === 0, registeredCommand: got.code === 0 ? registeredCommandOf(got.out) : undefined, computerUse: list.code === 0 && /computer-use/i.test(list.out) ? true : null });
  } else out.push({ id: "codex", name: "Codex", bin: null, registered: null, computerUse: null });
  return out;
}

/** 감지된 모든 클라이언트에 e2e-loop 를 등록한다(이미 있으면 건너뜀). */
export async function registerE2eLoop(opts: { env?: Env; dryRun?: boolean } = {}): Promise<RegisterResult[]> {
  const env = opts.env ?? process.env;
  const server = serverCommand();
  const results: RegisterResult[] = [];
  for (const c of await detectClients(env)) {
    if (!c.bin) {
      results.push({ client: c.id, action: "skipped", detail: tx(`${c.name} 가 설치되어 있지 않아 건너뜀`, `${c.name} is not installed, so it is skipped`) });
      continue;
    }
    // 등록은 있는데 명령·인자가 지금 설치와 다르면(저장소를 옮기거나 다시 받음) 옛 등록을 지우고 다시 등록한다.
    // 등록 내용을 읽지 못하면 그대로 둔다
    const stale = !!c.registered && !!c.registeredCommand && c.registeredCommand !== server.join(" ");
    if (c.registered && !stale) {
      results.push({ client: c.id, action: "already", detail: tx(`${c.name} 에 이미 등록되어 있음`, `Already registered in ${c.name}`) });
      continue;
    }
    const cmd = c.id === "claude" ? [c.bin, "mcp", "add", SERVER_NAME, "-s", "user", "--", ...server] : [c.bin, "mcp", "add", SERVER_NAME, "--", ...server];
    const remove = c.id === "claude" ? [c.bin, "mcp", "remove", SERVER_NAME, "-s", "user"] : [c.bin, "mcp", "remove", SERVER_NAME];
    if (opts.dryRun) {
      results.push({ client: c.id, action: "planned", command: cmd, detail: stale ? tx(`${c.name} 의 옛 등록(${c.registeredCommand})을 지우고 다시 등록할 예정(dry-run)`, `Will remove the old registration in ${c.name} (${c.registeredCommand}) and register again (dry-run)`) : tx(`${c.name} 에 등록할 예정(dry-run)`, `Will register in ${c.name} (dry-run)`) });
      continue;
    }
    if (stale) await run(remove, { env, timeoutMs: 60000 });
    const r = await run(cmd, { env, timeoutMs: 60000 });
    results.push(
      r.code === 0
        ? { client: c.id, action: stale ? "updated" : "added", command: cmd, detail: stale ? tx(`${c.name} 의 옛 등록(${c.registeredCommand})을 지우고 다시 등록했다. 새 세션부터 바뀐 경로로 뜬다.`, `Removed the old registration in ${c.name} (${c.registeredCommand}) and registered again. New sessions start it from the new path.`) : tx(`${c.name} 에 등록했다. 새 세션부터 e2e_* 도구가 보인다.`, `Registered in ${c.name}. The e2e_* tools show from the next new session.`) }
        : { client: c.id, action: "failed", command: cmd, detail: tx(`${c.name} 등록 실패: ${r.out.slice(-200)}`, `Registration in ${c.name} failed: ${r.out.slice(-200)}`) },
    );
  }
  return results;
}
