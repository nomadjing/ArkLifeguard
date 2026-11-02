/*
 * Copyright (c) 2024-2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { ts } from '../../adapter/arkanalyzer';
import type { ArkFile, ArkMethod, Stmt, Value } from '../../adapter/arkanalyzer';
import { assignedBeforeUse } from './DefiniteAssignment';

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
    truthinessConditions: Map<number, Set<string>>;
}

interface SourceEffect {
    start: number;
    end: number;
    write: string | null;
    call: boolean;
}

/** Source recovery for lowered expressions. Calls are never treated as stable access paths. */
export class NullnessSourceSemantics {
    private readonly files = new WeakMap<ArkFile, SourceIndex>();
    private readonly statements = new WeakMap<Stmt, readonly SourceAccess[]>();
    private readonly operands = new WeakMap<Stmt, WeakMap<Value, readonly SourceAccess[] | null>>();
    private readonly arrowMethods = new WeakMap<ArkMethod, boolean>();
    private readonly assignmentProofs = new WeakMap<Stmt, Map<string, { declaration: ts.VariableDeclaration; proven: boolean } | null>>();

    excludesUninitializedLocal(stmt: Stmt, name: string, origin: Stmt): boolean {
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) return false;
        const file = stmt.getCfg()?.getDeclaringMethod().getDeclaringArkFile();
        if (!file || file !== origin.getCfg()?.getDeclaringMethod().getDeclaringArkFile()) return false;
        this.getAccesses(stmt);
        const index = this.files.get(file);
        if (!index) return false;
        const position = stmt.getOriginPositionInfo();
        const line = index.source.getLineStarts()[position.getLineNo() - 1];
        if (line === undefined) return false;
        const offset = line + position.getColNo() - 1;
        const proofs = this.assignmentProofs.get(stmt) ?? new Map();
        this.assignmentProofs.set(stmt, proofs);
        if (!proofs.has(name)) {
            let body: ts.Block | undefined;
            const locate = (node: ts.Node): void => {
                if (node.pos > offset || node.end <= offset) return;
                if (ts.isFunctionLike(node) && 'body' in node && node.body && ts.isBlock(node.body as ts.Node)) {
                    body = node.body as ts.Block;
                }
                ts.forEachChild(node, locate);
            };
            locate(index.source);
            let declaration: ts.VariableDeclaration | undefined;
            let target: ts.Node | undefined;
            const inspect = (node: ts.Node): void => {
                if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
                    node.name.text === name && !node.initializer) declaration = node;
                if (!target && node.getStart() >= offset &&
                    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
                    pathName(node.expression) === name) target = node;
                if (!target && node.getStart() >= offset && ts.isForOfStatement(node) &&
                    pathName(node.expression) === name) target = node.expression;
                if (!target && node.getStart() >= offset && ts.isCallExpression(node)) {
                    target = node.arguments.find(argument => pathName(argument) === name);
                }
                ts.forEachChild(node, inspect);
            };
            if (body) inspect(body);
            proofs.set(name, body && declaration && target
                ? { declaration, proven: assignedBeforeUse(body, target, name) } : null);
        }
        const proof = proofs.get(name);
        const originPosition = origin.getOriginPositionInfo();
        const originLine = index.source.getLineStarts()[originPosition.getLineNo() - 1];
        if (!proof?.proven || originLine === undefined) return false;
        const originOffset = originLine + originPosition.getColNo() - 1;
        const declarationStatement = proof.declaration.parent.parent;
        return declarationStatement.getStart() <= originOffset && originOffset < declarationStatement.end;
    }

    isArrowMethod(method: ArkMethod): boolean {
        const cached = this.arrowMethods.get(method);
        if (cached !== undefined) return cached;
        let arrow = false;
        const code = method.isAnonymousMethod() || method.getOuterMethod() ? method.getCode() : undefined;
        if (code) {
            const source = ts.createSourceFile('callback.ts', `const callback = (${code});`,
                ts.ScriptTarget.Latest, true, ts.ScriptKind.ETS);
            const statement = source.statements[0];
            const initializer = statement && ts.isVariableStatement(statement)
                ? statement.declarationList.declarations[0]?.initializer : undefined;
            arrow = initializer !== undefined && ts.isArrowFunction(unwrap(initializer));
        }
        this.arrowMethods.set(method, arrow);
        return arrow;
    }

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

    isTruthinessCondition(stmt: Stmt, receiver: string): boolean {
        this.getAccesses(stmt);
        const file = stmt.getCfg()?.getDeclaringMethod().getDeclaringArkFile();
        const index = file && this.files.get(file);
        const position = stmt.getOriginPositionInfo();
        const line = index?.source.getLineStarts()[position.getLineNo() - 1];
        return line !== undefined && !!index?.truthinessConditions
            .get(line + position.getColNo() - 1)?.has(receiver);
    }

    getAccesses(stmt: Stmt): readonly SourceAccess[] {
        const cached = this.statements.get(stmt);
        if (cached) return cached;
        const empty = (): readonly SourceAccess[] => {
            const result: readonly SourceAccess[] = [];
            this.statements.set(stmt, result);
            return result;
        };
        const text = stmt.getOriginalText?.();
        if (!text) return empty();
        const position = stmt.getOriginPositionInfo();
        if (position.getLineNo() < 1 || position.getColNo() < 1) return empty();
        const file = stmt.getCfg()?.getDeclaringMethod().getDeclaringArkFile();
        if (!file) return empty();
        let index = this.files.get(file);
        if (!index) {
            index = this.buildIndex(file);
            this.files.set(file, index);
        }
        const lines = index.source.getLineStarts();
        const line = lines[position.getLineNo() - 1];
        if (line === undefined) return empty();
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

    /** Operand positions distinguish accesses lowered from the same containing expression. */
    getOperandAccesses(stmt: Stmt, operand: Value): readonly SourceAccess[] | null {
        const cache = this.operands.get(stmt) ?? new WeakMap();
        this.operands.set(stmt, cache);
        if (cache.has(operand)) return cache.get(operand)!;
        this.getAccesses(stmt);
        const file = stmt.getCfg()?.getDeclaringMethod().getDeclaringArkFile();
        const index = file && this.files.get(file);
        const position = stmt.getOperandOriginalPosition?.(operand);
        const lines = index?.source.getLineStarts();
        const first = position ? lines?.[position.getFirstLine() - 1] : undefined;
        const last = position ? lines?.[position.getLastLine() - 1] : undefined;
        let result: readonly SourceAccess[] | null = null;
        if (index && position && first !== undefined && last !== undefined &&
            position.getFirstCol() > 0 && position.getLastCol() > 0) {
            const start = first + position.getFirstCol() - 1;
            const end = last + position.getLastCol() - 1;
            let low = 0, high = index.accesses.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (index.accesses[middle].start < start) low = middle + 1; else high = middle;
            }
            const matches: SourceIndex['accesses'] = [];
            for (let i = low; i < index.accesses.length && index.accesses[i].start === start; i++) {
                if (index.accesses[i].end === end) matches.push(index.accesses[i]);
            }
            if (matches.length) result = matches.map(match => match.access);
        }
        cache.set(operand, result);
        return result;
    }

    private buildIndex(file: ArkFile): SourceIndex {
        const source = ts.createSourceFile(file.getFilePath(), file.getCode(), ts.ScriptTarget.Latest,
            true, ts.ScriptKind.ETS);
        const index: SourceIndex = { source, accesses: [], conditionEnds: new Map(), equalityConditions: new Set(),
            truthinessConditions: new Map() };
        const effectsByScope = new Map<ts.Node | undefined, SourceEffect[]>();
        const scopes = new WeakMap<ts.Node, ts.Node | undefined>();
        const collectEffects = (node: ts.Node, scope?: ts.Node): void => {
            scopes.set(node, scope);
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
            if (write || ts.isCallExpression(node)) {
                const effects = effectsByScope.get(scope) ?? [];
                effects.push({ start: node.getStart(source), end: node.end,
                    write, call: ts.isCallExpression(node) });
                effectsByScope.set(scope, effects);
            }
            const childScope = ts.isFunctionLike(node) ? node : scope;
            ts.forEachChild(node, child => collectEffects(child, childScope));
        };
        collectEffects(source);
        for (const effects of effectsByScope.values()) effects.sort((a, b) => a.start - b.start);
        const visit = (node: ts.Node): void => {
            if (ts.isIfStatement(node)) {
                const start = node.getStart(source);
                index.conditionEnds.set(start, node.expression.end);
                const paths = new Set<string>();
                const comparedPaths = new Set<string>();
                const collectTruthTests = (expression: ts.Expression): void => {
                    expression = unwrap(expression);
                    if (ts.isBinaryExpression(expression) &&
                        (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
                            expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
                        collectTruthTests(expression.left);
                        collectTruthTests(expression.right);
                    } else if (ts.isPrefixUnaryExpression(expression) &&
                        expression.operator === ts.SyntaxKind.ExclamationToken) {
                        collectTruthTests(expression.operand);
                    } else if (ts.isBinaryExpression(expression)) {
                        // Do not guess which test produced the IR sentinel if the same
                        // receiver is also explicitly compared in this source condition.
                        for (const operand of [expression.left, expression.right]) {
                            const path = pathName(operand);
                            if (path) comparedPaths.add(path);
                        }
                    } else {
                        const path = pathName(expression);
                        if (path) paths.add(path);
                    }
                };
                collectTruthTests(node.expression);
                for (const path of comparedPaths) paths.delete(path);
                index.truthinessConditions.set(start, paths);
            }
            if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsToken,
                ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
                ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) {
                // Ternaries and logical expressions also lower to ArkIfStmt,
                // often with the position of their containing assignment/return.
                for (let parent: ts.Node | undefined = node;
                    parent && !ts.isFunctionLike(parent) && !ts.isBlock(parent); parent = parent.parent) {
                    index.equalityConditions.add(parent.getStart(source));
                }
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
                        excluded: this.excludedAt(node, receiver, effectsByScope.get(scopes.get(node)) ?? []),
                        checkedLater: lateNullCheck(node, receiver),
                    } });
                }
                if (ts.isCallExpression(node)) {
                    node.arguments.forEach((argument, argumentIndex) => {
                        const receiver = pathName(argument);
                        index.accesses.push({ start: argument.getStart(source), end: argument.end,
                            access: { receiver, member: null, optional: false, asserted: false,
                                excluded: this.excludedAt(argument, receiver, effectsByScope.get(scopes.get(argument)) ?? []), argumentIndex } });
                    });
                }
            } else if (ts.isTemplateSpan(node)) {
                const receiver = pathName(node.expression);
                index.accesses.push({ start: node.getStart(source), end: node.end,
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
        const accessStart = access.getStart();
        const known = new Map(conditions.map(condition => [condition.expression.getText(), condition.truth]));
        let excluded = 0;
        for (const condition of conditions) {
            // Relating a later ternary test to an earlier disjunction requires unchanged state.
            const changed = hasEffectBetween(effects, condition.expression.end, accessStart);
            excluded |= excludedBy(condition.expression, condition.truth, receiver, changed ? new Map() : known,
                leaf => !hasInterveningEffect(leaf, accessStart, receiver, effects));
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
        return base ? appendSourceProperty(base, expression.name.text) : null;
    }
    if (ts.isElementAccessExpression(expression) &&
        (ts.isStringLiteral(expression.argumentExpression) || ts.isNumericLiteral(expression.argumentExpression))) {
        const base = pathName(expression.expression);
        return base ? appendSourceProperty(base, expression.argumentExpression.text) : null;
    }
    return null;
}

/** ArkIR retains quotes for unresolved literal field names, but resolves known fields without them. */
export function sourcePropertyName(name: string): string {
    if (name.startsWith("'") || name.startsWith('"')) {
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, name);
        if (scanner.scan() === ts.SyntaxKind.StringLiteral && scanner.getTextPos() === name.length) {
            return scanner.getTokenValue();
        }
    }
    return name;
}

export function appendSourceProperty(base: string, name: string): string {
    return /^[A-Za-z_$][\w$]*$/.test(name) ? `${base}.${name}` : `${base}[${JSON.stringify(name)}]`;
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
        if ((equal && truth) || (unequal && !truth)) {
            const left = unwrap(expression.left);
            const right = unwrap(expression.right);
            const typeOf = ts.isTypeOfExpression(left) ? left : ts.isTypeOfExpression(right) ? right : undefined;
            const tag = typeOf === left ? right : left;
            if (typeOf && ts.isStringLiteral(tag) &&
                ['string', 'number', 'boolean', 'bigint', 'symbol', 'function', 'object'].includes(tag.text)) {
                const path = pathName(typeOf.expression);
                if (path === receiver) return tag.text === 'object' ? UNDEFINED : NULLISH;
                // An optional property cannot have a defined typeof result when its receiver is nullish.
                if (path?.startsWith(`${receiver}.`) || path?.startsWith(`${receiver}[`)) return NULLISH;
            }
        }
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
function hasInterveningEffect(condition: ts.Expression, targetStart: number, receiver: string,
    effects: SourceEffect[]): boolean {
    const field = receiver.includes('.');
    return hasEffectBetween(effects, condition.end, targetStart, effect =>
        !!((effect.write && (effect.write === receiver || receiver.startsWith(`${effect.write}.`))) ||
            (field && effect.call)));
}

/** Effects are sorted and already restricted to the access's enclosing function. */
function hasEffectBetween(effects: readonly SourceEffect[], after: number, before: number,
    matches: (effect: SourceEffect) => boolean = () => true): boolean {
    let low = 0, high = effects.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (effects[middle].start < after) low = middle + 1;
        else high = middle;
    }
    for (let i = low; i < effects.length && effects[i].start <= before; i++) {
        if (effects[i].end <= before && matches(effects[i])) return true;
    }
    return false;
}

function alwaysExits(statement: ts.Statement): boolean {
    if (ts.isBlock(statement)) {
        const last = statement.statements[statement.statements.length - 1];
        return !!last && alwaysExits(last);
    }
    return ts.isReturnStatement(statement) || ts.isThrowStatement(statement) ||
        ts.isContinueStatement(statement) || ts.isBreakStatement(statement);
}
