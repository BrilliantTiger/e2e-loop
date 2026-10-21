// 공용 타입. 스텝은 JSON 으로 저장되므로 느슨하게 둔다(검증은 runner 에서).
export type Step = { op: string; [k: string]: any };

export type CaseStatus = "active" | "blocked" | "na";
/** logout=로그아웃(테스트하고 다시 로그인), delete=삭제(테스터가 등록한 데이터만), destructive=그 밖의 파괴적 동작(스킵) */
export type Risk = "safe" | "mutating" | "logout" | "delete" | "destructive";

export interface Case {
  id: string;
  title: string;
  /** spec = 기획서/디자인/기능정의서에서 옮긴 케이스, probe = 사이트 탐색으로 자동 생성한 케이스 */
  type: "spec" | "probe";
  /** 점검하는 이벤트 종류: nav click input select toggle tab form-empty form-valid modal-close ... */
  event?: string;
  /** 근거 위치. 예: "기획서 3.2절", "Figma 2673:222145" */
  source_ref?: string;
  /** 인벤토리 요소 id (probe 는 필수, spec 은 선택) */
  element?: string;
  area?: string;
  risk?: Risk;
  status?: CaseStatus;
  reason?: string;
  steps: Step[];
  /** 예약된 태그: allow-errors(오류 응답 허용), os-window(브라우저 밖 OS 창을 거침 — 컴퓨터 제어 도구가 맡음) */
  tags?: string[];
  /** 시트의 묶음: 화면 → 기능 단위 → 케이스 */
  screen?: string;
  feature?: string;
  /** 규칙이나 사용자 선택으로 일부러 돌리지 않는 케이스(결과는 SKIP) */
  skipReason?: string;
  /** 긴 계산을 기다리는 케이스의 대기 상한(초). 끝 상태 대기(wait.endStates)의 전체 상한이 되고, 60초 무변화는 로그만 남기고 상한까지 기다린다. 진행 신호가 보이는 동안도 이 상한까지 기다린다(넘으면 NA L). 예: 12분짜리 계산이면 720 이상 */
  maxWaitSec?: number;
  /** 챕터 이름(예: "C9"). 없으면 화면|기능 단위가 챕터다. 다른 케이스의 `requires` 가 이 이름을 가리킨다 */
  chapter?: string;
  /** 준비 신호: 서버의 비동기 계산이 끝났다는 신호(API 값 또는 화면 요소). 첫 동작 전에 이 신호가 모두 올 때까지 누르지 않고 기다린다. 상한 안에 안 오면 NA(M) */
  ready?: ReadySignal | ReadySignal[];
  /** 이 케이스가 쓰는 대상의 잠금 키(예: "dataset:123"). 챕터가 시작할 때 잠그고, 다른 프로세스가 같은 대상을 쓰는 중이면 그 챕터는 누르지 않고 NA(N) */
  lock?: string | string[];
  /** 이 케이스가 기대는 선행 챕터 이름들. 선행 챕터에 제품 FAIL 이 있으면 이 케이스는 돌리지 않고 NA(H) */
  requires?: string[];
  /** 이 케이스가 쓰는 Dataset 이름(설정 datasets 의 키). 스텝 글의 {{dataset.<이름>}} 이 이 Dataset 의 값으로 바뀐다 */
  dataset?: string;
}

/** Dataset 마다 다른 것: 전용 값(예: 「안 보냄」이 의도된 표 목록)과 그 근거 */
export interface DatasetProfile {
  /** 전용 값. 스텝 글에서 {{dataset.<이름>}} 으로 읽는다(판정식에 박지 않는다) */
  values?: Record<string, unknown>;
  /** 값의 근거(기획서 규칙 번호. 예: POL-CCB_048) */
  basis?: string;
  /** 특성(예: dictFile: false — 사전 파일 없음). words 를 적으면 그 말이 든 기대를 그 특성에 기댄 기대로 본다. 스텝의 when 으로 기대를 특성에 따라 가른다 */
  traits?: Record<string, boolean | string | number | { value: boolean | string | number; words?: string[] }>;
}

