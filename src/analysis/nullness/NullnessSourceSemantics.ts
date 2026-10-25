/*
 * Copyright (c) 2024-2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { ts } from '../../adapter/arkanalyzer';
import type { ArkFile, Stmt } from '../../adapter/arkanalyzer';

export const NULL = 1;
export const UNDEFINED = 2;
const NULLISH = NULL | UNDEFINED;

export interface SourceAccess {
    receiver: string | null;
    member: string | null;
    optional: boolean;
    asserted: boolean;
    excluded: number;
    argumentIndex?: number;
    coercion?: boolean;
    checkedLater?: number;
    indexed?: boolean;
}

interface SourceIndex {
    source: ts.SourceFile;
    accesses: Array<{ start: number; end: number; access: SourceAccess }>;
    conditionEnds: Map<number, number>;
    equalityConditions: Set<number>;
}

interface SourceEffect {
    start: number;
    end: number;
    scope: ts.Node | undefined;
    write: string | null;
    call: boolean;
}

/** Source recovery for lowered expressions. Calls are never treated as stable access paths. */
export class NullnessSourceSemantics {
    private readonly files = new WeakMap<ArkFile, SourceIndex>();
    private readonly statements = new WeakMap<Stmt, readonly SourceAccess[]>();

    isEqualityCondition(stmt: Stmt): boolean {
        if (!stmt.getOriginalText?.()) return false;
        this.getAccesses(stmt);
        const file = stmt.getCfg()?.getDeclaringMethod().getDeclaringArkFile();
        const index = file && this.files.get(file);
        if (!index) return false;
        const position = stmt.getOriginPositionInfo();
        const line = index.source.getLineStarts()[position.getLineNo() - 1];
        return line !== undefined && index.equalityConditions.has(line + position.getColNo() - 1);
    }

