// MCP 클라이언트(Claude Code, Codex 등) 감지와 e2e-loop 자동 등록.
import { join } from "node:path";
import { run, which, type Env } from "./detect.ts";

export type ClientId = "claude" | "codex";

export interface ClientState {
  id: ClientId;
  name: string;
  bin: string | null;
  registered: boolean | null;
  /** 컴퓨터 제어 MCP 가 목록에 보이면 true. 안 보이면 null(내장 기능은 목록에 안 나올 수 있어 "없음"으로 단정하지 않는다) */
  computerUse: boolean | null;
}

export interface RegisterResult {
  client: ClientId;
  action: "added" | "already" | "skipped" | "planned" | "failed";
  command?: string[];
  detail: string;
}

export const SERVER_NAME = "e2e-loop";

/** MCP 서버를 실행하는 명령: bun <패키지>/src/mcp.ts */
export function serverCommand(): string[] {
  const bun = Bun.which("bun") ?? process.execPath;
  return [bun, join(import.meta.dir, "../mcp.ts")];
}

export async function detectClients(env: Env = process.env): Promise<ClientState[]> {
  const out: ClientState[] = [];
  const claude = which("claude", env);
  if (claude) {
    const got = await run([claude, "mcp", "get", SERVER_NAME], { env, timeoutMs: 30000 });
    const list = await run([claude, "mcp", "list"], { env, timeoutMs: 60000 });
    out.push({ id: "claude", name: "Claude Code", bin: claude, registered: got.code === 0, computerUse: list.code === 0 && /computer-use/i.test(list.out) ? true : null });
  } else out.push({ id: "claude", name: "Claude Code", bin: null, registered: null, computerUse: null });

  const codex = which("codex", env);
  if (codex) {
    const got = await run([codex, "mcp", "get", SERVER_NAME], { env, timeoutMs: 30000 });
    const list = await run([codex, "mcp", "list"], { env, timeoutMs: 30000 });
    out.push({ id: "codex", name: "Codex", bin: codex, registered: got.code === 0, computerUse: list.code === 0 && /computer-use/i.test(list.out) ? true : null });
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
      results.push({ client: c.id, action: "skipped", detail: `${c.name} 가 설치되어 있지 않아 건너뜀` });
      continue;
    }
    if (c.registered) {
      results.push({ client: c.id, action: "already", detail: `${c.name} 에 이미 등록되어 있음` });
      continue;
    }
    const cmd = c.id === "claude" ? [c.bin, "mcp", "add", SERVER_NAME, "-s", "user", "--", ...server] : [c.bin, "mcp", "add", SERVER_NAME, "--", ...server];
    if (opts.dryRun) {
      results.push({ client: c.id, action: "planned", command: cmd, detail: `${c.name} 에 등록할 예정(dry-run)` });
      continue;
    }
    const r = await run(cmd, { env, timeoutMs: 60000 });
    results.push(r.code === 0 ? { client: c.id, action: "added", command: cmd, detail: `${c.name} 에 등록했다. 새 세션부터 e2e_* 도구가 보인다.` } : { client: c.id, action: "failed", command: cmd, detail: `${c.name} 등록 실패: ${r.out.slice(-200)}` });
  }
  return results;
}
