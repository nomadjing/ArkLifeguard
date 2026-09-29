import { DataflowProblem } from '../../ifds/DataflowProblem';
import type { ResourceFact } from './ResourceFact';

/** IFDS contract for the new engine. Flow functions are implemented in §3.2. */
export abstract class ResourceProblem extends DataflowProblem<ResourceFact> {}
