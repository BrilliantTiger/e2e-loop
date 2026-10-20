import { OWNER_MARK } from "../procs.ts";
import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../types.ts";
import { expandEnv } from "../store.ts";
import type { DPage, Drained, Driver, NetEntry, Session } from "./index.ts";
import { LIB } from "./inpage.ts";
import { buildVideoFromFrames } from "./egorec.ts";

class PwPage implements DPage {
  constructor(private page: Page, private d: Drained, private timeout: number, private net: { list: NetEntry[]; pending: Promise<unknown>[] }) {}
  private L(sel: string) {
    return this.page.locator(sel);
  }
  async goto(url: string) {
    await this.page.goto(url, { waitUntil: "load", timeout: 30000 });
    await this.page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  }
  async front() {
    await this.page.bringToFront();
  }
  async reload() {
    await this.page.reload({ waitUntil: "load" });
    await this.page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  }
  async click(sel: string) {
    await this.L(sel).click({ timeout: this.timeout });
  }
  async dblclick(sel: string) {
    await this.L(sel).dblclick({ timeout: this.timeout });
  }
  async hover(sel: string) {
    await this.L(sel).hover({ timeout: this.timeout });
  }
  async fill(sel: string, value: string) {
    await this.L(sel).fill(value, { timeout: this.timeout });
  }
  async selectOption(sel: string, value: string) {
    await this.L(sel).selectOption(value, { timeout: this.timeout });
  }
  async check(sel: string, on: boolean) {
    await this.L(sel).setChecked(on, { timeout: this.timeout });
  }
  async press(sel: string | null, key: string) {
    if (sel) await this.L(sel).press(key, { timeout: this.timeout });
    else await this.page.keyboard.press(key);
  }
  async waitFor(sel: string, state: "visible" | "hidden" | "attached" | "detached", timeout: number) {
    await this.L(sel).first().waitFor({ state, timeout });
  }
  async count(sel: string) {
    return this.L(sel).count();
  }
  async isVisible(sel: string) {
    return this.L(sel).first().isVisible();
  }
  async text(sel: string) {
    return (await this.L(sel).first().innerText({ timeout: this.timeout })).trim();
  }
  async value(sel: string) {
    return this.L(sel).first().inputValue({ timeout: this.timeout });
  }
  async evaluate<T = any>(expr: string): Promise<T> {
    return this.page.evaluate(`(() => { ${LIB}; return (${expr}); })()`) as Promise<T>;
  }
  async url() {
    return this.page.url();
  }
  async title() {
    return this.page.title();
  }
  async screenshot(path: string) {
    await this.page.screenshot({ path, fullPage: false });
  }
  async drainNet(): Promise<NetEntry[]> {
    await Promise.race([Promise.allSettled(this.net.pending), new Promise((r) => setTimeout(r, 3000))]);
    this.net.pending.length = 0;
    return this.net.list.splice(0);
  }
  async upload(sel: string, filePath: string) {
    await this.L(sel).first().setInputFiles(filePath, { timeout: this.timeout });
  }
  async download(sel: string, dir: string, timeoutMs: number) {
    mkdirSync(dir, { recursive: true });
    const wait = this.page.waitForEvent("download", { timeout: timeoutMs }).catch(() => null);
    await this.L(sel).first().click({ timeout: this.timeout });
    const dl = await wait;
    if (!dl) return null;
    const path = join(dir, dl.suggestedFilename() || "download.bin");
    await dl.saveAs(path);
    return { filename: dl.suggestedFilename(), size: statSync(path).size, path };
  }
  async drain(): Promise<Drained> {
    const out = { console: [...this.d.console], pageErrors: [...this.d.pageErrors], failedRequests: [...this.d.failedRequests] };
    this.d.console.length = 0;
    this.d.pageErrors.length = 0;
    this.d.failedRequests.length = 0;
    return out;
  }
}

