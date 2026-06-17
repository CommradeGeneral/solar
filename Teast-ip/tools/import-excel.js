/**
 * Excel Importer Tool
 * Imports IEC104, Modbus, alarm, and historian data from Excel files.
 *
 * Usage:
 * node tools/import-excel.js
 */

const ExcelJS = require('exceljs');
const sql = require('mssql/msnodesqlv8');
const path = require('path');
const fs = require('fs');
const ini = require('ini');

// ============================================================
// Configuration
// ============================================================
// ============================================================
// Load configuration from config.ini (if present)
// ============================================================
const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve(__dirname, '../config.ini');
let configFromIni = {};
if (fs.existsSync(CONFIG_PATH)) {
    try {
        const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
        configFromIni = ini.parse(content);
    } catch (error) {
        console.warn(`Failed to read config.ini: ${error.message}`);
    }
}

const dbSection = configFromIni.Database || {};
const normalizeBool = (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return false;
    const v = value.trim().toLowerCase();
    return v === 'true' || v === 'yes' || v === '1';
};
const useWindowsAuth = normalizeBool(dbSection.UseWindowsAuth);
const customDriverName =
    typeof dbSection.Driver === 'string' && dbSection.Driver.trim() !== ''
        ? dbSection.Driver.trim()
        : null;

// ============================================================
// Settings
// ============================================================
const CONFIG = {
    database: {
        server: dbSection.Server || '192.168.1.2',
        database: dbSection.Database || 'IndustrialDB',
        ...(useWindowsAuth
            ? { driver: 'msnodesqlv8' }
            : {
                  user: dbSection.User || 'sa',
                  password: dbSection.Password != null ? String(dbSection.Password) : 'YourPassword123!',
              }),
        options: {
            encrypt: dbSection.Encrypt || false,
            trustServerCertificate: dbSection.TrustServerCertificate !== false,
            ...(useWindowsAuth ? { trustedConnection: true } : {}),
        }
    },

    excelFiles: {
        analogAlarms: path.resolve(__dirname, '../excel-data/Analog_Alarm.xlsx'),
        discreteAlarms: path.resolve(__dirname, '../excel-data/Discrete_Alarm.xlsx'),
        historian: path.resolve(__dirname, '../excel-data/History.xlsx'),
    }
};

// ============================================================
// Excel parsing
// ============================================================

/**
 * Read an Excel worksheet and convert it to an array of objects.
 */

function normalizeCellValue(value) {
    if (value == null) return null;
    if (typeof value === 'object') {
        if (value.text) return value.text;
        if (value.richText) return value.richText.map(p => p.text).join('');
        if (value.formula != null && value.result != null) return value.result;
        if (value.result != null) return value.result;
    }
    return value;
}

function sheetToJson(worksheet) {
    const headerRow = worksheet.getRow(1);
    const headers = headerRow.values
        .slice(1)
        .map(h => (h != null ? String(h).trim() : ''))
        .map(h => (h === '' ? null : h));

    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const obj = {};
        let hasData = false;
        headers.forEach((header, idx) => {
            if (!header) return;
            const cell = row.getCell(idx + 1);
            const value = normalizeCellValue(cell.value);
            if (value !== null && value !== undefined && value !== '') {
                obj[header] = value;
                hasData = true;
            }
        });
        if (hasData) rows.push(obj);
    });

    return rows;
}

async function readExcelFile(filePath) {
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        return null;
    }
    
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheets = {};
    
    workbook.eachSheet((worksheet) => {
        sheets[worksheet.name] = sheetToJson(worksheet);
    });
    
    return sheets;
}

/**
 * Read IEC104 devices from Excel sheets.
 */
function readIEC104Devices(sheets) {
    const iecSheet = sheets['IEC104'] || sheets['iec104'] || sheets['IEC104Devices'] || sheets['IEC104_Devices'];
    if (!iecSheet) {
        console.warn('IEC104 sheet not found');
        return [];
    }

    const intOrNull = (v) => {
        if (v == null || v === '') return null;
        const n = parseInt(v, 10);
        return Number.isNaN(n) ? null : n;
    };

    return iecSheet.map(row => ({
        device_id: row['device_id'] || row['Device_ID'] || row['id'],
        device_name: row['device_name'] || row['Device_Name'] || row['name'],
        ip_address: row['ip_address'] || row['IP_Address'] || row['ip'],
        port: intOrNull(row['port'] || row['Port']) ?? 2404,
        t1: intOrNull(row['t1'] || row['T1']),
        t2: intOrNull(row['t2'] || row['T2']),
        t3: intOrNull(row['t3'] || row['T3']),
        k: intOrNull(row['k'] || row['K']),
        w: intOrNull(row['w'] || row['W']),
        gi_interval: intOrNull(row['gi_interval'] || row['Gi_Interval'] || row['GI_Interval']),
        description: row['description'] || row['Description'] || '',
    }));
}

