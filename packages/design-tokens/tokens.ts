import tokenDocument from './tokens.json';

export const tokens = tokenDocument;
export type CommonsTokens = typeof tokens;
export type TokenDocument = CommonsTokens;
export default tokens;
