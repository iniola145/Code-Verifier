import * as t from '@babel/types';
import { CFG } from '../types/verifier';
/**
 * Builds a Control Flow Graph for a single function body (or the module
 * top level). One builder instance produces ONE graph; the engine creates
 * a builder per function so nested functions are analyzed as independent
 * roots instead of being spliced into their parent's flow.
 */
export declare class CFGBuilder {
    private nextId;
    private nodes;
    private edgeConditions;
    private loopStack;
    /**
     * Builds a CFG for a statement list (function body or program body).
     */
    build(body: t.Statement[], name?: string): CFG;
    private createNode;
    private addEdge;
    private processStatements;
    private processIf;
    private processWhile;
    private processDoWhile;
    private processFor;
    private processForEach;
    private processSwitch;
    private processTry;
}
