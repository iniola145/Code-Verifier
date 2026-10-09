/**
 * Code Verifier Jest Setup File
 * Usage in jest.config.js:
 *   setupFilesAfterEnv: ['code-verifier/jest-setup']
 */

// Initialize global capture buffers
(globalThis as any).__cv_errors = (globalThis as any).__cv_errors || [];
(globalThis as any).__cv_rejections = (globalThis as any).__cv_rejections || [];

const originalConsoleError = console.error;

console.error = (...args: any[]) => {
  try {
    (globalThis as any).__cv_errors.push({
      args,
      ts: Date.now(),
    });

    if (typeof (globalThis as any).__cv_captureError === "function") {
      (globalThis as any).__cv_captureError(args);
    }
  } catch {
    // Fail-safe
  }

  originalConsoleError.apply(console, args);
};

if (typeof process !== "undefined" && process.on) {
  process.on("unhandledRejection", (reason: any) => {
    try {
      (globalThis as any).__cv_rejections.push({
        reason,
        ts: Date.now(),
      });

      if (typeof (globalThis as any).__cv_captureRejection === "function") {
        (globalThis as any).__cv_captureRejection(reason);
      }
    } catch {
      // Fail-safe
    }
  });
}
