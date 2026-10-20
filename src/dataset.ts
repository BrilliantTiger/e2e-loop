// Dataset 설정 (오류 P: 판정식 안에 Dataset 전용 예외 목록을 박음).
// 같은 화면이라도 Dataset 마다 의도된 값이 다르다(예: 「안 보냄」이 의도된 표 목록). 이 목록을 판정식(eval·기대 글)에 박으면
// 다른 Dataset 에서 돌릴 때 의도된 동작이 FAIL 로 나온다. 그래서 Dataset 마다 값을 설정에 두고(근거: 기획서 규칙),
// 스텝 글에서는 {{dataset.<이름>}} 으로 읽는다. 케이스는 쓰는 Dataset 을 dataset 필드로 적는다.
import type { Case, Config, DatasetProfile, Step } from "./types.ts";

const TOKEN = /\{\{\s*dataset\.([\w.-]+)\s*\}\}/g;
const WHOLE = /^\{\{\s*dataset\.([\w.-]+)\s*\}\}$/;

const pathGet = (o: unknown, path: string): unknown => path.split(".").reduce<any>((x, k) => (x == null ? undefined : x[k]), o);

export const datasetOf = (cfg: Pick<Config, "datasets">, c: Pick<Case, "dataset">): DatasetProfile | undefined => (c.dataset ? cfg.datasets?.[c.dataset] : undefined);