    getAccesses(stmt: Stmt): readonly SourceAccess[] {
        const cached = this.statements.get(stmt);
        if (cached) return cached;
        const text = stmt.getOriginalText?.();
        if (!text) return [];
        const position = stmt.getOriginPositionInfo();
        if (position.getLineNo() < 1 || position.getColNo() < 1) return [];
        const file = stmt.getCfg()?.getDeclaringMethod().getDeclaringArkFile();
        if (!file) return [];
        let index = this.files.get(file);
        if (!index) {
            index = this.buildIndex(file);
            this.files.set(file, index);
        }
        const lines = index.source.getLineStarts();
        const line = lines[position.getLineNo() - 1];
        if (line === undefined) return [];
        const start = line + position.getColNo() - 1;
        const end = index.conditionEnds.get(start) ?? start + text.length;
        let low = 0;
        let high = index.accesses.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (index.accesses[middle].start < start) low = middle + 1;
            else high = middle;
        }
        const result: SourceAccess[] = [];
        for (let i = low; i < index.accesses.length && index.accesses[i].start < end; i++) {
            if (index.accesses[i].end <= end) result.push(index.accesses[i].access);
        }
        this.statements.set(stmt, result);
        return result;
    }

    private buildIndex(file: ArkFile): SourceIndex {
        const source = ts.createSourceFile(file.getFilePath(), file.getCode(), ts.ScriptTarget.Latest,
            true, ts.ScriptKind.ETS);
        const index: SourceIndex = { source, accesses: [], conditionEnds: new Map(), equalityConditions: new Set() };
        const effects: SourceEffect[] = [];
        const collectEffects = (node: ts.Node): void => {
            let write: string | null = null;
            if ((ts.isVariableDeclaration(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
                write = node.name.text;
            }
            if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
                node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) write = pathName(node.left);
            if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
                (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
                write = pathName(node.operand);
            }
            if (write || ts.isCallExpression(node)) effects.push({ start: node.getStart(source), end: node.end,
                scope: enclosingFunction(node), write, call: ts.isCallExpression(node) });
            ts.forEachChild(node, collectEffects);
        };
        collectEffects(source);
        const visit = (node: ts.Node): void => {
            if (ts.isIfStatement(node)) {
                const start = node.getStart(source);
                index.conditionEnds.set(start, node.expression.end);
                const comparison = (child: ts.Node): void => {
                    if (ts.isBinaryExpression(child) && [ts.SyntaxKind.EqualsEqualsToken,
                        ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
                        ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(child.operatorToken.kind)) {
                        index.equalityConditions.add(start);
                    }
                    ts.forEachChild(child, comparison);
                };
                comparison(node.expression);
            }
            if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ||
                ts.isCallExpression(node)) {
                // A method call dereferences its qualifier, not the method value a second time.
                const expression = unwrap(node.expression);
                if (!ts.isCallExpression(node) ||
                    !(ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))) {
                    const receiver = pathName(node.expression);
                    index.accesses.push({ start: node.getStart(source), end: node.end, access: {
                        receiver,
                        member: ts.isPropertyAccessExpression(node) ? node.name.text
                            : ts.isElementAccessExpression(node) &&
                                (ts.isNumericLiteral(node.argumentExpression) || ts.isStringLiteral(node.argumentExpression))
                                ? node.argumentExpression.text : null,
                        indexed: ts.isElementAccessExpression(node),
                        optional: !!node.questionDotToken,
                        asserted: hasAssertion(node.expression),
                        excluded: this.excludedAt(node, receiver, effects),
                        checkedLater: lateNullCheck(node, receiver),
                    } });
                }
                if (ts.isCallExpression(node)) {
                    node.arguments.forEach((argument, argumentIndex) => {
                        const receiver = pathName(argument);
                        index.accesses.push({ start: argument.getStart(source), end: argument.end,
                            access: { receiver, member: null, optional: false, asserted: false,
                                excluded: this.excludedAt(argument, receiver, effects), argumentIndex } });
                    });
                }
            } else if (ts.isTemplateSpan(node)) {
                const receiver = pathName(node.expression);
                if (receiver) index.accesses.push({ start: node.getStart(source), end: node.end,
                    access: { receiver, member: 'toString', optional: false, asserted: false,
                        excluded: 0, coercion: true } });
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        index.accesses.sort((left, right) => left.start - right.start);
        return index;
    }

    private excludedAt(access: ts.Node, receiver: string | null, effects: SourceEffect[]): number {
        if (!receiver) return 0;
        const conditions: Array<{ expression: ts.Expression; truth: boolean }> = [];
        let child = access;
        for (let parent = child.parent; parent; child = parent, parent = parent.parent) {
            if (ts.isFunctionLike(parent) || ts.isForStatement(parent) || ts.isForOfStatement(parent) ||
                ts.isForInStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) break;
            if (ts.isBinaryExpression(parent) && child === parent.right) {
                if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
                    conditions.push({ expression: parent.left, truth: true });
                } else if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
                    conditions.push({ expression: parent.left, truth: false });
                }
            } else if (ts.isConditionalExpression(parent) && child !== parent.condition) {
                conditions.push({ expression: parent.condition, truth: child === parent.whenTrue });
            } else if (ts.isIfStatement(parent) && child !== parent.expression) {
                conditions.push({ expression: parent.expression, truth: child === parent.thenStatement });
            } else if (ts.isBlock(parent)) {
                // An earlier guard which exits establishes its opposite on the continuation.
                const position = parent.statements.indexOf(child as ts.Statement);
                for (const previous of parent.statements.slice(0, Math.max(0, position))) {
                    if (!ts.isIfStatement(previous)) continue;
                    if (alwaysExits(previous.thenStatement)) {
                        conditions.push({ expression: previous.expression, truth: false });
                    } else if (previous.elseStatement && alwaysExits(previous.elseStatement)) {
                        conditions.push({ expression: previous.expression, truth: true });
                    }
                }
            }
        }
        const known = new Map(conditions.map(condition => [condition.expression.getText(), condition.truth]));
        let excluded = 0;
        for (const condition of conditions) {
            // Relating a later ternary test to an earlier disjunction requires unchanged state.
            const changed = effects.some(effect => effect.scope === enclosingFunction(access) &&
                effect.start >= condition.expression.end && effect.end <= access.getStart());
            excluded |= excludedBy(condition.expression, condition.truth, receiver, changed ? new Map() : known,
                leaf => !hasInterveningEffect(leaf, access, receiver, effects));
        }
        return excluded;
    }
}

function lateNullCheck(node: ts.Node, receiver: string | null): number {
    if (!receiver) return 0;
    let child = node;
    for (let parent = child.parent; parent && !ts.isFunctionLike(parent);
        child = parent, parent = parent.parent) {
        if (ts.isBinaryExpression(parent) && parent.left === child &&
            parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
            const right = unwrap(parent.right);
            if (ts.isBinaryExpression(right) &&
                (right.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
                    right.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken)) {
                return excludedBy(right, false, receiver, new Map());
            }
        }
    }
    return 0;
}

function unwrap(expression: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) ||
        ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
        expression = expression.expression;
    }
    return expression;
}

