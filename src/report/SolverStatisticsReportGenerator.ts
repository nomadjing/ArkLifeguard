import fs from 'node:fs';
import path from 'node:path';
import type { ProjectAnalysisResult } from '../application';

export interface SolverStatisticsReport {
    schemaVersion: 2;
    reportKind: 'ifds-solver-statistics';
    project: ProjectAnalysisResult['project'];
    resourceAnalysis: {
        enabled: boolean;
        success: boolean;
        status: ProjectAnalysisResult['resourceAnalysis']['status'];
        statistics: ProjectAnalysisResult['resourceAnalysis']['solverStatistics'] | null;
    };
}

/** Writes developer-only IFDS aggregate statistics separately from user reports. */
export class SolverStatisticsReportGenerator {
    generate(result: ProjectAnalysisResult, outputPath?: string): string {
        const report: SolverStatisticsReport = {
            schemaVersion: 2,
            reportKind: 'ifds-solver-statistics',
            project: result.project,
            resourceAnalysis: {
                enabled: result.resourceAnalysis.enabled,
                success: result.resourceAnalysis.success,
                statistics: result.resourceAnalysis.solverStatistics ?? null,
                status: result.resourceAnalysis.status,
            },
        };
        const content = JSON.stringify(report, null, 2);
        if (outputPath) {
            const resolved = path.resolve(outputPath);
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
            fs.writeFileSync(resolved, content, 'utf8');
        }
        return content;
    }
}
