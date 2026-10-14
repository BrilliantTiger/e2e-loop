import { mkdirSync } from "node:fs";
import type { Config } from "../types.ts";
import { expandEnv } from "../store.ts";
import { OsWindowRequired, type DPage, type Drained, type Driver, type NetEntry, type Session } from "./index.ts";
import { HOOKS, LIB } from "./inpage.ts";

// ego-browser 는 자기 내장 Node 런타임 안에서만 page API 를 쓸 수 있다.
// 그래서 그 안에 작은 HTTP 서버를 띄우고, 이쪽(bun)에서 JSON 명령을 보낸다.
const BRIDGE = (port: number) => String.raw`
const http = await import("node:http");
const task = await taskSpace("e2e-loop");
const page = task.page("p1");
const call = async (m) => {
  switch (m.op) {
    case "goto": await page.goto(m.url); await page.waitForLoadState("load").catch(() => {}); return null;
    case "reload": await page.reload(); return null;
    case "click": await page.click(m.sel, { timeout: m.timeout, label: m.label }); return null;
    case "dblclick": await page.dblclick(m.sel, { timeout: m.timeout }); return null;
    case "hover": await page.hover(m.sel, { timeout: m.timeout }); return null;
    case "fill": await page.fill(m.sel, m.value, { timeout: m.timeout }); return null;
    case "select": await page.selectOption(m.sel, m.value); return null;
    case "press": if (m.sel) await page.press(m.sel, m.key); else await page.keyboard.press(m.key); return null;
    case "wait": await page.waitForSelector(m.sel, { state: m.state, timeout: m.timeout }); return null;
    case "eval": return await page.evaluate(m.expr);
    case "url": return await page.url();
    case "title": return await page.title();
    case "shot": await page.screenshot({ path: m.path }); return m.path;
    case "cdp": return await page.cdp(m.method, m.params || {});
  }
  throw new Error("unknown op " + m.op);
};
let server;
const done = new Promise((resolve) => {
  server = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    let m = {}; try { m = JSON.parse(body || "{}"); } catch (e) {}
    if (m.op === "quit") { res.end(JSON.stringify({ ok: true })); server.close(); resolve(); return; }
    try { const v = await call(m); res.end(JSON.stringify({ ok: true, v: v === undefined ? null : v })); }
    catch (e) { res.end(JSON.stringify({ ok: false, err: String((e && e.message) || e) })); }
  });
  server.listen(${port}, "127.0.0.1", () => console.log("E2E_READY " + task.spaceId));
});
await done;
await task.finish({ keep: [] });
console.log("E2E_DONE");
`;

