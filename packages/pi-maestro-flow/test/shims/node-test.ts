import { test as vitestTest } from "vitest";

interface NodeTestContext {
  test: (name: string, fn: () => void | Promise<void>) => Promise<void>;
}

function wrap(fn: unknown): (ctx: unknown) => Promise<void> {
  return async (ctx) => {
    const subtest = (subName: string, subFn: () => void | Promise<void>): Promise<void> =>
      Promise.resolve().then(subFn);
    const context = { ...(ctx as object), test: subtest } as NodeTestContext;
    await (fn as (t: NodeTestContext) => void | Promise<void>)(context);
  };
}

export default function test(
  name: string,
  optionsOrFn: unknown,
  maybeFn?: () => void | Promise<void>,
): void {
  const options = typeof optionsOrFn === "object" && optionsOrFn !== null
    ? optionsOrFn as { skip?: boolean | string; timeout?: number }
    : undefined;
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
  const run = (): void => {
    if (options?.timeout !== undefined) {
      vitestTest(name, { timeout: options.timeout }, wrap(fn));
      return;
    }
    vitestTest(name, wrap(fn));
  };
  if (options?.skip) {
    vitestTest.skip(name, wrap(fn));
    return;
  }
  run();
}
