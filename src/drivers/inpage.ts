// 브라우저 안에서 실행되는 코드(문자열). Playwright 와 ego 가 똑같이 쓴다.
// 선택자 문법: CSS | text="..." | role=button[name="..."] | xpath=... | CSS 끝에 :text-is("..") / :has-text("..")

export const LIB = String.raw`
if (!window.__e2e) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const textOf = (el) => norm(el.innerText || el.textContent || '');
  const accName = (el) => norm(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('placeholder') || el.getAttribute('title') || (el.tagName === 'INPUT' && ['button','submit','reset'].includes(el.type) ? el.value : '') || el.innerText || el.getAttribute('alt') || '');
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName;
    if (t === 'A' && el.hasAttribute('href')) return 'link';
    if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'INPUT') return ({checkbox:'checkbox',radio:'radio',button:'button',submit:'button',reset:'button'})[el.type] || 'textbox';
    return '';
  };
  const unq = (s) => s.replace(/^["']|["']$/g, '');
  const resolve = (sel) => {
    if (sel.startsWith('text=')) {
      const raw = sel.slice(5); const exact = /^".*"$/.test(raw); const q = unq(raw).toLowerCase();
      const all = [...document.querySelectorAll('body *')].filter((e) => { const t = textOf(e).toLowerCase(); return exact ? t === q : t.includes(q); });
      return all.filter((e) => ![...e.children].some((c) => all.includes(c)));
    }
    if (sel.startsWith('role=')) {
      const m = sel.match(/^role=([a-z]+)(?:\[name=(["'])(.*)\2\])?$/);
      if (!m) return [];
      return [...document.querySelectorAll('*')].filter((e) => roleOf(e) === m[1] && (!m[3] || accName(e).toLowerCase().includes(m[3].toLowerCase())));
    }
    if (sel.startsWith('xpath=')) {
      const out = []; const it = document.evaluate(sel.slice(6), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < it.snapshotLength; i++) out.push(it.snapshotItem(i)); return out;
    }
    const tm = sel.match(/^(.*):(text-is|has-text)\((["'])(.*)\3\)$/);
    if (tm) {
      const base = [...document.querySelectorAll(tm[1] || '*')];
      return base.filter((e) => tm[2] === 'text-is' ? textOf(e) === tm[4] : textOf(e).toLowerCase().includes(tm[4].toLowerCase()));
    }
    return [...document.querySelectorAll(sel)];
  };
  const dialogs = () => {
    const sels = 'dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true], .modal.show, .modal.is-open, .modal[style*="block"], .ant-modal, .MuiDialog-root, [data-state=open][role=dialog]';
    const seen = new Set(); const out = [];
    for (const el of document.querySelectorAll(sels)) {
      if (seen.has(el) || !vis(el)) continue; seen.add(el);
      out.push({ el, label: norm(el.getAttribute('aria-label') || (el.querySelector('h1,h2,h3,[class*=title]') || {}).innerText || el.innerText).slice(0, 60) });
    }
    return out;
  };
  window.__e2e = { v: 1, norm, vis, textOf, accName, roleOf, resolve, dialogs };
  // 오류 수집 훅 (ego 에서 쓰고, Playwright 는 네이티브 이벤트를 쓴다)
  window.__e2eHooks = window.__e2eHooks || { console: [], errors: [], requests: [] };
}
`;

