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
                ...(result.closureAnalysis ? {
                    registrationLeaks: result.closureAnalysis.registrationLeaks.length,
                    closureRetentionLeaks: result.closureAnalysis.closureRetentionLeaks.length,
                } : {}),
                ...(result.memoryAnalysis ? {
                    memoryRetentionCandidates: result.memoryAnalysis.memoryRetentionCandidates.length,
                } : {}),
            },
            nullness: {
                enabled: result.nullness.enabled, success: result.nullness.success,
                diagnostics: result.nullness.diagnostics,
                ...(result.nullness.error ? { error: result.nullness.error } : {}),
            },
            resourceAnalysis: resource,
            ...(result.closureAnalysis ? { closureAnalysis: result.closureAnalysis } : {}),
            ...(result.memoryAnalysis ? { memoryAnalysis: result.memoryAnalysis } : {}),
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
        lines.push(...this.retentionLines(result, markdown), '', heading('空指针诊断'), '');
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

    private retentionLines(result: ProjectAnalysisResult, markdown = false): string[] {
        const lines: string[] = [];
        const section = (title: string, enabled: boolean, success: boolean, error?: string): void => {
            lines.push('', markdown ? `## ${title}` : `【${title}】`, '',
                !enabled ? '未启用。' : !success ? `分析未完成：${error ?? '未知错误'}` : '分析完成，以下均为静态候选。');
        };
        const closure = result.closureAnalysis;
        if (closure) {
            section('闭包与注册检测', closure.enabled, closure.success, closure.error);
            if (closure.enabled) {
                lines.push(`未取消注册：${closure.registrationLeaks.length}；闭包保留：${closure.closureRetentionLeaks.length}。`);
                const entries = [...closure.registrationLeaks.map(item => ({ item, path: [] })),
                    ...closure.closureRetentionLeaks.map(item => ({ item, path: item.retentionPath }))];
                for (const { item, path } of entries) {
                    lines.push(`- ${item.ruleId} / ${item.reason}（${item.confidence}）`,
                        `  注册：${this.locationText(item.registration)}；生命周期边界：${this.locationText(item.boundary)}`,
                        `  注册身份：registrar=${item.registrars.join(', ')}；event=${item.events.join(', ')}；callback=${item.callbacks.join(', ')}${item.timerId ? `；timer=${item.timerId}` : ''}`);
                    for (const edge of path) {
                        lines.push(`  保留链：${edge.from} → ${edge.via} → ${edge.to}`);
                    }
                }
                if (closure.unresolvedRuleIds.length) lines.push(`未解析规则：${closure.unresolvedRuleIds.join(', ')}。`);
                if (closure.unsupportedApiFamilies?.length) lines.push(`未支持的 API 家族：${closure.unsupportedApiFamilies.join(', ')}。`);
                if (closure.limitations.length) lines.push(`覆盖限制：${closure.limitations.join(', ')}。`);
            }
        }
        const memory = result.memoryAnalysis;
        if (memory) {
            section('内存保留检测', memory.enabled, memory.success, memory.error);
            if (memory.enabled) {
                lines.push(`内存保留候选：${memory.memoryRetentionCandidates.length}。`);
                for (const item of memory.memoryRetentionCandidates) {
                    lines.push(`- ${item.objectType}（${item.confidence}）`,
                        `  创建：${this.locationText(item.allocation)}；生命周期结束：${this.locationText(item.lifecycleEnd)}`);
                    for (const edge of item.retentionPath) lines.push(`  保留链：${edge.from} → ${edge.via} → ${edge.to}`);
                }
                if (memory.registrationRetentions.length) lines.push(
                    `另有 ${memory.registrationRetentions.length} 条注册保留链关联证据，主诊断归闭包检测，不计入内存候选。`);
                if (memory.limitations.length) lines.push(`覆盖限制：${memory.limitations.join(', ')}。`);
                if (memory.unresolvedRegistrationRuleIds?.length) lines.push(`未解析的注册根规则：${memory.unresolvedRegistrationRuleIds.join(', ')}。`);
                if (memory.unsupportedRegistrationApiFamilies?.length) lines.push(`未支持的注册根规则：${memory.unsupportedRegistrationApiFamilies.join(', ')}。`);
            }
        }
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