/** 공용 선택자 → ego 선택자 */
export function toEgoSel(sel: string): string {
  const m = sel.match(/^role=([a-z]+)(?:\[name=(["'])(.*)\2(?:\s*[is])?\])?$/);
  if (m) return `loc=role:${m[1]}${m[3] ? `[name='${m[3].replace(/'/g, "\\'")}']` : ""}`;
  return sel;
}

class EgoPage implements DPage {
  constructor(private call: (m: any, ms?: number) => Promise<any>, private timeout: number) {}
  private async hooks() {
    await this.call({ op: "eval", expr: `(() => { ${LIB}; ${HOOKS}; return true; })()` }).catch(() => {});
  }
  async goto(url: string) {
    await this.call({ op: "goto", url }, 45000);
    await this.hooks();
  }
  async reload() {
    await this.call({ op: "reload" }, 45000);
    await this.hooks();
  }
  async click(sel: string, label?: string) {
    await this.call({ op: "click", sel: toEgoSel(sel), timeout: this.timeout, label });
    await this.hooks();
  }
  async dblclick(sel: string) {
    await this.call({ op: "dblclick", sel: toEgoSel(sel), timeout: this.timeout });
  }
  async hover(sel: string) {
    await this.call({ op: "hover", sel: toEgoSel(sel), timeout: this.timeout });
  }
  async fill(sel: string, value: string) {
    await this.call({ op: "fill", sel: toEgoSel(sel), value, timeout: this.timeout });
  }
  async selectOption(sel: string, value: string) {
    await this.call({ op: "select", sel: toEgoSel(sel), value });
  }
  async check(sel: string, on: boolean) {
    const cur = await this.evaluate<boolean | null>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; return e ? (e.checked ?? e.getAttribute('aria-checked') === 'true') : null; })()`);
    if (cur === null) throw new Error(`요소를 찾지 못했습니다: ${sel}`);
    if (!!cur !== on) await this.click(sel);
  }
  async press(sel: string | null, key: string) {
    await this.call({ op: "press", sel: sel ? toEgoSel(sel) : null, key });
  }
  async waitFor(sel: string, state: "visible" | "hidden" | "attached" | "detached", timeout: number) {
    await this.call({ op: "wait", sel: toEgoSel(sel), state, timeout }, timeout + 5000);
  }
  async count(sel: string) {
    return this.evaluate<number>(`window.__e2e.resolve(${JSON.stringify(sel)}).length`);
  }
  async isVisible(sel: string) {
    return this.evaluate<boolean>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; return !!e && window.__e2e.vis(e); })()`);
  }
  async text(sel: string) {
    return this.evaluate<string>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; if (!e) throw new Error('요소 없음'); return window.__e2e.textOf(e); })()`);
  }
  async value(sel: string) {
    return this.evaluate<string>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; if (!e) throw new Error('요소 없음'); return e.value ?? ''; })()`);
  }
  async evaluate<T = any>(expr: string): Promise<T> {
    return this.call({ op: "eval", expr: `(() => { ${LIB}; ${HOOKS}; return (${expr}); })()` });
  }
  async url() {
    return this.call({ op: "url" });
  }
  async title() {
    return this.call({ op: "title" });
  }
  async screenshot(path: string) {
    await this.call({ op: "shot", path }, 20000);
  }
  async drainNet(): Promise<NetEntry[]> {
    return this.evaluate<NetEntry[]>(`(() => { const h = window.__e2eHooks; const r = h.net.slice(); h.net.length = 0; return r; })()`).catch(() => []);
  }
  async upload(_sel: string, _filePath: string): Promise<void> {
    throw new OsWindowRequired("Ego 의 파일 선택 창은 브라우저 밖 OS 창이라 컴퓨터 제어 도구가 맡아야 합니다.");
  }
  async download(_sel: string, _dir: string, _timeoutMs: number): Promise<never> {
    throw new OsWindowRequired("Ego 의 다운로드는 브라우저 밖 OS 창이라 컴퓨터 제어 도구가 맡아야 합니다.");
  }
  async drain(): Promise<Drained> {
    const h = await this.evaluate<{ console: string[]; errors: string[]; requests: string[] }>(
      `(() => { const h = window.__e2eHooks; const r = { console: h.console.slice(), errors: h.errors.slice(), requests: h.requests.slice() }; h.console.length = 0; h.errors.length = 0; h.requests.length = 0; return r; })()`,
    ).catch(() => ({ console: [], errors: [], requests: [] }));
    return { console: h.console, pageErrors: h.errors, failedRequests: h.requests };
  }
}

export class EgoDriver implements Driver {
  name = "ego-browser";
  capabilities = { video: false, network: true, files: false };
  private proc?: ReturnType<typeof Bun.spawn>;
  private port = 0;
  constructor(private cfg: Config, private bin: string) {}
  private async call(m: any, ms = 20000): Promise<any> {
    const r = await fetch(`http://127.0.0.1:${this.port}`, { method: "POST", body: JSON.stringify(m), signal: AbortSignal.timeout(ms) });
    const j = (await r.json()) as { ok: boolean; v?: any; err?: string };
    if (!j.ok) throw new Error(j.err ?? "ego 명령 실패");
    return j.v;
  }
  async open() {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    this.port = probe.port!;
    probe.stop(true);
    this.proc = Bun.spawn([this.bin, "nodejs", "-e", BRIDGE(this.port)], { stdout: "pipe", stderr: "pipe" });
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array; done: boolean }>((r) => setTimeout(() => r({ done: false }), 1000)),
      ]);
      if (value) buf += dec.decode(value);
      if (buf.includes("E2E_READY")) return;
      if (done) break;
    }
    const err = this.proc.stderr ? await new Response(this.proc.stderr as ReadableStream).text().catch(() => "") : "";
    this.proc.kill();
    throw new Error("ego-browser 브리지가 시작되지 않았습니다. ego lite 앱이 실행 중인지 확인하세요. " + err.slice(0, 300));
  }
  async newSession(evidenceDir: string): Promise<Session> {
    mkdirSync(evidenceDir, { recursive: true });
    const page = new EgoPage((m, ms) => this.call(m, ms), this.cfg.stepTimeoutMs);
    // 이전 케이스의 상태를 비운다(localStorage/sessionStorage 만. 쿠키는 프로필 전체에 닿아서 건드리지 않는다)
    await page.goto(this.cfg.baseUrl);
    const kv = Object.fromEntries(Object.entries(this.cfg.auth?.localStorage ?? {}).map(([k, v]) => [k, expandEnv(v)]));
    await page.evaluate(`(() => { try { localStorage.clear(); sessionStorage.clear(); const kv = ${JSON.stringify(kv)}; for (const k of Object.keys(kv)) localStorage.setItem(k, kv[k]); } catch (e) {} return true; })()`);
    await page.drain();
    return {
      page,
      finish: async () => ({}),
    };
  }
  async close() {
    try {
      await this.call({ op: "quit" }, 15000);
    } catch {}
    setTimeout(() => this.proc?.kill(), 3000).unref?.();
  }
}