/** 준비 신호 하나. api 나 sel 중 하나를 쓴다 */
export interface ReadySignal {
  /** 사람이 읽는 이름(예: "Time key 후보 최신") */
  name?: string;
  /** API 값: 응답이 json 의 경로마다 그 값이면 준비됨. via:"page" 면 브라우저 안에서 보낸다(로그인 세션) */
  api?: { url: string; method?: string; via?: "page"; status?: unknown; json?: Record<string, unknown> };
  /** 화면 요소: 보이고, text/textContains 가 있으면 그 글자일 때 준비됨 */
  sel?: string;
  text?: string;
  textContains?: string;
  /** 상한(초). 없으면 케이스 maxWaitSec, 그것도 없으면 600 */
  timeoutSec?: number;
  /** 다시 묻는 간격(ms). 기본 2000 */
  pollMs?: number;
}

export type DriverName = "auto" | "ego" | "chrome" | "edge" | "chromium";
export type DataPolicy = "ask" | "reset" | "keep";

export interface Config {
  baseUrl: string;
  driver: DriverName;
  headless: boolean;
  viewport: { width: number; height: number };
  /** 코드 변경 감지(회차 도중 수정 방지)에 쓰는 저장소 경로. 기본: 프로젝트 루트 */
  codeRoot?: string;
  data: {
    policy: DataPolicy;
    /** 데이터 초기화 명령(셸). 회차 시작 전(또는 케이스마다) 실행 */
    resetCommand?: string;
    resetCwd?: string;
    resetScope: "round" | "case";
  };
  auth?: {
    /** 페이지 로드 전에 심을 localStorage. 값에 ${ENV_NAME} 사용 가능 */
    localStorage?: Record<string, string>;
    cookies?: { name: string; value: string; url?: string; domain?: string; path?: string }[];
    /** 케이스마다 맨 앞에 실행할 스텝(로그인 등) */
    setupSteps?: Step[];
    /** 로그인 화면 주소(정규식). 시험 도중 이 화면으로 튕기면 로그인 만료(오류 V) */
    loginPath?: string;
    /** 심을 토큰의 남은 시간이 이보다 짧으면(분) 시작하지 않는다. 기본 240 */
    minRemainingMin?: number;
  };
  crawl: {
    maxPages: number;
    maxDepth: number;
    seeds: string[];
    ignore: string[]; // 정규식 문자열. 링크 URL 에 매치되면 방문하지 않음
    reveal: boolean; // 버튼을 눌러 모달/패널을 열어 안쪽 요소까지 수집
    maxRevealPerPage: number;
  };
  /** 로그아웃으로 분류할 텍스트(정규식 문자열, 대소문자 무시) */
  logoutPattern: string;
  /** 삭제로 분류할 텍스트 */
  deletePattern: string;
  /** 그 밖의 파괴적 동작으로 분류할 텍스트 */
  destructivePattern: string;
  /** 라운드 상한(전체 라운드 기준). 기본 10 */
  maxRounds: number;
  /** 같은 이슈가 이 횟수만큼 전체 라운드에서 연속으로 나오면 사용자에게 올린다. 기본 3(확정 요구사항). 한 표를 끝내는 데 더 걸리면 사용자가 7 등으로 올린다 */
  repeatLimit: number;
  /** 증거(영상·스크린샷) 보관 용량 상한(MB). 넘기 전에 알린다 */
  evidenceLimitMB: number;
  /** 사용자가 이슈로 승격한 경고: 경고 문구에 match(부분 문자열)가 들어 있으면 그 케이스를 실패로 본다. case 가 있으면 그 케이스에만 */
  promotedWarnings: { match: string; case?: string; note?: string }[];
  /** 사람이 근거를 대고 "검증 못 해도 완료로 봄"으로 받아들인 케이스 id */
  acceptedSkips: string[];
  dashboardPort: number;
  /** 현황판 코멘트에 일회용 AI 로 자동 응답할지: off(기본, 사용자가 켜야 함) / answer(읽기·코드 분석만, 답만 함) / fix(answer + 오너가 수정 지시한 것은 코드까지 고침) */
  responder: { mode: "off" | "answer" | "fix"; agent?: "claude" | "codex"; /** 연달아 달린 코멘트를 묶어 한 번에 처리하는 대기 시간(초). 호출 횟수 상한은 두지 않는다 */ batchSeconds: number };
  /** 영상 프레임 상한(fps). 화면이 바뀔 때만 프레임이 만들어지므로 정지 구간은 용량이 들지 않는다. 기본 60 */
  videoFps: number;
  /** 현황판을 띄울 내부망 IP(192.168.x.x · 10.x.x.x). 비우면 첫 내부망 주소 */
  dashboardHost?: string;
  probes: "auto" | "off";
  stepTimeoutMs: number;
  /** 멈춤 측정: 누르는 스텝마다 화면이 멈췄는지 잰다(기능 판정과 따로). mode 기본 on, limitMs(멈춤으로 볼 길이) 기본 1000 */
  freeze?: { mode?: "on" | "off"; limitMs?: number };
  /** Dataset 이름 → 그 Dataset 의 전용 값·근거(e2e_dataset 으로 기록) */
  datasets?: Record<string, DatasetProfile>;
}

