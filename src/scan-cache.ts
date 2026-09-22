import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { VerificationResult } from './types/verifier';

interface CacheFile { version: 1; entries: Record<string, VerificationResult>; }

export class ScanCache {
  private readonly entries: Record<string, VerificationResult>;
  constructor(private readonly filePath: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CacheFile;
      this.entries = parsed.version === 1 && parsed.entries ? parsed.entries : {};
    } catch {
      this.entries = {};
    }
  }
  get(key: string): VerificationResult | undefined { return this.entries[key]; }
  set(key: string, value: VerificationResult): void { this.entries[key] = value; }
  save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify({ version: 1, entries: this.entries })}\n`, 'utf8');
  }
}

export function projectSignature(files: string[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    const stat = fs.statSync(file);
    hash.update(path.resolve(file)).update('\0').update(String(stat.size)).update('\0').update(String(stat.mtimeMs));
  }
  return hash.digest('hex');
}

export function fileCacheKey(filePath: string, signature: string, optionsIdentity: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).update('\0').update(signature)
    .update('\0').update(optionsIdentity).digest('hex');
}

export async function mapWithConcurrency<T, R>(items: T[], concurrency: number,
  work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return results;
}
