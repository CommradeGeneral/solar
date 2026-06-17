/**
 * Tag Value Registry
 *
 * Process-wide store of the latest numeric value for every tag, keyed by
 * tag_name. Device read paths (Alarm / Historian, Modbus / IEC104) publish
 * values here, and internal "calc" tags read from it to compute derived values
 * (e.g. actual-power = INV003_InverterRunningStopped * INV003_PowerFactor).
 *
 * Singleton: a single shared map across all services in the process.
 */

const values = new Map(); // tag_name -> { value, ts }

/**
 * Publish the latest value for a tag (booleans are normalized to 1/0).
 */
function set(tagName, value) {
    if (tagName == null || tagName === '') return;
    let v = value;
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (typeof v !== 'number') {
        const n = Number(v);
        if (!Number.isFinite(n)) return;
        v = n;
    }
    if (!Number.isFinite(v)) return;
    values.set(String(tagName), { value: v, ts: Date.now() });
}

/**
 * Get the latest numeric value for a tag, or undefined if unknown.
 */
function get(tagName) {
    const entry = values.get(String(tagName));
    return entry ? entry.value : undefined;
}

function getEntry(tagName) {
    return values.get(String(tagName));
}

function has(tagName) {
    return values.has(String(tagName));
}

function clear() {
    values.clear();
}

module.exports = { set, get, getEntry, has, clear };
