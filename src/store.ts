import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, appendFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Case, Config, Feedback, Inventory, RoundMeta, Source } from "./types.ts";

export const DEFAULT_CONFIG: Config = {
  baseUrl: "http://localhost:3000",
  driver: "auto",
  headless: false, // 기본 Headed. Headless 는 사용자가 요구할 때만
  viewport: { width: 1440, height: 900 },
  data: { policy: "ask", resetScope: "round" },
  crawl: {
    maxPages: 30,
    maxDepth: 3,
    seeds: [],
    ignore: ["logout", "signout", "sign-out", "log-out", "\\.(pdf|zip|png|jpe?g|gif|svg|webp|csv|xlsx?|docx?|pptx?)(\\?|$)"],
    reveal: true,
    maxRevealPerPage: 60,
  },
  logoutPattern: "(logout|log out|log-out|sign ?out|로그아웃)",
  deletePattern: "(delete|remove|trash|삭제|제거|지우기|휴지통)",
  destructivePattern: "(destroy|purge|drop|reset|withdraw|deactivate|초기화|탈퇴|폐기|비활성)",
  maxRounds: 10,
  responder: { mode: "off", batchSeconds: 30 },
  evidenceLimitMB: 4096,
  promotedWarnings: [],
  acceptedSkips: [],
  dashboardPort: 7788,
  probes: "auto",
  stepTimeoutMs: 8000,
};

export class Project {
  root: string;
  dir: string;
  constructor(root: string) {
    this.root = resolve(root);
    this.dir = join(this.root, ".e2e");
  }
  p(...a: string[]) {
    return join(this.dir, ...a);
  }
  ensure() {
    mkdirSync(this.p("rounds"), { recursive: true });
  }
  get initialized() {
    return existsSync(this.p("config.json"));
  }
  readJson<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(this.p(file), "utf8")) as T;
    } catch {
      return fallback;
    }
  }
  writeJson(file: string, data: unknown) {
    this.ensure();
    const path = this.p(file);
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  }
  config(): Config {
    const c = this.readJson<Partial<Config>>("config.json", {});
    return {
      ...DEFAULT_CONFIG,
      ...c,
      data: { ...DEFAULT_CONFIG.data, ...(c.data ?? {}) },
      crawl: { ...DEFAULT_CONFIG.crawl, ...(c.crawl ?? {}) },
      viewport: { ...DEFAULT_CONFIG.viewport, ...(c.viewport ?? {}) },
      responder: { ...DEFAULT_CONFIG.responder, ...(c.responder ?? {}) },
    } as Config;
  }
  saveConfig(c: Config) {
    this.writeJson("config.json", c);
  }
  sources(): Source[] {
    return this.readJson<Source[]>("sources.json", []);
  }
  cases(): Case[] {
    return this.readJson<Case[]>("cases.json", []);
  }
  saveCases(c: Case[]) {
    this.writeJson("cases.json", c);
  }
  feedback(): Feedback[] {
    return this.readJson<Feedback[]>("feedback.json", []);
  }
  inventory(): Inventory | null {
    return this.readJson<Inventory | null>("inventory.json", null);
  }
  rounds(): RoundMeta[] {
    const d = this.p("rounds");
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((n) => /^R\d+$/.test(n))
      .sort()
      .map((n) => this.readJson<RoundMeta | null>(`rounds/${n}/meta.json`, null))
      .filter((x): x is RoundMeta => !!x);
  }
  roundDir(id: string) {
    return this.p("rounds", id);
  }
  nextRoundId() {
    const n = this.rounds().reduce((m, r) => Math.max(m, r.n), 0) + 1;
    return { id: "R" + String(n).padStart(2, "0"), n };
  }
  appendEvent(roundId: string, ev: Record<string, unknown>) {
    appendFileSync(this.p("rounds", roundId, "events.ndjson"), JSON.stringify({ t: Date.now(), ...ev }) + "\n");
  }
}

export function caseHash(cases: Case[]): string {
  const stable = cases
    .filter((c) => (c.status ?? "active") === "active")
    .map((c) => ({ id: c.id, steps: c.steps }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha1").update(JSON.stringify(stable)).digest("hex").slice(0, 12);
}

export function expandEnv(s: string): string {
  return s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => process.env[k] ?? "");
}

export function nowIso() {
  return new Date().toISOString();
}
