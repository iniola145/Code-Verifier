import * as t from "@babel/types";
import { CFG, CFGNode, EdgeCondition } from "../types/verifier";

interface LoopContext {
  continueTarget: CFGNode;
  breakTarget: CFGNode;
}

/**
 * Builds a Control Flow Graph for a single function body (or the module
 * top level). One builder instance produces ONE graph; the engine creates
 * a builder per function so nested functions are analyzed as independent
 * roots instead of being spliced into their parent's flow.
 */
export class CFGBuilder {
  private nextId = 0;
  private nodes: Map<number, CFGNode> = new Map();
  private edgeConditions: Map<string, EdgeCondition> = new Map();
  private loopStack: LoopContext[] = [];

  /**
   * Builds a CFG for a statement list (function body or program body).
   */
  public build(body: t.Statement[], name = "<module>"): CFG {
    this.nextId = 0;
    this.nodes.clear();
    this.edgeConditions.clear();
    this.loopStack = [];

    const entry = this.createNode(`ENTRY(${name})`);
    const exit = this.createNode(`EXIT(${name})`);

    const end = this.processStatements(body, entry, exit);
    if (end.id !== exit.id) {
      this.addEdge(end, exit);
    }

    return {
      entryNodeId: entry.id,
      exitNodeId: exit.id,
      nodes: new Map(this.nodes),
      edgeConditions: this.edgeConditions,
      name,
    };
  }

  private createNode(label: string, isLoopHeader = false): CFGNode {
    const id = this.nextId++;
    const node: CFGNode = {
      id,
      label,
      statements: [],
      predecessors: [],
      successors: [],
      isLoopHeader,
      stateIn: new Map(),
      stateOut: new Map(),
    };
    this.nodes.set(id, node);
    return node;
  }

  private addEdge(from: CFGNode, to: CFGNode, condition?: EdgeCondition): void {
    if (!from.successors.includes(to.id)) {
      from.successors.push(to.id);
    }
    if (!to.predecessors.includes(from.id)) {
      to.predecessors.push(from.id);
    }
    if (condition) {
      this.edgeConditions.set(`${from.id}->${to.id}`, condition);
    }
  }

  private processStatements(
    stmts: t.Statement[],
    currentBlock: CFGNode,
    exitNode: CFGNode,
  ): CFGNode {
    let block = currentBlock;

    for (const stmt of stmts) {
      if (t.isIfStatement(stmt)) {
        block = this.processIf(stmt, block, exitNode);
      } else if (t.isWhileStatement(stmt)) {
        block = this.processWhile(stmt, block, exitNode);
      } else if (t.isDoWhileStatement(stmt)) {
        block = this.processDoWhile(stmt, block, exitNode);
      } else if (t.isForStatement(stmt)) {
        block = this.processFor(stmt, block, exitNode);
      } else if (t.isForOfStatement(stmt) || t.isForInStatement(stmt)) {
        block = this.processForEach(stmt, block, exitNode);
      } else if (t.isSwitchStatement(stmt)) {
        block = this.processSwitch(stmt, block, exitNode);
      } else if (t.isTryStatement(stmt)) {
        block = this.processTry(stmt, block, exitNode);
      } else if (t.isReturnStatement(stmt)) {
        block.statements.push(stmt);
        this.addEdge(block, exitNode);
        // Unreachable continuation; still created so later statements are
        // recorded (they are also analyzed as unreachable).
        block = this.createNode("AFTER_RETURN");
      } else if (t.isThrowStatement(stmt)) {
        block.statements.push(stmt);
        this.addEdge(block, exitNode); // conservative: throw leaves the function
        block = this.createNode("AFTER_THROW");
      } else if (t.isBreakStatement(stmt)) {
        const target = this.loopStack[this.loopStack.length - 1]?.breakTarget;
        if (target) {
          this.addEdge(block, target);
          block = this.createNode("AFTER_BREAK");
        } else {
          block.statements.push(stmt);
        }
      } else if (t.isContinueStatement(stmt)) {
        const target =
          this.loopStack[this.loopStack.length - 1]?.continueTarget;
        if (target) {
          this.addEdge(block, target);
          block = this.createNode("AFTER_CONTINUE");
        } else {
          block.statements.push(stmt);
        }
      } else if (t.isBlockStatement(stmt)) {
        block = this.processStatements(stmt.body, block, exitNode);
      } else if (t.isLabeledStatement(stmt)) {
        block = this.processStatements([stmt.body], block, exitNode);
      } else if (t.isWithStatement(stmt)) {
        block.statements.push(stmt);
        block = this.processStatements(
          t.isBlockStatement(stmt.body) ? stmt.body.body : [stmt.body],
          block,
          exitNode,
        );
      } else {
        // Standard assignment, call, declaration, expression, etc.
        // Nested function bodies are NOT spliced in here — the engine
        // analyzes them as separate CFG roots.
        block.statements.push(stmt);
      }
    }

    return block;
  }

