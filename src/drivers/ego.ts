import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildVideoFromFrames } from "./egorec.ts";
import type { Config } from "../types.ts";
import { expandEnv } from "../store.ts";
import { type DPage, type Drained, type Driver, type NetEntry, type Session } from "./index.ts";
import { HOOKS, LIB } from "./inpage.ts";

// ego-browser 는 자기 내장 Node 런타임 안에서만 page API 를 쓸 수 있다.
// 그래서 그 안에 작은 HTTP 서버를 띄우고, 이쪽(bun)에서 JSON 명령을 보낸다.
export const SPACE_NAME = "e2e-loop";
const BRIDGE = (port: number) => String.raw`
const http = await import("node:http");
const task = await taskSpace(${JSON.stringify(SPACE_NAME)});
const page = task.page("p1");
const rec = { timer: null, n: 0, busy: false, err: null };
const call = async (m) => {
  switch (m.op) {
    case "ping": return "pong";
    case "upload": await page.setInputFiles(m.sel, [m.path]); return null;
    case "download": {
      const wait = page.waitForEvent("download", { timeout: m.timeout }).catch(() => null);
      await page.click(m.sel, { timeout: m.timeout });
      const dl = await wait;
      if (!dl) return null;
      const fs = await import("node:fs");
      fs.mkdirSync(m.dir, { recursive: true });
      const name = dl.suggestedFilename() || "download.bin";
      const path = m.dir + "/" + name;
      await dl.saveAs(path);
      return { filename: name, size: fs.statSync(path).size, path };
    }
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
    case "shot": {
      // 브라우저 안쪽(CDP)에서 직접 캡처 — 탭이 가려져 있어도 된다. 안 되면 Ego 의 screenshot 으로 한 번 더 시도
      const fs = await import("node:fs");
      try { const r = await page.cdp("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(m.path, Buffer.from(r.data, "base64")); return m.path; }
      catch (e) { await page.screenshot({ path: m.path }); return m.path; }
    }
    case "recStart": {
      // 작업 공간의 페이지 화면을 일정 간격으로 받아 파일로 쓴다(영상 재료). 이전 요청이 안 끝났으면 그 프레임은 건너뛴다.
      const fs = await import("node:fs");
      fs.mkdirSync(m.dir, { recursive: true });
      if (rec.timer) clearInterval(rec.timer);
      rec.n = 0; rec.busy = false; rec.err = null;
      const grab = async () => {
        if (rec.busy) return; rec.busy = true;
        try { const r = await page.cdp("Page.captureScreenshot", { format: "jpeg", quality: m.quality || 60 }); rec.n++; fs.writeFileSync(m.dir + "/f" + String(rec.n).padStart(6, "0") + "_" + Date.now() + ".jpg", Buffer.from(r.data, "base64")); }
        catch (e) { rec.err = String((e && e.message) || e).slice(0, 120); }
        finally { rec.busy = false; }
      };
      await grab();
      rec.timer = setInterval(grab, m.intervalMs || 200);
      return { first: rec.n };
    }
    case "recStop": {
      if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
      for (let i = 0; i < 40 && rec.busy; i++) await new Promise((r) => setTimeout(r, 50));
      return { frames: rec.n, err: rec.err };
    }
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

/** 드라이버 하나(= 한 번의 라운드) 안에서 공유하는 상태: 화면 캡처가 한 번 응답하지 않으면 이후 세션에서는 시도하지 않는다 */
export interface EgoShared {
  shotBroken: boolean;
}

class EgoPage implements DPage {
  constructor(private call: (m: any, ms?: number) => Promise<any>, private timeout: number, private shared: EgoShared) {}
  get shotBroken() {
    return this.shared.shotBroken;
  }
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
  /** 작업 탭이 가려져 있으면 화면 캡처가 응답하지 않는다. 한 번 실패하면 이 세션에서는 더 시도하지 않는다(매 스텝 기다리지 않게). */
  async screenshot(path: string) {
    if (this.shared.shotBroken) throw new Error("Ego 화면 캡처를 건너뜀(앞서 응답 없음)");
    try {
      await this.call({ op: "shot", path }, 8000);
    } catch (e) {
      this.shared.shotBroken = true;
      throw e;
    }
  }
  async drainNet(): Promise<NetEntry[]> {
    return this.evaluate<NetEntry[]>(`(() => { const h = window.__e2eHooks; const r = h.net.slice(); h.net.length = 0; return r; })()`).catch(() => []);
  }
  async upload(sel: string, filePath: string): Promise<void> {
    await this.call({ op: "upload", sel: toEgoSel(sel), path: filePath });
  }
  async download(sel: string, dir: string, timeoutMs: number) {
    return this.call({ op: "download", sel: toEgoSel(sel), dir, timeout: timeoutMs }, timeoutMs + 20000);
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
  capabilities = { video: true, network: true, files: true };
  private proc?: ReturnType<typeof Bun.spawn>;
  private port = 0;
  private shared: EgoShared = { shotBroken: false };
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
    // 내장 Node 런타임은 console.log 를 stderr 로 내보내기도 한다 — 두 스트림을 함께 읽는다
    let buf = "";
    const dec = new TextDecoder();
    const pump = async (s: ReadableStream<Uint8Array>) => {
      const reader = s.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value);
        }
      } catch {}
    };
    void pump(this.proc.stdout as ReadableStream<Uint8Array>);
    void pump(this.proc.stderr as ReadableStream<Uint8Array>);
    const deadline = Date.now() + 30000;
    // 내장 런타임은 출력을 프로세스가 끝날 때까지 쌓아 두기도 해서, 출력 대신 포트에 직접 물어본다
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}`, { method: "POST", body: JSON.stringify({ op: "ping" }), signal: AbortSignal.timeout(1500) });
        if ((await r.json()).ok) return;
      } catch {}
      if (this.proc.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    this.proc.kill();
    throw new Error("ego-browser 브리지가 시작되지 않았습니다. ego lite 앱이 실행 중인지 확인하세요. " + buf.slice(-300));
  }
  async newSession(evidenceDir: string): Promise<Session> {
    mkdirSync(evidenceDir, { recursive: true });
    const page = new EgoPage((m, ms) => this.call(m, ms), this.cfg.stepTimeoutMs, this.shared);
    // 이전 케이스의 상태를 비운다(localStorage/sessionStorage 만. 쿠키는 프로필 전체에 닿아서 건드리지 않는다)
    await page.goto(this.cfg.baseUrl);
    const kv = Object.fromEntries(Object.entries(this.cfg.auth?.localStorage ?? {}).map(([k, v]) => [k, expandEnv(v)]));
    await page.evaluate(`(() => { try { localStorage.clear(); sessionStorage.clear(); const kv = ${JSON.stringify(kv)}; for (const k of Object.keys(kv)) localStorage.setItem(k, kv[k]); } catch (e) {} return true; })()`);
    await page.drain();
    // 작업 공간의 페이지 화면을 CDP 로 직접 받아 영상으로 만든다(창이 가려져도 된다)
    const frames = join(evidenceDir, "_frames");
    let recErr: string | undefined;
    try {
      await this.call({ op: "recStart", dir: frames, intervalMs: 200, quality: 60 }, 15000);
    } catch (e: any) {
      recErr = `Ego 화면 프레임 받기를 시작하지 못했습니다: ${String(e?.message ?? e).slice(0, 120)}`;
    }
    return {
      page,
      finish: async () => {
        if (recErr) return { warn: recErr };
        let stop: { frames: number; err: string | null } = { frames: 0, err: null };
        try {
          stop = await this.call({ op: "recStop" }, 15000);
        } catch (e: any) {
          return { warn: `Ego 화면 프레임 받기를 마치지 못했습니다: ${String(e?.message ?? e).slice(0, 120)}` };
        }
        const out = await buildVideoFromFrames(frames, join(evidenceDir, "video.mkv"));
        const warns = [out.warn, stop.err && !out.video ? `프레임 캡처 오류: ${stop.err}` : undefined, page.shotBroken ? "Ego 스크린샷을 남기지 못했습니다." : undefined].filter(Boolean);
        return { video: out.video, warn: warns.length ? warns.join(" ") : undefined };
      },
    };
  }
  async close() {
    try {
      await this.call({ op: "quit" }, 15000);
    } catch {}
    setTimeout(() => this.proc?.kill(), 3000).unref?.();
  }
}
