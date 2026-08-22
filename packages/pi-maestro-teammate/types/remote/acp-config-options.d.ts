/**
 * Resolution of ACP session configuration options against an operator request.
 *
 * An ACP agent advertises its selectable settings — model, mode, reasoning
 * depth — as `configOptions` on the `session/new` response, and the client
 * chooses among them with `session/set_config_option`. This module owns the
 * pure half of that exchange: locating the option a request names and turning a
 * requested value into an advertised one. The driver owns the wire calls.
 *
 * Two rules from the ACP specification shape the resolution below. `category`
 * is declared UX-only — "It MUST NOT be required for correctness. Clients MUST
 * handle missing or unknown categories gracefully" — so it is a preference and
 * never the sole locator. Select options may arrive flat or grouped, so every
 * reader flattens before matching.
 */
import type { SessionConfigOption, SessionConfigSelectOption, SessionConfigSelectOptions } from "@agentclientprotocol/sdk";
/**
 * The advertised selectors this client knows how to drive.
 *
 * Each value is both the ACP `category` and the option id agents conventionally
 * use for it, which is why one string locates either. Adding an axis is adding
 * a member here and a field that carries it — no per-agent code, because an
 * agent that does not offer one simply advertises no option in that category
 * and the axis reads as empty for it.
 */
export declare const ACP_MODEL_CONFIG_ID = "model";
export declare const ACP_MODE_CONFIG_ID = "mode";
export declare const ACP_THOUGHT_LEVEL_CONFIG_ID = "thought_level";
/**
 * The order selections are applied to a new session.
 *
 * Fixed rather than incidental: ACP says nothing about whether setting one
 * option disturbs another, so the sequence has to be the same on every run for
 * two runs of one registration to be comparable. Mode is set first because it
 * is the coarsest choice, and the model last so it is the most recent word.
 */
export declare const ACP_SELECTION_ORDER: readonly string[];
/**
 * Flatten advertised select options into the selectable values they contain.
 *
 * @param options - the advertised options, flat or grouped.
 * @returns every selectable option, in advertised order.
 */
export declare function flattenSelectOptions(options: SessionConfigSelectOptions): readonly SessionConfigSelectOption[];
/**
 * Locate the select option a config id names.
 *
 * Prefers the advertised `category`, then falls back to the option id, because
 * the specification forbids requiring `category` for correctness: an agent that
 * omits it must still be selectable.
 *
 * @param configOptions - options advertised by `session/new`.
 * @param configId - the option to locate; also the category preferred for it.
 * @returns the matching select option, or undefined when none matches.
 */
export declare function findSelectOption(configOptions: readonly SessionConfigOption[] | null | undefined, configId: string): (SessionConfigOption & {
    type: "select";
}) | undefined;
/**
 * Resolve a requested value against the values an option advertises.
 *
 * Matches the advertised value first. A request that names an option's
 * human-readable name instead resolves only when exactly one advertised value
 * carries that name, so `claude-opus-5` reaches
 * `claude-opus-5[thinking=true,...]` while an ambiguous name is refused rather
 * than silently assigned one variant.
 *
 * @param option - the advertised select option.
 * @param requested - the value or name the operator asked for.
 * @returns the advertised value to send.
 * @throws when nothing matches or a name matches more than once; the message
 * lists every advertised value, so a rejected request is also a catalogue.
 */
export declare function resolveSelectValue(option: SessionConfigOption & {
    type: "select";
}, requested: string): string;
/**
 * Resolve a requested value for one advertised selector.
 *
 * The same resolution serves every axis, because the difference between a model
 * and a reasoning depth is which option the agent published it under, not how a
 * client picks among the values.
 *
 * @param configOptions - options advertised by `session/new`.
 * @param configId - the selector to set; also the category preferred for it.
 * @param requested - the value the task or registration asked for.
 * @returns the config id to set and the advertised value to set it to.
 * @throws when the agent advertises no such selector, or the value is not one
 * it offers.
 */
export declare function resolveConfigSelection(configOptions: readonly SessionConfigOption[] | null | undefined, configId: string, requested: string): {
    configId: string;
    value: string;
};
/**
 * The values one advertised selector offers, for a configuration surface.
 *
 * An empty result is the answer for an agent that does not offer this axis at
 * all, and the settings shell renders it as such. That is why this reports
 * emptiness rather than throwing: not offering a selector is a fact about the
 * agent, not a failure of the request.
 *
 * @param configOptions - options advertised by `session/new`.
 * @param configId - the selector to read; also the category preferred for it.
 * @returns each selectable value with its advertised label; empty when the
 * agent advertises no such selector.
 */
export declare function advertisedValues(configOptions: readonly SessionConfigOption[] | null | undefined, configId: string): readonly {
    value: string;
    label: string;
}[];
