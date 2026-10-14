// 공용 타입. 스텝은 JSON 으로 저장되므로 느슨하게 둔다(검증은 runner 에서).
export type Step = { op: string; [k: string]: any };

export type CaseStatus = "active" | "blocked" | "na";
export type Risk = "safe" | "mutating" | "destructive";

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
  tags?: string[];
}

export type DriverName = "auto" | "ego" | "chrome" | "chromium";
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
  };
  crawl: {
    maxPages: number;
    maxDepth: number;
    seeds: string[];
    ignore: string[]; // 정규식 문자열. 링크 URL 에 매치되면 방문하지 않음
    reveal: boolean; // 버튼을 눌러 모달/패널을 열어 안쪽 요소까지 수집
    maxRevealPerPage: number;
  };
  /** 파괴적 동작으로 분류할 텍스트(정규식 문자열, 대소문자 무시) */
  destructivePattern: string;
  /** 사람이 근거를 대고 "검증 못 해도 완료로 봄"으로 받아들인 케이스 id */
  acceptedSkips: string[];
  dashboardPort: number;
  probes: "auto" | "off";
  stepTimeoutMs: number;
}

export interface Source {
  id: string;
  kind: "plan" | "design" | "feature-spec" | "live-site";
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
}

export interface Inventory {
  generatedAt: string;
  baseUrl: string;
  pages: { path: string; title: string; elements: number; forms: number; depth: number; error?: string }[];
  elements: InvElement[];
  skipped: { url: string; reason: string }[];
}

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "NA" | "SKIP";

export interface StepResult {
  i: number;
  op: string;
  desc: string;
  status: "ok" | "fail" | "skip";
  ms: number;
  error?: string;
  shot?: string; // evidence 상대 경로
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
  trace?: string;
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
  tainted?: string;
  /** 이 회차를 시작할 때 아직 반영되지 않은 사용자 요청 */
  pendingFeedback?: { id: string; text: string }[];
  /** 회차 도중 '지금 흐름에서 적용'으로 끼워 넣은 케이스 */
  injected?: string[];
  baseUrl: string;
  summary?: Record<Verdict, number> & { total: number };
  error?: string;
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
