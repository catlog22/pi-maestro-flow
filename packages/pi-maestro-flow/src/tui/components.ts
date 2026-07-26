import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

/**
 * A one-line TUI Component that clips to whatever width it is given.
 *
 * Tool render functions across src/tools/ hand back one of these; the shared
 * definition exists because the commit that enriched those renderers copied the
 * call sites without the helper, leaving five modules referencing a name that
 * was only ever local to two others.
 */
export function singleLine(text: string): Component {
  return {
    render: (width: number) => [truncateToWidth(text, Math.max(1, width), "…")],
    invalidate() {},
  };
}
