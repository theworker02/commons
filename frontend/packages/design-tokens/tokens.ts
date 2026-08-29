import tokenDocument from './tokens.json';

/**
 * The JSON document is the canonical source. This typed export keeps the
 * package dependency-free while letting TypeScript consumers inspect tokens
 * without requiring a runtime token compiler.
 */
export const tokens = tokenDocument;
export type CommonsTokens = typeof tokens;
export type TokenDocument = CommonsTokens;
export default tokens;