/**
 * Read Modbus devices from Excel sheets.
 */
function readModbusDevices(sheets) {
    const modbusSheet = sheets['ModbusDevices'] || sheets['Modbus'] || sheets['modbus'];
    if (!modbusSheet) {
        console.warn('ModbusDevices sheet not found');
        return [];
    }
    
    return modbusSheet.map(row => ({
        device_id: row['device_id'] || row['Device_ID'] || row['id'],
        device_name: row['device_name'] || row['Device_Name'] || row['name'],
        ip_address: row['ip_address'] || row['IP_Address'] || row['ip'],
        port: parseInt(row['port'] || row['Port'] || 502),
        unit_id: parseInt(row['unit_id'] || row['Unit_ID'] || 1),
        connection_type: row['connection_type'] || row['Connection_Type'] || 'tcp',
        serial_port: row['serial_port'] || row['Serial_Port'] || null,
        baud_rate: parseInt(row['baud_rate'] || row['Baud_Rate'] || 9600),
        parity: row['parity'] || row['Parity'] || 'none',
        stop_bits: parseInt(row['stop_bits'] || row['Stop_Bits'] || 1),
        data_bits: parseInt(row['data_bits'] || row['Data_Bits'] || 8),
        description: row['description'] || row['Description'] || '',
    }));
}

/**
 * Parse a Modbus address that may carry a bit using register.bit notation,
 * e.g. "281.12" -> { address: 281, bit: 12 }, "296" -> { address: 296, bit: null }.
 *
 * NOTE: the part after the dot is the bit NUMBER (not a decimal fraction), so
 * 281.12 means bit 12 (the same convention Siemens uses for byte.bit). If you
 * need bit 10, format that Excel cell as Text ("281.10"); a plain numeric cell
 * collapses 281.10 to 281.1 (bit 1). Alternatively use a separate "bit" column.
 */
function parseModbusAddress(raw) {
    if (raw == null || raw === '') return { address: null, bit: null };
    const s = String(raw).trim();
    if (s === '') return { address: null, bit: null };

    if (s.includes('.')) {
        const [regPart, bitPart] = s.split('.');
        const address = parseInt(regPart, 10);
        const bit = parseInt(bitPart, 10);
        return {
            address: Number.isNaN(address) ? null : address,
            bit: Number.isNaN(bit) ? null : bit,
        };
    }

    const address = parseInt(s, 10);
    return { address: Number.isNaN(address) ? null : address, bit: null };
}

/**
 * Normalize a Modbus word/byte order value. Returns null when not provided so
 * the runtime default (ABCD) applies.
 */
function normalizeWordOrder(raw) {
    if (raw == null || raw === '') return null;
    const v = String(raw).trim().toUpperCase();
    return ['ABCD', 'CDAB', 'BADC', 'DCBA'].includes(v) ? v : null;
}

/**
 * Parse an IEC104 Type ID written either as a number (e.g. 13) or as the
 * standard mnemonic (e.g. M_ME_NC_1). Returns the numeric Type ID or null.
 */
const IEC104_TYPE_MNEMONICS = {
    M_SP_NA_1: 1,
    M_DP_NA_1: 3,
    M_ME_NA_1: 9,
    M_ME_NB_1: 11,
    M_ME_NC_1: 13,
    M_IT_NA_1: 15,
    M_ME_ND_1: 21,
};
function parseIec104TypeId(raw) {
    if (raw == null || raw === '') return null;
    const s = String(raw).trim().toUpperCase();
    if (IEC104_TYPE_MNEMONICS[s] != null) return IEC104_TYPE_MNEMONICS[s];
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? null : n;
}

/**
 * Read tags from Excel sheets.
 */
