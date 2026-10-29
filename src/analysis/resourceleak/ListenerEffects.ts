import { ArkAssignStmt, ArkInstanceFieldRef, ArkStaticFieldRef, Local, type ArkMethod, type Scene, type Value } from '../../adapter/arkanalyzer';
import type { ListenerRule } from './rules/ListenerRules';

interface Effects { unknown: boolean; cancel: Set<string>; calls: Set<string>; fields: Set<string> }

/** Conservative transitive effects. Absence is a proof only for resolved bodies. */
export class ListenerEffects {
    private readonly methods = new Map<string, Effects>();
    private readonly callers = new Map<string, Set<string>>();
    private readonly fieldSeeds = new Map<string, Set<string>>();
    private readonly fieldInterest = new Map<string, Set<string>>();
    readonly statistics = { entered: 0, skipped: 0, emptyHandleEntries: 0 };

    constructor(scene: Scene, rules: readonly ListenerRule[]) {
        const apis = new Set(rules.flatMap(rule => [...rule.allocators, ...rule.releasers]));
        for (const method of scene.getMethods()) {
            const effect: Effects = { unknown: !method.getCfg(), cancel: new Set(), calls: new Set(), fields: new Set() };
            for (const stmt of method.getCfg()?.getStmts() ?? []) {
                const seen = new Set<Value>();
                const visit = (value: Value | null): void => {
                    if (!value || seen.has(value)) return;
                    seen.add(value);
                    if (value instanceof ArkStaticFieldRef || value instanceof ArkInstanceFieldRef) effect.fields.add(value.getFieldSignature().toString());
                    for (const child of value.getUses()) visit(child);
                };
                visit(stmt.getDef());
                for (const value of stmt.getUses()) visit(value);
                // Shared storage may change a timer/callback identity even without off().
                if (stmt instanceof ArkAssignStmt && !(stmt.getLeftOp() instanceof Local)) effect.unknown = true;
                const signature = stmt.getInvokeExpr()?.getMethodSignature().toString();
                if (!signature) continue;
                for (const rule of rules) if (rule.releasers.includes(signature)) effect.cancel.add(rule.id);
                if (!apis.has(signature)) effect.calls.add(signature);
            }
            const signature = method.getSignature().toString();
            this.methods.set(signature, effect);
            for (const field of effect.fields) {
                const seeds = this.fieldSeeds.get(field) ?? new Set<string>();
                seeds.add(signature); this.fieldSeeds.set(field, seeds);
            }
        }
        const callers = this.callers;
        for (const [signature, effect] of this.methods) for (const call of effect.calls) {
            if (!this.methods.has(call)) effect.unknown = true;
            const entries = callers.get(call) ?? new Set<string>();
            entries.add(signature); callers.set(call, entries);
        }
        const pending = [...this.methods.keys()];
        const queued = new Set(pending);
        for (let head = 0; head < pending.length; head++) {
            const signature = pending[head]; queued.delete(signature);
            const effect = this.methods.get(signature)!;
            for (const caller of callers.get(signature) ?? []) {
                const target = this.methods.get(caller)!;
                let changed = false;
                if (effect.unknown && !target.unknown) { target.unknown = true; changed = true; }
                for (const id of effect.cancel) if (!target.cancel.has(id)) {
                    target.cancel.add(id); changed = true;
                }
                if (changed && !queued.has(caller)) { pending.push(caller); queued.add(caller); }
            }
        }
    }

    mayAffect(method: ArkMethod, ruleId: string): boolean {
        const effect = this.methods.get(method.getSignature().toString());
        return !effect || effect.unknown || effect.cancel.has(ruleId);
    }

    /** Unknown external effects are handled conservatively by the caller bypass.
     * This query only proves absence of modeled cancellation in resolved bodies. */
    mayCancel(method: ArkMethod, ruleId: string): boolean {
        const effect = this.methods.get(method.getSignature().toString());
        return !method.getCfg() || !effect || effect.cancel.has(ruleId);
    }

    mayAccessField(method: ArkMethod, field: string): boolean {
        const effect = this.methods.get(method.getSignature().toString());
        if (!method.getCfg() || !effect) return true;
        let interested = this.fieldInterest.get(field);
        if (!interested) {
            interested = new Set(this.fieldSeeds.get(field) ?? []);
            const pending = [...interested];
            for (let head = 0; head < pending.length; head++) {
                for (const caller of this.callers.get(pending[head]) ?? []) {
                    if (!interested.has(caller)) { interested.add(caller); pending.push(caller); }
                }
            }
            this.fieldInterest.set(field, interested);
        }
        return interested.has(method.getSignature().toString());
    }
}
