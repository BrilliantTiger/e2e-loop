// 코드 분석 결과 저장: .e2e/analysis.json (등록된 코드 경로마다 한 건)
import type { Project } from "../store.ts";
import type { CodeAnalysis } from "./code.ts";

export interface AnalysisFile {
  generatedAt: string;
  analyses: CodeAnalysis[];
}

export const loadAnalyses = (p: Project): CodeAnalysis[] => p.readJson<AnalysisFile>("analysis.json", { generatedAt: "", analyses: [] }).analyses;
export const saveAnalyses = (p: Project, analyses: CodeAnalysis[]) => p.writeJson("analysis.json", { generatedAt: new Date().toISOString(), analyses } satisfies AnalysisFile);
