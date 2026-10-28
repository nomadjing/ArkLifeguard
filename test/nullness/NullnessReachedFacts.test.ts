import { describe, expect, it } from 'vitest';
import { ArkAssignStmt, Local, NullConstant, Scene, type Stmt } from '../../src/adapter/arkanalyzer';
import { NullnessAnalysisRunner } from '../../src/analysis/nullness/NullnessAnalysisRunner';
import { NullnessAccessPath, NullnessFact, NullnessKind, NullnessOriginKind } from '../../src/analysis/nullness/NullnessFact';

describe('Nullness reached-fact merging', () => {
    it('preserves colliding facts, statement separation and the first provenance', () => {
        const firstLocal = new Local('value');
        const otherLocal = new Local('value');
        const firstStmt = new ArkAssignStmt(firstLocal, NullConstant.getInstance());
        const secondStmt = new ArkAssignStmt(otherLocal, NullConstant.getInstance());
        const fact = (local: Local, stmt: Stmt) => NullnessFact.create(
            NullnessAccessPath.fromValue(local), NullnessKind.Null,
            { kind: NullnessOriginKind.NullLiteral, stmt }
        );
        const first = fact(firstLocal, firstStmt);
        const same = fact(firstLocal, secondStmt);
        const colliding = fact(otherLocal, secondStmt);
        expect(first.equals(same)).toBe(true);
        expect(first.hashCode()).toBe(colliding.hashCode());
        expect(first.equals(colliding)).toBe(false);

        const runner = new NullnessAnalysisRunner(new Scene());
        const original = [first];
        const target = new Map<Stmt, NullnessFact[]>([[firstStmt, original]]);
        runner['mergeReachedFacts'](target, new Map([
            [firstStmt, [same, colliding, fact(otherLocal, firstStmt)]],
            [secondStmt, [same]],
        ]));
        runner['mergeReachedFacts'](target, new Map([[firstStmt, [same, colliding]]]));

        expect(target.get(firstStmt)).toBe(original);
        expect(target.get(firstStmt)).toEqual([first, colliding]);
        expect(target.get(firstStmt)![0]).toBe(first);
        expect(target.get(secondStmt)).toEqual([same]);
    });
});
