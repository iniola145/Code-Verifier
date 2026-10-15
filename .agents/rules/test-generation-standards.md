---
trigger: always_on
description: Invariants for test generation, React component testing, and MCP server management in Code Verifier.
---

# Test Generation & MCP Architecture Rules

## 1. React Component Testing Invariants
- **No Private React Internals:** Never monkey-patch `React.__CLIENT_INTERNALS` or undocumented engine symbols.
- **No Direct Component Execution:** Never invoke a component as a raw function (e.g. `const res = MyComponent()`). Always render via the reconciler using JSX: `render(<MyComponent />)`.
- **Standard Testing Libraries:**
  - For Web React projects (`react-dom`): Use `@testing-library/react`.
  - For Mobile React Native projects (`react-native`): Use `@testing-library/react-native`.
- **No Child Property Index-Walking:** Never assert or query via `tree.props.children[0].props...`. Use testing-library queries (`getByRole`, `getByText`, `getByTestId`) or verify container definitions.

## 2. AST Test Generator Guardrails
- **Component vs. Service Disambiguation:** Never route components (`hasJsx || isComponent`) into API service test generators (`generateServiceModuleTests`).
- **No Hallucinated Identifiers or Endpoints:** Never fabricate `apiClient` or `/api/<Method>` mocks unless network client AST nodes actually exist in the file.
- **Strict Import Parity:** Any symbol used in a generated test (`render`, `screen`, `vi`, `apiClient`) must have a corresponding import statement emitted in the test header.

## 3. MCP Server Build & Reload Discipline
- When modifying MCP tool schemas (`schemas/`), handlers (`src/mcp-server.ts`), or generators (`src/test-gen/`):
  1. Compile TypeScript: `npm run build`
  2. Run the test suite: `npm test`
  3. Terminate stale running MCP server processes so Antigravity spawns fresh instances with updated code.
