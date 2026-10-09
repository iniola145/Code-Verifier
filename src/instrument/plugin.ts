import * as fs from "fs";
import * as path from "path";
import traverse, { NodePath } from "@babel/traverse";
// @ts-ignore
import generate from "@babel/generator";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { parseSourceCode } from "../parser/ast";
import { Diagnostic } from "../types/verifier";
import { generateProbe } from "./probe-templates";
import { RUNTIME_PREAMBLE_CODE, generateRuntimePreamble } from "./runtime";

export interface InstrumentOptions {
  findings: Diagnostic[];
  filePath?: string;
}

export interface InstrumentCodeOptions {
  prependRuntime?: boolean;
  probeOutput?: string;
}

/**
 * Creates the visitor for selective code instrumentation.
 */
export function createInstrumentVisitor(options: InstrumentOptions) {
  const { findings } = options;
  const findingsByLine = new Map<number, Diagnostic[]>();

  for (const finding of findings || []) {
    const line = finding.loc?.start?.line;
    if (line) {
      if (!findingsByLine.has(line)) {
        findingsByLine.set(line, []);
      }
      findingsByLine.get(line)!.push(finding);
    }
  }

  const handledFindings = new Set<Diagnostic>();

  function findInsertablePath(nodePath: NodePath<any>): NodePath<any> | null {
    let cur: NodePath<any> | null = nodePath;
    while (cur) {
      if (cur.listKey) {
        return cur;
      }
      if (cur.isProgram()) {
        return null;
      }
      cur = cur.parentPath;
    }
    return null;
  }

  function injectProbes(
    pathNode: NodePath<any>,
    findingsToInject: Diagnostic[],
    position: "before" | "after",
  ) {
    const targetPath = findInsertablePath(pathNode);
    if (!targetPath) return;

    for (const finding of findingsToInject) {
      if (handledFindings.has(finding)) continue;
      const line = finding.loc?.start?.line || 1;
      const column = finding.loc?.start?.column || 0;
      
      // Try to extract variable name from the finding's code snippet
      const variableName = extractVariableName(finding, pathNode);
      const probeCode = generateProbe(finding, { line, column }, variableName);

      try {
        const parsed = parse(probeCode);
        const probeStmt = parsed.program.body[0];
        if (probeStmt) {
          if (position === "before") {
            targetPath.insertBefore(probeStmt);
          } else {
            targetPath.insertAfter(probeStmt);
          }
          handledFindings.add(finding);
        }
      } catch {
        // Fallback: ignore parse error
      }
    }
  }

  function extractVariableName(
    finding: Diagnostic,
    pathNode: NodePath<any>,
  ): string | undefined {
    // Try to extract variable name from common patterns
    const code = finding.codeSnippet || "";
    
    // Pattern: const/let/var x = ...
    const declMatch = code.match(/(?:const|let|var)\s+(\w+)/);
    if (declMatch) return declMatch[1];
    
    // Pattern: x.y or x?.y (member expression)
    const memberMatch = code.match(/(\w+)\??\./);
    if (memberMatch) return memberMatch[1];
    
    // Pattern: return x
    const returnMatch = code.match(/return\s+(\w+)/);
    if (returnMatch) return returnMatch[1];
    
    return undefined;
  }

  return {
    name: "code-verifier-instrument",
    visitor: {
      VariableDeclaration(pathNode: NodePath<t.VariableDeclaration>) {
        const line = pathNode.node.loc?.start.line;
        if (!line) return;
        const lineFindings = findingsByLine.get(line);
        if (lineFindings && lineFindings.length > 0) {
          injectProbes(pathNode, lineFindings, "after");
        }
      },

      ReturnStatement(pathNode: NodePath<t.ReturnStatement>) {
        const line = pathNode.node.loc?.start.line;
        if (!line) return;
        const lineFindings = findingsByLine.get(line);
        if (lineFindings && lineFindings.length > 0) {
          injectProbes(pathNode, lineFindings, "before");
        }
      },

      ExpressionStatement(pathNode: NodePath<t.ExpressionStatement>) {
        const line = pathNode.node.loc?.start.line;
        if (!line) return;
        const lineFindings = findingsByLine.get(line);
        if (lineFindings && lineFindings.length > 0) {
          injectProbes(pathNode, lineFindings, "before");
        }
      },

      Statement(pathNode: NodePath<t.Statement>) {
        const line = pathNode.node.loc?.start.line;
        if (!line) return;
        const lineFindings = findingsByLine.get(line);
        if (lineFindings && lineFindings.length > 0) {
          const unhandled = lineFindings.filter((f) => !handledFindings.has(f));
          if (unhandled.length > 0) {
            injectProbes(pathNode, unhandled, "before");
          }
        }
      },

      Program: {
        exit(programPath: NodePath<t.Program>) {
          const unhandled = (findings || []).filter((f) => !handledFindings.has(f));
          if (unhandled.length === 0) return;

          for (const finding of unhandled) {
            const findingLine = finding.loc?.start?.line || 1;
            let bestPath: NodePath<any> | null = null;
            let smallestSpan = Infinity;

            programPath.traverse({
              Statement(stmtPath) {
                if (stmtPath.isProgram() || stmtPath.isBlockStatement()) return;
                const s = stmtPath.node.loc?.start?.line;
                const e = stmtPath.node.loc?.end?.line;
                if (s && e && s <= findingLine && findingLine <= e) {
                  const span = e - s;
                  if (span < smallestSpan && stmtPath.listKey) {
                    smallestSpan = span;
                    bestPath = stmtPath;
                  }
                }
              },
            });

            if (bestPath) {
              injectProbes(bestPath, [finding], "before");
            } else if (programPath.node.body.length > 0) {
              const lastStmt = programPath.get(`body.${programPath.node.body.length - 1}`) as NodePath<any>;
              if (lastStmt) {
                injectProbes(lastStmt, [finding], "after");
              }
            }
          }
        },
      },
    },
  };
}

