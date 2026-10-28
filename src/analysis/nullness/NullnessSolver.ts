/*
 * Copyright (c) 2024-2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Scene } from '../../adapter/arkanalyzer';
import type { Stmt } from '../../adapter/arkanalyzer';
import { PathEdge, PathEdgePoint } from '../../ifds';
import type { ArkMethod } from '../../adapter/arkanalyzer';
import { DataflowSolver } from '../../ifds';
import type { DataflowSolverOptions, InterproceduralCFG } from '../../ifds';
import { NullnessFact } from './NullnessFact';
import { NullnessProblem } from './NullnessProblem';
import { findRecursiveMethods } from '../../ifds/CallResolver';

/** Nullness-specific fact abstraction and propagation bounds over the shared IFDS solver. */
export class NullnessSolver extends DataflowSolver<NullnessFact> {
    private readonly recursiveMethods: ReadonlySet<ArkMethod>;
    private readonly largeProjectWidening: boolean;

    constructor(
        problem: NullnessProblem,
        scene: Scene,
        options: DataflowSolverOptions = {},
        recursiveMethods?: ReadonlySet<ArkMethod>,
        icfg?: InterproceduralCFG
    ) {
        super(problem, scene, options, icfg);
        this.recursiveMethods = problem.getConfig().recursiveSccWidening
            ? recursiveMethods ?? findRecursiveMethods(scene)
            : new Set();
        this.largeProjectWidening = scene.getMethods().length >= problem.getConfig().largeProjectWideningThreshold;
    }

    protected prepareEdgeForPropagation(edge: PathEdge<NullnessFact>): PathEdge<NullnessFact> | null {
        edge = this.abstractEdgeFacts(edge);
        if (!edge.edgeEnd.fact.isZeroFact() && edge.edgeEnd.fact.propagationDepth > (this.problem as NullnessProblem).getConfig().maxPropagationDepth) {
            return null;
        }
        return edge;
    }

    protected createCalleeStartPoint(firstStmt: Stmt, fact: NullnessFact): PathEdgePoint<NullnessFact> {
        const rawPoint = new PathEdgePoint(firstStmt, fact);
        return new PathEdgePoint(firstStmt, this.abstractPointFact(rawPoint, true));
    }

    private abstractEdgeFacts(edge: PathEdge<NullnessFact>): PathEdge<NullnessFact> {
        const startFact = this.abstractPointFact(edge.edgeStart, true);
        const endFact = this.abstractPointFact(edge.edgeEnd);
        if (startFact === edge.edgeStart.fact && endFact === edge.edgeEnd.fact) {
            return edge;
        }
        return new PathEdge(new PathEdgePoint(edge.edgeStart.node, startFact), new PathEdgePoint(edge.edgeEnd.node, endFact));
    }

    private abstractPointFact(point: PathEdgePoint<NullnessFact>, methodEntry: boolean = false): NullnessFact {
        const config = (this.problem as NullnessProblem).getConfig();
        const method = point.node.getCfg()?.getDeclaringMethod();
        const recursive = config.recursiveSccWidening && method !== undefined && this.recursiveMethods.has(method);
        let maxLength = recursive ? Math.min(config.maxAccessPathLength, config.recursiveSccAccessPathLength) : config.maxAccessPathLength;
        if (this.largeProjectWidening) {
            maxLength = Math.min(maxLength, config.largeProjectAccessPathLength);
        }
        const bounded = point.fact.abstractAccessPath(maxLength);
        return recursive || (this.largeProjectWidening && methodEntry) ? bounded.widenKindForRecursion() : bounded;
    }
}
