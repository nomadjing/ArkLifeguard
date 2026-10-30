import { ts } from '../../adapter/arkanalyzer';

interface State { assigned: boolean; flags: Map<string, boolean>; }

/** Bounded source proof for a local declaration and Boolean early-exit flags. No loops or closures. */
export function assignedBeforeUse(body: ts.Block, target: ts.Node, name: string): boolean {
    let unsupported = false;
    let declarations = 0;
    const locals = new Set<string>();
    const inspect = (node: ts.Node): void => {
        if (node.getStart() > target.getStart()) return;
        if (ts.isForOfStatement(node) && node.expression.pos <= target.pos && target.end <= node.expression.end) {
            inspect(node.expression);
            return;
        }
        if (node !== body && (ts.isFunctionLike(node) || ts.isIterationStatement(node, false) ||
            ts.isTryStatement(node) || ts.isSwitchStatement(node))) unsupported = true;
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            if (locals.has(node.name.text) || node.parent.parent.parent !== body) unsupported = true;
            locals.add(node.name.text);
            if (node.name.text === name) declarations++;
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
            !(node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) &&
                ts.isExpressionStatement(node.parent))) unsupported = true;
        if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
            (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) unsupported = true;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') unsupported = true;
        ts.forEachChild(node, inspect);
    };
    inspect(body);
    if (unsupported || declarations !== 1) return false;
    const contains = (node: ts.Node): boolean => node.pos <= target.pos && node.end >= target.end;
    const fork = (state: State): State => ({ assigned: state.assigned, flags: new Map(state.flags) });
    const concreteValue = (expression: ts.Expression): boolean => {
        if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
            ts.isNonNullExpression(expression)) return concreteValue(expression.expression);
        return ts.isNewExpression(expression) || ts.isArrayLiteralExpression(expression) ||
            ts.isObjectLiteralExpression(expression) || ts.isStringLiteral(expression) ||
            ts.isNumericLiteral(expression) || expression.kind === ts.SyntaxKind.TrueKeyword ||
            expression.kind === ts.SyntaxKind.FalseKeyword;
    };
    const truth = (expression: ts.Expression, state: State): boolean | undefined => {
        if (ts.isParenthesizedExpression(expression)) return truth(expression.expression, state);
        if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
        if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
        if (ts.isIdentifier(expression)) return state.flags.get(expression.text);
        if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
            const value = truth(expression.operand, state);
            return value === undefined ? undefined : !value;
        }
        return undefined;
    };
    let atUse: State[] = [];
    const run = (statement: ts.Statement, states: State[]): State[] => {
        if (states.length > 32) { unsupported = true; return []; }
        if (ts.isBlock(statement)) {
            for (const child of statement.statements) {
                states = run(child, states);
                if (contains(child)) break;
            }
            return states;
        }
        if (ts.isIfStatement(statement)) {
            if (contains(statement.expression)) { atUse.push(...states); return []; }
            const yes: State[] = [], no: State[] = [];
            for (const state of states) {
                const value = truth(statement.expression, state);
                if (value !== false) yes.push(fork(state));
                if (value !== true) no.push(fork(state));
            }
            const thenStates = run(statement.thenStatement, yes);
            const elseStates = statement.elseStatement ? run(statement.elseStatement, no) : no;
            return [...thenStates, ...elseStates];
        }
        if (contains(statement)) { atUse.push(...states); return []; }
        if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return [];
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) { unsupported = true; return []; }
                const variable = declaration.name.text;
                for (const state of states) {
                    if (variable === name) state.assigned = !!declaration.initializer && concreteValue(declaration.initializer);
                    const value = declaration.initializer && truth(declaration.initializer, state);
                    if (value === undefined) state.flags.delete(variable); else state.flags.set(variable, value);
                }
            }
        } else if (ts.isExpressionStatement(statement)) {
            const expression = statement.expression;
            if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(expression.left)) {
                for (const state of states) {
                    const variable = expression.left.text;
                    const value = truth(expression.right, state);
                    // A copy/call may carry this very declaration's undefined through an alias.
                    // Only a concrete new value discharges the old uninitialized alternative.
                    if (variable === name) state.assigned = concreteValue(expression.right);
                    if (value === undefined) state.flags.delete(variable); else state.flags.set(variable, value);
                }
            } else {
                // Do not retain a flag through an expression with unmodeled assignments/increments.
                for (const state of states) state.flags.clear();
            }
        } else if (!ts.isEmptyStatement(statement)) {
            unsupported = true;
        }
        return states;
    };
    run(body, [{ assigned: false, flags: new Map() }]);
    return !unsupported && atUse.length > 0 && atUse.every(state => state.assigned);
}