function readTags(sheets) {
    const tagsSheet = sheets['Tags'] || sheets['tags'] || sheets['Sheet1'];
    if (!tagsSheet) {
        console.warn('Tags sheet not found');
        return [];
    }
    
    return tagsSheet
        .map(row => {
        // Modbus address may be written as register.bit (e.g. 281.12 = register 281, bit 12).
        const parsedAddr = parseModbusAddress(
            row['modbus_address'] ?? row['Modbus_Address'] ?? row['address'] ?? row['Address']
        );
        // An explicit bit column wins over a bit embedded in the address.
        const explicitBit = row['bit_offset'] != null
            ? parseInt(row['bit_offset'])
            : (row['bit'] != null ? parseInt(row['bit']) : (row['Bit'] != null ? parseInt(row['Bit']) : null));
        const bitOffset = (explicitBit != null && !Number.isNaN(explicitBit))
            ? explicitBit
            : parsedAddr.bit;

        return ({
            id: parseInt(
                row['id'] ??
                row['ID'] ??
                row['Tag_ID'] ??
                row['tag_id'] ??
                row['TagId'] ??
                row['Tag Id'] ??
                row['TAG_ID']
            ),
        tag_name: row['tag_name'] || row['Tag_Name'] || row['name'],
        protocol_type: (row['protocol_type'] || row['Protocol_Type'] || 'modbus').toLowerCase(),
        // IEC104 fields
        iec104_device_id: row['iec104_device_id'] || row['IEC104_Device_ID'] || row['IEC104_Device_Id'] || null,
        iec104_asdu_address: parseInt(row['iec104_asdu_address'] || row['IEC104_ASDU_Address'] || row['asdu_address']) || null,
        iec104_ioa: parseInt(row['iec104_ioa'] || row['IEC104_IOA'] || row['ioa']) || null,
        iec104_type_id: parseIec104TypeId(row['iec104_type_id'] || row['IEC104_Type_ID'] || row['type_id']),
        // Modbus fields
        bit_offset: bitOffset,
        modbus_device_id: row['modbus_device_id'] || row['Modbus_Device_ID'] || null,
        register_type: row['register_type'] || row['Register_Type'] || null,
        modbus_address: parsedAddr.address,
        register_count: parseInt(row['register_count'] || row['Register_Count'] || 1),
        word_order: normalizeWordOrder(
            row['word_order'] ?? row['Word_Order'] ?? row['byte_order'] ?? row['Byte_Order']
        ),
        data_type: row['data_type'] || row['Data_Type'] || 'int',
        equation: row['equation'] || row['Equation'] || null,
        // Internal/calc tag formula (e.g. INV003_Run * INV003_PowerFactor)
        calc: row['calc'] || row['Calc'] || row['CALC'] || null,
        limit_value: parseFloat(row['limit_value'] || row['Limit_Value']) || null,
        limit_mode: row['limit_mode'] || row['Limit_Mode'] || 'High',
        alarm_class: row['alarm_class'] || row['Alarm_Class'] || null,
        alarm_number: parseInt(row['alarm_number'] || row['Alarm_Number']) || null,
        alarm_type: row['alarm_type'] || row['Alarm_Type'] || 'alarm',
        alarm_text: row['alarm_text'] || row['Alarm_Text'] || row['tag_name'] || row['Tag_Name'] || row['name'],
        alarm_tooltip: row['alarm_tooltip'] || row['Alarm_Tooltip'] || null,
        additional_text1: row['additional_text1'] || row['Additional_Text1'] || null,
        additional_text2: row['additional_text2'] || row['Additional_Text2'] || null,
        consecutive_true_count: parseInt(row['consecutive_true_count'] || row['Consecutive_True_Count'] || 3),
        consecutive_false_count: parseInt(row['consecutive_false_count'] || row['Consecutive_False_Count'] || 3),
        chatter_filter_ms: parseInt(row['chatter_filter_ms'] || row['Chatter_Filter_Ms'] || 1000),
        // Historian fields
        reading_cycle: row['reading_cycle'] || row['Reading_Cycle'] || row['reading_cycles'] || '1 min',
        reading_cycle_ms: parseInt(row['reading_cycle_ms'] || row['Reading_Cycle_Ms'] || 60000),
        // Deadband (optional: 0 or null = disabled)
        deadband: parseFloat(row['deadband'] || row['Deadband'] || row['dead_band'] || 0) || 0,
        deadband_check_cycle_s: parseFloat(row['deadband_check_cycle_s'] || row['Deadband_Check_Cycle_S'] || row['deadband_check_cycle'] || 0) || 0,
        description: row['description'] || row['Description'] || null,
        });
    })
    .filter(tag => {
        if (Number.isNaN(tag.id) || tag.id == null) {
            console.warn(`Skipping row without tag_id: ${tag.tag_name || 'unknown'}`);
            return false;
        }
        // Validate deadband
        if (tag.deadband < 0) {
            console.warn(`Tag ${tag.id}: deadband is negative (${tag.deadband}); reset to 0`);
            tag.deadband = 0;
        }
        if (tag.deadband_check_cycle_s < 0) {
            console.warn(`Tag ${tag.id}: deadband_check_cycle_s is negative; reset to 0`);
            tag.deadband_check_cycle_s = 0;
        }
        if (tag.deadband_check_cycle_s > 0) {
            const rounded = Math.max(1, Math.round(tag.deadband_check_cycle_s));
            if (rounded !== tag.deadband_check_cycle_s) {
                console.warn(`Tag ${tag.id}: deadband_check_cycle_s rounded to ${rounded}s`);
            }
            tag.deadband_check_cycle_s = rounded;
        }
        // Bool tags cannot use deadband
        const dtype = (tag.data_type || '').toLowerCase();
        if (tag.deadband > 0 && (dtype === 'bool' || dtype === 'boolean')) {
            console.warn(`Tag ${tag.id}: deadband is not supported for Bool; reset to 0`);
            tag.deadband = 0;
            tag.deadband_check_cycle_s = 0;
        }
        return true;
    });
}

