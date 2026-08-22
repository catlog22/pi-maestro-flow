/**
 * Shortcut hint labels, re-exported so this package's call sites keep one name
 * for them.
 *
 * The implementation lives in `pi-maestro-settings-core` because Cockpit and
 * Teammate render shortcut hints too and cannot import from this package — it
 * sits above both. A copy here is what left every `Alt+…` hint outside this
 * package naming a key that macOS keyboards do not have.
 */

export { altKey, altModifierLabel as altLabel } from "pi-maestro-settings-core/v1";
