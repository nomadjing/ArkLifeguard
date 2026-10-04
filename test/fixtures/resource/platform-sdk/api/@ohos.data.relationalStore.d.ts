declare namespace relationalStore { interface ResultSet { close(): void; } interface RdbStore { querySync(): ResultSet; query(): Promise<ResultSet>; } } export default relationalStore;