// ============================================================
// Database import helpers
// ============================================================

/**
 * Insert or update IEC104 devices.
 */
async function insertIEC104Devices(pool, devices) {
    console.log(`\nImporting ${devices.length} IEC104 Devices...`);

    for (const dev of devices) {
        try {
            await pool.request()
                .input('device_id', sql.NVarChar, dev.device_id)
                .input('device_name', sql.NVarChar, dev.device_name)
                .input('ip_address', sql.NVarChar, dev.ip_address)
                .input('port', sql.Int, dev.port)
                .input('t1', sql.Int, dev.t1)
                .input('t2', sql.Int, dev.t2)
                .input('t3', sql.Int, dev.t3)
                .input('k', sql.Int, dev.k)
                .input('w', sql.Int, dev.w)
                .input('gi_interval', sql.Int, dev.gi_interval)
                .input('description', sql.NVarChar, dev.description)
                .query(`
                    MERGE IEC104Devices AS target
                    USING (SELECT @device_id AS device_id) AS source
                    ON target.device_id = source.device_id
                    WHEN MATCHED THEN
                        UPDATE SET device_name = @device_name, ip_address = @ip_address,
                                   port = @port, t1 = @t1, t2 = @t2, t3 = @t3,
                                   k = @k, w = @w, gi_interval = @gi_interval,
                                   description = @description, updated_at = GETDATE()
                    WHEN NOT MATCHED THEN
                        INSERT (device_id, device_name, ip_address, port, t1, t2, t3, k, w, gi_interval, description)
                        VALUES (@device_id, @device_name, @ip_address, @port, @t1, @t2, @t3, @k, @w, @gi_interval, @description);
                `);
            console.log(`  ${dev.device_id}: ${dev.device_name} (${dev.ip_address}:${dev.port})`);
        } catch (error) {
            console.error(`  ${dev.device_id}: ${error.message}`);
        }
    }
}

/**
 * Insert or update Modbus devices.
 */
async function insertModbusDevices(pool, devices) {
    console.log(`\nImporting ${devices.length} Modbus Devices...`);

    for (const device of devices) {
        try {
            await pool.request()
                .input('device_id', sql.NVarChar, device.device_id)
                .input('device_name', sql.NVarChar, device.device_name)
                .input('ip_address', sql.NVarChar, device.ip_address)
                .input('port', sql.Int, device.port)
                .input('unit_id', sql.Int, device.unit_id)
                .input('connection_type', sql.NVarChar, device.connection_type)
                .input('serial_port', sql.NVarChar, device.serial_port)
                .input('baud_rate', sql.Int, device.baud_rate)
                .input('parity', sql.NVarChar, device.parity)
                .input('stop_bits', sql.Int, device.stop_bits)
                .input('data_bits', sql.Int, device.data_bits)
                .input('description', sql.NVarChar, device.description)
                .query(`
                    MERGE ModbusDevices AS target
                    USING (SELECT @device_id AS device_id) AS source
                    ON target.device_id = source.device_id
                    WHEN MATCHED THEN
                        UPDATE SET device_name = @device_name, ip_address = @ip_address,
                                   port = @port, unit_id = @unit_id, connection_type = @connection_type,
                                   serial_port = @serial_port, baud_rate = @baud_rate,
                                   parity = @parity, stop_bits = @stop_bits, data_bits = @data_bits,
                                   description = @description, updated_at = GETDATE()
                    WHEN NOT MATCHED THEN
                        INSERT (device_id, device_name, ip_address, port, unit_id, connection_type,
                                serial_port, baud_rate, parity, stop_bits, data_bits, description)
                        VALUES (@device_id, @device_name, @ip_address, @port, @unit_id, @connection_type,
                                @serial_port, @baud_rate, @parity, @stop_bits, @data_bits, @description);
                `);
            console.log(`  ${device.device_id}: ${device.device_name}`);
        } catch (error) {
            console.error(`  ${device.device_id}: ${error.message}`);
        }
    }
}

