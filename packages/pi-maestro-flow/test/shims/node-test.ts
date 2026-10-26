import { test as vitestTest, vi } from "vitest";

interface NodeTestContext {
  test: (name: string, fn: () => void | Promise<void>) => Promise<void>;
  mock: {
    timers: {
      enable(options?: { apis?: string[] }): void;
      tick(milliseconds: number): void;
      reset(): void;
    };
  };
}

function wrap(fn: unknown): (ctx: unknown) => Promise<void> {
  return async (ctx) => {
    const subtest = (subName: string, subFn: () => void | Promise<void>): Promise<void> =>
      Promise.resolve().then(subFn);
    const timers = {
      enable: (options?: { apis?: string[] }) => {
        const apis = options?.apis?.filter((api): api is "Date" | "setTimeout" | "setInterval" | "setImmediate" =>
          api === "Date" || api === "setTimeout" || api === "setInterval" || api === "setImmediate",
        );
        const toFake = apis && [
          ...apis,
          ...(apis.includes("setTimeout") ? ["clearTimeout" as const] : []),
          ...(apis.includes("setInterval") ? ["clearInterval" as const] : []),
          ...(apis.includes("setImmediate") ? ["clearImmediate" as const] : []),
        ];
        vi.useFakeTimers(toFake && toFake.length > 0 ? { toFake } : undefined);
      },
      tick: (milliseconds: number) => {
        vi.advanceTimersByTime(milliseconds);
      },
      reset: () => {
        vi.useRealTimers();
      },
    };
    const context = {
      ...(ctx as object),
      test: subtest,
      mock: { timers },
    } as NodeTestContext;
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
