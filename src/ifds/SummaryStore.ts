import type { Stmt } from "../adapter/arkanalyzer";
import { PathEdge, PathEdgePoint } from "./PathEdge";
import type { FactSemantics } from "./FactSemantics";

interface PointEntry<D, V> {
  point: PathEdgePoint<D>;
  value: V;
}

interface ReturnSummaries<D> {
  points: PathEdgePoint<D>[];
  byFactHash: Map<number, PathEdgePoint<D>[]>;
}

interface CallSummaryEntry<D> {
  byReturnSite: Map<Stmt, ReturnSummaries<D>>;
}

class SemanticPointMap<D, V> {
  private readonly index = new Map<Stmt, Map<number, PointEntry<D, V>[]>>();

  constructor(private readonly semantics: FactSemantics<D>) {}

  get(point: PathEdgePoint<D>): V | undefined {
    const bucket = this.index
      .get(point.node)
      ?.get(this.semantics.factHash(point.fact));
    return bucket?.find((entry) => this.pointsEqual(entry.point, point))?.value;
  }

  getOrCreate(point: PathEdgePoint<D>, create: () => V): V {
    let byFactHash = this.index.get(point.node);
    if (!byFactHash) {
      byFactHash = new Map();
      this.index.set(point.node, byFactHash);
    }
    const hash = this.semantics.factHash(point.fact);
    let bucket = byFactHash.get(hash);
    const existing = bucket?.find((entry) =>
      this.pointsEqual(entry.point, point),
    );
    if (existing) return existing.value;

    const value = create();
    const entry = { point, value };
    if (bucket) {
      bucket.push(entry);
    } else {
      bucket = [entry];
      byFactHash.set(hash, bucket);
    }
    return value;
  }

  clear(): void {
    this.index.clear();
  }

  private pointsEqual(
    left: PathEdgePoint<D>,
    right: PathEdgePoint<D>,
  ): boolean {
    return (
      left.node === right.node &&
      this.semantics.factEqual(left.fact, right.fact)
    );
  }
}

class SemanticPointSet<D> extends Set<PathEdgePoint<D>> {
  private readonly index: SemanticPointMap<D, boolean>;
  constructor(semantics: FactSemantics<D>) { super(); this.index = new SemanticPointMap(semantics); }
  override add(point: PathEdgePoint<D>): this {
    if (this.index.get(point)) return this;
    this.index.getOrCreate(point, () => true);
    return super.add(point);
  }
}

/** Owns collision-safe incoming, end-summary and call-summary state. */
export class SummaryStore<D> {
  private readonly incomingByCall = new WeakMap<ReadonlySet<PathEdge<D>>, SemanticPointMap<D, Set<PathEdge<D>>>>();
  readonly counts = { incoming: 0, normal: 0, exceptional: 0, calls: 0, duplicateExits: 0 };
  private readonly incoming: SemanticPointMap<D, Set<PathEdge<D>>>;
  private readonly endSummaries: SemanticPointMap<D, Set<PathEdgePoint<D>>>;
  private readonly exceptionalEndSummaries: SemanticPointMap<
    D,
    Set<PathEdgePoint<D>>
  >;
  private readonly callSummaries: SemanticPointMap<D, CallSummaryEntry<D>>;

  constructor(private readonly semantics: FactSemantics<D>) {
    this.incoming = new SemanticPointMap(semantics);
    this.endSummaries = new SemanticPointMap(semantics);
    this.exceptionalEndSummaries = new SemanticPointMap(semantics);
    this.callSummaries = new SemanticPointMap(semantics);
  }

  addIncoming(calleeEntry: PathEdgePoint<D>, callerEdge: PathEdge<D>): void {
    const edges = this.incoming.getOrCreate(calleeEntry, () => new Set());
    if (!edges.has(callerEdge)) this.counts.incoming++;
    edges.add(callerEdge);
    let index = this.incomingByCall.get(edges);
    if (!index) { index = new SemanticPointMap(this.semantics); this.incomingByCall.set(edges, index); }
    index.getOrCreate(callerEdge.edgeEnd, () => new Set()).add(callerEdge);
  }

  getIncoming(
    calleeEntry: PathEdgePoint<D>,
  ): ReadonlySet<PathEdge<D>> | undefined {
    return this.incoming.get(calleeEntry);
  }

  matchingIncoming(edges: ReadonlySet<PathEdge<D>>, call: PathEdgePoint<D>): ReadonlySet<PathEdge<D>> {
    return this.incomingByCall.get(edges)?.get(call) ?? edges;
  }

  addEndSummary(entry: PathEdgePoint<D>, exit: PathEdgePoint<D>): boolean {
    const exits = this.endSummaries.getOrCreate(entry, () => new SemanticPointSet(this.semantics));
    const size = exits.size; exits.add(exit);
    if (size === exits.size) { this.counts.duplicateExits++; return false; }
    this.counts.normal++; return true;
  }

  getEndSummaries(entry: PathEdgePoint<D>): ReadonlySet<PathEdgePoint<D>> {
    return this.endSummaries.get(entry) ?? new Set();
  }

  addExceptionalEndSummary(
    entry: PathEdgePoint<D>,
    exit: PathEdgePoint<D>,
  ): boolean {
    const summaries = this.exceptionalEndSummaries.getOrCreate(
      entry,
      () => new SemanticPointSet(this.semantics),
    );
    const size = summaries.size;
    summaries.add(exit);
    if (summaries.size === size) this.counts.duplicateExits++;
    else this.counts.exceptional++;
    return summaries.size !== size;
  }

  getExceptionalEndSummaries(
    entry: PathEdgePoint<D>,
  ): ReadonlySet<PathEdgePoint<D>> {
    return this.exceptionalEndSummaries.get(entry) ?? new Set();
  }

  addCallSummary(
    callPoint: PathEdgePoint<D>,
    returnPoint: PathEdgePoint<D>,
  ): boolean {
    const entry = this.callSummaries.getOrCreate(callPoint, () => ({
      byReturnSite: new Map(),
    }));
    let summaries = entry.byReturnSite.get(returnPoint.node);
    if (!summaries) {
      summaries = { points: [], byFactHash: new Map() };
      entry.byReturnSite.set(returnPoint.node, summaries);
    }

    const hash = this.semantics.factHash(returnPoint.fact);
    const bucket = summaries.byFactHash.get(hash);
    if (
      bucket?.some((existing) =>
        this.semantics.factEqual(existing.fact, returnPoint.fact),
      )
    ) {
      return false;
    }
    this.counts.calls++;
    summaries.points.push(returnPoint);
    if (bucket) {
      bucket.push(returnPoint);
    } else {
      summaries.byFactHash.set(hash, [returnPoint]);
    }
    return true;
  }

  getCallSummaries(
    callPoint: PathEdgePoint<D>,
    returnSite: Stmt,
  ): readonly PathEdgePoint<D>[] {
    return (
      this.callSummaries.get(callPoint)?.byReturnSite.get(returnSite)?.points ??
      []
    );
  }

  clear(): void {
    for (const key of Object.keys(this.counts) as (keyof typeof this.counts)[]) this.counts[key] = 0;
    this.incoming.clear();
    this.endSummaries.clear();
    this.exceptionalEndSummaries.clear();
    this.callSummaries.clear();
  }
}
