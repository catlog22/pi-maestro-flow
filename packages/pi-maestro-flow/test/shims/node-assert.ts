import { assert } from "vitest";

// node:test compatibility: chai's assert does not expose doesNotMatch.
if (!("doesNotMatch" in assert)) {
  (assert as Record<string, unknown>).doesNotMatch = (
    value: unknown,
    pattern: RegExp,
    message?: string,
  ) => {
    pattern.lastIndex = 0;
    if (pattern.test(String(value))) {
      assert.fail(message ?? `expected ${JSON.stringify(String(value))} not to match ${pattern}`);
    }
  };
}

// node:test compatibility: chai's assert does not expose rejects.
if (!("rejects" in assert)) {
  (assert as Record<string, unknown>).rejects = async (
    promise: Promise<unknown> | (() => Promise<unknown>),
    matcher?: RegExp | (new (...args: never[]) => Error) | ((error: unknown) => boolean) | Record<string, unknown> | string,
    message?: string,
  ) => {
    if (typeof matcher === "string" && message === undefined) {
      message = matcher;
      matcher = undefined;
    }
    const pending = typeof promise === "function" ? promise() : promise;
    try {
      await pending;
    } catch (error) {
      if (matcher === undefined || errorMatches(error, matcher)) return;
      assert.fail(message ?? `expected rejection to match matcher, got: ${String(error)}`);
      return;
    }
    assert.fail(message ?? "expected promise to reject");
  };
}

function errorMatches(
  error: unknown,
  matcher: RegExp | (new (...args: never[]) => Error) | ((error: unknown) => boolean) | Record<string, unknown>,
): boolean {
  if (matcher instanceof RegExp) {
    return matcher.test(error instanceof Error ? error.message : String(error));
  }
  if (typeof matcher === "function") {
    if (matcher.prototype instanceof Error) return error instanceof matcher;
    return matcher(error);
  }
  return Object.entries(matcher).every(([key, value]) => (error as Record<string, unknown>)[key] === value);
}

export default assert;