/**
 * Insert or update analog alarm tags.
 */
async function insertAnalogAlarmTags(pool, tags) {
    console.log(`\nImporting ${tags.length} Analog Alarm Tags...`);

    for (const tag of tags) {
        try {
            const alarmText = tag.alarm_text || tag.tag_name || String(tag.id);
            await pool.request()
                .input('id', sql.Int, tag.id)
                .input('tag_name', sql.NVarChar, tag.tag_name)
                .input('protocol_type', sql.NVarChar, tag.protocol_type)
                .input('iec104_device_id', sql.NVarChar, tag.iec104_device_id)
                .input('iec104_asdu_address', sql.Int, tag.iec104_asdu_address)
                .input('iec104_ioa', sql.Int, tag.iec104_ioa)
                .input('iec104_type_id', sql.Int, tag.iec104_type_id)
                .input('bit_offset', sql.Int, tag.bit_offset)
                .input('modbus_device_id', sql.NVarChar, tag.modbus_device_id)
                .input('register_type', sql.NVarChar, tag.register_type)
                .input('modbus_address', sql.Int, tag.modbus_address)
                .input('register_count', sql.Int, tag.register_count)
                .input('word_order', sql.NVarChar, tag.word_order)
                .input('data_type', sql.NVarChar, tag.data_type)
                .input('equation', sql.NVarChar, tag.equation)
                .input('calc', sql.NVarChar, tag.calc)
                .input('limit_value', sql.Float, tag.limit_value)
                .input('limit_mode', sql.NVarChar, tag.limit_mode)
                .input('alarm_class', sql.NVarChar, tag.alarm_class)
                .input('alarm_number', sql.Int, tag.alarm_number)
                .input('alarm_type', sql.NVarChar, tag.alarm_type)
                .input('alarm_text', sql.NVarChar, alarmText)
                .input('alarm_tooltip', sql.NVarChar, tag.alarm_tooltip)
                .input('additional_text1', sql.NVarChar, tag.additional_text1)
                .input('additional_text2', sql.NVarChar, tag.additional_text2)
                .input('consecutive_true_count', sql.Int, tag.consecutive_true_count)
                .input('consecutive_false_count', sql.Int, tag.consecutive_false_count)
                .input('chatter_filter_ms', sql.Int, tag.chatter_filter_ms)
                .query(`
                    MERGE AnalogAlarmTags AS target
                    USING (SELECT @id AS id) AS source
                    ON target.id = source.id
                    WHEN MATCHED THEN
                        UPDATE SET tag_name = @tag_name, protocol_type = @protocol_type,
                                   iec104_device_id = @iec104_device_id, iec104_asdu_address = @iec104_asdu_address,
                                   iec104_ioa = @iec104_ioa, iec104_type_id = @iec104_type_id,
                                   bit_offset = @bit_offset, modbus_device_id = @modbus_device_id,
                                   register_type = @register_type, modbus_address = @modbus_address,
                                   register_count = @register_count, word_order = @word_order,
                                   data_type = @data_type,
                                   equation = @equation, calc = @calc,
                                   limit_value = @limit_value, limit_mode = @limit_mode,
                                   alarm_class = @alarm_class, alarm_number = @alarm_number,
                                   alarm_type = @alarm_type, alarm_text = @alarm_text,
                                   alarm_tooltip = @alarm_tooltip, additional_text1 = @additional_text1,
                                   additional_text2 = @additional_text2,
                                   consecutive_true_count = @consecutive_true_count,
                                   consecutive_false_count = @consecutive_false_count,
                                   chatter_filter_ms = @chatter_filter_ms, updated_at = GETDATE()
                    WHEN NOT MATCHED THEN
                        INSERT (id, tag_name, protocol_type, iec104_device_id, iec104_asdu_address,
                                iec104_ioa, iec104_type_id, bit_offset,
                                modbus_device_id, register_type, modbus_address, register_count, word_order,
                                data_type, equation, calc, limit_value, limit_mode, alarm_class, alarm_number,
                                alarm_type, alarm_text, alarm_tooltip, additional_text1, additional_text2,
                                consecutive_true_count, consecutive_false_count, chatter_filter_ms)
                        VALUES (@id, @tag_name, @protocol_type, @iec104_device_id, @iec104_asdu_address,
                                @iec104_ioa, @iec104_type_id, @bit_offset,
                                @modbus_device_id, @register_type, @modbus_address, @register_count, @word_order,
                                @data_type, @equation, @calc, @limit_value, @limit_mode, @alarm_class, @alarm_number,
                                @alarm_type, @alarm_text, @alarm_tooltip, @additional_text1, @additional_text2,
                                @consecutive_true_count, @consecutive_false_count, @chatter_filter_ms);
                `);
            console.log(`  ${tag.id}: ${tag.tag_name}`);
        } catch (error) {
            console.error(`  ${tag.id}: ${error.message}`);
        }
    }
}

