#!/usr/bin/env node
/** Expands CLI targets: files pass through, directories are walked recursively. */
export declare function expandTargets(targets: string[], excludes?: string[]): string[];