function hasAssertion(expression: ts.Expression): boolean {
    while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
        ts.isTypeAssertionExpression(expression)) expression = expression.expression;
    return ts.isNonNullExpression(expression);
}

function pathName(expression: ts.Expression): string | null {
    expression = unwrap(expression);
    if (ts.isIdentifier(expression)) return expression.text;
    if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this';
    if (ts.isPropertyAccessExpression(expression)) {
        const base = pathName(expression.expression);
        return base ? `${base}.${expression.name.text}` : null;
    }
    return null;
}

function knownTruth(expression: ts.Expression, known: Map<string, boolean>): boolean | undefined {
    expression = unwrap(expression);
    const simple = (node: ts.Expression): boolean => ts.isIdentifier(node) || ts.isLiteralExpression(node);
    const correlatable = simple(expression) || (ts.isBinaryExpression(expression) &&
        simple(expression.left) && simple(expression.right) &&
        expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken);
    const direct = correlatable ? known.get(expression.getText()) : undefined;
    if (direct !== undefined) return direct;
    if (ts.isBinaryExpression(expression)) {
        if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            return knownTruth(expression.left, known);
        }
        const left = knownTruth(expression.left, known);
        const right = knownTruth(expression.right, known);
        if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
            if (left === true || right === true) return true;
            if (left === false && right === false) return false;
        }
        if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
            if (left === false || right === false) return false;
            if (left === true && right === true) return true;
        }
    }
    return undefined;
}

function excludedBy(expression: ts.Expression, truth: boolean, receiver: string,
    known: Map<string, boolean>, stable: (expression: ts.Expression) => boolean = () => true): number {
    expression = unwrap(expression);
    if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
        return excludedBy(expression.operand, !truth, receiver, known, stable);
    }
    if (ts.isBinaryExpression(expression)) {
        const operator = expression.operatorToken.kind;
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
            const left = excludedBy(expression.left, truth, receiver, known, stable);
            const right = excludedBy(expression.right, truth, receiver, known, stable);
            if ((operator === ts.SyntaxKind.AmpersandAmpersandToken) === truth) return left | right;
            const leftTruth = knownTruth(expression.left, known);
            const rightTruth = knownTruth(expression.right, known);
            if (leftTruth === !truth) return right;
            if (rightTruth === !truth) return left;
            return left & right;
        }
        if (!stable(expression)) return 0;
        if (operator === ts.SyntaxKind.EqualsToken && truth && pathName(expression.left) === receiver) {
            return NULLISH;
        }
        if (operator === ts.SyntaxKind.InstanceOfKeyword && truth && pathName(expression.left) === receiver) {
            return NULLISH;
        }
        const equal = operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsEqualsToken;
        const unequal = operator === ts.SyntaxKind.ExclamationEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;
        if ((equal && !truth) || (unequal && truth)) {
            const left = pathName(expression.left);
            const right = pathName(expression.right);
            const other = left === receiver ? expression.right : right === receiver ? expression.left : undefined;
            if (other) {
                const kind = other.kind === ts.SyntaxKind.NullKeyword ? NULL
                    : ts.isIdentifier(other) && other.text === 'undefined' ? UNDEFINED : 0;
                return kind && (operator === ts.SyntaxKind.EqualsEqualsToken ||
                    operator === ts.SyntaxKind.ExclamationEqualsToken) ? NULLISH : kind;
            }
        }
    }
    // A truthy object/field also establishes that its receiver prefixes exist.
    const path = pathName(expression);
    return stable(expression) && truth && path &&
        (path === receiver || path.startsWith(`${receiver}.`)) ? NULLISH : 0;
}

/** Source guard recovery must not survive a write, or a possibly mutating call for fields. */
function hasInterveningEffect(condition: ts.Expression, target: ts.Node, receiver: string,
    effects: SourceEffect[]): boolean {
    const scope = enclosingFunction(target);
    return effects.some(effect => effect.scope === scope && effect.start >= condition.end &&
        effect.end <= target.getStart() &&
        ((effect.write && (effect.write === receiver || receiver.startsWith(`${effect.write}.`))) ||
            (receiver.includes('.') && effect.call)));
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
    let parent = node.parent;
    while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
    return parent;
}

function alwaysExits(statement: ts.Statement): boolean {
    if (ts.isBlock(statement)) {
        const last = statement.statements[statement.statements.length - 1];
        return !!last && alwaysExits(last);
    }
    return ts.isReturnStatement(statement) || ts.isThrowStatement(statement);
}
