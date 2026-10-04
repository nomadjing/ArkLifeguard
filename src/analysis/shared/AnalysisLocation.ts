import type { Stmt } from '../../adapter/arkanalyzer';

export interface RetentionLocation { readonly filePath: string; readonly line: number; readonly col: number; }
export function retentionLocation(stmt: Stmt): RetentionLocation {
    const method = stmt.getCfg()?.getDeclaringMethod();
    const position = stmt.getOriginPositionInfo();
    const source = position?.getLineNo() > 0 ? position : method?.getCfg()?.getStmts()
        .find(candidate => candidate.getOriginPositionInfo()?.getLineNo() > 0)?.getOriginPositionInfo();
    return { filePath: method?.getDeclaringArkFile()?.getFilePath() || `[synthetic] ${method?.getSignature()}`,
        line: Math.max(0, source?.getLineNo() ?? method?.getImplOriginFullPosition()?.getFirstLine() ?? 0),
        col: Math.max(0, source?.getColNo() ?? method?.getImplOriginFullPosition()?.getFirstCol() ?? 0) };
}