/**
 * Insert or update discrete alarm tags.
 */
async function insertDiscreteAlarmTags(pool, tags) {
    console.log(`\nImporting ${tags.length} Discrete Alarm Tags...`);

    for (const tag of tags) {
        try {
            const alarmText = tag.alarm_text || tag.tag_name || String(tag.id);
            await pool.request()
                .input('id', sql.Int, tag.id)
                .input('tag_name', sql.NVarChar, tag.tag_name)
                .input('protocol_type', sql.NVarChar, tag.protocol_type)
                .input('iec104_device_id', sql.NVarChar, tag.iec104_device_id)
                .input('iec104_asdu_address', sql.Int, tag.iec104_asdu_address)
                .input('iec104_ioa', sql.Int, tag.iec104_ioa)
                .input('iec104_type_id', sql.Int, tag.iec104_type_id)
                .input('bit_offset', sql.Int, tag.bit_offset)
                .input('modbus_device_id', sql.NVarChar, tag.modbus_device_id)
                .input('register_type', sql.NVarChar, tag.register_type)
                .input('modbus_address', sql.Int, tag.modbus_address)
                .input('register_count', sql.Int, tag.register_count)
                .input('word_order', sql.NVarChar, tag.word_order)
                .input('data_type', sql.NVarChar, tag.data_type || 'Bool')
                .input('equation', sql.NVarChar, tag.equation)
                .input('calc', sql.NVarChar, tag.calc)
                .input('limit_mode', sql.NVarChar, tag.limit_mode)
                .input('alarm_class', sql.NVarChar, tag.alarm_class)
                .input('alarm_number', sql.Int, tag.alarm_number)
                .input('alarm_type', sql.NVarChar, tag.alarm_type)
                .input('alarm_text', sql.NVarChar, alarmText)
                .input('alarm_tooltip', sql.NVarChar, tag.alarm_tooltip)
                .input('consecutive_true_count', sql.Int, tag.consecutive_true_count)
                .input('consecutive_false_count', sql.Int, tag.consecutive_false_count)
                .input('chatter_filter_ms', sql.Int, tag.chatter_filter_ms)
                .query(`
                    MERGE DiscreteAlarmTags AS target
                    USING (SELECT @id AS id) AS source
                    ON target.id = source.id
                    WHEN MATCHED THEN
                        UPDATE SET tag_name = @tag_name, protocol_type = @protocol_type,
                                   iec104_device_id = @iec104_device_id, iec104_asdu_address = @iec104_asdu_address,
                                   iec104_ioa = @iec104_ioa, iec104_type_id = @iec104_type_id,
                                   bit_offset = @bit_offset, modbus_device_id = @modbus_device_id,
                                   register_type = @register_type, modbus_address = @modbus_address,
                                   register_count = @register_count, word_order = @word_order,
                                   data_type = @data_type,
                                   equation = @equation, calc = @calc, limit_mode = @limit_mode,
                                   alarm_class = @alarm_class, alarm_number = @alarm_number,
                                   alarm_type = @alarm_type, alarm_text = @alarm_text,
                                   alarm_tooltip = @alarm_tooltip,
                                   consecutive_true_count = @consecutive_true_count,
                                   consecutive_false_count = @consecutive_false_count,
                                   chatter_filter_ms = @chatter_filter_ms, updated_at = GETDATE()
                    WHEN NOT MATCHED THEN
                        INSERT (id, tag_name, protocol_type, iec104_device_id, iec104_asdu_address,
                                iec104_ioa, iec104_type_id, bit_offset,
                                modbus_device_id, register_type, modbus_address, register_count, word_order,
                                data_type, equation, calc, limit_mode, alarm_class, alarm_number,
                                alarm_type, alarm_text, alarm_tooltip,
                                consecutive_true_count, consecutive_false_count, chatter_filter_ms)
                        VALUES (@id, @tag_name, @protocol_type, @iec104_device_id, @iec104_asdu_address,
                                @iec104_ioa, @iec104_type_id, @bit_offset,
                                @modbus_device_id, @register_type, @modbus_address, @register_count, @word_order,
                                @data_type, @equation, @calc, @limit_mode, @alarm_class, @alarm_number,
                                @alarm_type, @alarm_text, @alarm_tooltip,
                                @consecutive_true_count, @consecutive_false_count, @chatter_filter_ms);
                `);
            console.log(`  ${tag.id}: ${tag.tag_name}`);
        } catch (error) {
            console.error(`  ${tag.id}: ${error.message}`);
        }
    }
}

