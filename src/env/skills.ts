// 테스터 스킬(skills/e2e-loop)을 클라이언트가 읽는 위치에 설치한다.
// Claude Code: ~/.claude/skills, Codex: ~/.agents/skills (Codex 바이너리에서 읽는 위치를 확인함).
// 저장소의 폴더를 가리키는 심볼릭 링크라서 git pull 만 해도 스킬이 갱신된다. 링크가 안 되면 복사한다.
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { which, type Env } from "./detect.ts";

export const SKILL_NAME = "e2e-loop";

export interface SkillInstallResult {
  client: "claude" | "codex";
  path: string;
  action: "linked" | "copied" | "already" | "planned" | "skipped" | "conflict";
  detail: string;
}

export function skillSource(): string {
  return resolve(import.meta.dir, "../../skills", SKILL_NAME);
}

export function installSkills(opts: { env?: Env; home?: string; dryRun?: boolean } = {}): SkillInstallResult[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const src = skillSource();
  const targets = [
    { client: "claude" as const, name: "Claude Code", root: join(home, ".claude", "skills"), present: !!which("claude", env) || existsSync(join(home, ".claude")) },
    { client: "codex" as const, name: "Codex", root: join(home, ".agents", "skills"), present: !!which("codex", env) || existsSync(join(home, ".codex")) },
  ];
  const out: SkillInstallResult[] = [];
  for (const t of targets) {
    const path = join(t.root, SKILL_NAME);
    if (!t.present) {
      out.push({ client: t.client, path, action: "skipped", detail: `${t.name} 가 설치되어 있지 않아 건너뜀` });
      continue;
    }
    let st;
    try {
      st = lstatSync(path);
    } catch {}
    if (st?.isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === src) {
      out.push({ client: t.client, path, action: "already", detail: `${t.name} 에 이미 설치되어 있음` });
      continue;
    }
    if (st && !st.isSymbolicLink()) {
      out.push({ client: t.client, path, action: "conflict", detail: `${path} 에 같은 이름의 폴더·파일이 이미 있어 덮어쓰지 않음. 직접 확인하세요.` });
      continue;
    }
    if (opts.dryRun) {
      out.push({ client: t.client, path, action: "planned", detail: `${t.name} 에 스킬 링크를 만들 예정(dry-run)` });
      continue;
    }
    mkdirSync(t.root, { recursive: true });
    if (st) rmSync(path); // 다른 곳을 가리키는 옛 링크만 지운다
    try {
      symlinkSync(src, path, "dir");
      out.push({ client: t.client, path, action: "linked", detail: `${t.name} 에 스킬을 연결했다. 새 세션부터 e2e-loop 스킬이 보인다.` });
    } catch {
      cpSync(src, path, { recursive: true });
      out.push({ client: t.client, path, action: "copied", detail: `${t.name} 에 스킬을 복사했다(링크 실패). 스킬을 고치면 install.sh 를 다시 실행해야 한다.` });
    }
  }
  return out;
}