/** 스텝 글이 Dataset 값을 읽는가 */
export const usesDataset = (s: Step): boolean => /\{\{\s*dataset\./.test(JSON.stringify(s));

/**
 * 스텝의 {{dataset.<이름>}} 을 설정 값으로 바꾼다. 글 전체가 토큰이면 값 그대로(배열·숫자도),
 * 글 안에 섞였으면 스크립트(script)는 JSON 으로, 다른 글은 글자로(배열은 「, 」로 이어) 넣는다. 없는 이름은 missing 에 모은다.
 */
export function fillDataset(step: Step, profile: DatasetProfile | undefined): { step: Step; missing: string[] } {
  const missing: string[] = [];
  const get = (name: string) => {
    const v = pathGet(profile?.values, name);
    if (v === undefined) missing.push(name);
    return v;
  };
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === "string") {
      const whole = WHOLE.exec(v);
      if (whole) return get(whole[1]!) ?? v;
      if (!v.includes("{{")) return v;
      return v.replace(TOKEN, (m, name: string) => {
        const x = get(name);
        if (x === undefined) return m;
        if (key === "script") return JSON.stringify(x);
        return Array.isArray(x) ? x.join(", ") : String(x);
      });
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  if (!JSON.stringify(step).includes("{{")) return { step, missing };
  return { step: walk(step, "") as Step, missing: [...new Set(missing)] };
}

/** Dataset 값의 글자 조각(배열·객체 안까지) */
function leaves(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v] : [];
  if (typeof v === "number") return [String(v)];
  if (Array.isArray(v)) return v.flatMap(leaves);
  if (v && typeof v === "object") return Object.values(v).flatMap(leaves);
  return [];
}

export interface HardValue {
  dataset: string;
  key: string;
  value: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 스텝 하나에 따옴표로 박힌 Dataset 전용 값. 여러 Dataset 에 같이 있는 값은 「전용」이 아니라 세지 않는다 */
export function hardValuesIn(step: Step, datasets: Config["datasets"]): HardValue[] {
  if (!datasets || !Object.keys(datasets).length) return [];
  const { basis: _b, name: _n, ...rest } = step;
  const text = JSON.stringify(rest);
  const owners = new Map<string, Set<string>>();
  for (const [name, d] of Object.entries(datasets)) for (const v of leaves(d.values)) owners.set(v, (owners.get(v) ?? new Set()).add(name));
  const out: HardValue[] = [];
  for (const [name, d] of Object.entries(datasets)) {
    for (const [key, val] of Object.entries(d.values ?? {})) {
      for (const v of leaves(val)) {
        if ((owners.get(v)?.size ?? 0) > 1) continue;
        // 'te' · "te" · `te` · \"te\" 처럼 따옴표로 감싼 값만 본다(글자 조각이 우연히 겹친 것은 세지 않는다)
        if (new RegExp(`(?:\\\\"|['"\`])${esc(v)}(?:\\\\"|['"\`])`).test(text)) out.push({ dataset: name, key, value: v });
      }
    }
  }
  return out;
}

/** 케이스 전체에 박힌 Dataset 전용 값: 자기 Dataset 의 것(own)과 다른 Dataset 의 것(foreign) */
export function hardValues(c: Pick<Case, "steps" | "dataset">, datasets: Config["datasets"]): { own: HardValue[]; foreign: HardValue[] } {
  const all = c.steps.flatMap((s) => hardValuesIn(s, datasets));
  return { own: all.filter((h) => h.dataset === c.dataset), foreign: all.filter((h) => h.dataset !== c.dataset) };
}

/** 「가.notSent=te,tv」 */
export const describeHard = (list: HardValue[]): string => {
  const g = new Map<string, string[]>();
  for (const h of list) g.set(`${h.dataset}.${h.key}`, [...(g.get(`${h.dataset}.${h.key}`) ?? []), h.value]);
  return [...g].map(([k, vs]) => `${k}=${[...new Set(vs)].join(",")}`).join(" · ");
};

export const HARD_VALUE_WARNING = (list: HardValue[], own: boolean) =>
  `판정식에 Dataset 전용 값이 박혀 있음(${describeHard(list)}) — ${own ? "" : "다른 Dataset 의 값이라 이 Dataset 에서는 의도된 동작이 FAIL 로 나올 수 있음. "}값은 e2e_dataset 의 values 에 두고(근거: 기획서 규칙) 스텝에서 {{dataset.<이름>}} 으로 읽을 것(오류 P)`;

// ---- 오류 Q: Dataset 특성(예: 사전 파일 유무)과 어긋난 기대 ----
// Dataset 마다 특성(traits)을 선언한다. 스텝의 when 으로 기대를 특성에 따라 가르고(맞지 않으면 그 스텝은 건너뜀),
// 선언과 어긋난 기대(없는 특성에 기댄 기대, 선언 안 된 특성)는 실행 전에 막는다 — 누르지 않고 NA(Q).

type TraitSpec = NonNullable<DatasetProfile["traits"]>[string];
export const traitValue = (t: TraitSpec | undefined): unknown => (t !== null && typeof t === "object" ? t.value : t);
const traitWords = (t: TraitSpec | undefined): string[] => (t !== null && typeof t === "object" ? (t.words ?? []).filter((w) => w.trim()) : []);
const show = (v: unknown) => (typeof v === "string" ? `"${v}"` : String(v));

/** 스텝이 이 Dataset 에서 쓰이는가(when 의 특성이 모두 맞는가). 선언 안 된 특성은 undeclared */
export function stepApplies(step: Step, profile: DatasetProfile | undefined): { ok: boolean; why?: string; undeclared: string[] } {
  const when = step.when as Record<string, unknown> | undefined;
  if (!when || typeof when !== "object") return { ok: true, undeclared: [] };
  const traits = profile?.traits ?? {};
  const undeclared = Object.keys(when).filter((k) => !(k in traits));
  const off = Object.entries(when).filter(([k, v]) => k in traits && traitValue(traits[k]) !== v);
  return { ok: !undeclared.length && !off.length, why: off.length ? off.map(([k, v]) => `${k}=${show(traitValue(traits[k]))}(이 스텝은 ${show(v)} 일 때)`).join(", ") : undefined, undeclared };
}

/** 기대를 가진 스텝의 글(근거·이름 제외) */
const expectText = (s: Step) => {
  const { basis: _b, name: _n, when: _w, op: _o, ...rest } = s;
  return JSON.stringify(rest);
};

/**
 * 실행 전에 막을 어긋남. ① when 이 있는데 케이스에 dataset 이 없거나 Dataset 이 설정에 없음 ② when 이 선언 안 된 특성을 씀
 * ③ 이 Dataset 에서 쓰이는 기대가 「없음(false)」으로 선언된 특성의 말(words)을 기대함
 */
export function datasetConflicts(c: Pick<Case, "steps" | "dataset">, datasets: Config["datasets"], isExpectation: (s: Step) => boolean): string[] {
  const out: string[] = [];
  const profile = c.dataset ? datasets?.[c.dataset] : undefined;
  c.steps.forEach((s, i) => {
    const n = `#${i + 1}`;
    if (s.when && typeof s.when === "object") {
      if (!c.dataset) return void out.push(`${n}: when 으로 Dataset 특성에 따라 가르는데 케이스에 dataset 이 없음`);
      if (!profile) return void out.push(`${n}: dataset 「${c.dataset}」 이 설정에 없음(e2e_dataset 으로 특성을 선언할 것)`);
      const ap = stepApplies(s, profile);
      if (ap.undeclared.length) return void out.push(`${n}: when 의 특성 ${ap.undeclared.map((k) => `「${k}」`).join(" ")} 이 Dataset 「${c.dataset}」 에 선언돼 있지 않음`);
      if (!ap.ok) return; // 이 Dataset 에서는 쓰지 않는 기대(건너뜀)
    }
    if (!profile?.traits || !isExpectation(s)) return;
    const text = expectText(s).toLowerCase();
    for (const [k, t] of Object.entries(profile.traits)) {
      if (traitValue(t) !== false) continue;
      const hit = traitWords(t).find((w) => text.includes(w.toLowerCase()));
      if (hit) out.push(`${n}: Dataset 「${c.dataset}」 은 ${k}=false(없음)로 선언됐는데 기대에 「${hit}」 — 선언과 어긋난 기대(이 Dataset 에 맞게 when 으로 가르거나 기대를 고칠 것)`);
    }
  });
  return out;
}
