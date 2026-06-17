/**
 * IEC 60870-5-104 Connection Manager (Client / Master)
 *
 * Connects to one or more IEC 104 outstations (RTUs / data loggers) over TCP,
 * performs STARTDT + General Interrogation, keeps the link alive with TESTFR,
 * and caches the latest value of every received information object.
 *
 * The Alarm / Historian services then read the cached value for a tag using
 * (common address / ASDU address, IOA). This mirrors how Modbus is polled,
 * except IEC 104 is event driven so we sample from a live cache.
 *
 * Supported monitoring Type IDs (decoded into numbers / booleans):
 *   1  M_SP_NA_1  Single point (boolean)
 *   3  M_DP_NA_1  Double point (0..3)
 *   9  M_ME_NA_1  Measured value, normalized (-1..+1)
 *   11 M_ME_NB_1  Measured value, scaled (int16)
 *   13 M_ME_NC_1  Measured value, short float (float32)
 *   15 M_IT_NA_1  Integrated totals (int32 counter)
 *   21 M_ME_ND_1  Measured value, normalized without quality
 * Time-tagged variants (2/4/30/31/34/35/36/37) are decoded the same way,
 * ignoring the appended timestamp.
 *
 * NOTE: read-only. No control commands are issued (per project requirement).
 */

const net = require('net');
const EventEmitter = require('eventemitter3');
const { getLogger } = require('../utils/Logger');

// U-format control function codes (first control octet)
const U_STARTDT_ACT = 0x07;
const U_STARTDT_CON = 0x0B;
const U_STOPDT_ACT = 0x13;
const U_STOPDT_CON = 0x23;
const U_TESTFR_ACT = 0x43;
const U_TESTFR_CON = 0x83;

const QOI_STATION_INTERROGATION = 0x14; // 20 = global station interrogation
const TYPE_C_IC_NA_1 = 100; // General Interrogation command
const TYPE_M_EI_NA_1 = 70;  // End of initialization

// Per-Type-ID information-element layout (size in bytes AFTER the 3-byte IOA)
// and a decoder for the element value. Time-tagged types add a trailing
// CP24Time2a (3 bytes) or CP56Time2a (7 bytes) which we skip.
const TYPE_DECODERS = {
    1:  { size: 1, decode: (b, o) => Boolean(b[o] & 0x01) },                              // M_SP_NA_1
    3:  { size: 1, decode: (b, o) => (b[o] & 0x03) },                                     // M_DP_NA_1
    9:  { size: 3, decode: (b, o) => b.readInt16LE(o) / 32768 },                          // M_ME_NA_1 (+QDS)
    11: { size: 3, decode: (b, o) => b.readInt16LE(o) },                                  // M_ME_NB_1 (+QDS)
    13: { size: 5, decode: (b, o) => b.readFloatLE(o) },                                  // M_ME_NC_1 (+QDS)
    15: { size: 5, decode: (b, o) => b.readInt32LE(o) },                                  // M_IT_NA_1 (BCR)
    21: { size: 2, decode: (b, o) => b.readInt16LE(o) / 32768 },                          // M_ME_ND_1 (no QDS)
    // Time-tagged variants: same value decode, plus trailing timestamp bytes.
    2:  { size: 1 + 3, decode: (b, o) => (b[o] & 0x03) },                                 // M_DP_TA_1
    30: { size: 1 + 7, decode: (b, o) => Boolean(b[o] & 0x01) },                          // M_SP_TB_1
    31: { size: 1 + 7, decode: (b, o) => (b[o] & 0x03) },                                 // M_DP_TB_1
    34: { size: 3 + 7, decode: (b, o) => b.readInt16LE(o) / 32768 },                      // M_ME_TD_1
    35: { size: 3 + 7, decode: (b, o) => b.readInt16LE(o) },                              // M_ME_TE_1
    36: { size: 5 + 7, decode: (b, o) => b.readFloatLE(o) },                              // M_ME_TF_1
    37: { size: 5 + 7, decode: (b, o) => b.readInt32LE(o) },                              // M_IT_TB_1
};

