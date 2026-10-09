/**
 * Code Verifier Runtime Probes
 * This runtime preamble is prepended to instrumented source files
 * and captures runtime telemetry in browser, Node.js, and React Native environments.
 */

declare global {
  /* eslint-disable no-var */
  var window: any;
  var __cv_probes: Array<{
    type: string;
    message: string;
    location: string;
    value?: any;
    timestamp: number;
    [key: string]: any;
  }>;
  var __cv_probe_output: string | undefined;
  var __cv_record: (
    type: string,
    message: string,
    location: string,
    value?: any,
  ) => void;
  var __cv_probe_null: (
    message: string,
    location: string,
    value?: any,
  ) => void;
  var __cv_probe_taint: (
    message: string,
    location: string,
    value?: any,
  ) => void;
  var __cv_probe_props: (
    message: string,
    location: string,
    value?: any,
  ) => void;
  var __cv_probe_async: <T>(
    message: string,
    location: string,
    operation?: () => Promise<T>,
  ) => Promise<T> | undefined;
  var __cv_probe_promise: <T>(
    message: string,
    location: string,
    promise?: Promise<T>,
  ) => Promise<T> | undefined;
  var __cv_probe_fetch: (
    message: string,
    location: string,
    response?: any,
  ) => void;
  var __cv_probe: (ruleId: string, location: string) => void;
  /* eslint-enable no-var */
}

export interface ProbeEvent {
  type: string;
  message: string;
  location: string;
  value?: any;
  timestamp: number;
  [key: string]: any;
}

/**
 * Standard runtime preamble code injected at the top of instrumented bundles.
 */
export const RUNTIME_PREAMBLE_CODE = `// [code-verifier] Runtime Probes Preamble
(function() {
  var _g = typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : (typeof global !== "undefined" ? global : this));
  if (!_g) return;
  _g.__cv_probes = _g.__cv_probes || [];

  if (typeof window === "undefined" && typeof globalThis !== "undefined") {
    try {
      globalThis.window = globalThis;
    } catch (_e) {}
  }
  if (typeof window !== "undefined") {
    window.__cv_probes = _g.__cv_probes;
  }

  function __cv_record(type, message, location, value) {
    var entry = {
      type: type,
      message: message,
      location: location,
      value: value,
      timestamp: Date.now()
    };
    _g.__cv_probes.push(entry);
    if (_g.__cv_probe_output && typeof require !== "undefined") {
      try {
        var _fs = require("fs");
        _fs.appendFileSync(_g.__cv_probe_output, JSON.stringify(entry) + "\\n");
      } catch (_e) {}
    }
  }

  function __cv_probe_null(message, location, value) {
    if (arguments.length < 3 || value === null || value === undefined) {
      __cv_record("null_dereference", message, location, value);
    }
  }

  function __cv_probe_taint(message, location, value) {
    __cv_record("taint_flow", message, location, value);
  }

  function __cv_probe_props(message, location, value) {
    __cv_record("component_props", message, location, value);
  }

  function __cv_probe_async(message, location, operation) {
    if (typeof operation !== "function") return;
    var start = Date.now();
    return operation().then(
      function(result) {
        __cv_record("async_success", message, location, { duration: Date.now() - start, result: result });
        return result;
      },
      function(error) {
        __cv_record("async_failure", message, location, { duration: Date.now() - start, error: error });
        throw error;
      }
    );
  }

  function __cv_probe_promise(message, location, promise) {
    if (!promise || typeof promise.then !== "function") return promise;
    return promise.then(
      function(result) {
        __cv_record("promise_resolved", message, location, result);
        return result;
      },
      function(error) {
        __cv_record("promise_rejected", message, location, error);
        throw error;
      }
    );
  }

  function __cv_probe_fetch(message, location, response) {
    __cv_record("fetch_response", message, location, {
      status: response ? response.status : undefined,
      ok: response ? response.ok : undefined,
      url: response ? response.url : undefined
    });
  }

  function __cv_probe(ruleId, location) {
    __cv_record("probe", ruleId, location);
  }

  _g.__cv_record = __cv_record;
  _g.__cv_probe_null = __cv_probe_null;
  _g.__cv_probe_taint = __cv_probe_taint;
  _g.__cv_probe_props = __cv_probe_props;
  _g.__cv_probe_async = __cv_probe_async;
  _g.__cv_probe_promise = __cv_probe_promise;
  _g.__cv_probe_fetch = __cv_probe_fetch;
  _g.__cv_probe = __cv_probe;
  if (typeof window !== "undefined") {
    window.__cv_record = __cv_record;
    window.__cv_probe_null = __cv_probe_null;
    window.__cv_probe_taint = __cv_probe_taint;
    window.__cv_probe_props = __cv_probe_props;
    window.__cv_probe_async = __cv_probe_async;
    window.__cv_probe_promise = __cv_probe_promise;
    window.__cv_probe_fetch = __cv_probe_fetch;
    window.__cv_probe = __cv_probe;
  }
})();
`;

/**
 * Generate runtime preamble code, optionally configuring a target file for trace writes.
 */
export function generateRuntimePreamble(probeOutput?: string): string {
  if (!probeOutput) {
    return RUNTIME_PREAMBLE_CODE;
  }
  const escapedOutput = JSON.stringify(probeOutput);
  return (
    `// [code-verifier] Runtime Probes Preamble Config\n` +
    `(function() {\n` +
    `  var _g = typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : (typeof global !== "undefined" ? global : this));\n` +
    `  if (_g) { _g.__cv_probe_output = ${escapedOutput}; }\n` +
    `})();\n\n` +
    RUNTIME_PREAMBLE_CODE
  );
}

// Also initialize in the current Node environment if loaded
const currentGlobal: any =
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
      ? window
      : typeof global !== "undefined"
        ? global
        : {};

if (currentGlobal && !currentGlobal.__cv_probes) {
  try {
    // Run the preamble in current execution context
    const fn = new Function(RUNTIME_PREAMBLE_CODE);
    fn();
  } catch {
    currentGlobal.__cv_probes = [];
  }
}