  private processIf(
    stmt: t.IfStatement,
    currentBlock: CFGNode,
    exitNode: CFGNode,
  ): CFGNode {
    const joinNode = this.createNode("IF_JOIN");
    const thenNode = this.createNode("THEN_BRANCH");

    this.addEdge(currentBlock, thenNode, { test: stmt.test, polarity: true });

    const thenStmts = t.isBlockStatement(stmt.consequent)
      ? stmt.consequent.body
      : [stmt.consequent];
    const endThen = this.processStatements(thenStmts, thenNode, exitNode);
    this.addEdge(endThen, joinNode);

    if (stmt.alternate) {
      const elseNode = this.createNode("ELSE_BRANCH");
      this.addEdge(currentBlock, elseNode, {
        test: stmt.test,
        polarity: false,
      });
      const elseStmts = t.isBlockStatement(stmt.alternate)
        ? stmt.alternate.body
        : [stmt.alternate];
      const endElse = this.processStatements(elseStmts, elseNode, exitNode);
      this.addEdge(endElse, joinNode);
    } else {
      this.addEdge(currentBlock, joinNode, {
        test: stmt.test,
        polarity: false,
      });
    }

    return joinNode;
  }

  private processWhile(
    stmt: t.WhileStatement,
    currentBlock: CFGNode,
    exitNode: CFGNode,
  ): CFGNode {
    const loopHeader = this.createNode("LOOP_HEADER", true);
    const loopExit = this.createNode("LOOP_EXIT");
    const bodyNode = this.createNode("LOOP_BODY");

    this.addEdge(currentBlock, loopHeader);
    this.addEdge(loopHeader, bodyNode, { test: stmt.test, polarity: true });
    this.addEdge(loopHeader, loopExit, { test: stmt.test, polarity: false });

    this.loopStack.push({ continueTarget: loopHeader, breakTarget: loopExit });
    const bodyStmts = t.isBlockStatement(stmt.body)
      ? stmt.body.body
      : [stmt.body];
    const endBody = this.processStatements(bodyStmts, bodyNode, exitNode);
    this.loopStack.pop();

    this.addEdge(endBody, loopHeader); // back-edge, no refinement
    return loopExit;
  }

  private processDoWhile(
    stmt: t.DoWhileStatement,
    currentBlock: CFGNode,
    exitNode: CFGNode,
  ): CFGNode {
    const bodyNode = this.createNode("DO_BODY");
    const condNode = this.createNode("DO_COND", true);
    const loopExit = this.createNode("LOOP_EXIT");

    this.addEdge(currentBlock, bodyNode);

    this.loopStack.push({ continueTarget: condNode, breakTarget: loopExit });
    const bodyStmts = t.isBlockStatement(stmt.body)
      ? stmt.body.body
      : [stmt.body];
    const endBody = this.processStatements(bodyStmts, bodyNode, exitNode);
    this.loopStack.pop();

    this.addEdge(endBody, condNode);
    this.addEdge(condNode, bodyNode, { test: stmt.test, polarity: true });
    this.addEdge(condNode, loopExit, { test: stmt.test, polarity: false });
    return loopExit;
  }

  private processFor(
    stmt: t.ForStatement,
    currentBlock: CFGNode,
    exitNode: CFGNode,
  ): CFGNode {
    // `for (init; test; update)` — init executes once before the header,
    // update executes on every back-edge (the latch).
    let preheader = currentBlock;
    if (stmt.init) {
      if (t.isVariableDeclaration(stmt.init)) {
        preheader.statements.push(stmt.init);
      } else if (t.isExpression(stmt.init)) {
        preheader.statements.push(t.expressionStatement(stmt.init));
      }
    }

    const loopHeader = this.createNode("LOOP_HEADER", true);
    const loopExit = this.createNode("LOOP_EXIT");
    const bodyNode = this.createNode("LOOP_BODY");
    const latchNode = this.createNode("LOOP_UPDATE");

    this.addEdge(preheader, loopHeader);
    if (stmt.test) {
      this.addEdge(loopHeader, bodyNode, { test: stmt.test, polarity: true });
      this.addEdge(loopHeader, loopExit, { test: stmt.test, polarity: false });
    } else {
      // `for (;;)` — only the true path exists
      this.addEdge(loopHeader, bodyNode);
    }

    this.loopStack.push({ continueTarget: latchNode, breakTarget: loopExit });
    const bodyStmts = t.isBlockStatement(stmt.body)
      ? stmt.body.body
      : [stmt.body];
    const endBody = this.processStatements(bodyStmts, bodyNode, exitNode);
    this.loopStack.pop();

    this.addEdge(endBody, latchNode);
    if (stmt.update) {
      latchNode.statements.push(t.expressionStatement(stmt.update));
    }
    this.addEdge(latchNode, loopHeader); // back-edge

    return loopExit;
  }