class Iec104ConnectionManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.connections = new Map(); // device_id -> connection info
        this.options = {
            connectionTimeout: options.connectionTimeout || 10000,
            autoReconnect: options.autoReconnect !== false,
            reconnectInterval: options.reconnectInterval || 10000,
            // IEC 104 defaults (IEC 60870-5-104 standard recommended values)
            defaultPort: options.defaultPort || 2404,
            t1: options.t1 || 15,   // ack timeout for sent APDUs (s)
            t2: options.t2 || 10,   // ack timeout for received I-frames (s, < t1)
            t3: options.t3 || 20,   // idle timeout before sending TESTFR (s)
            k: options.k || 12,     // max unacknowledged sent I-frames
            w: options.w || 8,      // ack after receiving w I-frames
            giInterval: options.giInterval || 60, // general interrogation period (s)
        };

        this.logger = getLogger().getServiceLogger('Iec104ConnectionManager');
        this.reconnectTimers = new Map();
    }

    /**
     * Add an IEC 104 device configuration.
     * config: { ip_address, port, t1, t2, t3, k, w, gi_interval, common_address? }
     */
    addDevice(deviceId, config) {
        const existing = this.connections.get(deviceId);
        const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

        const cfg = {
            host: config.ip_address || config.host,
            port: num(config.port, this.options.defaultPort),
            t1: num(config.t1, this.options.t1),
            t2: num(config.t2, this.options.t2),
            t3: num(config.t3, this.options.t3),
            k: num(config.k, this.options.k),
            w: num(config.w, this.options.w),
            giInterval: num(config.gi_interval, this.options.giInterval),
        };

        if (existing) {
            // Update config but keep live socket / value cache / registered CAs.
            existing.config = cfg;
            if (config.common_address != null) existing.commonAddresses.add(Number(config.common_address));
            this.logger.info(`Updated IEC104 device configuration: ${deviceId}`, { host: cfg.host, port: cfg.port });
            return;
        }

        this.connections.set(deviceId, {
            config: cfg,
            socket: null,
            connected: false,        // TCP + STARTDT confirmed
            started: false,          // STARTDT con received
            rxBuffer: Buffer.alloc(0),
            vS: 0,                   // our send sequence number
            vR: 0,                   // our receive sequence number
            ackPending: 0,           // received I-frames not yet acked
            startdtTimer: null,
            ackTimer: null,
            lastError: null,
            testAwaitingReply: false,
            testReplyTimer: null,
            values: new Map(),       // "ca:ioa" -> { value, typeId, quality, ts }
            commonAddresses: new Set((config.common_address != null) ? [Number(config.common_address)] : []),
            giTimer: null,
            testTimer: null,
            metrics: { reads: 0, frames: 0, errors: 0, reconnects: 0 },
        });

        this.logger.info(`Added IEC104 device configuration: ${deviceId}`, { host: cfg.host, port: cfg.port });
    }

    /**
     * Register a common ASDU address that should be polled via General
     * Interrogation for this device (collected from the configured tags).
     */
    addCommonAddress(deviceId, commonAddress) {
        const dev = this.connections.get(deviceId);
        if (!dev) return;
        const ca = Number(commonAddress);
        if (Number.isFinite(ca)) dev.commonAddresses.add(ca);
    }

    /**
     * Connect to a specific IEC 104 device.
     */
    connect(deviceId) {
        const dev = this.connections.get(deviceId);
        if (!dev) throw new Error(`IEC104 device ${deviceId} not found`);
        if (dev.socket) return Promise.resolve(true); // already connecting/connected

        return new Promise((resolve, reject) => {
            this.logger.info(`Connecting to IEC104 device ${deviceId}...`, { host: dev.config.host, port: dev.config.port });

            const socket = new net.Socket();
            dev.socket = socket;
            dev.rxBuffer = Buffer.alloc(0);
            dev.vS = 0;
            dev.vR = 0;
            dev.ackPending = 0;

            let settled = false;
            const connTimer = setTimeout(() => {
                if (settled) return;
                settled = true;
                socket.destroy();
                this._onSocketDown(deviceId, new Error('Connection timeout'));
                reject(new Error('Connection timeout'));
            }, this.options.connectionTimeout);

            socket.setNoDelay(true);

            socket.on('connect', () => {
                clearTimeout(connTimer);
                this.logger.info(`TCP connected to IEC104 device ${deviceId}, sending STARTDT...`);
                dev.connected = true;
                dev.started = false;
                dev.lastError = null;
                // Start data transfer
                this._sendU(dev, U_STARTDT_ACT);
                this._armStartdtTimer(deviceId);
                this._startTestTimer(deviceId);
                if (!settled) {
                    settled = true;
                    resolve(true);
                }
            });

            socket.on('data', (chunk) => this._onData(deviceId, chunk));

            socket.on('error', (err) => {
                clearTimeout(connTimer);
                dev.lastError = err.message;
                dev.metrics.errors++;
                if (!settled) {
                    settled = true;
                    this._onSocketDown(deviceId, err);
                    reject(err);
                } else {
                    this._onSocketDown(deviceId, err);
                }
            });

            socket.on('close', () => {
                clearTimeout(connTimer);
                this._onSocketDown(deviceId, dev.lastError ? new Error(dev.lastError) : new Error('Connection closed'));
            });

            socket.connect(dev.config.port, dev.config.host);
        });
    }

    async connectAll() {
        const results = [];
        for (const deviceId of this.connections.keys()) {
            try {
                await this.connect(deviceId);
                results.push({ deviceId, success: true });
            } catch (error) {
                results.push({ deviceId, success: false, error: error.message });
            }
        }
        return results;
    }

    /**
     * Handle a socket going down: clean up timers, mark disconnected, reconnect.
     */
    _onSocketDown(deviceId, error) {
        const dev = this.connections.get(deviceId);
        if (!dev) return;

        const wasUp = dev.connected || dev.started;

        this._stopTestTimer(deviceId);
        this._stopGiTimer(deviceId);
        this._stopAckTimer(deviceId);
        this._clearTestReplyTimer(deviceId);
        this._clearStartdtTimer(deviceId);

        if (dev.socket) {
            try { dev.socket.removeAllListeners(); dev.socket.destroy(); } catch (_) { /* ignore */ }
            dev.socket = null;
        }
        dev.connected = false;
        dev.started = false;
        dev.ackPending = 0;

        if (wasUp) {
            this.logger.warn(`IEC104 device ${deviceId} disconnected`, { host: dev.config.host, error: error?.message });
            this.emit('disconnected', { deviceId, error });
            this.emit('error', { deviceId, error });
        }

        if (this.options.autoReconnect) this._scheduleReconnect(deviceId);
    }

    _scheduleReconnect(deviceId) {
        const dev = this.connections.get(deviceId);
        if (!dev) return;
        if (this.reconnectTimers.has(deviceId)) clearTimeout(this.reconnectTimers.get(deviceId));

        dev.metrics.reconnects++;
        const timer = setTimeout(() => {
            this.reconnectTimers.delete(deviceId);
            this.connect(deviceId).catch(() => { /* reconnect rescheduled on failure */ });
        }, this.options.reconnectInterval);
        this.reconnectTimers.set(deviceId, timer);
    }

    async disconnect(deviceId) {
        const dev = this.connections.get(deviceId);
        if (!dev) return;

        if (this.reconnectTimers.has(deviceId)) {
            clearTimeout(this.reconnectTimers.get(deviceId));
            this.reconnectTimers.delete(deviceId);
        }
        this._stopTestTimer(deviceId);
        this._stopGiTimer(deviceId);
        this._stopAckTimer(deviceId);
        this._clearTestReplyTimer(deviceId);
        this._clearStartdtTimer(deviceId);

        if (dev.socket) {
            try { dev.socket.removeAllListeners(); dev.socket.destroy(); } catch (_) { /* ignore */ }
            dev.socket = null;
        }
        dev.connected = false;
        dev.started = false;
        dev.ackPending = 0;
        this.logger.info(`Disconnected from IEC104 device ${deviceId}`);
        this.emit('disconnected', { deviceId });
    }

    async disconnectAll() {
        for (const deviceId of this.connections.keys()) {
            await this.disconnect(deviceId);
        }
    }

    // =========================================================
    // Receive path
    // =========================================================

    _onData(deviceId, chunk) {
        const dev = this.connections.get(deviceId);
        if (!dev) return;

        dev.rxBuffer = Buffer.concat([dev.rxBuffer, chunk]);

        // Parse as many complete APDUs as available.
        while (dev.rxBuffer.length >= 2) {
            if (dev.rxBuffer[0] !== 0x68) {
                // Resync: drop one byte and keep scanning for the start flag.
                dev.rxBuffer = dev.rxBuffer.slice(1);
                continue;
            }
            const len = dev.rxBuffer[1];
            if (dev.rxBuffer.length < len + 2) break; // wait for the rest
            const apdu = dev.rxBuffer.slice(0, len + 2);
            dev.rxBuffer = dev.rxBuffer.slice(len + 2);
            try {
                this._handleApdu(deviceId, apdu);
            } catch (err) {
                dev.metrics.errors++;
                this.logger.debug(`IEC104 ${deviceId}: error handling APDU`, { error: err.message });
            }
        }
    }

    _handleApdu(deviceId, apdu) {
        const dev = this.connections.get(deviceId);
        if (!dev) return;
        dev.metrics.frames++;

        const cf0 = apdu[2];
        const cf1 = apdu[3];
        const cf2 = apdu[4];
        const cf3 = apdu[5];

        if ((cf0 & 0x01) === 0) {
            // I-format: carries an ASDU
            dev.vR = (dev.vR + 1) & 0x7FFF;
            dev.ackPending++;
            const asdu = apdu.slice(6);
            this._parseAsdu(deviceId, asdu);
            // Acknowledge after w received I-frames.
            if (dev.ackPending >= dev.config.w) {
                this._sendS(dev);
            } else {
                this._armAckTimer(deviceId);
            }
        } else if ((cf0 & 0x03) === 0x01) {
            // S-format: acknowledgement of our sent I-frames. Nothing to do.
        } else if ((cf0 & 0x03) === 0x03) {
            // U-format control
            switch (cf0) {
                case U_STARTDT_CON:
                    this._clearStartdtTimer(deviceId);
                    dev.started = true;
                    this.logger.info(`IEC104 ${deviceId}: STARTDT confirmed, starting interrogation`);
                    this.emit('connected', { deviceId });
                    this._sendGeneralInterrogation(deviceId);
                    this._startGiTimer(deviceId);
                    break;
                case U_TESTFR_ACT:
                    this._sendU(dev, U_TESTFR_CON);
                    break;
                case U_TESTFR_CON:
                    // keepalive acknowledged
                    this._clearTestReplyTimer(deviceId);
                    break;
                case U_STARTDT_ACT:
                case U_STOPDT_ACT:
                case U_STOPDT_CON:
                    break;
                default:
                    this.logger.debug(`IEC104 ${deviceId}: unhandled U-frame 0x${cf0.toString(16)}`);
            }
        }
    }

    /**
     * Parse an ASDU and update the value cache for every information object.
     */
    _parseAsdu(deviceId, asdu) {
        const dev = this.connections.get(deviceId);
        if (!dev || asdu.length < 6) return;

        const typeId = asdu[0];
        const vsq = asdu[1];
        const numObjects = vsq & 0x7F;
        const sq = (vsq & 0x80) !== 0;
        // asdu[2] = cause of transmission, asdu[3] = originator address
        const ca = asdu[4] | (asdu[5] << 8); // common address (2 octets LE)

        if (typeId === TYPE_M_EI_NA_1) {
            this.logger.info(`IEC104 ${deviceId}: end of initialization (CA=${ca})`);
            return;
        }

        const decoder = TYPE_DECODERS[typeId];
        if (!decoder) {
            // Unknown/unsupported type: we can't know the element size, so stop.
            this.logger.debug(`IEC104 ${deviceId}: unsupported Type ID ${typeId} (skipped)`);
            return;
        }

        let offset = 6;
        const ts = Date.now();

        if (sq) {
            // Sequence of elements sharing a base IOA that increments by 1.
            if (asdu.length < offset + 3) return;
            const baseIoa = asdu[offset] | (asdu[offset + 1] << 8) | (asdu[offset + 2] << 16);
            offset += 3;
            for (let i = 0; i < numObjects; i++) {
                if (asdu.length < offset + decoder.size) break;
                const value = decoder.decode(asdu, offset);
                this._storeValue(dev, ca, baseIoa + i, typeId, value, ts);
                offset += decoder.size;
            }
        } else {
            for (let i = 0; i < numObjects; i++) {
                if (asdu.length < offset + 3 + decoder.size) break;
                const ioa = asdu[offset] | (asdu[offset + 1] << 8) | (asdu[offset + 2] << 16);
                offset += 3;
                const value = decoder.decode(asdu, offset);
                this._storeValue(dev, ca, ioa, typeId, value, ts);
                offset += decoder.size;
            }
        }
    }

    _storeValue(dev, ca, ioa, typeId, value, ts) {
        dev.values.set(`${ca}:${ioa}`, { value, typeId, ts });
        dev.metrics.reads++;
    }

    // =========================================================
    // Send path
    // =========================================================

    _sendU(dev, code) {
        if (!dev.socket) return;
        const buf = Buffer.from([0x68, 0x04, code, 0x00, 0x00, 0x00]);
        try { dev.socket.write(buf); } catch (_) { /* socket errors handled via 'error' */ }
    }

    _sendS(dev) {
        if (!dev.socket) return;
        if (dev.ackTimer) {
            clearTimeout(dev.ackTimer);
            dev.ackTimer = null;
        }
        const buf = Buffer.from([
            0x68, 0x04,
            0x01, 0x00,
            (dev.vR << 1) & 0xFE, (dev.vR >> 7) & 0xFF,
        ]);
        try { dev.socket.write(buf); } catch (_) { /* ignore */ }
        dev.ackPending = 0;
    }

    _sendI(dev, asdu) {
        if (!dev.socket) return;
        const header = Buffer.from([
            0x68,
            asdu.length + 4,
            (dev.vS << 1) & 0xFE, (dev.vS >> 7) & 0xFF,
            (dev.vR << 1) & 0xFE, (dev.vR >> 7) & 0xFF,
        ]);
        dev.vS = (dev.vS + 1) & 0x7FFF;
        try { dev.socket.write(Buffer.concat([header, asdu])); } catch (_) { /* ignore */ }
    }

    /**
     * Send a General Interrogation to each known common address (or broadcast).
     */
    _sendGeneralInterrogation(deviceId) {
        const dev = this.connections.get(deviceId);
        if (!dev || !dev.connected) return;

        const cas = dev.commonAddresses.size > 0 ? Array.from(dev.commonAddresses) : [0xFFFF];
        for (const ca of cas) {
            // ASDU: type=100, VSQ=1, COT=6 (activation), ORG=0, CA(2), IOA=0(3), QOI(1)
            const asdu = Buffer.from([
                TYPE_C_IC_NA_1,
                0x01,
                0x06, 0x00,
                ca & 0xFF, (ca >> 8) & 0xFF,
                0x00, 0x00, 0x00,
                QOI_STATION_INTERROGATION,
            ]);
            this._sendI(dev, asdu);
        }
        this.logger.debug(`IEC104 ${deviceId}: sent General Interrogation`, { commonAddresses: cas });
    }

    // =========================================================
    // Timers (TESTFR keepalive + periodic GI)
    // =========================================================

    _startTestTimer(deviceId) {
        const dev = this.connections.get(deviceId);
        if (!dev) return;
        this._stopTestTimer(deviceId);
        dev.testTimer = setInterval(() => {
            if (!dev.connected || !dev.started) return;
            if (dev.testAwaitingReply) {
                this._onSocketDown(deviceId, new Error('TESTFR confirmation timeout'));
                return;
            }
            this._sendU(dev, U_TESTFR_ACT);
            this._armTestReplyTimer(deviceId);
        }, dev.config.t3 * 1000);
    }

    _stopTestTimer(deviceId) {
        const dev = this.connections.get(deviceId);
        if (dev && dev.testTimer) { clearInterval(dev.testTimer); dev.testTimer = null; }
    }

    _armStartdtTimer(deviceId) {
        const dev = this.connections.get(deviceId);
        if (!dev) return;
        this._clearStartdtTimer(deviceId);
        dev.startdtTimer = setTimeout(() => {
            this._onSocketDown(deviceId, new Error('STARTDT confirmation timeout'));
        }, dev.config.t1 * 1000);
    }

    _clearStartdtTimer(deviceId) {
        const dev = this.connections.get(deviceId);
        if (dev && dev.startdtTimer) {
            clearTimeout(dev.startdtTimer);
            dev.startdtTimer = null;
        }
    }

    _armTestReplyTimer(deviceId) {
        const dev = this.connections.get(deviceId);
        if (!dev) return;
        this._clearTestReplyTimer(deviceId);
        dev.testAwaitingReply = true;
        dev.testReplyTimer = setTimeout(() => {
            this._onSocketDown(deviceId, new Error('TESTFR confirmation timeout'));
        }, dev.config.t1 * 1000);
    }

    _clearTestReplyTimer(deviceId) {
        const dev = this.connections.get(deviceId);
        if (!dev) return;
        dev.testAwaitingReply = false;
        if (dev.testReplyTimer) {
            clearTimeout(dev.testReplyTimer);
            dev.testReplyTimer = null;
        }
    }

    _armAckTimer(deviceId) {
        const dev = this.connections.get(deviceId);
        if (!dev || dev.ackTimer || dev.ackPending <= 0) return;
        dev.ackTimer = setTimeout(() => {
            dev.ackTimer = null;
            if (!dev.connected || !dev.started || dev.ackPending <= 0) return;
            this._sendS(dev);
        }, dev.config.t2 * 1000);
    }

    _stopAckTimer(deviceId) {
        const dev = this.connections.get(deviceId);
        if (dev && dev.ackTimer) {
            clearTimeout(dev.ackTimer);
            dev.ackTimer = null;
        }
    }

    _startGiTimer(deviceId) {
        const dev = this.connections.get(deviceId);
        if (!dev) return;
        this._stopGiTimer(deviceId);
        if (!dev.config.giInterval || dev.config.giInterval <= 0) return;
        dev.giTimer = setInterval(() => {
            this._sendGeneralInterrogation(deviceId);
        }, dev.config.giInterval * 1000);
    }

    _stopGiTimer(deviceId) {
        const dev = this.connections.get(deviceId);
        if (dev && dev.giTimer) { clearInterval(dev.giTimer); dev.giTimer = null; }
    }

    // =========================================================
    // Read API (used by Alarm / Historian services)
    // =========================================================

    /**
     * Return the latest cached value for an information object, or null if it
     * has not been received yet. Synchronous (reads from the live cache).
     */
    readPoint(deviceId, commonAddress, ioa) {
        const dev = this.connections.get(deviceId);
        if (!dev) return null;
        const entry = dev.values.get(`${Number(commonAddress)}:${Number(ioa)}`);
        return entry ? entry.value : null;
    }

    getStatus() {
        const status = {};
        for (const [deviceId, dev] of this.connections) {
            status[deviceId] = {
                connected: dev.connected && dev.started,
                host: dev.config.host,
                port: dev.config.port,
                points: dev.values.size,
                commonAddresses: Array.from(dev.commonAddresses),
                lastError: dev.lastError,
                metrics: { ...dev.metrics },
            };
        }
        return status;
    }

    isConnected(deviceId) {
        const dev = this.connections.get(deviceId);
        return Boolean(dev && dev.connected && dev.started);
    }

    getDeviceIds() {
        return Array.from(this.connections.keys());
    }
}

module.exports = Iec104ConnectionManager;