/**
 * Insert or update historian tags.
 */
async function insertHistorianTags(pool, tags) {
    console.log(`\nImporting ${tags.length} Historian Tags...`);

    // Convert reading_cycle to milliseconds
    const cycleToMs = (cycle) => {
        if (!cycle) return 60000;
        const lower = cycle.toLowerCase();
        if (lower.includes('sec')) {
            const num = parseInt(lower) || 1;
            return num * 1000;
        }
        if (lower.includes('min')) {
            const num = parseInt(lower) || 1;
            return num * 60000;
        }
        if (lower.includes('hour')) {
            const num = parseInt(lower) || 1;
            return num * 3600000;
        }
        return 60000;
    };

    for (const tag of tags) {
        try {
            const cycleMs = tag.reading_cycle_ms || cycleToMs(tag.reading_cycle);
            const request = pool.request();
            request
                .input('tag_id', sql.Int, tag.id)
                .input('tag_name', sql.NVarChar, tag.tag_name)
                .input('protocol_type', sql.NVarChar, tag.protocol_type)
                .input('iec104_device_id', sql.NVarChar, tag.iec104_device_id)
                .input('iec104_asdu_address', sql.Int, tag.iec104_asdu_address)
                .input('iec104_ioa', sql.Int, tag.iec104_ioa)
                .input('iec104_type_id', sql.Int, tag.iec104_type_id)
                .input('bit_offset', sql.Int, tag.bit_offset)
                .input('modbus_device_id', sql.NVarChar, tag.modbus_device_id)
                .input('register_type', sql.NVarChar, tag.register_type)
                .input('modbus_address', sql.Int, tag.modbus_address)
                .input('register_count', sql.Int, tag.register_count)
                .input('word_order', sql.NVarChar, tag.word_order)
                .input('data_type', sql.NVarChar, tag.data_type)
                .input('equation', sql.NVarChar, tag.equation)
                .input('calc', sql.NVarChar, tag.calc)
                .input('description', sql.NVarChar, tag.description || tag.tag_name)
                .input('reading_cycle', sql.NVarChar, tag.reading_cycle)
                .input('reading_cycle_ms', sql.Int, cycleMs)
                .input('deadband', sql.Float, tag.deadband || 0)
                .input('deadband_check_cycle_s', sql.Int, tag.deadband_check_cycle_s > 0 ? tag.deadband_check_cycle_s : null);

            const updateResult = await request.query(`
                UPDATE dbo.HistorianTags
                SET tag_name = @tag_name,
                    protocol_type = @protocol_type,
                    iec104_device_id = @iec104_device_id,
                    iec104_asdu_address = @iec104_asdu_address,
                    iec104_ioa = @iec104_ioa,
                    iec104_type_id = @iec104_type_id,
                    bit_offset = @bit_offset,
                    modbus_device_id = @modbus_device_id,
                    register_type = @register_type,
                    modbus_address = @modbus_address,
                    register_count = @register_count,
                    word_order = @word_order,
                    data_type = @data_type,
                    equation = @equation,
                    calc = @calc,
                    description = @description,
                    reading_cycle = @reading_cycle,
                    reading_cycle_ms = @reading_cycle_ms,
                    deadband = @deadband,
                    deadband_check_cycle_s = @deadband_check_cycle_s,
                    updated_at = GETDATE()
                WHERE tag_id = @tag_id;
            `);

            if (!updateResult.rowsAffected || updateResult.rowsAffected[0] === 0) {
                await request.query(`
                    INSERT INTO dbo.HistorianTags (
                        tag_id, tag_name, protocol_type, iec104_device_id, iec104_asdu_address,
                        iec104_ioa, iec104_type_id, bit_offset,
                        modbus_device_id, register_type, modbus_address, register_count, word_order,
                        data_type, equation, calc, description, reading_cycle, reading_cycle_ms,
                        deadband, deadband_check_cycle_s
                    )
                    VALUES (
                        @tag_id, @tag_name, @protocol_type, @iec104_device_id, @iec104_asdu_address,
                        @iec104_ioa, @iec104_type_id, @bit_offset,
                        @modbus_device_id, @register_type, @modbus_address, @register_count, @word_order,
                        @data_type, @equation, @calc, @description, @reading_cycle, @reading_cycle_ms,
                        @deadband, @deadband_check_cycle_s
                    );
                `);
            }

            const dbInfo = tag.deadband > 0 ? ` [DB:+/-${tag.deadband} @${tag.deadband_check_cycle_s}s]` : '';
            console.log(`  ${tag.id}: ${tag.tag_name} (${tag.reading_cycle})${dbInfo}`);
        } catch (error) {
            console.error(`  ${tag.id}: ${error.message}`);
        }
    }
}

