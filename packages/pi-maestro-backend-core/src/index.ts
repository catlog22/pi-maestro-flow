/**
 * Package root.
 *
 * `export type *` rather than `export *`: this package is types only, and the
 * type-only form makes a consumer's bundler drop the import entirely instead of
 * emitting a runtime require for a module that contributes no runtime code.
 */
export type * from "./public/v1/index.ts";
