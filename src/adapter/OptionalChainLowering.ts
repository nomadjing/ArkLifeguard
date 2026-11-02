import { ts } from 'arkanalyzer';
import { ArkValueTransformer } from 'arkanalyzer/lib/core/common/ArkValueTransformer';
import { ArkIRTransformer, DummyStmt, type ValueAndStmts } from 'arkanalyzer/lib/core/common/ArkIRTransformer';
import { ArkAssignStmt, ArkIfStmt } from 'arkanalyzer/lib/core/base/Stmt';
import { ArkConditionExpr, ArkDeleteExpr, RelationalBinaryOperator } from 'arkanalyzer/lib/core/base/Expr';
import { BooleanConstant, NullConstant, UndefinedConstant } from 'arkanalyzer/lib/core/base/Constant';
import { ArkInstanceFieldRef } from 'arkanalyzer/lib/core/base/Ref';
import { Local } from 'arkanalyzer/lib/core/base/Local';
import { FullPosition } from 'arkanalyzer/lib/core/base/Position';

type Chain = ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.CallExpression | ts.NonNullExpression;
const originalLower = ArkValueTransformer.prototype.tsNodeToValueAndStmts;
// A defined chain result implies all these evaluated local receivers passed
// their guards. Consumers must check that the original locals stayed stable.
const resultGuards = new WeakMap<Local, readonly Local[]>();
export function getOptionalChainGuards(value: Local): readonly Local[] | undefined {
    return resultGuards.get(value);
}
const bindings = new WeakMap<ArkValueTransformer, Map<ts.Node, ValueAndStmts>>();

function isChain(node: ts.Node): node is Chain {
    return !!(node.flags & ts.NodeFlags.OptionalChain) &&
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ||
            ts.isCallExpression(node) || ts.isNonNullExpression(node));
}

/**
 * ArkAnalyzer 1.0.94 drops optional-chain tokens during value lowering. Install
 * the missing lowering at its public value-transform entry point, before CFG
 * construction. Reuse its ternary markers so all analyses see real branches.
 * No source text, position matching, or application-specific rules are used.
 */
class OptionalChainTransformer extends ArkValueTransformer {
    override tsNodeToValueAndStmts(node: ts.Node): ValueAndStmts {
        const bound = bindings.get(this)?.get(node);
        if (bound) return bound;
        if (ts.isDeleteExpression(node) && isChain(node.expression)) {
            return OptionalChainTransformer.prototype.lowerChain.call(this, node.expression, true);
        }
        if (!isChain(node)) return originalLower.call(this, node);
        return OptionalChainTransformer.prototype.lowerChain.call(this, node, false);
    }

    private lowerChain(node: Chain, deleting: boolean): ValueAndStmts {
        const steps: Chain[] = [];
        let base: ts.Expression = node;
        while (isChain(base)) {
            steps.unshift(base);
            base = base.expression;
        }
        const stmts: ValueAndStmts['stmts'] = [];
        let current = this.tsNodeToValueAndStmts(base);
        stmts.push(...current.stmts);
        const guards: number[] = [];
        const checkedLocals: Local[] = [];
        const result = this.generateTempLocal();
        const positions = [FullPosition.buildFromNode(node, this.sourceFile)];
        const map = bindings.get(this) ?? new Map<ts.Node, ValueAndStmts>();
        bindings.set(this, map);

        for (const step of steps) {
            const optional = !ts.isNonNullExpression(step) && !!step.questionDotToken;
            if (optional) {
                if (ts.isCallExpression(step) && current.value instanceof ArkInstanceFieldRef) {
                    // Capture the method receiver before evaluating its arguments.
                    const receiver = this.arkIRTransformer.generateAssignStmtForValue(
                        current.value.getBase(), current.valueOriginalPositions.slice(1));
                    stmts.push(...receiver.stmts);
                    current = { ...current, value: new ArkInstanceFieldRef(receiver.value as Local,
                        current.value.getFieldSignature(), current.value.isDynamic()) };
                }
                if (current.value instanceof Local) checkedLocals.push(current.value);
                // Snapshot once: index/argument evaluation may mutate the source.
                const snapshot = this.arkIRTransformer.generateAssignStmtForValue(current.value, current.valueOriginalPositions);
                stmts.push(...snapshot.stmts);
                const id = this.conditionalOperatorNo++;
                guards.push(id);
                const guard = new ArkIfStmt(new ArkConditionExpr(snapshot.value,
                    NullConstant.getInstance(), RelationalBinaryOperator.InEquality));
                guard.setOperandOriginalPositions([...snapshot.valueOriginalPositions, FullPosition.DEFAULT]);
                stmts.push(guard, new DummyStmt(ArkIRTransformer.DUMMY_CONDITIONAL_OPERATOR_IF_TRUE_STMT + id));
                // Method calls retain their original receiver. The guarded function
                // value is read above; ordinary property/index steps use the snapshot.
                if (!ts.isCallExpression(step) || current.value instanceof Local) current = snapshot;
            }
            map.set(step.expression, { ...current, stmts: [] });
            try {
                current = originalLower.call(this, step);
            } finally {
                map.delete(step.expression);
            }
            stmts.push(...current.stmts);
        }
        const assign = new ArkAssignStmt(result, deleting ? new ArkDeleteExpr(current.value) : current.value);
        assign.setOperandOriginalPositions([...positions, ...current.valueOriginalPositions]);
        stmts.push(assign);
        for (const id of guards.reverse()) {
            stmts.push(new DummyStmt(ArkIRTransformer.DUMMY_CONDITIONAL_OPERATOR_IF_FALSE_STMT + id));
            const absent = new ArkAssignStmt(result, deleting ? BooleanConstant.getInstance(true) : UndefinedConstant.getInstance());
            absent.setOperandOriginalPositions([...positions, FullPosition.DEFAULT]);
            stmts.push(absent, new DummyStmt(ArkIRTransformer.DUMMY_CONDITIONAL_OPERATOR_END_STMT + id));
        }
        if (!deleting) resultGuards.set(result, checkedLocals);
        return { value: result, valueOriginalPositions: positions, stmts };
    }
}

ArkValueTransformer.prototype.tsNodeToValueAndStmts = OptionalChainTransformer.prototype.tsNodeToValueAndStmts;
