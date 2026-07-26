/**
 * Version 1 public prompt discovery contract.
 *
 * Never had an out-of-package consumer — the subpath was published in e7f13c3a
 * to complete the versioned surface. The underlying module is live (the tool
 * description and `resolvePromptTask` both use it), so this stays published:
 * an unused door is not a broken one, and `@deprecated` would falsely signal a
 * migration that does not exist.
 */
export * from "../../prompts/prompts.ts";