export interface Source {
  id: string;
  kind: "plan" | "design" | "feature-spec" | "code" | "live-site";
  title: string;
  location: string; // 파일 경로 / URL
  sections?: string[]; // 근거 절 목록(커버리지 확인용)
  addedAt: string;
}

export interface InvElement {
  id: string;
  page: string; // 경로
  layer: string; // "page" 또는 "modal:<trigger id>"
  tag: string;
  kind: string; // link button input select toggle tab summary textarea ...
  inputType?: string;
  label: string;
  selector: string;
  href?: string;
  external?: boolean;
  disabled?: boolean;
  required?: boolean;
  formKey?: string;
  options?: string[];
  attrs?: Record<string, string>;
  risk: Risk;
  opensModal?: boolean;
  /** 눌렀을 때 파일이 내려받아지는 링크(download 속성 또는 파일 확장자) */
  download?: boolean;
}

export interface Inventory {
  generatedAt: string;
  baseUrl: string;
  pages: { path: string; title: string; elements: number; forms: number; depth: number; error?: string; /** link=링크로 닿음, code=코드 분석에서 알게 된 화면을 직접 열었음, seed=사용자가 준 시작 주소 */ via?: "link" | "code" | "seed" }[];
  elements: InvElement[];
  skipped: { url: string; reason: string }[];
  /** 화면을 열고 눌러 보는 동안 브라우저가 보낸 API 요청(fetch·XHR) */
  apis?: ObservedApi[];
}

export interface ObservedApi {
  method: string;
  /** 쿼리를 뗀 경로 */
  path: string;
  /** 처음 본 요청의 경로+쿼리 */
  sample: string;
  status: number;
  contentType?: string;
  /** JSON 객체 응답의 최상위 키 */
  jsonKeys?: string[];
  jsonArray?: boolean;
  /** 이 요청을 처음 본 화면 */
  page: string;
  sameOrigin: boolean;
  count: number;
}

export type Verdict = "PASS" | "FAIL" | "FLAKY" | "BLOCKED" | "NA" | "SKIP";

/** 도구 오류의 원인: A 오지 않을 상태를 기다림 · B 줄 번호 재사용 · C 요소 찾는 방법이 화면과 다름 · D 그리기 전에 읽음 · E 기대가 기획서와 다름 · F 앞 단계가 실패했는데 뒤 단계를 계속 누름 · G 판정용 문자열을 잘라서 비교 · L 진행 중인데 무변화 종료 규칙으로 끝냄 · M 서버 비동기 계산이 안 끝났는데 누름 · N 같은 탭·같은 Dataset 에서 챕터 두 개가 동시에 돎 · O 창이 가려진 채 잰 멈춤 측정(측정 무효) · U 화면 열기의 멈춤이 재현되지 않음(첫 로드 비용·동시 부하) · P 판정식 안에 다른 Dataset 전용 값을 박음 · Q Dataset 특성 선언과 어긋난 기대 · R 선행 챕터가 도구 오류로 끝나 하위 챕터를 돌리지 않음 · S 기획서와 화면설계서가 다른 기대 */
export type ToolErrorKind = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "L" | "M" | "N" | "O" | "P" | "Q" | "R" | "S" | "U" | "V";