export const HOOKS = String.raw`
if (!window.__e2eHooksOn) {
  window.__e2eHooksOn = true;
  const h = window.__e2eHooks;
  const oe = console.error;
  console.error = function () { try { h.console.push([].map.call(arguments, (a) => (a && a.message) || String(a)).join(' ').slice(0, 300)); } catch (e) {} return oe.apply(console, arguments); };
  addEventListener('error', (e) => h.errors.push(String(e.message).slice(0, 300)));
  addEventListener('unhandledrejection', (e) => h.errors.push('unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason).slice(0, 300)));
  const of = window.fetch;
  if (of) window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const method = (init && init.method) || (input && input.method) || 'GET';
    return of.apply(this, arguments).then((r) => { if (r.status >= 400) h.requests.push(r.status + ' ' + method + ' ' + url); return r; }, (err) => { h.requests.push('ERR ' + method + ' ' + url); throw err; });
  };
  const xo = XMLHttpRequest.prototype.open; const xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; return xo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () { this.addEventListener('loadend', () => { if (this.status >= 400 || this.status === 0) h.requests.push((this.status || 'ERR') + ' ' + this.__m + ' ' + this.__u); }); return xs.apply(this, arguments); };
}
`;

/** 화면 상태 스냅샷. 앞뒤 비교로 "무슨 일이 일어났는지" 판정한다. */
export const OBSERVE = String.raw`(() => {
  const E = window.__e2e;
  const alerts = [...document.querySelectorAll('[role=alert],[role=status],.toast,.Toastify__toast,.snackbar,.ant-message,.error,.invalid-feedback,[class*=error-message]')].filter(E.vis).map((e) => E.textOf(e)).filter(Boolean).slice(0, 5);
  const d = E.dialogs();
  const invalid = [...document.querySelectorAll('input,select,textarea')].filter((e) => E.vis(e) && (e.getAttribute('aria-invalid') === 'true' || (e.validity && !e.validity.valid))).length;
  return {
    url: location.pathname + location.search,
    title: document.title,
    dialogs: d.map((x) => x.label || 'dialog'),
    nodes: document.getElementsByTagName('*').length,
    textLen: (document.body.innerText || '').length,
    alerts, invalid,
    expanded: document.querySelectorAll('[aria-expanded=true]').length,
    selected: document.querySelectorAll('[aria-selected=true]').length,
    checked: document.querySelectorAll(':checked').length,
    openDetails: document.querySelectorAll('details[open]').length,
    hash: location.hash,
  };
})()`;

