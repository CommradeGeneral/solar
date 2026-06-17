/**
 * Calc Engine
 *
 * Evaluates "calc" expressions for internal tags. An expression references
 * other tags BY NAME and applies a general math operation, e.g.:
 *
 *   INV003_InverterRunningStopped * INV003_PowerFactor
 *   (TankLevel_A + TankLevel_B) / 2
 *   max(P1, P2)
 *
 * Tag names may contain letters, digits, underscore and hyphen. Each name
 * token is resolved to its current numeric value via a resolver callback; any
 * token that does not resolve to a number is left untouched so math functions
 * and constants (sin, abs, pi, ...) still work.
 */

const { compile } = require('mathjs');

// Identifier token: starts with a letter/underscore, may contain letters,
// digits, underscore, hyphen and dots (e.g. actual-power, INV003_PowerFactor).
const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_.\-]*/g;
const SAFE_SYMBOL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Evaluate a calc expression.
 *
 * @param {string} expression - the calc formula
 * @param {(name: string) => number|undefined} resolve - returns a tag's value
 * @returns {number|null} the computed number, or null if it could not be evaluated
 */
const expressionCache = new Map();

function getCachedExpression(expression) {
    const key = String(expression);
    let cached = expressionCache.get(key);
    if (cached) return cached;

    const tokens = referencedTokens(key);
    const aliases = new Map();
    let aliasIndex = 0;
    const compiledExpression = key.replace(TOKEN_RE, (token) => {
        if (SAFE_SYMBOL_RE.test(token)) return token;
        let alias = aliases.get(token);
        if (!alias) {
            alias = `__calc_${aliasIndex++}`;
            aliases.set(token, alias);
        }
        return alias;
    });

    cached = {
        compiled: compile(compiledExpression),
        tokens,
        aliases,
    };
    expressionCache.set(key, cached);
    return cached;
}

function evaluateCalc(expression, resolve) {
    if (!expression || String(expression).trim() === '') return null;

    try {
        const { compiled, tokens, aliases } = getCachedExpression(expression);
        const scope = {};

        for (const token of tokens) {
            const v = resolve(token);
            if (v == null) continue;
            const num = Number(v);
            if (!Number.isFinite(num)) continue;
            scope[aliases.get(token) || token] = num;
        }

        const result = compiled.evaluate(scope);
        const num = typeof result === 'number' ? result : Number(result);
        return Number.isFinite(num) ? num : null;
    } catch (_) {
        // Unknown symbol (a referenced tag not yet available) or bad expression.
        return null;
    }
}

/**
 * Extract the candidate tag-name tokens referenced by an expression.
 * Useful for diagnostics / dependency listing.
 */
function referencedTokens(expression) {
    if (!expression) return [];
    return Array.from(new Set(String(expression).match(TOKEN_RE) || []));
}

module.exports = { evaluateCalc, referencedTokens };
