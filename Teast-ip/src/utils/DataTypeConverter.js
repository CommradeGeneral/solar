/**
 * Data Type Converter
 * Converts raw PLC/Modbus data to appropriate types
 */

const { evaluate, compile } = require('mathjs');

/**
 * Convert buffer to specified data type
 */
function convertFromBuffer(buffer, dataType, byteOffset = 0, bitOffset = null) {
    const type = dataType?.toLowerCase() || 'int';
    
    switch (type) {
        case 'bool':
        case 'boolean':
            if (bitOffset !== null && bitOffset !== undefined) {
                const byte = buffer.readUInt8(Math.floor(byteOffset));
                return Boolean((byte >> (bitOffset % 8)) & 1);
            }
            return Boolean(buffer.readUInt8(byteOffset) & 1);
            
        case 'byte':
        case 'usint':
            return buffer.readUInt8(byteOffset);
            
        case 'sint':
            return buffer.readInt8(byteOffset);
            
        case 'int':
        case 'int16':
            return buffer.readInt16BE(byteOffset);
            
        case 'uint':
        case 'uint16':
        case 'word':
            return buffer.readUInt16BE(byteOffset);
            
        case 'dint':
        case 'int32':
            return buffer.readInt32BE(byteOffset);
            
        case 'udint':
        case 'uint32':
        case 'dword':
            return buffer.readUInt32BE(byteOffset);
            
        case 'real':
        case 'float':
            return buffer.readFloatBE(byteOffset);
            
        case 'lreal':
        case 'double':
            return buffer.readDoubleBE(byteOffset);
            
        case 'string':
            // S7 string format: first byte is max length, second is actual length
            const maxLen = buffer.readUInt8(byteOffset);
            const actLen = buffer.readUInt8(byteOffset + 1);
            return buffer.toString('ascii', byteOffset + 2, byteOffset + 2 + actLen);
            
        default:
            return buffer.readInt16BE(byteOffset);
    }
}

/**
 * Supported Modbus word/byte orders for multi-register values.
 * Letters describe how the device lays the bytes out relative to the
 * "natural" big-endian order ABCD:
 *   ABCD = big-endian (no swap)            -> [A B C D]
 *   CDAB = word swap (most common)         -> device sends [C D A B]
 *   BADC = byte swap within each register  -> device sends [B A D C]
 *   DCBA = full little-endian              -> device sends [D C B A]
 */
const MODBUS_WORD_ORDERS = ['ABCD', 'CDAB', 'BADC', 'DCBA'];

/**
 * Normalize a word-order string. Falls back to ABCD (current default) when
 * the value is missing or unrecognized.
 */
function normalizeWordOrder(wordOrder) {
    const v = String(wordOrder || '').trim().toUpperCase();
    return MODBUS_WORD_ORDERS.includes(v) ? v : 'ABCD';
}

/**
 * Modbus register types that address 16-bit word registers (so bit-level
 * addressing like 281.12 makes sense). Coils/discrete inputs (0x/1x) are
 * already single bits and don't use bit extraction.
 */
function isModbusRegisterType(registerType) {
    const t = String(registerType || '').toLowerCase().replace('x', '');
    return t === '3' || t === '4';
}

/**
 * How many 16-bit registers must be read for a given data type.
 * When bitOffset is set, we only need enough registers to reach that bit.
 */
function getModbusReadQuantity(dataType, registerCount, bitOffset = null) {
    if (bitOffset != null && Number.isFinite(Number(bitOffset))) {
        return Math.floor(Number(bitOffset) / 16) + 1;
    }
    const type = (dataType || '').toLowerCase();
    switch (type) {
        case 'dint':
        case 'int32':
        case 'udint':
        case 'uint32':
        case 'dword':
        case 'real':
        case 'float':
            return Math.max(2, registerCount || 0);
        case 'lreal':
        case 'double':
            return Math.max(4, registerCount || 0);
        default:
            return registerCount || 1;
    }
}

/**
 * Reorder two registers (32-bit value) into a big-endian buffer per word order.
 */
