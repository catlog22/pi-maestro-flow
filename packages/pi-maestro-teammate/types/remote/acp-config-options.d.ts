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
/** The option id an agent conventionally gives its model selector. */
export declare const ACP_MODEL_CONFIG_ID = "model";
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
 * Resolve a requested model against the options a session advertised.
 *
 * @param configOptions - options advertised by `session/new`.
 * @param requested - the model the task or registration asked for.
 * @returns the config id to set and the advertised value to set it to.
 * @throws when the agent advertises no model selector, or the value is not one
 * it offers.
 */
export declare function resolveModelSelection(configOptions: readonly SessionConfigOption[] | null | undefined, requested: string): {
    configId: string;
    value: string;
};
/**
 * The models a session advertised, for a configuration surface to display.
 *
 * @param configOptions - options advertised by `session/new`.
 * @returns each selectable model as its advertised value and label; empty when
 * the agent advertises no model selector.
 */
export declare function advertisedModels(configOptions: readonly SessionConfigOption[] | null | undefined): readonly {
    value: string;
    label: string;
}[];