export interface StepResult {
  i: number;
  op: string;
  desc: string;
  status: "ok" | "fail" | "skip";
  ms: number;
  error?: string;
  shot?: string; // evidence 상대 경로
  /** 케이스 시작(세션 시작)으로부터 이 스텝이 시작된 시각(ms) — 영상 챕터에 쓴다 */
  at?: number;
  /** 이 케이스(라운드)에서 처음 쓰는 요소면, 찾은 요소의 글자·값·식별 속성(눈으로 확인하도록 로그에 남긴다) */
  found?: string;
  /** api 스텝이면 요청·응답(AI용 시트에 쓴다) */
  api?: { method: string; url: string; status?: number; requestBody?: string; responseBody?: string; via: "server" | "page" };
  /** 멈춤 측정(누르는 스텝). 기능 판정(status)과 따로: ok · freeze(1초 넘게 멈춤, 경고) · invalid(창이 가려져 측정 무효, 오류 O) · unconfirmed(화면 열기의 멈춤이 다시 열면 재현 안 됨, 오류 U) */
  measure?: { verdict: "ok" | "freeze" | "invalid" | "unconfirmed"; summary: string; why?: string; /** 창이 보이게 된 뒤 다시 잰 결과 */ remeasured?: string };
}

export interface CaseResult {
  id: string;
  title: string;
  type: string;
  event?: string;
  source_ref?: string;
  element?: string;
  risk?: Risk;
  status: Verdict;
  reason?: string;
  warnings: string[];
  steps: StepResult[];
  console: string[];
  pageErrors: string[];
  failedRequests: string[];
  video?: string;
  /** 영상의 챕터 파일(스텝별 시각) */
  chapters?: string;
  trace?: string;
  /** 불안정 판정을 위해 다시 돌린 결과: 재시도 횟수와 통과·실패 수 */
  retries?: { n: number; pass: number; fail: number; reasons: string[] };
  /** 사용자가 이슈로 승격한 경고 때문에 실패로 바뀐 것 */
  promoted?: boolean;
  /** 시험 도구 탓에 판정하지 못한 것(status 는 NA). 이슈가 아니라 제외 시트로 간다 */
  toolError?: { kind: ToolErrorKind; detail: string; /** 예상 못 한 대화상자의 글자 같은 증거 */ evidenceText?: string; /** F 의 하위 항목: condition = 시험 조건 불성립(일부러 만드는 실패·장애의 조건이 안 섬) */ sub?: "condition" };
  /** 선행 챕터의 제품 결함에 막혀 돌리지 않은 것(status 는 NA, 사유 H). 도구 오류가 아니다 — 제외 시트로 간다 */
  blockedBy?: { chapter: string; by: string[]; detail: string };
  /** 선행 챕터가 도구 오류(NA)로 끝나 돌리지 않은 것(사유 R): 선행 챕터를 다시 시험한 뒤 재시험 대기열에서 돈다 */
  retest?: { after: string; by: string[] };
  /** 증거 파일의 기록(커밋·시각·케이스 id·해시) */
  evidence?: { file: string; sha256: string; rawSha256?: string }[];
  durationMs: number;
  startedAt: string;
  priority?: "P1" | "P2" | "P3";
}

export interface RoundMeta {
  id: string; // R01
  n: number;
  status: "running" | "finished" | "aborted";
  startedAt: string;
  finishedAt?: string;
  driver: string;
  headless: boolean;
  data: { decision: "reset" | "keep" | "manual-reset-done"; resetOutput?: string; scope: string };
  scope: "full" | "partial";
  only?: string[];
  caseHash: string;
  caseCount: number;
  code: { head?: string; dirtyHash?: string };
  /** 이 회차를 시작할 때 아직 반영되지 않은 사용자 요청 */
  pendingFeedback?: { id: string; text: string }[];
  /** 회차 도중 '지금 흐름에서 적용'으로 끼워 넣은 케이스 */
  injected?: string[];
  baseUrl: string;
  summary?: Record<Verdict, number> & { total: number; /** NA 중 시험 도구 오류인 것(해당 없음과 구분) */ toolError?: number; /** NA 중 선행 결함에 막힌 것(사유 H) */ blockedByDefect?: number };
  error?: string;
  /** 영상 변환 실패·ffmpeg 없음 같은 증거 관련 경고 */
  evidenceWarnings?: string[];
}

export interface Feedback {
  id: string;
  text: string;
  createdAt: string;
  /** 요청을 받았을 때 진행 중이던 회차 */
  duringRound?: string;
  /** 어느 회차부터 적용하는가 */
  appliesTo: "next-round" | "now-restart" | "now-in-flow";
  appliesFrom?: string; // 예: R03
  status: "pending" | "done";
  resolvedAt?: string;
  note?: string;
}
