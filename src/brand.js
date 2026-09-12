/**
 * The host's brand helpers (`@deepseek-ai/dsh-brand`, `dsh-llm`'s `ProviderRequestId`)
 * are not declared plugin dependencies, so this plugin keeps its own trivial
 * miminal stand-in for the two branded strings it must produce.
 *
 * A brand is a compile-time tag over a plain string: at runtime these are
 * identity functions, which is exactly what the host's own `brandString` is.
 * Keeping the helper local means the adapter never depends on a private
 * package path that DESIGN.md §2.9 warns can drift.
 *
 * @module dsh-opencodego/brand
 */

/**
 * Runtime identity over a string, tagged as a `ToolCallId` for the host's
 * `tool-call-delta` chunk contract.
 * @param {string} value - the provider-issued call id.
 * @returns {string} the same value.
 */
export function brandString(value) {
  return value
}
