export interface File { fd: number; }
/** @throws Error */
export function openSync(path: string): File;
/** @throws Error */
export function open(path: string): Promise<File>;
/** @throws Error */
export function closeSync(file: number | File): void;
/** @throws Error */
export function close(file: number | File): Promise<void>;
/** @throws Error */
export function writeSync(fd: number, data: string): number;