// ============================================================
// Main entry point
// ============================================================

async function main() {
    console.log('==============================================');
    console.log('   Excel Importer - Industrial Data Server   ');
    console.log('==============================================');
    console.log('');
    let pool;
    
    try {
        // 1. Connect to the database
        console.log('Connecting to database...');
        
        const dbConfig = CONFIG.database;
        const driverCandidates = [
            customDriverName,
            'ODBC Driver 18 for SQL Server',
            'ODBC Driver 17 for SQL Server',
            'SQL Server',
        ].filter(Boolean);

        let lastError = null;
        for (const driverName of driverCandidates) {
            const connStr =
                `Driver={${driverName}};` +
                `Server=${dbConfig.server};` +
                `Database=${dbConfig.database};` +
                `Trusted_Connection=Yes;` +
                `TrustServerCertificate=Yes;`;
            try {
                pool = await sql.connect({
                    driver: 'msnodesqlv8',
                    connectionString: connStr,
                });
                console.log(`Connected using driver: ${driverName}`);
                lastError = null;
                break;
            } catch (err) {
                lastError = err;
                console.warn(`Driver failed: ${driverName} (${err.message})`);
            }
        }

        if (!pool) {
            throw lastError || new Error('Failed to connect with available ODBC drivers.');
        }

        // Print where we are connected (helps catch wrong instance/database).
        try {
            const ident = await pool.request().query(`
                SELECT
                    @@SERVERNAME AS server_name,
                    CAST(SERVERPROPERTY('MachineName') AS nvarchar(256)) AS machine_name,
                    CAST(SERVERPROPERTY('InstanceName') AS nvarchar(256)) AS instance_name,
                    DB_NAME() AS database_name,
                    SUSER_SNAME() AS login_name;
            `);
            const row = ident.recordset?.[0] || {};
            const instanceSuffix = row.instance_name ? `\\${row.instance_name}` : '';
            console.log(`Target SQL: ${row.machine_name}${instanceSuffix} | DB: ${row.database_name} | Login: ${row.login_name}`);
        } catch (e) {
            // Non-fatal; keep import running even if identity query fails.
        }

        // 2. Import analog alarms
        if (fs.existsSync(CONFIG.excelFiles.analogAlarms)) {
            console.log(`Reading: ${CONFIG.excelFiles.analogAlarms}`);
            const sheets = await readExcelFile(CONFIG.excelFiles.analogAlarms);
            if (sheets) {
                const iec104 = readIEC104Devices(sheets);
                const modbus = readModbusDevices(sheets);
                const tags = readTags(sheets);
                
                if (iec104.length > 0) await insertIEC104Devices(pool, iec104);
                if (modbus.length > 0) await insertModbusDevices(pool, modbus);
                if (tags.length > 0) await insertAnalogAlarmTags(pool, tags);
            }
        }
        
        // 3. Import discrete alarms
        if (fs.existsSync(CONFIG.excelFiles.discreteAlarms)) {
            console.log(`\nReading: ${CONFIG.excelFiles.discreteAlarms}`);
            const sheets = await readExcelFile(CONFIG.excelFiles.discreteAlarms);
            if (sheets) {
                const iec104 = readIEC104Devices(sheets);
                const modbus = readModbusDevices(sheets);
                const tags = readTags(sheets);
                
                if (iec104.length > 0) await insertIEC104Devices(pool, iec104);
                if (modbus.length > 0) await insertModbusDevices(pool, modbus);
                if (tags.length > 0) await insertDiscreteAlarmTags(pool, tags);
            }
        }
        
        // 4. Import historian tags
        if (fs.existsSync(CONFIG.excelFiles.historian)) {
            console.log(`\nReading: ${CONFIG.excelFiles.historian}`);
            const sheets = await readExcelFile(CONFIG.excelFiles.historian);
            if (sheets) {
                const iec104 = readIEC104Devices(sheets);
                const modbus = readModbusDevices(sheets);
                const tags = readTags(sheets);
                
                if (iec104.length > 0) await insertIEC104Devices(pool, iec104);
                if (modbus.length > 0) await insertModbusDevices(pool, modbus);
                if (tags.length > 0) await insertHistorianTags(pool, tags);
            }
        }
        
        console.log('\nImport completed successfully!');
        
    } catch (error) {
        console.error('\\nError:', error.message);
    } finally {
        if (pool) {
            await pool.close();
            console.log('\\nDatabase connection closed');
        }
    }
}

// Start the program
main();