  private processForEach(
    stmt: t.ForOfStatement | t.ForInStatement,
    currentBlock: CFGNode,
    exitNode: CFGNode,
  ): CFGNode {
    const loopHeader = this.createNode("LOOP_HEADER", true);
    const loopExit = this.createNode("LOOP_EXIT");
    const bodyNode = this.createNode("LOOP_BODY");

    this.addEdge(currentBlock, loopHeader);
    // Iteration count is unknown; no meaningful refinement on either edge.
    this.addEdge(loopHeader, bodyNode);
    this.addEdge(loopHeader, loopExit);

    this.loopStack.push({ continueTarget: loopHeader, breakTarget: loopExit });
    const bodyStmts = t.isBlockStatement(stmt.body)
      ? stmt.body.body
      : [stmt.body];
    const endBody = this.processStatements(bodyStmts, bodyNode, exitNode);
    this.loopStack.pop();

    this.addEdge(endBody, loopHeader);
    return loopExit;
  }

  private processSwitch(
    stmt: t.SwitchStatement,
    currentBlock: CFGNode,
    exitNode: CFGNode,
  ): CFGNode {
    const breakTarget = this.createNode("SWITCH_EXIT");
    currentBlock.statements.push(stmt);

    const caseNodes: CFGNode[] = [];
    let defaultNode: CFGNode | undefined;

    for (const clause of stmt.cases) {
      const node = this.createNode(clause.test ? "CASE" : "CASE_DEFAULT");
      node.statements.push(clause); // kept for statementStates bookkeeping
      if (clause.test) {
        // test expression evaluated, body lives in clause.consequent
      } else {
        defaultNode = node;
      }
      caseNodes.push(node);
    }

    // Jump-table edges from the dispatch block to every case
    for (const caseNode of caseNodes) {
      this.addEdge(currentBlock, caseNode);
    }

    // Fall-through chain: each case flows into the next when not broken.
    // A `break` inside a case body already edges to breakTarget via the
    // loop/switch stack; nothing else is needed here.
    const prevStack = this.loopStack;
    const enclosingContinue =
      prevStack[prevStack.length - 1]?.continueTarget ?? breakTarget;
    this.loopStack.push({ continueTarget: enclosingContinue, breakTarget });
    for (let i = 0; i < caseNodes.length; i++) {
      const clause = stmt.cases[i];
      const body = clause.consequent;
      let end = this.processStatements(body, caseNodes[i], exitNode);
      if (i + 1 < caseNodes.length) {
        this.addEdge(end, caseNodes[i + 1]);
      } else {
        this.addEdge(end, breakTarget);
      }
    }
    this.loopStack = prevStack;

    if (!defaultNode && caseNodes.length > 0) {
      // No default: the switch may match nothing
      this.addEdge(currentBlock, breakTarget);
    }

    return breakTarget;
  }

  private processTry(
    stmt: t.TryStatement,
    currentBlock: CFGNode,
    exitNode: CFGNode,
  ): CFGNode {
    const bodyStmts = t.isBlockStatement(stmt.block)
      ? stmt.block.body
      : [stmt.block];
    let afterBody = this.processStatements(bodyStmts, currentBlock, exitNode);

    if (stmt.handler) {
      const catchNode = this.createNode("CATCH");
      const catchStmts = t.isBlockStatement(stmt.handler.body)
        ? stmt.handler.body.body
        : [stmt.handler.body];
      // Conservative throw edges: any statement in the try may throw
      this.addEdge(currentBlock, catchNode);
      this.addEdge(afterBody, catchNode);

      let afterCatch = this.processStatements(catchStmts, catchNode, exitNode);
      if (stmt.finalizer) {
        const finStmts = t.isBlockStatement(stmt.finalizer)
          ? stmt.finalizer.body
          : [stmt.finalizer];
        const join = this.createNode("TRY_JOIN");
        this.addEdge(afterBody, join);
        this.addEdge(afterCatch, join);
        afterCatch = this.processStatements(finStmts, join, exitNode);
      }
      return afterCatch;
    }

    if (stmt.finalizer) {
      const finStmts = t.isBlockStatement(stmt.finalizer)
        ? stmt.finalizer.body
        : [stmt.finalizer];
      return this.processStatements(finStmts, afterBody, exitNode);
    }

    return afterBody;
  }
}
