// Applied only to the fresh parent process. A native value import (or any Pi
// peer import) fails the test; the plain worker must not inherit this loader.
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@ff-labs/") || specifier === "ffi-rs" ||
      specifier.startsWith("@earendil-works/") || specifier === "typebox") {
    throw new Error(`Forbidden parent-process value import: ${specifier}`);
  }
  return nextResolve(specifier, context);
}
