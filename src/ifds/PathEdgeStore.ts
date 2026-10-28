import type { Stmt } from "../adapter/arkanalyzer";
import type { FactSemantics } from "./FactSemantics";
import { PathEdge } from "./PathEdge";

type EndFactIndex<D> = Map<number, PathEdge<D>[]>;
type EndNodeIndex<D> = Map<Stmt, EndFactIndex<D>>;

export interface PathEdgeInsertResult {
  inserted: boolean;
  candidateChecks: number;
  factEqualityChecks: number;
}

/** Stores path edges and performs collision-safe semantic deduplication. */
export class PathEdgeStore<D> {
  private readonly edges = new Set<PathEdge<D>>();
  private readonly index = new Map<Stmt, EndNodeIndex<D>>();

  constructor(private readonly semantics: FactSemantics<D>) {}

  addIfAbsent(edge: PathEdge<D>): PathEdgeInsertResult {
    const bucket = this.getBucket(edge, false);
    let candidateChecks = 0;
    let factEqualityChecks = 0;
    for (const existing of bucket ?? []) {
      candidateChecks++;
      factEqualityChecks++;
      if (!this.semantics.factEqual(existing.edgeEnd.fact, edge.edgeEnd.fact))
        continue;
      factEqualityChecks++;
      if (
        this.semantics.factEqual(existing.edgeStart.fact, edge.edgeStart.fact)
      ) {
        return { inserted: false, candidateChecks, factEqualityChecks };
      }
    }

    this.edges.add(edge);
    this.getBucket(edge, true)!.push(edge);
    return { inserted: true, candidateChecks, factEqualityChecks };
  }

  containsEndPoint(node: Stmt, fact: D): boolean {
    for (const edge of this.edges) {
      if (
        edge.edgeEnd.node === node &&
        this.semantics.factEqual(edge.edgeEnd.fact, fact)
      ) {
        return true;
      }
    }
    return false;
  }

  values(): ReadonlySet<PathEdge<D>> {
    return this.edges;
  }

  asSet(): Set<PathEdge<D>> {
    return this.edges;
  }

  get size(): number {
    return this.edges.size;
  }

  private getBucket(
    edge: PathEdge<D>,
    create: boolean,
  ): PathEdge<D>[] | undefined {
    let byEndNode = this.index.get(edge.edgeStart.node);
    if (!byEndNode) {
      if (!create) return undefined;
      byEndNode = new Map();
      this.index.set(edge.edgeStart.node, byEndNode);
    }

    let byFactHash = byEndNode.get(edge.edgeEnd.node);
    if (!byFactHash) {
      if (!create) return undefined;
      byFactHash = new Map();
      byEndNode.set(edge.edgeEnd.node, byFactHash);
    }

    const startHash = this.semantics.factHash(edge.edgeStart.fact);
    const endHash = this.semantics.factHash(edge.edgeEnd.fact);
    // Combining hashes removes a Map per start fact. addIfAbsent still
    // compares both facts, including collisions introduced by this pairing.
    const hash = (Math.imul(startHash, 31) + endHash) | 0;
    let bucket = byFactHash.get(hash);
    if (!bucket && create) {
      bucket = [];
      byFactHash.set(hash, bucket);
    }
    return bucket;
  }
}