function orderRegisters32(registers, wordOrder) {
    const reg0 = registers[0] & 0xFFFF;
    const reg1 = registers[1] & 0xFFFF;
    // Natural device byte stream (as received, big-endian within each register)
    const n = [reg0 >> 8, reg0 & 0xFF, reg1 >> 8, reg1 & 0xFF];
    let seq;
    switch (normalizeWordOrder(wordOrder)) {
        case 'CDAB': seq = [n[2], n[3], n[0], n[1]]; break;
        case 'BADC': seq = [n[1], n[0], n[3], n[2]]; break;
        case 'DCBA': seq = [n[3], n[2], n[1], n[0]]; break;
        case 'ABCD':
        default:     seq = [n[0], n[1], n[2], n[3]]; break;
    }
    return Buffer.from(seq);
}

/**
 * Reorder four registers (64-bit value) into a big-endian buffer per word order.
 */
function orderRegisters64(registers, wordOrder) {
    const n = [];
    for (let i = 0; i < 4; i++) {
        const r = registers[i] & 0xFFFF;
        n.push(r >> 8, r & 0xFF);
    }
    let seq;
    switch (normalizeWordOrder(wordOrder)) {
        case 'CDAB': seq = [n[6], n[7], n[4], n[5], n[2], n[3], n[0], n[1]]; break;
        case 'BADC': seq = [n[1], n[0], n[3], n[2], n[5], n[4], n[7], n[6]]; break;
        case 'DCBA': seq = [n[7], n[6], n[5], n[4], n[3], n[2], n[1], n[0]]; break;
        case 'ABCD':
        default:     seq = [...n]; break;
    }
    return Buffer.from(seq);
}

/**
 * Convert Modbus registers to specified data type.
 *
 * @param {object|Array} data - modbus-serial read result (or raw array)
 * @param {string} dataType - int, uint, dint, real, ...
 * @param {number} registerCount - number of 16-bit registers read
 * @param {object} [options]
 * @param {string} [options.wordOrder] - ABCD | CDAB | BADC | DCBA (for 32/64-bit)
 * @param {number|null} [options.bitOffset] - when set, extract a single bit
 *        from the read register(s) and return a boolean (e.g. 281.12 -> bit 12).
 */
function convertFromRegisters(data, dataType, registerCount = 1, options = {}) {
    const type = dataType?.toLowerCase() || 'int';
    const { wordOrder = null, bitOffset = null } = options;

    // For coils/discrete inputs (boolean array)
    if (Array.isArray(data) && typeof data[0] === 'boolean') {
        return data[0];
    }

    // For register data
    const registers = data.data || data;

    if (!registers || registers.length === 0) {
        return null;
    }

    // Bit-level addressing on a 16-bit register (e.g. 281.12 -> register 281, bit 12).
    // Takes priority over data_type: the result is always a boolean.
    if (bitOffset != null && Number.isFinite(Number(bitOffset))) {
        const bit = Number(bitOffset);
        const regIndex = Math.floor(bit / 16);
        const bitInReg = bit % 16;
        const reg = registers[regIndex] != null ? registers[regIndex] : registers[0];
        return Boolean((reg >> bitInReg) & 1);
    }

    switch (type) {
        case 'bool':
        case 'boolean':
            return Boolean(registers[0] & 1);

        case 'int':
        case 'int16':
            // Convert unsigned to signed
            const val = registers[0];
            return val > 32767 ? val - 65536 : val;

        case 'uint':
        case 'uint16':
        case 'word':
            return registers[0];

        case 'dint':
        case 'int32':
            if (registers.length < 2) return registers[0];
            return orderRegisters32(registers, wordOrder).readInt32BE(0);

        case 'udint':
        case 'uint32':
        case 'dword':
            if (registers.length < 2) return registers[0];
            return orderRegisters32(registers, wordOrder).readUInt32BE(0);

        case 'real':
        case 'float':
            if (registers.length < 2) return registers[0];
            return orderRegisters32(registers, wordOrder).readFloatBE(0);

        case 'lreal':
        case 'double':
            if (registers.length < 4) return registers[0];
            return orderRegisters64(registers, wordOrder).readDoubleBE(0);

        default:
            return registers[0];
    }
}

