import fs from 'node:fs';
import path from 'node:path';
import type { ProjectAnalysisResult } from '../application';

export type ReportFormat = 'json' | 'text' | 'html' | 'markdown';
export interface ReportOptions { format: ReportFormat; outputPath?: string; title?: string }

/** Serializes independent module results; solver metrics belong to the statistics report. */
export class ReportGenerator {
    generate(result: ProjectAnalysisResult, options: ReportOptions): string {
        const content = options.format === 'json'
            ? JSON.stringify(this.compactJson(result), null, 2)
            : options.format === 'html' ? this.html(result, options)
                : this.lines(result, options, options.format === 'markdown').join('\n');
        if (options.outputPath) {
            const output = path.resolve(options.outputPath);
            fs.mkdirSync(path.dirname(output), { recursive: true });
            fs.writeFileSync(output, content, 'utf8');
        }
        return content;
    }

    private compactJson(result: ProjectAnalysisResult): object {
        const { solverStatistics: _statistics, ...resource } = result.resourceAnalysis;
        return {
            schemaVersion: result.schemaVersion, analysisKind: result.analysisKind,
            status: result.status, project: result.project,
            summary: {
                nullDereferences: result.summary.nullDereferences,
                resourceLeaks: result.resourceAnalysis.diagnostics.length,
                ...(result.listenerAnalysis ? { listenerLeaks: result.listenerAnalysis.diagnostics.length } : {}),
            },
            nullness: {
                enabled: result.nullness.enabled, success: result.nullness.success,
                diagnostics: result.nullness.diagnostics,
                ...(result.nullness.error ? { error: result.nullness.error } : {}),
            },
            resourceAnalysis: resource,
            ...(result.listenerAnalysis ? { listenerAnalysis: this.compactListener(result.listenerAnalysis) } : {}),
            duration: { total: result.duration.total }, warnings: result.warnings, errors: result.errors,
        };
    }

    private lines(result: ProjectAnalysisResult, options: ReportOptions, markdown = false): string[] {
        const heading = (title: string): string => markdown ? `## ${title}` : `【${title}】`;
        const resource = result.resourceAnalysis;
        const count = (enabled: boolean, success: boolean, value: number): string | number =>
            !enabled ? '未启用' : !success ? '失败' : value;
        const lines = [markdown ? `# ${options.title ?? 'ArkLifeguard HarmonyOS 静态分析报告'}`
            : options.title ?? 'ArkLifeguard HarmonyOS 静态分析报告', '',
            `项目: ${result.project.name}`, `路径: ${result.project.path}`, `状态: ${result.status}`,
            `时间: ${result.project.analyzedAt}`, '', heading('结果摘要'), '',
            `空指针报告: ${count(result.nullness.enabled, result.nullness.success, result.nullness.diagnostics.length)}`,
            `资源泄漏报告: ${count(resource.enabled, resource.success, resource.diagnostics.length)}`,
            `总耗时: ${result.duration.total}ms`, '', heading('资源泄漏诊断'), ''];
        if (!resource.enabled) lines.push('未启用资源泄漏分析。');
        else if (!resource.success) lines.push(`分析失败：${resource.error ?? '未知错误'}`);
        else if (!resource.diagnostics.length) lines.push('未检出资源泄漏候选问题。');
        else for (const item of resource.diagnostics) {
            lines.push(`- ${item.ruleId}：${item.reason}（${item.confidence}）`,
                `  创建：${this.locationText(item.allocation)}`, `  边界：${this.locationText(item.boundary)}`);
            for (const event of item.evidence.slice(1, -1)) lines.push(`  关键节点：${this.locationText(event)}`);
        }
        if (resource.enabled) {
            if (resource.unresolvedRuleIds?.length) lines.push(`未解析规则：${resource.unresolvedRuleIds.join(', ')}。`);
            if (resource.unsupportedApiFamilies?.length) lines.push(`未支持的 API 家族：${resource.unsupportedApiFamilies.join(', ')}。`);
        }
        lines.push(...this.listenerLines(result, markdown), '', heading('空指针诊断'), '');
        if (!result.nullness.enabled) lines.push('未启用空指针分析。');
        else if (!result.nullness.success) lines.push(`分析失败：${result.nullness.error ?? '未知错误'}`);
        else if (!result.nullness.diagnostics.length) lines.push('未检出空指针候选问题。');
        else for (const item of result.nullness.diagnostics) lines.push(`- ${item.description}（${item.confidence}）`,
            `  位置：${this.locationText(item.dereference)}`, `  来源：${this.locationText(item.source)}`,
            `  访问路径：${item.accessPath}（${item.nullness}）`);
        if (result.warnings.length) lines.push('', heading('警告'), '', ...result.warnings);
        if (result.errors.length) lines.push('', heading('错误'), '', ...result.errors);
        return lines;
    }

    private html(result: ProjectAnalysisResult, options: ReportOptions): string {
        const title = this.escape(options.title ?? 'ArkLifeguard HarmonyOS 静态分析报告');
        const lines = this.lines(result, options);
        const body = lines.slice(1).filter(Boolean).map(line =>
            /^【.+】$/.test(line) ? `<h2>${this.escape(line.slice(1, -1))}</h2>`
                : `<p>${this.escape(line)}</p>`).join('\n');
        return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px/1.6 system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 20px;color:#202124}h1,h2{color:#16324f}p{white-space:pre-wrap;overflow-wrap:anywhere}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
    }

    private compactListener(listener: NonNullable<ProjectAnalysisResult['listenerAnalysis']>): object {
        const { solverStatistics: _statistics, ...result } = listener;
        return result;
    }

    private listenerLines(result: ProjectAnalysisResult, markdown: boolean): string[] {
        const listener = result.listenerAnalysis;
        if (!listener) return [];
        const lines = ['', markdown ? '## Listener 注册清理' : '【Listener 注册清理】', ''];
        if (!listener.enabled) return [...lines, '未启用。'];
        if (!listener.success) lines.push(`分析未完成：${listener.error ?? '未知错误'}`);
        else lines.push(`未解除注册候选：${listener.diagnostics.length}。`);
        for (const item of listener.diagnostics) lines.push(
            `- ${item.ruleId}：${item.reason}（${item.confidence}）`,
            `  注册：${this.locationText(item.allocation)}；边界：${this.locationText(item.boundary)}`);
        if (listener.unresolvedRuleIds?.length) lines.push(`未解析规则：${listener.unresolvedRuleIds.join(', ')}。`);
        if (listener.unsupportedApiFamilies?.length) lines.push(`覆盖限制：${listener.unsupportedApiFamilies.join(', ')}。`);
        return lines;
    }

    private locationText(location: { relativePath?: string; filePath?: string; line: number; col: number }): string {
        return `${location.relativePath ?? location.filePath ?? 'unknown'}:${location.line}:${location.col}`;
    }
    private escape(value: unknown): string {
        return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    }
}
