/** Script workers must not invoke a compiled Pi host as their interpreter. */
export function nodeExecutable(execPath = process.execPath): string {
  const name = execPath.split(/[\\/]/).pop() ?? "";
  return /^node(?:js)?(?:\.exe)?$/i.test(name) ? execPath : "node";
}