/**
 * Get byte size for data type
 */
function getDataTypeSize(dataType) {
    const type = dataType?.toLowerCase() || 'int';
    
    switch (type) {
        case 'bool':
        case 'boolean':
        case 'byte':
        case 'usint':
        case 'sint':
            return 1;
            
        case 'int':
        case 'int16':
        case 'uint':
        case 'uint16':
        case 'word':
            return 2;
            
        case 'dint':
        case 'int32':
        case 'udint':
        case 'uint32':
        case 'dword':
        case 'real':
        case 'float':
            return 4;
            
        case 'lreal':
        case 'double':
            return 8;
            
        default:
            return 2;
    }
}

/**
 * Equation Parser
 * Applies mathematical equations to values
 */
class EquationParser {
    constructor() {
        this.cache = new Map();
    }

    /**
     * Apply equation to a value
     * @param {string} equation - Equation string like "(x/2)" or "(x*100+5)"
     * @param {number} x - The raw value
     * @returns {number} - The calculated result
     */
    apply(equation, x) {
        if (!equation || equation.trim() === '') {
            return x;
        }

        try {
            // Evaluate using mathjs scope to avoid breaking identifiers like max/exp.
            // Support both x and X as variable names.
            const rawX =
                typeof x === 'boolean' ? (x ? 1 : 0) :
                (typeof x === 'number' ? x : Number(x));

            if (!Number.isFinite(rawX)) {
                return x;
            }

            let compiledExpr = this.cache.get(equation);
            if (!compiledExpr) {
                compiledExpr = compile(equation);
                this.cache.set(equation, compiledExpr);
            }

            const result = compiledExpr.evaluate({ x: rawX, X: rawX });
            const num = typeof result === 'number' ? result : Number(result);
            return Number.isFinite(num) ? num : x;
        } catch (error) {
            // Return original value if equation fails
            return x;
        }
    }

    /**
     * Validate an equation
     * @param {string} equation - Equation to validate
     * @returns {boolean} - True if valid
     */
    validate(equation) {
        if (!equation || equation.trim() === '') {
            return true;
        }

        try {
            // Compile and evaluate with a sample value.
            const compiledExpr = compile(equation);
            const result = compiledExpr.evaluate({ x: 1, X: 1 });
            const num = typeof result === 'number' ? result : Number(result);
            if (!Number.isFinite(num)) {
                return false;
            }
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get reverse equation (for display to raw conversion)
     * Only works for simple linear equations
     */
    getReverseEquation(equation) {
        if (!equation || equation.trim() === '') {
            return 'x';
        }

        // Simple pattern matching for common equations
        // (x/n) -> (x*n)
        const divMatch = equation.match(/\(x\/(\d+\.?\d*)\)/);
        if (divMatch) {
            return `(x*${divMatch[1]})`;
        }

        // (x*n) -> (x/n)
        const mulMatch = equation.match(/\(x\*(\d+\.?\d*)\)/);
        if (mulMatch) {
            return `(x/${mulMatch[1]})`;
        }

        // (x+n) -> (x-n)
        const addMatch = equation.match(/\(x\+(\d+\.?\d*)\)/);
        if (addMatch) {
            return `(x-${addMatch[1]})`;
        }

        // (x-n) -> (x+n)
        const subMatch = equation.match(/\(x-(\d+\.?\d*)\)/);
        if (subMatch) {
            return `(x+${subMatch[1]})`;
        }

        return null; // Cannot reverse complex equations
    }
}

module.exports = {
    convertFromBuffer,
    convertFromRegisters,
    getDataTypeSize,
    EquationParser,
    // Modbus word-order + bit-addressing helpers
    MODBUS_WORD_ORDERS,
    normalizeWordOrder,
    isModbusRegisterType,
    getModbusReadQuantity,
};