export class PwDriver implements Driver {
  name: string;
  capabilities = { video: true, network: true, files: true };
  private browser?: Browser;
  constructor(private cfg: Config, private pick: "chrome" | "edge" | "chromium") {
    this.name = `playwright+${pick}`;
  }
  async open() {
    this.browser = await chromium.launch({
      headless: this.cfg.headless,
      channel: this.pick === "chrome" ? "chrome" : this.pick === "edge" ? "msedge" : undefined,
      // 이 도구가 띄운 브라우저라는 표지(알 수 없는 인자는 브라우저가 무시한다). 다음 라운드가 남은 프로세스를 가려내는 데 쓴다
      args: [`--${OWNER_MARK}=${process.pid}`],
    });
  }
  async newSession(evidenceDir: string): Promise<Session> {
    mkdirSync(evidenceDir, { recursive: true });
    const vp = this.cfg.viewport;
    const ctx = await this.browser!.newContext({
      viewport: vp,
      ignoreHTTPSErrors: true,
    });
    const kv = Object.fromEntries(Object.entries(this.cfg.auth?.localStorage ?? {}).map(([k, v]) => [k, expandEnv(v)]));
    if (Object.keys(kv).length) {
      await ctx.addInitScript((data: Record<string, string>) => {
        try {
          if (sessionStorage.getItem("__e2e_auth")) return;
          for (const k of Object.keys(data)) localStorage.setItem(k, data[k]!);
          sessionStorage.setItem("__e2e_auth", "1");
        } catch {}
      }, kv);
    }
    if (this.cfg.auth?.cookies?.length) {
      const base = new URL(this.cfg.baseUrl);
      await ctx.addCookies(this.cfg.auth.cookies.map((c) => ({ ...c, value: expandEnv(c.value), url: c.url ?? (c.domain ? undefined : base.origin) })));
    }
    await ctx.addInitScript(LIB);
    await ctx.tracing.start({ screenshots: true, snapshots: true });
    const page = await ctx.newPage();
    // 영상: CDP 스크린캐스트 프레임을 받아 mp4 로 만든다(화면이 바뀔 때만 프레임이 오고, videoFps 가 상한).
    // Playwright 내장 녹화는 25fps 고정이라 쓰지 않는다. Ego 와 같은 방식이라 두 경로의 영상이 같은 형식이다.
    const framesDir = join(evidenceDir, "_frames");
    rmSync(framesDir, { recursive: true, force: true }); // 이전 녹화의 프레임이 섞이지 않게
    mkdirSync(framesDir, { recursive: true });
    const cdp = await ctx.newCDPSession(page);
    const minGap = Math.floor(1000 / Math.max(1, this.cfg.videoFps));
    let seq = 0;
    let last = 0;
    let recErr: string | undefined;
    const writeFrame = (ts: number, b64: string) => {
      seq++;
      writeFileSync(join(framesDir, `f${String(seq).padStart(6, "0")}_${ts}.jpg`), Buffer.from(b64, "base64"));
      last = ts;
    };
    // 스크린캐스트 프레임 시각은 벽시계(에포크) 기준이라 그대로 쓴다. 지금과 3초 넘게 차이 나는 프레임은 낡은 것이라 버린다.
    cdp.on("Page.screencastFrame", (e: any) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
      const ts = Math.round(e.metadata.timestamp * 1000);
      if (Math.abs(Date.now() - ts) > 3000) return;
      if (ts - last >= minGap) writeFrame(ts, e.data);
    });
    try {
      // 첫 장은 있으면 좋은 것이다. 실제 Chrome 은 새 탭 직후 「Unable to capture screenshot」 으로 실패할 때가 있어,
      // 그때도 스크린캐스트는 시작한다(예전에는 여기서 녹화를 통째로 포기해 첫 케이스의 영상이 빠졌다)
      const first: any = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 60 }).catch(() => null);
      if (first?.data) writeFrame(Date.now(), first.data);
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 });
    } catch (e: any) {
      recErr = `영상 프레임 받기를 시작하지 못했습니다: ${String(e?.message ?? e).slice(0, 120)}`;
    }
    const d: Drained = { console: [], pageErrors: [], failedRequests: [] };
    const uniq = (arr: string[], s: string) => {
      if (!arr.includes(s) && arr.length < 50) arr.push(s);
    };
    page.on("console", (m) => {
      if (m.type() === "error") uniq(d.console, `${m.text().slice(0, 300)}${m.location().url ? " @" + m.location().url.replace(/^https?:\/\/[^/]+/, "") : ""}`);
    });
    page.on("pageerror", (e) => uniq(d.pageErrors, String(e.message).slice(0, 300)));
    page.on("requestfailed", (r) => {
      const err = r.failure()?.errorText ?? "";
      if (/ERR_ABORTED|cancel/i.test(err)) return;
      uniq(d.failedRequests, `ERR ${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, "")} (${err})`);
    });
    page.on("response", (r) => {
      if (r.status() >= 400 && !/favicon\.ico/.test(r.url())) uniq(d.failedRequests, `${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, "")}`);
    });
    const net = { list: [] as NetEntry[], pending: [] as Promise<unknown>[] };
    page.on("response", (r) => {
      const t = r.request().resourceType();
      if (t !== "fetch" && t !== "xhr") return;
      let u: URL;
      try {
        u = new URL(r.url());
      } catch {
        return;
      }
      const entry: NetEntry = { method: r.request().method(), url: u.pathname + u.search, origin: u.origin, status: r.status(), contentType: r.headers()["content-type"]?.split(";")[0] };
      net.list.push(entry);
      if (net.list.length > 300) net.list.shift();
      if (/json/i.test(entry.contentType ?? "") && r.status() < 400) {
        net.pending.push(
          r.text().then((txt) => {
            if (txt.length > 500_000) return;
            const j = JSON.parse(txt);
            if (Array.isArray(j)) entry.jsonArray = true;
            else if (j && typeof j === "object") entry.jsonKeys = Object.keys(j).slice(0, 30);
          }).catch(() => {}),
        );
      }
    });
    const wrapped = new PwPage(page, d, this.cfg.stepTimeoutMs, net);
    return {
      page: wrapped,
      finish: async (passed: boolean) => {
        const res: { video?: string; trace?: string; warn?: string } = {};
        try {
          if (!recErr) {
            await cdp.send("Page.stopScreencast").catch(() => {});
            const lastShot: any = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 60 }).catch(() => null);
            if (lastShot) writeFrame(Math.max(Date.now(), last + 1), lastShot.data);
          }
        } catch {}
        try {
          if (!passed) {
            const tp = join(evidenceDir, "trace.zip");
            await ctx.tracing.stop({ path: tp });
            res.trace = tp;
          } else await ctx.tracing.stop();
        } catch {}
        await page.close().catch(() => {});
        if (recErr) res.warn = recErr;
        else {
          const out = await buildVideoFromFrames(framesDir, join(evidenceDir, "video.mkv"));
          if (out.video) res.video = out.video;
          if (out.warn) res.warn = out.warn;
        }
        await ctx.close().catch(() => {});
        return res;
      },
    };
  }
  async close() {
    await this.browser?.close().catch(() => {});
  }
}