/**
 * Standard Babel plugin function.
 * Supports direct invocation `codeVerifierInstrumentPlugin(options)`
 * and Babel loader invocation `codeVerifierInstrumentPlugin(api, options)`.
 */
export function codeVerifierInstrumentPlugin(
  apiOrOptions: any,
  maybeOptions?: InstrumentOptions,
) {
  const options: InstrumentOptions =
    maybeOptions && maybeOptions.findings
      ? maybeOptions
      : apiOrOptions && apiOrOptions.findings
        ? apiOrOptions
        : { findings: [] };
  return createInstrumentVisitor(options);
}

/**
 * Instrument source code directly by injecting probes for flagged locations.
 */
export function instrumentCode(
  code: string,
  filePath: string,
  findings: Diagnostic[],
  options?: InstrumentCodeOptions,
): string {
  if (!findings || findings.length === 0) {
    return code;
  }

  const { ast } = parseSourceCode(code, filePath);
  const traverseFn = typeof traverse === "function" ? traverse : (traverse as any).default;
  const generateFn = typeof generate === "function" ? generate : (generate as any).default;

  const pluginObj = createInstrumentVisitor({ findings, filePath });
  traverseFn(ast, pluginObj.visitor);

  const output = generateFn(ast, { retainLines: false, compact: false }, code);
  const instrumentedBody = output.code || code;

  if (options?.prependRuntime === false) {
    return instrumentedBody;
  }
  return `${generateRuntimePreamble(options?.probeOutput)}\n\n${instrumentedBody}`;
}

/**
 * Instrument a file on disk directly.
 */
export function instrumentFile(
  filePath: string,
  findings: Diagnostic[],
  options?: InstrumentCodeOptions,
): string {
  const code = fs.readFileSync(path.resolve(filePath), "utf-8");
  return instrumentCode(code, filePath, findings, options);
}

export default codeVerifierInstrumentPlugin;
