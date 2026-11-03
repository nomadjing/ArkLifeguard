import { ArkValueTransformer } from 'arkanalyzer/lib/core/common/ArkValueTransformer';
import { ArkAssignStmt, Stmt } from 'arkanalyzer/lib/core/base/Stmt';
import { ArkInstanceInvokeExpr, ArkStaticInvokeExpr } from 'arkanalyzer/lib/core/base/Expr';
import { Local } from 'arkanalyzer/lib/core/base/Local';
import { AnyType, StringType } from 'arkanalyzer/lib/core/base/Type';
import { MethodSignature, MethodSubSignature } from 'arkanalyzer/lib/core/model/ArkSignature';
import { Builtin } from 'arkanalyzer/lib/core/common/Builtin';
import { MethodParameter } from 'arkanalyzer/lib/core/model/builder/ArkMethodBuilder';

// ArkAnalyzer lowers implicit template coercions to receiver.toString(), which
// incorrectly dereferences null/undefined. Represent ECMAScript ToString as a
// built-in static operation instead. Explicit source calls remain untouched.
const parameter = new MethodParameter();
parameter.setName('value');
parameter.setType(AnyType.getInstance());
const toString = new MethodSignature(Builtin.buildBuiltInClassSignature('String'),
    new MethodSubSignature('ToString', [parameter],
        StringType.getInstance(), true));
type PlaceholderResult = { placeholderStringLocals: Local[]; newStmts: Stmt[] };
type TemplateTransformer = {
    processTemplatePlaceholders: (...args: unknown[]) => PlaceholderResult;
};
// This dependency hook is private in its .d.ts, but present on the runtime prototype.
const prototype = ArkValueTransformer.prototype as unknown as TemplateTransformer;
const original = prototype.processTemplatePlaceholders;
prototype.processTemplatePlaceholders = function (...args: unknown[]): PlaceholderResult {
    const result = original.apply(this, args);
    for (const local of result.placeholderStringLocals) {
        const stmt = result.newStmts.find(stmt => stmt instanceof ArkAssignStmt && stmt.getLeftOp() === local);
        if (!(stmt instanceof ArkAssignStmt)) continue;
        const invoke = stmt.getRightOp();
        if (!(invoke instanceof ArkInstanceInvokeExpr)) continue;
        stmt.setRightOp(new ArkStaticInvokeExpr(toString, [invoke.getBase()]));
        local.setType(StringType.getInstance());
    }
    return result;
};