/** 요소 인벤토리. scope 가 있으면 그 요소 안쪽만(모달 수집용). */
export const inventoryExpr = (scope: string | null) => String.raw`(() => {
  const E = window.__e2e;
  const SCOPE = ${JSON.stringify(scope)};
  const root = SCOPE ? (E.resolve(SCOPE)[0] || null) : document;
  if (!root) return { elements: [], forms: 0, title: document.title };
  const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const count = (sel) => { try { return E.resolve(sel).length; } catch (e) { return 99; } };
  const attrQ = (v) => '"' + v.replace(/"/g, '\\"') + '"';
  const best = (el) => {
    const tag = el.tagName.toLowerCase();
    for (const a of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
      const v = el.getAttribute(a); if (v) { const s = '[' + a + '=' + attrQ(v) + ']'; if (count(s) === 1) return s; }
    }
    if (el.id && !/\d{4,}|^:r|radix|headlessui|react-aria/i.test(el.id)) { const s = '#' + cssEsc(el.id); if (count(s) === 1) return s; }
    const nm = el.getAttribute('name');
    if (nm) { const s = tag + '[name=' + attrQ(nm) + ']'; if (count(s) === 1) return s; }
    const al = el.getAttribute('aria-label');
    if (al) { const s = tag + '[aria-label=' + attrQ(al) + ']'; if (count(s) === 1) return s; }
    const ph = el.getAttribute('placeholder');
    if (ph) { const s = tag + '[placeholder=' + attrQ(ph) + ']'; if (count(s) === 1) return s; }
    const t = E.textOf(el);
    if (t && t.length <= 40 && !t.includes('"')) {
      const base = el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : tag;
      const s = base + ':text-is(' + attrQ(t) + ')'; if (count(s) === 1) return s;
    }
    const href = el.getAttribute('href');
    if (href) { const s = tag + '[href=' + attrQ(href) + ']'; if (count(s) === 1) return s; }
    const parts = []; let cur = el;
    for (let i = 0; i < 6 && cur && cur.nodeType === 1 && cur !== document.body; i++) {
      const sibs = [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName);
      parts.unshift(cur.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')' : ''));
      const s = parts.join(' > '); if (count(s) === 1) return s;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const cand = new Set();
  const q = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=radio],[role=combobox],[role=option],[onclick],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  root.querySelectorAll(q).forEach((e) => cand.add(e));
  root.querySelectorAll('div,span,li,img,svg,td').forEach((e) => {
    if (cand.size > 600) return;
    if (getComputedStyle(e).cursor !== 'pointer') return;
    if (e.closest('a,button,[role=button],input,select,summary')) return;
    if (E.textOf(e).length > 40) return;
    cand.add(e);
  });
  const formIdx = new Map(); let fi = 0;
  const out = []; const seenSel = new Set();
  for (const el of cand) {
    if (!E.vis(el) && el.type !== 'checkbox' && el.type !== 'radio') continue;
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
    if (!SCOPE && el.closest('dialog:not([open]),[aria-hidden=true]')) continue;
    const tag = el.tagName.toLowerCase(); const role = E.roleOf(el);
    let kind = 'button';
    if (tag === 'a') kind = 'link';
    else if (tag === 'select') kind = 'select';
    else if (tag === 'textarea' || el.isContentEditable) kind = 'input';
    else if (tag === 'summary') kind = 'summary';
    else if (tag === 'input') kind = ['checkbox', 'radio'].includes(el.type) ? 'toggle' : ['button', 'submit', 'reset', 'image'].includes(el.type) ? 'button' : el.type === 'file' ? 'file' : 'input';
    else if (role === 'tab') kind = 'tab';
    else if (role === 'checkbox' || role === 'switch' || role === 'radio') kind = 'toggle';
    else if (role === 'link') kind = 'link';
    else if (role === 'combobox') kind = 'select';
    const form = el.closest('form');
    let formKey;
    if (form) { if (!formIdx.has(form)) formIdx.set(form, form.id || form.getAttribute('name') || 'form' + (++fi)); formKey = formIdx.get(form); }
    const selector = best(el);
    if (seenSel.has(selector)) continue; seenSel.add(selector);
    const href = el.getAttribute('href');
    let external = false;
    if (href) { try { external = new URL(href, location.href).origin !== location.origin; } catch (e) {} }
    const aria = (n) => el.getAttribute(n) || undefined;
    out.push({
      tag, kind, inputType: tag === 'input' ? el.type : undefined,
      label: E.accName(el).slice(0, 80) || el.getAttribute('name') || el.id || tag,
      selector, href: href || undefined, external,
      newTab: el.getAttribute('target') === '_blank' || undefined,
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
      required: el.required || undefined, formKey,
      submit: (tag === 'button' && (el.getAttribute('type') === 'submit' || (!el.getAttribute('type') && !!form))) || (tag === 'input' && el.type === 'submit') || undefined,
      options: tag === 'select' ? [...el.options].map((o) => o.value || o.text).slice(0, 12) : undefined,
      attrs: { pattern: aria('pattern'), min: aria('min'), max: aria('max'), maxlength: aria('maxlength'), 'aria-haspopup': aria('aria-haspopup'), 'aria-controls': aria('aria-controls'), 'data-bs-toggle': aria('data-bs-toggle'), 'data-toggle': aria('data-toggle') },
      popupHint: !!(aria('aria-haspopup') && aria('aria-haspopup') !== 'false') || aria('data-bs-toggle') === 'modal' || aria('data-toggle') === 'modal' || undefined,
    });
    if (out.length >= 500) break;
  }
  const links = SCOPE ? [] : [...document.querySelectorAll('a[href]')].map((a) => a.href);
  return { elements: out, links, forms: document.forms.length, title: document.title };
})()`;
