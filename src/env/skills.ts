// 테스터 스킬(skills/e2e-loop)을 클라이언트가 읽는 위치에 설치한다.
// Claude Code: ~/.claude/skills, Codex: ~/.agents/skills (Codex 바이너리에서 읽는 위치를 확인함).
// 저장소의 폴더를 가리키는 심볼릭 링크라서 git pull 만 해도 스킬이 갱신된다. 링크가 안 되면 복사한다.
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { which, type Env } from "./detect.ts";
import { tx } from "../i18n.ts";

export const SKILL_NAME = "e2e-loop";

export interface SkillInstallResult {
  client: "claude" | "codex";
  path: string;
  action: "linked" | "copied" | "already" | "planned" | "skipped" | "conflict";
  detail: string;
}

/** 링크가 안 돼 복사한 스킬 폴더에 두는 표지. 이 표지가 있는 폴더만 다시 설치할 때 새로 바꾼다(사용자가 만든 같은 이름 폴더는 건드리지 않는다) */
export const COPY_MARK = ".e2e-loop-copy";

/** 스킬 폴더를 복사하고 표지를 남긴다 */
export function copySkill(src: string, dest: string) {
  cpSync(src, dest, { recursive: true });
  writeFileSync(join(dest, COPY_MARK), tx("e2e-loop 설치가 복사한 스킬 폴더입니다. 다시 설치하면 새로 바뀝니다.\n", "This skill folder was copied by the e2e-loop install. Installing again replaces it.\n"));
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
      out.push({ client: t.client, path, action: "skipped", detail: tx(`${t.name} 가 설치되어 있지 않아 건너뜀`, `${t.name} is not installed, so it is skipped`) });
      continue;
    }
    let st;
    try {
      st = lstatSync(path);
    } catch {}
    if (st?.isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === src) {
      out.push({ client: t.client, path, action: "already", detail: tx(`${t.name} 에 이미 설치되어 있음`, `Already installed in ${t.name}`) });
      continue;
    }
    // 예전에 이 도구가 복사해 둔 폴더(표지 있음)는 새로 바꾼다
    const ourCopy = !!st && !st.isSymbolicLink() && existsSync(join(path, COPY_MARK));
    if (st && !st.isSymbolicLink() && !ourCopy) {
      out.push({ client: t.client, path, action: "conflict", detail: tx(`${path} 에 같은 이름의 폴더·파일이 이미 있어 덮어쓰지 않음. 직접 확인하세요.`, `A folder or file with the same name already exists at ${path}, so it is not overwritten. Check it yourself.`) });
      continue;
    }
    if (opts.dryRun) {
      out.push({ client: t.client, path, action: "planned", detail: tx(`${t.name} 에 스킬 링크를 만들 예정(dry-run)`, `Will create the skill link in ${t.name} (dry-run)`) });
      continue;
    }
    mkdirSync(t.root, { recursive: true });
    if (st) rmSync(path, { recursive: ourCopy }); // 다른 곳을 가리키는 옛 링크나 이 도구의 옛 복사본만 지운다
    try {
      symlinkSync(src, path, "dir");
      out.push({ client: t.client, path, action: "linked", detail: tx(`${t.name} 에 스킬을 연결했다. 새 세션부터 e2e-loop 스킬이 보인다.`, `Linked the skill in ${t.name}. The e2e-loop skill shows from the next new session.`) });
    } catch {
      copySkill(src, path);
      out.push({ client: t.client, path, action: "copied", detail: tx(`${t.name} 에 스킬을 복사했다(링크 실패). 스킬을 고치면 install.sh 를 다시 실행해야 한다.`, `Copied the skill to ${t.name} (the link failed). After the skill changes, run install.sh again.`) });
    }
  }
  return out;
}
