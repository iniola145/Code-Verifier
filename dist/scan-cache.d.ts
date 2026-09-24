import { VerificationResult } from "./types/verifier";
export declare class ScanCache {
    private readonly filePath;
    private readonly entries;
    constructor(filePath: string);
    get(key: string): VerificationResult | undefined;
    set(key: string, value: VerificationResult): void;
    save(): void;
}
export declare function projectSignature(files: string[]): string;
export declare function fileCacheKey(filePath: string, signature: string, optionsIdentity: string): string;
export declare function mapWithConcurrency<T, R>(items: T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]>;
