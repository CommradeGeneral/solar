/**
 * Excel Device Loader
 * Reads PLC + Modbus device definitions from one or more Excel files and
 * keeps Iec104ConnectionManager / ModbusConnectionManager updated.
 *
 * Expected sheet names (case-insensitive):
 * - IEC104 / IEC104Devices
 * - Modbus / ModbusDevices
 *
 * This matches the conventions used by tools/import-excel.js.
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

function normalizeCellValue(value) {
    if (value == null) return null;
    if (typeof value === 'object') {
        if (value.text) return value.text;
        if (value.richText) return value.richText.map((p) => p.text).join('');
        if (value.formula != null && value.result != null) return value.result;
        if (value.result != null) return value.result;
    }
    return value;
}

function sheetToJson(worksheet) {
    const headerRow = worksheet.getRow(1);
    const headers = headerRow.values
        .slice(1)
        .map((h) => (h != null ? String(h).trim() : ''))
        .map((h) => (h === '' ? null : h));

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

function findSheet(sheets, candidates) {
    const byLower = new Map(Object.keys(sheets).map((k) => [k.toLowerCase(), k]));
    for (const c of candidates) {
        const key = byLower.get(String(c).toLowerCase());
        if (key) return sheets[key];
    }
    return null;
}

function normalizeIec104Row(row) {
    const deviceId = row.device_id ?? row.Device_ID ?? row.id ?? row.ID;
    if (deviceId == null || deviceId === '') return null;

    const host = row.ip_address ?? row.IP_Address ?? row.ip ?? row.IP ?? row.host ?? row.Host;
    if (!host) return null;

    const numOrNull = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

    return {
        device_id: deviceId,
        ip_address: String(host).trim(),
        port: numOrNull(row.port ?? row.Port),
        t1: numOrNull(row.t1 ?? row.T1),
        t2: numOrNull(row.t2 ?? row.T2),
        t3: numOrNull(row.t3 ?? row.T3),
        k: numOrNull(row.k ?? row.K),
        w: numOrNull(row.w ?? row.W),
        gi_interval: numOrNull(row.gi_interval ?? row.Gi_Interval ?? row.GI_Interval),
    };
}

function normalizeModbusRow(row) {
    const deviceId = row.device_id ?? row.Device_ID ?? row.id ?? row.ID;
    if (deviceId == null || deviceId === '') return null;

    const type = (row.connection_type ?? row.Connection_Type ?? row.type ?? 'tcp');
    const ip = row.ip_address ?? row.IP_Address ?? row.ip ?? row.IP;
    const port = row.port ?? row.Port ?? 502;
    const unitId = row.unit_id ?? row.Unit_ID ?? row.unitId ?? 1;
    const serialPort = row.serial_port ?? row.Serial_Port ?? row.serialPort ?? null;
    const baudRate = row.baud_rate ?? row.Baud_Rate ?? row.baudRate ?? 9600;
    const parity = row.parity ?? row.Parity ?? 'none';
    const stopBits = row.stop_bits ?? row.Stop_Bits ?? 1;
    const dataBits = row.data_bits ?? row.Data_Bits ?? 8;

    // For TCP, ip is required. For RTU, serialPort is required.
    if (String(type).toLowerCase() === 'tcp' && !ip) return null;
    if (String(type).toLowerCase() === 'rtu' && !serialPort) return null;

    return {
        device_id: deviceId,
        connection_type: String(type).toLowerCase(),
        ip_address: ip ? String(ip).trim() : null,
        port: Number(port),
        unit_id: Number(unitId),
        serial_port: serialPort ? String(serialPort).trim() : null,
        baud_rate: Number(baudRate),
        parity: String(parity).trim(),
        stop_bits: Number(stopBits),
        data_bits: Number(dataBits),
    };
}

async function readExcelFile(filePath) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheets = {};
    workbook.eachSheet((worksheet) => {
        sheets[worksheet.name] = sheetToJson(worksheet);
    });
    return sheets;
}

class ExcelDeviceLoader {
    constructor(options = {}) {
        this.options = {
            enabled: options.enabled !== false,
            files: Array.isArray(options.files) ? options.files : [],
        };

        this.logger = options.logger;
        this._started = false;
        this._lastMtimeByFile = new Map();
        this._knownIec104Ids = new Set();
        this._knownModbusIds = new Set();
    }

    start(iec104Manager, modbusManager) {
        if (!this.options.enabled) return;
        if (this._started) return;
        this._started = true;

        void this._reloadIfChanged(iec104Manager, modbusManager).catch((err) => {
            this.logger?.warn?.('Excel device initial load failed', { error: err?.message || err });
        });
    }

    stop() {
        this._started = false;
    }

    async _reloadIfChanged(iec104Manager, modbusManager) {
        const files = this.options.files
            .map((f) => (f ? path.resolve(f) : null))
            .filter(Boolean);

        if (files.length === 0) return;

        let anyChanged = false;
        for (const filePath of files) {
            try {
                if (!fs.existsSync(filePath)) continue;
                const mtimeMs = fs.statSync(filePath).mtimeMs;
                const last = this._lastMtimeByFile.get(filePath);
                if (last == null || mtimeMs > last) {
                    anyChanged = true;
                }
            } catch {
                // ignore stat errors
            }
        }

        // First load should proceed even if we couldn't stat.
        if (!anyChanged && this._lastMtimeByFile.size > 0) return;

        const allIec104 = [];
        const allModbus = [];

        for (const filePath of files) {
            if (!fs.existsSync(filePath)) continue;
            const sheets = await readExcelFile(filePath);

            const iec104Rows =
                findSheet(sheets, ['IEC104', 'IEC104Devices', 'iec104', 'iec104devices']) || [];
            const modbusRows =
                findSheet(sheets, ['Modbus', 'ModbusDevices', 'modbus', 'modbusdevices']) || [];

            for (const row of iec104Rows) {
                const dev = normalizeIec104Row(row);
                if (dev) allIec104.push(dev);
            }
            for (const row of modbusRows) {
                const dev = normalizeModbusRow(row);
                if (dev) allModbus.push(dev);
            }

            try {
                this._lastMtimeByFile.set(filePath, fs.statSync(filePath).mtimeMs);
            } catch {
                // ignore
            }
        }

        // Upsert IEC104 devices
        for (const dev of allIec104) {
            iec104Manager.addDevice(dev.device_id, dev);
            if (!this._knownIec104Ids.has(dev.device_id)) {
                this._knownIec104Ids.add(dev.device_id);
                // Try connect immediately; auto-reconnect will keep trying if it fails.
                iec104Manager.connect(dev.device_id).catch(() => {});
            }
        }

        // Upsert Modbus devices
        for (const dev of allModbus) {
            modbusManager.addDevice(dev.device_id, dev);
            if (!this._knownModbusIds.has(dev.device_id)) {
                this._knownModbusIds.add(dev.device_id);
                modbusManager.connect(dev.device_id).catch(() => {});
            }
        }

        this.logger?.info?.('Excel devices loaded', {
            iec104Count: this._knownIec104Ids.size,
            modbusCount: this._knownModbusIds.size,
        });
    }
}

module.exports = ExcelDeviceLoader;
