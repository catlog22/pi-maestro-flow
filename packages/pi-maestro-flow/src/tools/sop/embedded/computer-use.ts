/**
 * Embedded computer-use SOP baseline — the zero-dependency fallback served by
 * {@link SopRegistry}. Content is the verbatim former `COMPUTER_USE_SOPS` map
 * extracted from `computer-use/sops.ts`; knowhow entries with
 * `tools: [computer_use]` + `sop_topic` override these by the registry's
 * merge rules.
 */

import type { EmbeddedSopMap } from "../sop-types.ts";

const SOP_CORE = `Computer-use SOP — use the smallest verified action and keep the observe-act-verify loop.

1. OBSERVE -> ACT -> VERIFY
  - Start with capabilities/permissions, then list_windows or screenshot.
  - Use screenshot, ocr, detect, ui_tree, or find_control to establish current state.
  - Activate the target window before input. After every input, inspect the result or request a fresh probe.
  - A near-zero pointer diagnostic latches the window. Stop input and re-probe before retrying.

2. PHYSICAL COORDINATES
  - Pointer coordinates are physical screen pixels unless coordinate_space is window_client_physical.
  - Client coordinates are added to the verified ClientToScreen/client origin; outer window bounds are never used as a client origin.
  - Windows DPI and macOS Retina scaling can differ from logical pixels. Use image metadata, display bounds, and physical coordinates; never guess a scale.
  - Regions and OCR/detect boxes use the source image origin and physical pixel space.

3. SAFETY
  - Destructive key chords and controls require allow_destructive=true and an explicit user-authorized task.
  - Software input into network_game targets is disabled. Use an approved hardware path instead.
  - Keep timeouts bounded. Stop immediately on abort, timeout, foreground verification failure, permission denial, stale control refs, or a near-zero verification.

4. PLATFORM LIMITS
  - Call capabilities and permissions before assuming capture, accessibility, input, or window control exists.
  - Wayland commonly restricts global window listing, capture, activation, accessibility, and input; use a tested portal/compositor or an X11 session.
  - Screen capture and accessibility permissions may require a user action. Do not bypass OS permission prompts.
  - Native providers are platform-dependent and may be unavailable; errors include remediation when a bridge or permission is missing.
`;

const SOP_COORDINATES = `Coordinate guide

- screen_physical: absolute physical desktop pixels.
- window_client_physical: physical pixels relative to the target's client area; the platform resolves this through ClientToScreen/client origin.
- image: coordinates relative to an explicitly supplied image and its origin; map to screen only when image metadata proves the mapping.
- Windows DPI scaling and macOS Retina scaling make logical and physical coordinates different. Use display logicalToPhysicalScale/scale when exposed and keep bounds in physical pixels.
- A screenshot region must include region { x, y, width, height }; window capture must include window_id. Verify foreground and the resulting frame before input.
`;

const SOP_SAFETY = `Safety guide

- Observe before acting and verify after acting. Every input must target a known window and verified foreground state.
- Destructive controls/chords are rejected unless allow_destructive=true. Network-game software input is always rejected.
- If the diagnostic verdict is near_zero, the manager latches the window: stop, take a fresh screenshot/detect/ui_tree/find_control, or activate again, then reassess.
- AbortSignal, timeout_ms, and deadlines are hard stops. Do not retry blindly after TIMEOUT, ABORTED, FOREGROUND_NOT_VERIFIED, STALE_CONTROL_REF, or permission errors.
- Never work around OS permissions, Wayland restrictions, or provider capability failures.
`;

const SOP_PLATFORM = `Platform guide

- capabilities reports platform/session and per-feature state; permissions reports screen capture, accessibility, input, and window-control permission state.
- On Wayland, global capture/window/input/accessibility operations may be restricted. Prefer a tested compositor portal or X11 and re-probe.
- Windows and macOS may require screen-recording/accessibility/input permission grants. A denied or prompt state is not permission to proceed.
- Network-game targets reject software input. Unsupported platform, missing native bridge, missing vision model, blank frames, and invalid images are structured failures.
- Native providers must be bounded and verified; do not invoke arbitrary shell commands or guess provider-specific coordinates.
`;

export const COMPUTER_USE_SOPS_BASELINE: EmbeddedSopMap = {
  core: { title: "Observe, act, verify; coordinates, safety latches, and platform limits", body: SOP_CORE },
  coordinates: { title: "Coordinate spaces, client origin, DPI, Retina, image origins, and verification", body: SOP_COORDINATES },
  safety: { title: "Destructive input, near-zero stop, foreground verification, and bounded operations", body: SOP_SAFETY },
  platform: { title: "Capabilities, permissions, Wayland, native bridges, and unsupported targets", body: SOP_PLATFORM },
};

/** Trailing lines appended to the computer-use guide index (mirrors the former index footer). */
export const COMPUTER_USE_INDEX_FOOTER = `Required loop: capabilities/permissions -> observe -> activate -> act -> verify.
Coordinates are physical pixels; ClientToScreen/client origin, Windows DPI, and macOS Retina scaling matter.
Safety stops: near-zero verification, abort/timeout, foreground failure, stale controls, permissions, Wayland, and network-game limits.`;
