/**
 * Version 1 public teammate progress-tree rendering primitives.
 *
 * Pure layout over an `AgentProgressSnapshot[]`: it depends on nothing but
 * `shared/`, so an observer can render the same tree the teammate TUI does
 * without loading a terminal runtime. Flow's native Swarm dashboard was the
 * one consumer (24e066d8) and was removed with that runtime (581141b3); the
 * renderer is unchanged and stays published rather than deprecated.
 */
export {
  buildProgressTree,
  focusTaskIndex,
  progressIcon,
  progressLabel,
  selectPriorityProgressRows,
  selectProgressWindow,
} from "../../tui/progress-tree.ts";
export type {
  ProgressPalette,
  ProgressTreeRow,
} from "../../tui/progress-tree.ts";
