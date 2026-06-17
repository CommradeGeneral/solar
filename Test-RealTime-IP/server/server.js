/**
 * SCADA Server - Modbus TCP Client + IEC 60870-5-104 Client
 * Uses exceljs - Production Only
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const net = require('net');
const ExcelJS = require('exceljs');
const fs = require('fs');

let math;
try { math = require('mathjs'); console.log('✅ mathjs loaded'); }
catch (e) { console.warn('⚠️ mathjs not available'); math = null; }

const Logger = {
    info: (msg, data = '') => console.log(`[${new Date().toISOString()}] INFO: ${msg}`, data),
    warn: (msg, data = '') => console.warn(`[${new Date().toISOString()}] WARN: ${msg}`, data),
    error: (msg, data = '') => console.error(`[${new Date().toISOString()}] ERROR: ${msg}`, data),
    debug: (msg, data = '') => { if (process.env.DEBUG) console.log(`[${new Date().toISOString()}] DEBUG: ${msg}`, data); }
};

// ═══════════════════════════════════════════════════════════════════════════
// Load config.json
// ═══════════════════════════════════════════════════════════════════════════
const configPath = path.join(__dirname, '../config.json');
let appConfig = {};
try { appConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); Logger.info('✅ config.json loaded'); }
catch (e) { Logger.error('Failed to load config.json:', e.message); }

// ═══════════════════════════════════════════════════════════════════════════
// Express + Socket.IO
// ═══════════════════════════════════════════════════════════════════════════
const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://192.168.1.2:5000', 'http://192.168.1.2:5000'];
if (process.env.SERVER_IP) ALLOWED_ORIGINS.push(`http://${process.env.SERVER_IP}:5000`);

const io = new Server(server, {
    cors: {
        origin: (origin, cb) => {
            if (!origin || ALLOWED_ORIGINS.includes(origin) || process.env.NODE_ENV === 'development') cb(null, true);
            else cb(new Error('Not allowed by CORS'));
        },
        methods: ["GET", "POST"], credentials: true
    },
    perMessageDeflate: { threshold: 1024 }
});

// Rooms
// - "all": legacy broadcast clients (default)
// - "prefix:<INV001_>": optimized per-prefix updates
const ALL_ROOM = 'all';
const PREFIX_ROOM_PREFIX = 'prefix:';

function normalizePrefix(prefix) {
    if (prefix == null) return null;
    const p = String(prefix).trim().toUpperCase();
    // Prefix tags: INV###_, EM###_, PR###_, WS###_
    if (!/^(INV|EM|PR|WS)\d{3}_$/.test(p)) return null;
    return p;
}

function getPrefixRoom(prefix) {
    return `${PREFIX_ROOM_PREFIX}${prefix}`;
}

function extractKnownPrefix(tagName) {
    if (!tagName) return null;
    const m = String(tagName).toUpperCase().match(/^(INV|EM|PR|WS)\d{3}_/);
    return m ? m[0] : null;
}

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());


// IDS_HTML_GUARD_MW
// Guard HTML pages before express.static serves them (prevents URL copy / Back cache bypass after logout).
app.use(async (req, res, next) => {
    try {
        const pth = String(req.path || '');
        const lower = pth.toLowerCase();

        // Never guard API/socket/asset requests
        if (
            lower.startsWith('/api/') ||
            lower.startsWith('/socket.io') ||
            lower.startsWith('/images/') ||
            lower.startsWith('/css/') ||
            lower.startsWith('/js/')
        ) {
            return next();
        }

        const isHtml =
            lower === '/' ||
            lower.endsWith('.html') ||
            (lower.startsWith('/pages/') && lower.endsWith('.html'));

        if (!isHtml) return next();

        _setNoStore(res);

        // Always send login to API server (source of truth)
        if (lower === '/login' || lower === '/login.html') {
            return res.redirect(302, LOGIN_REDIRECT_URL);
        }

        const user = await _fetchAuthMe(req);
        if (!user) return res.redirect(302, LOGIN_REDIRECT_URL);

        // Admin-only page
        if (lower === '/user-interface.html' || lower.endsWith('/user-interface.html')) {
            if (user.role !== 'administrator') return res.redirect(302, '/dashboard.html');
        }

        req.authUser = user;
        return next();
    } catch {
        return res.redirect(302, LOGIN_REDIRECT_URL);
    }
});

app.use(express.static(path.join(__dirname, '../web')));
// Fallback for legacy layout where images live under `web/pages/images/*`
// but the UI/config references them as `/images/*`.
app.use('/images', express.static(path.join(__dirname, '../web/pages/images')));

// ==================== External Auth (IndustrialDataServer on :3000) ====================
// This UI server (port 5000) relies on JWT stored in an httpOnly cookie set by the API server.
// We enforce page access server-side so copying URLs / Back button won't bypass auth.
const AUTH_BASE_URL = process.env.AUTH_BASE_URL || "http://192.168.1.2:3000";
const LOGIN_REDIRECT_URL = process.env.LOGIN_REDIRECT_URL || "http://192.168.1.2:3000/login";

function _setNoStore(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
}

async function _fetchAuthMe(req) {
    try {
        const cookie = req.headers.cookie || '';
        const r = await fetch(AUTH_BASE_URL + '/api/auth/me', {
            method: 'GET',
            headers: { cookie, accept: 'application/json' },
        });
        if (!r.ok) return null;
        const data = await r.json().catch(() => null);
        return data && data.user ? data.user : null;
    } catch {
        return null;
    }
}

function requireLoginPage() {
    return async (req, res, next) => {
        _setNoStore(res);
        const user = await _fetchAuthMe(req);
        if (!user) return res.redirect(302, LOGIN_REDIRECT_URL);
        req.authUser = user;
        next();
    };
}

function requireAdminPage() {
    return async (req, res, next) => {
        _setNoStore(res);
        const user = await _fetchAuthMe(req);
        if (!user) return res.redirect(302, LOGIN_REDIRECT_URL);
        if (user.role !== 'administrator') return res.redirect(302, '/dashboard.html');
        req.authUser = user;
        next();
    };
}


// ═══════════════════════════════════════════════════════════════════════════
// Config — reconnect settings from config.json
// ═══════════════════════════════════════════════════════════════════════════
const reconnectConfig = appConfig.reconnect || {};
const CONFIG = {
    port: process.env.PORT || 5000,
    updateInterval: parseInt(process.env.UPDATE_INTERVAL) || appConfig.updateInterval || 1000,
    // Per-read Modbus timeout. 5 s was far too long for a 1 s update loop — a
    // single slow device could stall the whole cycle. Tune via env/config.json.
    modbusTimeoutMs: parseInt(process.env.MODBUS_TIMEOUT_MS) || appConfig.modbusTimeoutMs || 2000,
    excelPath: path.join(__dirname, '../config/tags_config.xlsx'),
    // Modbus register addressing:
    // - Many device manuals use 1-based (e.g. "40001") while Modbus PDU uses 0-based.
    // - `excel.modbus_address` is treated as 1-based by default (base=1).
    //   Set `modbusAddressBase` to 0 in config.json to keep current (0-based) behavior.
    modbusAddressBase: Number.isFinite(appConfig?.modbusAddressBase) ? Number(appConfig.modbusAddressBase) : 1,
    reconnect: {
        maxAttempts: reconnectConfig.maxAttempts !== undefined ? reconnectConfig.maxAttempts : 0, // 0 = infinite
        interval: reconnectConfig.interval || appConfig.reconnectInterval || 5000,
        shutdownOnMaxRetries: reconnectConfig.shutdownOnMaxRetries || false
    }
};

Logger.info(`Reconnect config: maxAttempts=${CONFIG.reconnect.maxAttempts} (${CONFIG.reconnect.maxAttempts === 0 ? 'infinite' : CONFIG.reconnect.maxAttempts}), interval=${CONFIG.reconnect.interval}ms, shutdownOnMaxRetries=${CONFIG.reconnect.shutdownOnMaxRetries}`);

let ModbusRTU = null;
try { ModbusRTU = require('modbus-serial'); Logger.info('✅ modbus-serial loaded'); }
catch (e) { Logger.warn('⚠️ modbus-serial not available'); }

// ═══════════════════════════════════════════════════════════════════════════
// ExcelJS Helper
// ═══════════════════════════════════════════════════════════════════════════
function sheetToJson(worksheet) {
    const rows = [];
    if (!worksheet || worksheet.rowCount === 0) return rows;
    const headerRow = worksheet.getRow(1);
    const headers = [];
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        headers[colNumber] = cell.value ? String(cell.value).trim() : '';
    });
    for (let i = 2; i <= worksheet.rowCount; i++) {
        const row = worksheet.getRow(i);
        const obj = {};
        let hasData = false;
        headers.forEach((header, colNumber) => {
            if (!header) return;
            const cell = row.getCell(colNumber);
            let value = cell.value;
            if (value && typeof value === 'object') {
                if (value.result !== undefined) value = value.result;
                else if (value.text) value = value.text;
                else if (value.hyperlink) value = value.text || value.hyperlink;
            }
            if (value !== null && value !== undefined && value !== '') { obj[header] = value; hasData = true; }
        });
        if (hasData) rows.push(obj);
    }
    return rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// IEC 104 Constants
// ═══════════════════════════════════════════════════════════════════════════
const IEC104_TYPES = {
    M_SP_NA_1: 1, M_SP_TA_1: 2, M_DP_NA_1: 3, M_ST_NA_1: 5,
    M_ME_NA_1: 9, M_ME_NB_1: 11, M_ME_NC_1: 13, M_IT_NA_1: 15,
    M_ME_ND_1: 21, M_SP_TB_1: 30, M_DP_TB_1: 31, M_ME_TD_1: 34,
    M_ME_TE_1: 35, M_ME_TF_1: 36, M_IT_TB_1: 37,
    C_SC_NA_1: 45, C_DC_NA_1: 46, C_IC_NA_1: 100, C_CI_NA_1: 101, C_CS_NA_1: 103,
};

const COT = {
    PERIODIC: 1, BACKGROUND: 2, SPONTANEOUS: 3, INITIALIZED: 4, REQUEST: 5,
    ACTIVATION: 6, ACTIVATION_CON: 7, DEACTIVATION: 8, DEACTIVATION_CON: 9,
    ACTIVATION_TERM: 10, INTERROGATED_STATION: 20,
};

// ═══════════════════════════════════════════════════════════════════════════
// IEC 104 CLIENT
// ═══════════════════════════════════════════════════════════════════════════
class IEC104Client {
    constructor(config) {
        this.id = config.device_id;
        this.name = config.device_name || `IEC104-${this.id}`;
        this.ip = config.ip_address;
        this.port = config.port || 2404;
        this.description = config.description || '';
        this.socket = null;
        this.connected = false;
        this.startdtConfirmed = false;
        this.buffer = Buffer.alloc(0);
        this.ssn = 0; this.rsn = 0; this.ackRsn = 0; this.unackedCount = 0;
        this.t1 = (config.t1 || 15) * 1000;
        this.t2 = (config.t2 || 10) * 1000;
        this.t3 = (config.t3 || 20) * 1000;
        this.k = config.k || 12;
        this.w = config.w || 8;
        this.t3Timer = null;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.lastError = null;
        this.lastConnectTime = null;
        this.lastDisconnectTime = null;
        this.giInterval = (config.gi_interval || 60) * 1000;
        this.giTimer = null;
        this.tagMap = new Map();
        this.gaveUp = false; // true if maxAttempts reached and not infinite
    }

    registerTag(asduAddress, ioa, tag) { this.tagMap.set(`${asduAddress}_${ioa}`, tag); }

    async connect() {
        return new Promise((resolve) => {
            try {
                if (this.socket) try { this.socket.destroy(); } catch (e) { /* */ }
                this.socket = new net.Socket();
                this.socket.setTimeout(this.t1);
                this.buffer = Buffer.alloc(0);
                this.ssn = 0; this.rsn = 0; this.ackRsn = 0;
                this.unackedCount = 0; this.startdtConfirmed = false;

                this.socket.connect(this.port, this.ip, () => {
                    this.connected = true;
                    this.gaveUp = false;
                    this.lastConnectTime = new Date();
                    this.lastError = null;
                    this.reconnectAttempts = 0;
                    this.stopReconnectLoop();
                    Logger.info(`[${this.name}] ✅ Connected to ${this.ip}:${this.port}`);
                    this._sendUFrame(0x07);
                    this._resetT3Timer();
                    resolve(true);
                });

                this.socket.on('data', (data) => { this._resetT3Timer(); this._onData(data); });
                this.socket.on('close', () => { this._handleDisconnect('Connection closed'); });
                this.socket.on('error', (err) => {
                    // Initial connect failures may happen before STARTDT; still start reconnect loop.
                    this.connected = false; this.startdtConfirmed = false;
                    this.lastError = err.message; this.lastDisconnectTime = new Date();
                    this._clearTimers(); this.startReconnectLoop();
                    resolve(false);
                });
                this.socket.on('timeout', () => {
                    this.connected = false; this.startdtConfirmed = false;
                    this.lastError = 'Timeout'; this.lastDisconnectTime = new Date();
                    this._clearTimers(); this.startReconnectLoop();
                    resolve(false);
                });
            } catch (e) { this.lastError = e.message; resolve(false); }
        });
    }

    disconnect() {
        this.stopReconnectLoop(); this._clearTimers();
        if (this.socket) {
            if (this.connected) try { this._sendUFrame(0x13); } catch (e) { /* */ }
            try { this.socket.destroy(); } catch (e) { /* */ }
        }
        this.connected = false; this.startdtConfirmed = false;
    }

    startReconnectLoop() {
        if (this.reconnectTimer || this.connected) return;
        const maxAtt = CONFIG.reconnect.maxAttempts;
        const isInfinite = maxAtt === 0;

        if (!isInfinite && this.reconnectAttempts >= maxAtt) {
            this.gaveUp = true;
            Logger.error(`[${this.name}] ❌ Max reconnect attempts (${maxAtt}) reached.`);
            if (CONFIG.reconnect.shutdownOnMaxRetries) {
                Logger.error(`[${this.name}] shutdownOnMaxRetries=true → Shutting down server...`);
                setTimeout(() => shutdown('maxRetries'), 1000);
            }
            return;
        }

        const delay = CONFIG.reconnect.interval;
        Logger.info(`[${this.name}] Reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1}${isInfinite ? '/∞' : '/' + maxAtt})`);
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.connected) return;
            this.reconnectAttempts++;
            if (!(await this.connect())) this.startReconnectLoop();
        }, delay);
    }

    stopReconnectLoop() {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    }

    _handleDisconnect(reason) {
        if (!this.connected && !this.startdtConfirmed) return;
        Logger.warn(`[${this.name}] ⚠️ Disconnected: ${reason}`);
        this.connected = false; this.startdtConfirmed = false;
        this.lastError = reason; this.lastDisconnectTime = new Date();
        this._clearTimers(); this.startReconnectLoop();
    }

    _resetT3Timer() {
        if (this.t3Timer) clearTimeout(this.t3Timer);
        this.t3Timer = setTimeout(() => { if (this.connected) this._sendUFrame(0x43); }, this.t3);
    }

    _clearTimers() {
        if (this.t3Timer) { clearTimeout(this.t3Timer); this.t3Timer = null; }
        if (this.giTimer) { clearInterval(this.giTimer); this.giTimer = null; }
    }

    sendGeneralInterrogation(asduAddress = 1) {
        if (!this.connected || !this.startdtConfirmed) return;
        this._sendIFrame(Buffer.from([
            IEC104_TYPES.C_IC_NA_1, 0x01, COT.ACTIVATION & 0xFF, 0x00,
            asduAddress & 0xFF, (asduAddress >> 8) & 0xFF, 0x00, 0x00, 0x00, 0x14
        ]));
        Logger.info(`[${this.name}] Sent GI to ASDU ${asduAddress}`);
    }

    startPeriodicGI() {
        if (this.giTimer) clearInterval(this.giTimer);
        const asdus = new Set();
        this.tagMap.forEach((_, key) => asdus.add(parseInt(key.split('_')[0])));
        const doGI = () => { if (this.connected && this.startdtConfirmed) asdus.forEach(a => this.sendGeneralInterrogation(a)); };
        setTimeout(doGI, 1000);
        this.giTimer = setInterval(doGI, this.giInterval);
    }

    _sendUFrame(ctrl) { if (!this.socket || this.socket.destroyed) return; try { this.socket.write(Buffer.from([0x68, 0x04, ctrl, 0x00, 0x00, 0x00])); } catch (e) { /* */ } }

    _sendSFrame() {
        if (!this.socket || this.socket.destroyed) return;
        const r = this.rsn;
        try { this.socket.write(Buffer.from([0x68, 0x04, 0x01, 0x00, (r << 1) & 0xFE, (r >> 7) & 0xFF])); this.ackRsn = r; this.unackedCount = 0; } catch (e) { /* */ }
    }

    _sendIFrame(asdu) {
        if (!this.socket || this.socket.destroyed || !this.connected) return;
        const s = this.ssn, r = this.rsn;
        const h = Buffer.from([0x68, asdu.length + 4, (s << 1) & 0xFE, (s >> 7) & 0xFF, (r << 1) & 0xFE, (r >> 7) & 0xFF]);
        this.ssn = (this.ssn + 1) & 0x7FFF; this.ackRsn = r; this.unackedCount = 0;
        try { this.socket.write(Buffer.concat([h, asdu])); } catch (e) { /* */ }
    }

    _onData(data) {
        this.buffer = Buffer.concat([this.buffer, data]);

        // Guard: if the buffer grows beyond 64 KB something is very wrong
        // (normal IEC 104 APDUs are ≤ 255 bytes). Reset to avoid memory leak.
        if (this.buffer.length > 65536) {
            Logger.warn(`[${this.name}] Buffer overflow (${this.buffer.length} bytes) — resetting`);
            this.buffer = Buffer.alloc(0);
            return;
        }

        while (this.buffer.length >= 2) {
            if (this.buffer[0] !== 0x68) { const i = this.buffer.indexOf(0x68); if (i === -1) { this.buffer = Buffer.alloc(0); return; } this.buffer = this.buffer.slice(i); continue; }
            const tl = this.buffer[1] + 2;
            // Sanity: IEC 104 APDU max length is 255; reject obviously bad frames
            if (tl > 255) {
                Logger.warn(`[${this.name}] Invalid APDU length ${tl} — skipping byte`);
                this.buffer = this.buffer.slice(1);
                continue;
            }
            if (this.buffer.length < tl) break;
            this._processAPDU(this.buffer.slice(0, tl));
            this.buffer = this.buffer.slice(tl);
        }
    }

    _processAPDU(apdu) {
        if (apdu.length < 6) return;
        const c1 = apdu[2], c2 = apdu[3];
        if ((c1 & 0x01) === 0) {
            this.rsn = (((c1 >> 1) | (c2 << 7)) + 1) & 0x7FFF;
            this.unackedCount++;
            this._processIFrame(apdu.slice(6));
            if (this.unackedCount >= this.w) this._sendSFrame();
        } else if ((c1 & 0x03) === 0x03) {
            if (c1 & 0x08) { Logger.info(`[${this.name}] STARTDT confirmed`); this.startdtConfirmed = true; this.startPeriodicGI(); }
            else if (c1 & 0x20) { this.startdtConfirmed = false; }
            else if (c1 & 0x40) { this._sendUFrame(0x83); }
        }
        // --- updated by me

    }

    _processIFrame(d) {
        if (d.length < 6) return;
        const typeId = d[0], vsq = d[1], numObj = vsq & 0x7F, sq = (vsq >> 7) & 0x01;
        const cot = d[2] & 0x3F, asdu = d[4] | (d[5] << 8);
        let off = 6;
        if (typeId === IEC104_TYPES.C_IC_NA_1) {
            if (cot === COT.ACTIVATION_CON) Logger.info(`[${this.name}] GI Confirmed ASDU=${asdu}`);
            else if (cot === COT.ACTIVATION_TERM) Logger.info(`[${this.name}] GI Complete ASDU=${asdu}`);
            return;
        }
        if (sq === 0) {
            for (let i = 0; i < numObj; i++) {
                if (off + 3 > d.length) break;
                const ioa = d[off] | (d[off + 1] << 8) | (d[off + 2] << 16); off += 3;
                const r = this._parse(typeId, d, off);
                if (r) { off += r.bc; this._updateTag(asdu, ioa, r.v, r.q); }
            }
        } else {
            if (off + 3 > d.length) return;
            let ioa = d[off] | (d[off + 1] << 8) | (d[off + 2] << 16); off += 3;
            for (let i = 0; i < numObj; i++) { const r = this._parse(typeId, d, off); if (r) { off += r.bc; this._updateTag(asdu, ioa + i, r.v, r.q); } }
        }
    }

    _parse(t, d, o) {
        try {
            switch (t) {
                case 1: if (o >= d.length) return null; return { v: d[o] & 1, q: (d[o] >> 4) & 0xF, bc: 1 };
                case 2: if (o + 3 >= d.length) return null; return { v: d[o] & 1, q: (d[o] >> 4) & 0xF, bc: 4 };
                case 30: if (o + 7 >= d.length) return null; return { v: d[o] & 1, q: (d[o] >> 4) & 0xF, bc: 8 };
                case 3: if (o >= d.length) return null; return { v: d[o] & 3, q: (d[o] >> 4) & 0xF, bc: 1 };
                case 31: if (o + 7 >= d.length) return null; return { v: d[o] & 3, q: (d[o] >> 4) & 0xF, bc: 8 };
                case 5: if (o + 1 >= d.length) return null; let sv = d[o] & 0x7F; if (d[o] & 0x40) sv -= 64; return { v: sv, q: d[o + 1], bc: 2 };
                case 9: if (o + 2 >= d.length) return null; return { v: d.readInt16LE(o) / 32768.0, q: d[o + 2], bc: 3 };
                case 11: if (o + 2 >= d.length) return null; return { v: d.readInt16LE(o), q: d[o + 2], bc: 3 };
                case 13: if (o + 4 >= d.length) return null; return { v: d.readFloatLE(o), q: d[o + 4], bc: 5 };
                case 15: if (o + 4 >= d.length) return null; return { v: d.readInt32LE(o), q: d[o + 4], bc: 5 };
                case 21: if (o + 1 >= d.length) return null; return { v: d.readInt16LE(o) / 32768.0, q: 0, bc: 2 };
                case 34: if (o + 9 >= d.length) return null; return { v: d.readInt16LE(o) / 32768.0, q: d[o + 2], bc: 10 };
                case 35: if (o + 9 >= d.length) return null; return { v: d.readInt16LE(o), q: d[o + 2], bc: 10 };
                case 36: if (o + 11 >= d.length) return null; return { v: d.readFloatLE(o), q: d[o + 4], bc: 12 };
                case 37: if (o + 11 >= d.length) return null; return { v: d.readInt32LE(o), q: d[o + 4], bc: 12 };
                default: return null;
            }
        } catch (e) { return null; }
    }

    _updateTag(asdu, ioa, value, quality) {
        const tag = this.tagMap.get(`${asdu}_${ioa}`);
        if (tag) {
            // Keep the last raw IEC value so equations don't compound on each loop.
            tag.rawValue = value;
            tag.value = applyEquation(value, tag.equation, tag._compiledEquation);
            tag.quality = quality;
            tag.lastUpdate = Date.now();
        }
    }

    getStatus() {
        return {
            id: this.id, name: this.name, type: 'IEC104',
            ip: this.ip, port: this.port,
            connected: this.connected, startdtConfirmed: this.startdtConfirmed,
            reconnectAttempts: this.reconnectAttempts, lastError: this.lastError,
            lastConnectTime: this.lastConnectTime, lastDisconnectTime: this.lastDisconnectTime,
            registeredTags: this.tagMap.size, gaveUp: this.gaveUp
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Modbus TCP Client
// ═══════════════════════════════════════════════════════════════════════════
class ModbusConnection {
    constructor(config) {
        this.id = config.device_id;
        this.name = config.device_name || `Modbus-${this.id}`;
        this.ip = config.ip_address;
        this.port = config.port || 502;
        this.unitId = config.unit_id || 1;
        this.description = config.description || '';
        this.client = null; this.connected = false;
        this.reconnectAttempts = 0; this.reconnectTimer = null;
        this.lastError = null; this.lastConnectTime = null; this.lastDisconnectTime = null;
        this.gaveUp = false;
    }

    startReconnectLoop() {
        if (this.reconnectTimer || this.connected) return;
        const maxAtt = CONFIG.reconnect.maxAttempts;
        const isInfinite = maxAtt === 0;

        if (!isInfinite && this.reconnectAttempts >= maxAtt) {
            this.gaveUp = true;
            Logger.error(`[${this.name}] ❌ Max reconnect attempts (${maxAtt}) reached.`);
            if (CONFIG.reconnect.shutdownOnMaxRetries) {
                Logger.error(`[${this.name}] shutdownOnMaxRetries=true → Shutting down server...`);
                setTimeout(() => shutdown('maxRetries'), 1000);
            }
            return;
        }

        const delay = CONFIG.reconnect.interval;
        Logger.info(`[${this.name}] Reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1}${isInfinite ? '/∞' : '/' + maxAtt})`);
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null; if (this.connected) return;
            this.reconnectAttempts++;
            if (!(await this.connect())) this.startReconnectLoop();
        }, delay);
    }

    stopReconnectLoop() {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    }

    async connect() {
        if (!ModbusRTU) return false;
        try {
            // Close any previous client to avoid socket/FD leak on reconnect
            if (this.client) {
                try { this.client.close(); } catch (e) { /* ignore */ }
                this.client = null;
            }
            this.client = new ModbusRTU();
            this.client.setTimeout(CONFIG.modbusTimeoutMs);
            await this.client.connectTCP(this.ip, { port: this.port });
            this.client.setID(this.unitId);
            this.connected = true; this.gaveUp = false;
            this.reconnectAttempts = 0; this.lastError = null;
            this.lastConnectTime = new Date();
            this.stopReconnectLoop();
            Logger.info(`[${this.name}] ✅ Connected to ${this.ip}:${this.port}`);
            return true;
        } catch (e) {
            Logger.error(`[${this.name}] Connection failed:`, e.message);
            this.connected = false; this.lastError = e.message; this.lastDisconnectTime = new Date();
            // Also close on failed connect so the half-open socket is freed
            if (this.client) {
                try { this.client.close(); } catch (_) { /* ignore */ }
                this.client = null;
            }
            // If initial connect fails, start reconnect loop even if no reads happened yet.
            this.startReconnectLoop();
            return false;
        }
    }

    async readRegisters(registerType, address, count) {
        if (!this.connected || !this.client) throw new Error('Not connected');
        try {
            let r;
            switch (registerType) {
                case '1x': r = await this.client.readCoils(address, count); return r.data;
                case '2x': r = await this.client.readDiscreteInputs(address, count); return r.data;
                case '3x': r = await this.client.readInputRegisters(address, count); return r.data;
                case '4x': default: r = await this.client.readHoldingRegisters(address, count); return r.data;
            }
        } catch (e) { this._handleDisconnect(e.message); throw e; }
    }

    async writeRegister(address, value) {
        if (!this.connected || !this.client) throw new Error('Not connected');
        try { await this.client.writeRegister(address, value); return true; }
        catch (e) { this._handleDisconnect(e.message); throw e; }
    }

    _handleDisconnect(reason) {
        if (!this.connected) return;
        Logger.warn(`[${this.name}] ⚠️ Disconnected: ${reason}`);
        this.connected = false; this.lastError = reason; this.lastDisconnectTime = new Date();
        this.startReconnectLoop();
    }

    disconnect() {
        this.stopReconnectLoop();
        if (this.client) try { this.client.close(); } catch (e) { /* */ }
        this.connected = false;
    }

    getStatus() {
        return {
            id: this.id, name: this.name, type: 'Modbus',
            ip: this.ip, port: this.port, unitId: this.unitId,
            connected: this.connected, reconnectAttempts: this.reconnectAttempts,
            lastError: this.lastError, lastConnectTime: this.lastConnectTime,
            lastDisconnectTime: this.lastDisconnectTime, gaveUp: this.gaveUp
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tag Manager
// ═══════════════════════════════════════════════════════════════════════════
class TagManager {
    constructor() { this.tags = {}; this.modbusDevices = {}; this.iec104Devices = {}; this.tagsByPage = {}; this.tagsByDevice = {}; this.calcTags = []; this.scope = {}; }

    getFieldCI(row, fieldName) {
        if (!row || !fieldName) return undefined;
        const target = String(fieldName).trim().toLowerCase();
        for (const k of Object.keys(row)) {
            if (String(k).trim().toLowerCase() === target) return row[k];
        }
        return undefined;
    }

    normalizeModbusAddress(raw) {
        if (raw === null || raw === undefined || raw === '') return null;
        const n = parseInt(raw);
        if (!Number.isFinite(n) || isNaN(n)) return null;
        const base = Number.isFinite(CONFIG.modbusAddressBase) ? CONFIG.modbusAddressBase : 0;
        // Clamp at 0 to avoid negative addresses when users put "0" while base=1.
        return Math.max(0, n - base);
    }

    normalizeBitIndex(raw) {
        if (raw === null || raw === undefined || raw === '') return null;
        const n = parseInt(raw);
        if (!Number.isFinite(n) || isNaN(n)) return null;
        if (n < 0 || n > 15) return null;
        return n;
    }

    parseModbusAddressAndBit(rawAddress, rawBit) {
        // Supports either:
        // - modbus_address=181, bit=12
        // - modbus_address="181.12" (bit inferred), bit column optional
        const bitFromColumn = this.normalizeBitIndex(rawBit);
        if (rawAddress === null || rawAddress === undefined || rawAddress === '') {
            return { address: null, bit: bitFromColumn };
        }

        const s = String(rawAddress).trim();
        if (s.includes('.')) {
            const [a, b] = s.split('.', 2);
            const addr = this.normalizeModbusAddress(a);
            const bitFromAddress = this.normalizeBitIndex(b);
            return { address: addr, bit: bitFromColumn !== null ? bitFromColumn : bitFromAddress };
        }

        return { address: this.normalizeModbusAddress(s), bit: bitFromColumn };
    }

    normalizeDataType(raw) {
        if (raw == null) return '';
        switch (String(raw).trim().toLowerCase()) {
            case 'bool': case 'boolean': return 'Bool'; case 'byte': case 'uint8': return 'Byte';
            case 'int': case 'int16': return 'Int'; case 'uint': case 'uint16': return 'UInt'; case 'word': return 'Word';
            case 'dint': case 'int32': return 'DInt'; case 'dword': case 'uint32': return 'DWord';
            case 'real': case 'float': case 'float32': return 'Real'; default: return String(raw).trim();
        }
    }

    dtToIecType(dt) {
        switch (dt) { case 'Bool': return 1; case 'Int': case 'UInt': case 'Word': return 11; case 'Real': return 13; case 'DInt': case 'DWord': return 15; default: return 13; }
    }

    async loadFromExcel(filePath) {
        try {
            const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(filePath);

            const mbSheet = wb.getWorksheet('ModbusDevices');
            //console.log(mbSheet)
            if (mbSheet) {
                sheetToJson(mbSheet).forEach(row => {
                    const id = row.device_id ? String(row.device_id).trim() : ''; if (!id) return;
                    this.modbusDevices[id] = new ModbusConnection({ device_id: id, device_name: row.device_name || '', ip_address: row.ip_address || '', port: row.port || 502, unit_id: row.unit_id || 1, description: row.description || '' });
                });
                Logger.info(`Loaded ${Object.keys(this.modbusDevices).length} Modbus devices`);
            }

            const iecSheet = wb.getWorksheet('IEC104Devices');
            if (iecSheet) {
                sheetToJson(iecSheet).forEach(row => {
                    const id = row.device_id ? String(row.device_id).trim() : ''; if (!id) return;
                    this.iec104Devices[id] = new IEC104Client({ device_id: id, device_name: row.device_name || '', ip_address: row.ip_address || '', port: row.port || 2404, description: row.description || '', t1: row.t1 || 15, t2: row.t2 || 10, t3: row.t3 || 20, k: row.k || 12, w: row.w || 8, gi_interval: row.gi_interval || 60 });
                });
                Logger.info(`Loaded ${Object.keys(this.iec104Devices).length} IEC104 devices`);
            }

            const tagsSheet = wb.getWorksheet('Tags');
            if (tagsSheet) {
                sheetToJson(tagsSheet).forEach(row => {
                    const name = row.tag_name != null ? String(row.tag_name).trim() : ''; if (!name) return;
                    const calcExpr = row.calc != null ? String(row.calc).trim() : '';
                    const proto = calcExpr ? 'calc' : (row.protocol_type || '').trim().toLowerCase();
                    const dt = this.normalizeDataType(row.data_type);
                    const bitRaw = this.getFieldCI(row, 'bit') ?? this.getFieldCI(row, 'bit_index');
                    const addrAndBit = this.parseModbusAddressAndBit(row.modbus_address, bitRaw);
                    const tag = {
                        id: row.tag_id, name, protocolType: proto, dataType: dt,
                        page: row.page !== undefined ? parseInt(row.page) : null,
                        unit: row.unit || '', description: row.description || '', equation: row.equation || null,
                        calc: calcExpr || null,
                        rawValue: null, value: null, quality: 0, lastUpdate: null,
                        actualTagId: (row.actual_tag_id !== undefined && row.actual_tag_id !== '') ? parseInt(row.actual_tag_id) : null,
                        chartable: (row.actual_tag_id !== undefined && row.actual_tag_id !== '') && dt !== 'Bool',
                        modbusDeviceId: row.modbus_device_id ? String(row.modbus_device_id).trim() : null,
                        registerType: row.register_type || '4x',
                        modbusAddress: addrAndBit.address,
                        modbusBit: addrAndBit.bit,
                        registerCount: row.register_count || 1,
                        iec104DeviceId: row.iec104_device_id ? String(row.iec104_device_id).trim() : null,
                        iec104AsduAddress: row.iec104_asdu_address !== undefined ? parseInt(row.iec104_asdu_address) : 1,
                        iec104IOA: row.iec104_ioa !== undefined ? parseInt(row.iec104_ioa) : null,
                        iec104TypeId: row.iec104_type_id ? parseInt(row.iec104_type_id) : this.dtToIecType(dt),
                    };
                    this.tags[name] = tag;
                    if (tag.page !== null && !isNaN(tag.page)) { if (!this.tagsByPage[tag.page]) this.tagsByPage[tag.page] = []; this.tagsByPage[tag.page].push(tag); }
                    if (proto === 'calc') {
                        this.calcTags.push(tag);
                    } else if (proto === 'iec104' && tag.iec104DeviceId && tag.iec104IOA !== null) {
                        const dev = this.iec104Devices[tag.iec104DeviceId]; if (dev) dev.registerTag(tag.iec104AsduAddress, tag.iec104IOA, tag);
                    } else if (proto === 'modbus' && tag.modbusDeviceId) {
                        if (!this.tagsByDevice[tag.modbusDeviceId]) this.tagsByDevice[tag.modbusDeviceId] = [];
                        this.tagsByDevice[tag.modbusDeviceId].push(tag);
                    }
                });
                Logger.info(`Loaded ${Object.keys(this.tags).length} tags (${this.calcTags.length} calculated, ${Object.values(this.tags).filter(t => t.chartable).length} chartable)`);
            }
            return true;
        } catch (e) { Logger.error('Error loading Excel:', e.message); return false; }
    }

    getTagsForPage(p) { return this.tagsByPage[p] || []; }
    getTagInfo(n) { return this.tags[n] || null; }
    getChartableTags() { return Object.values(this.tags).filter(t => t.chartable); }

    /**
     * Pre-compile all mathjs expressions (calc + equation) once at startup.
     * math.compile() parses the string into an AST one time; subsequent
     * .evaluate(scope) calls skip parsing entirely → ~10-30x faster per call.
     */
    compileExpressions() {
        if (!math) return;

        const cleanExpr = (raw) => String(raw).trim()
            .replace(/^=/, '')
            .replace(/[×✕]/g, '*')
            .replace(/[÷]/g, '/');

        let compiledCalc = 0, compiledEq = 0;

        for (const tag of Object.values(this.tags)) {
            // Compile calc expressions (use tag names as variables)
            if (tag.calc) {
                try {
                    tag._compiledCalc = math.compile(cleanExpr(tag.calc));
                    compiledCalc++;
                } catch (e) {
                    Logger.error(`Failed to compile calc for "${tag.name}": ${e.message}`);
                    tag._compiledCalc = null;
                }
            }

            // Compile equation expressions (use 'x' as variable)
            if (tag.equation) {
                const expr = cleanExpr(tag.equation)
                    .replace(/\bX\b/g, 'x')
                    .replace(/\bVALUE\b/gi, 'x');
                try {
                    tag._compiledEquation = math.compile(expr);
                    compiledEq++;
                } catch (e) {
                    Logger.error(`Failed to compile equation for "${tag.name}": ${e.message}`);
                    tag._compiledEquation = null;
                }
            }
        }

        Logger.info(`Compiled expressions: ${compiledCalc} calc + ${compiledEq} equations`);
    }

    /**
     * Pre-compute optimal Modbus batch groups per device.
     * Groups contiguous (or near-contiguous) registers of the same type
     * into single reads, respecting the Modbus protocol limit of 125 registers.
     * Runs once at startup — batches don't change at runtime.
     */
    buildModbusBatches() {
        const MAX_REGISTERS = 125;  // Modbus protocol limit for register reads
        const MAX_COILS = 2000;     // Modbus protocol limit for coil/discrete reads
        const MAX_GAP = 10;         // Max unused registers to include in a batch (trade-off: read a few extra vs extra request)

        this.modbusBatches = {};    // { deviceId: [ { regType, start, count, tags[] } ] }
        let totalBatches = 0, totalTags = 0;

        for (const [devId, tags] of Object.entries(this.tagsByDevice)) {
            // Group tags by register type
            const byType = {};
            for (const tag of tags) {
                if (tag.modbusAddress == null) continue;
                const rt = tag.registerType || '4x';
                if (!byType[rt]) byType[rt] = [];
                byType[rt].push(tag);
            }

            const batches = [];

            for (const [regType, regTags] of Object.entries(byType)) {
                const maxBatch = (regType === '1x' || regType === '2x') ? MAX_COILS : MAX_REGISTERS;

                // Sort by address for optimal grouping
                regTags.sort((a, b) => a.modbusAddress - b.modbusAddress);

                let bStart = regTags[0].modbusAddress;
                let bEnd = bStart + (regTags[0].registerCount || 1) - 1;
                let bTags = [regTags[0]];

                for (let i = 1; i < regTags.length; i++) {
                    const tag = regTags[i];
                    const tagEnd = tag.modbusAddress + (tag.registerCount || 1) - 1;
                    const gap = tag.modbusAddress - bEnd - 1;
                    const totalIfMerged = tagEnd - bStart + 1;

                    if (gap <= MAX_GAP && totalIfMerged <= maxBatch) {
                        bEnd = Math.max(bEnd, tagEnd);
                        bTags.push(tag);
                    } else {
                        batches.push({ regType, start: bStart, count: bEnd - bStart + 1, tags: bTags });
                        bStart = tag.modbusAddress;
                        bEnd = tagEnd;
                        bTags = [tag];
                    }
                }
                batches.push({ regType, start: bStart, count: bEnd - bStart + 1, tags: bTags });
            }

            this.modbusBatches[devId] = batches;
            totalBatches += batches.length;
            totalTags += tags.length;
        }

        Logger.info(`Modbus batching: ${totalTags} tags → ${totalBatches} batch reads across ${Object.keys(this.modbusBatches).length} devices`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
function parseModbusValue(data, dt, bitIndex = null) {
    try {
        if (!data || !data.length) return 0;
        switch (dt) {
            case 'Bool': {
                const word = data[0] & 0xFFFF;
                const bi = bitIndex === null || bitIndex === undefined || bitIndex === '' ? null : parseInt(bitIndex);
                if (Number.isFinite(bi) && !isNaN(bi) && bi >= 0 && bi <= 15) {
                    return (word >> bi) & 0x01;
                }
                return word ? 1 : 0;
            }
            case 'Byte': return data[0] & 0xFF;
            case 'Int': return data[0] > 32767 ? data[0] - 65536 : data[0];
            case 'UInt': case 'Word': return data[0];
            case 'DInt': if (data.length >= 2) { const v = (data[0] << 16) | data[1]; return v > 2147483647 ? v - 4294967296 : v; } return data[0];
            case 'DWord': return data.length >= 2 ? (data[0] << 16) | data[1] : data[0];
            case 'Real': if (data.length >= 2) { const b = Buffer.alloc(4); b.writeUInt16BE(data[0], 0); b.writeUInt16BE(data[1], 2); return b.readFloatBE(0); } return data[0];
            default: return data[0];
        }
    } catch (e) { return 0; }
}

function applyEquation(value, eq, compiledEquation) {
    if (eq == null || eq === '' || !math) return value;

    try {
        // Use pre-compiled expression if available (10-30x faster)
        if (compiledEquation) {
            const r = compiledEquation.evaluate({ x: value });
            return typeof r === 'number' && !isNaN(r) ? r : value;
        }

        // Fallback: parse at runtime (only hit if compilation failed at startup)
        const raw = String(eq);
        const expr = raw
            .trim()
            .replace(/^=/, '')
            .replace(/[×✕]/g, '*')
            .replace(/[÷]/g, '/')
            .replace(/\bX\b/g, 'x')
            .replace(/\bVALUE\b/gi, 'x');

        const r = math.evaluate(expr, { x: value });
        return typeof r === 'number' && !isNaN(r) ? r : value;
    } catch (e) {
        // Log once per unique (equation, error) to help users fix their Excel sheet.
        // Cap at 500 entries to prevent unbounded memory growth over long runs.
        if (!global.__equationErrors) global.__equationErrors = new Set();
        const key = `${eq}||${e && e.message ? e.message : String(e)}`;
        if (!global.__equationErrors.has(key)) {
            if (global.__equationErrors.size >= 500) global.__equationErrors.clear();
            global.__equationErrors.add(key);
            Logger.warn(`Invalid equation ignored: "${eq}" (${e.message})`);
        }
        return value;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Calculated Tags — internal tags whose value is derived from other tags
// ═══════════════════════════════════════════════════════════════════════════
function evaluateCalcTags(tm) {
    if (!math || tm.calcTags.length === 0) return [];

    // Update the persistent scope with current tag values (avoids rebuilding object each cycle)
    const scope = tm.scope;
    for (const [name, tag] of Object.entries(tm.tags)) {
        if (tag.value !== null && tag.value !== undefined) {
            scope[name] = tag.value;
        }
    }

    const updates = [];

    for (const tag of tm.calcTags) {
        try {
            let r;
            if (tag._compiledCalc) {
                // Fast path: use pre-compiled expression (~10-30x faster than math.evaluate)
                r = tag._compiledCalc.evaluate(scope);
            } else if (tag.calc) {
                // Slow fallback: parse at runtime (only if compilation failed at startup)
                const expr = String(tag.calc).trim().replace(/^=/, '').replace(/[×✕]/g, '*').replace(/[÷]/g, '/');
                r = math.evaluate(expr, scope);
            } else {
                continue;
            }

            if (typeof r === 'number' && !isNaN(r) && isFinite(r)) {
                const final = applyEquation(r, tag.equation, tag._compiledEquation);
                tag.rawValue = r;
                tag.value = final;
                tag.lastUpdate = Date.now();
                scope[tag.name] = final;
                updates.push({ tag_name: tag.name, value: final, unit: tag.unit, actual_tag_id: tag.actualTagId, chartable: tag.chartable });
            }
        } catch (e) {
            if (!global.__calcErrors) global.__calcErrors = new Set();
            const key = `${tag.name}||${e && e.message ? e.message : String(e)}`;
            if (!global.__calcErrors.has(key)) {
                if (global.__calcErrors.size >= 200) global.__calcErrors.clear();
                global.__calcErrors.add(key);
                Logger.warn(`Calc tag "${tag.name}" error: "${tag.calc}" (${e.message})`);
            }
        }
    }

    return updates;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════
const tagManager = new TagManager();
let isUpdating = false, updateTimeout = null;
let lastDeviceStatusJson = '';   // cache for diff-based emit

// Per-cycle safety net: a single slow/hung device must NOT stall the whole
// update cycle (that would delay every tag for all clients). We cap how long
// the cycle waits for any one device; stragglers keep reading in the background
// and are skipped (via dev._reading) next cycle until they finish.
const DEVICE_DEADLINE_MS = (CONFIG.modbusTimeoutMs || 2000) + 600;

function raceDeadline(promise, ms) {
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Change-detection (deadband) for broadcasts ──
// Only push a tag when its value actually moved beyond a small deadband. A
// periodic full refresh re-syncs slow-drifting tags and any client that
// subscribed mid-stream. Cuts payload size + CPU/GC + network on every client.
let lastFullBroadcast = 0;
// Keep this BELOW the client's staleness threshold (MultiTrend STALE_MS) so a
// constant-but-connected tag is re-sent before a client would wrongly flag it
// as "no signal". A genuinely disconnected device drops out of `updates`
// entirely (so it is never refreshed, and clients correctly detect the gap).
const FULL_REFRESH_MS = parseInt(process.env.FULL_REFRESH_MS) || appConfig.fullRefreshMs || 3000;
const DEADBAND_ABS = (appConfig.deadbandAbs != null) ? Number(appConfig.deadbandAbs) : 0.001;
const DEADBAND_REL = (appConfig.deadbandRel != null) ? Number(appConfig.deadbandRel) : 0.0005;

function tagChanged(prev, v) {
    if (prev === undefined) return true;
    if (typeof v === 'number' && typeof prev === 'number') {
        const ref = Math.max(Math.abs(v), Math.abs(prev));
        return Math.abs(v - prev) > Math.max(DEADBAND_ABS, DEADBAND_REL * ref);
    }
    return v !== prev;
}

// Only retry a failed batch tag-by-tag when the batch is this small. For large
// batches a per-tag fallback would multiply the delay, and a read failure has
// usually already marked the device disconnected anyway.
const SMALL_BATCH_FALLBACK = 6;

async function readDeviceBatched(dev, batches) {
    const updates = [];
    if (!dev.connected) { if (!dev.reconnectTimer && !dev.gaveUp) dev.startReconnectLoop(); return updates; }

    for (const batch of batches) {
        // A failed read marks the device disconnected; stop hammering it this
        // cycle (remaining reads would just throw "Not connected" instantly).
        if (!dev.connected) break;
        try {
            const data = await dev.readRegisters(batch.regType, batch.start, batch.count);

            for (const tag of batch.tags) {
                try {
                    const offset = tag.modbusAddress - batch.start;
                    const count = tag.registerCount || 1;
                    const tagData = data.slice(offset, offset + count);
                    const raw = parseModbusValue(tagData, tag.dataType, tag.modbusBit);
                    const v = applyEquation(raw, tag.equation, tag._compiledEquation);
                    tag.rawValue = raw;
                    tag.value = v;
                    tag.lastUpdate = Date.now();
                    updates.push({ tag_name: tag.name, value: v, unit: tag.unit, actual_tag_id: tag.actualTagId, chartable: tag.chartable });
                } catch (e) { /* skip individual tag parse error */ }
            }
        } catch (e) {
            // Batch read failed. Only retry per-tag for very small batches.
            if (dev.connected && batch.tags.length <= SMALL_BATCH_FALLBACK) {
                for (const tag of batch.tags) {
                    if (!dev.connected) break;
                    try {
                        if (tag.modbusAddress == null) continue;
                        const data = await dev.readRegisters(tag.registerType, tag.modbusAddress, tag.registerCount || 1);
                        const raw = parseModbusValue(data, tag.dataType, tag.modbusBit);
                        const v = applyEquation(raw, tag.equation, tag._compiledEquation);
                        tag.rawValue = raw;
                        tag.value = v;
                        tag.lastUpdate = Date.now();
                        updates.push({ tag_name: tag.name, value: v, unit: tag.unit, actual_tag_id: tag.actualTagId, chartable: tag.chartable });
                    } catch (e2) { /* skip */ }
                }
            }
        }
    }

    return updates;
}

async function updateTags() {
    if (isUpdating) return; isUpdating = true;
    const updates = [];
    try {
        // Read all Modbus devices in PARALLEL, each using BATCHED register reads,
        // but bounded by a per-device deadline so one straggler can't hold up the
        // cycle. A device still reading from a previous slow cycle is skipped so
        // we never issue overlapping reads on the same Modbus client.
        const devicePromises = Object.entries(tagManager.modbusBatches || {}).map(([devId, batches]) => {
            const dev = tagManager.modbusDevices[devId];
            if (!dev) return Promise.resolve([]);
            if (dev._reading) return Promise.resolve([]);
            dev._reading = true;
            const p = readDeviceBatched(dev, batches)
                .catch(() => [])
                .finally(() => { dev._reading = false; });
            // Returns null if the device blew the deadline (its tags go stale this
            // cycle); p keeps running in the background and clears _reading later.
            return raceDeadline(p, DEVICE_DEADLINE_MS);
        });

        const deviceResults = await Promise.all(devicePromises);
        for (const result of deviceResults) if (result && result.length) updates.push(...result);

        Object.values(tagManager.tags).forEach(tag => {
            if (tag.protocolType === 'iec104' && tag.rawValue !== null && tag.rawValue !== undefined) {
                // Don't rebroadcast a stale value for a device that's offline — let
                // the tag go absent so clients show "no signal" instead of a frozen
                // value (Modbus already stops emitting offline devices via the read).
                const dev = tag.iec104DeviceId ? tagManager.iec104Devices[tag.iec104DeviceId] : null;
                if (dev && !dev.connected) return;
                // Re-apply equation on the raw value (not the already-transformed value).
                const v = applyEquation(tag.rawValue, tag.equation, tag._compiledEquation);
                tag.value = v;
                updates.push({ tag_name: tag.name, value: v, unit: tag.unit, actual_tag_id: tag.actualTagId, chartable: tag.chartable });
            }
        });

        // Evaluate calculated (internal) tags — must run after modbus + iec104 so all source values are fresh
        const calcUpdates = evaluateCalcTags(tagManager);
        if (calcUpdates.length > 0) updates.push(...calcUpdates);

        // Keep only the tags that actually changed (deadband), plus everything on
        // a periodic full refresh. `updates` still updated tag state above; we
        // only trim what goes over the wire.
        const nowMs = Date.now();
        const fullRefresh = (nowMs - lastFullBroadcast) >= FULL_REFRESH_MS;
        const changed = [];
        for (const u of updates) {
            const tag = tagManager.tags[u.tag_name];
            const prev = tag ? tag._lastSent : undefined;
            if (fullRefresh || tagChanged(prev, u.value)) {
                if (tag) tag._lastSent = u.value;
                changed.push(u);
            }
        }
        if (fullRefresh) lastFullBroadcast = nowMs;

        if (changed.length > 0) {
            // Legacy broadcast clients (default room)
            io.to(ALL_ROOM).emit('tag_updates', changed);

            // Optimized per-prefix rooms for INV/EM/PR
            const byPrefix = new Map(); // prefix -> updates[]
            for (const u of changed) {
                const pfx = extractKnownPrefix(u.tag_name);
                if (!pfx) continue;
                let list = byPrefix.get(pfx);
                if (!list) { list = []; byPrefix.set(pfx, list); }
                list.push(u);
            }
            for (const [pfx, list] of byPrefix.entries()) {
                io.to(getPrefixRoom(pfx)).emit('tag_updates', list);
            }
        }

        Object.values(tagManager.iec104Devices).forEach(d => { if (!d.connected && !d.reconnectTimer && !d.gaveUp) d.startReconnectLoop(); });

        // Build detailed device status — only emit when something changed
        const deviceStatus = [
            ...Object.values(tagManager.modbusDevices).map(d => d.getStatus()),
            ...Object.values(tagManager.iec104Devices).map(d => d.getStatus())
        ];
        const statusJson = JSON.stringify(deviceStatus);
        if (statusJson !== lastDeviceStatusJson) {
            lastDeviceStatusJson = statusJson;
            io.emit('device_status', deviceStatus);
        }
    } catch (e) { Logger.error('updateTags error:', e.message); }
    finally { isUpdating = false; }
}

function startUpdateLoop() { updateTags().finally(() => { updateTimeout = setTimeout(startUpdateLoop, CONFIG.updateInterval); }); }

// ── Socket.IO ──
io.on('connection', (socket) => {
    Logger.info(`Web client: ${socket.id}`);
    // Default to legacy broadcast mode until the client opts into subscriptions.
    socket.join(ALL_ROOM);
    const tv = {}, tm = {};
    Object.entries(tagManager.tags).forEach(([n, t]) => { tv[n] = t.value; tm[n] = { actual_tag_id: t.actualTagId, chartable: t.chartable, unit: t.unit, dataType: t.dataType, protocolType: t.protocolType }; });
    socket.emit('init', {
        devices: [...Object.values(tagManager.modbusDevices).map(d => d.getStatus()), ...Object.values(tagManager.iec104Devices).map(d => d.getStatus())],
        tags: tv, tagMeta: tm
    });
    socket.on('subscribe', p => socket.join(`page_${p}`));
    socket.on('unsubscribe', p => socket.leave(`page_${p}`));
    socket.on('use_subscriptions', () => {
        // Opt into subscription model: stop receiving full broadcast updates.
        socket.leave(ALL_ROOM);
    });
    socket.on('subscribe_prefix', (prefix) => {
        const p = normalizePrefix(prefix);
        if (!p) return;
        socket.join(getPrefixRoom(p));
    });
    socket.on('unsubscribe_prefix', (prefix) => {
        const p = normalizePrefix(prefix);
        if (!p) return;
        socket.leave(getPrefixRoom(p));
    });
    socket.on('get_tag_info', (n, cb) => { const t = tagManager.getTagInfo(n); cb(t ? { success: true, data: { name: t.name, actual_tag_id: t.actualTagId, chartable: t.chartable, unit: t.unit, dataType: t.dataType } } : { success: false, error: 'Not found' }); });
    socket.on('disconnect', () => Logger.info(`Web client left: ${socket.id}`));
});

// ── REST API ──
app.get('/api/config', (_, res) => res.json(appConfig));

// HEALTH — always 200, status in body
app.get('/api/health', (_, res) => {
    const mb = Object.values(tagManager.modbusDevices);
    const iec = Object.values(tagManager.iec104Devices);
    const disconnected = [];

    mb.forEach(d => { if (!d.connected) disconnected.push({ name: d.name, type: 'Modbus', ip: d.ip, error: d.lastError, gaveUp: d.gaveUp, attempts: d.reconnectAttempts }); });
    iec.forEach(d => { if (!d.connected) disconnected.push({ name: d.name, type: 'IEC104', ip: d.ip, error: d.lastError, gaveUp: d.gaveUp, attempts: d.reconnectAttempts }); });

    const allConnected = disconnected.length === 0;

    res.status(200).json({
        status: allConnected ? 'OK' : 'DEGRADED',
        allConnected: allConnected,
        disconnectedDevices: disconnected,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        stats: {
            totalTags: Object.keys(tagManager.tags).length,
            modbusDevices: mb.length,
            connectedModbus: mb.filter(d => d.connected).length,
            iec104Devices: iec.length,
            connectedIEC104: iec.filter(d => d.connected).length
        }
    });
});

app.get('/api/tags', (_, res) => { const v = {}; Object.entries(tagManager.tags).forEach(([n, t]) => v[n] = t.value); res.json({ success: true, data: v }); });
app.get('/api/tag/:name', (req, res) => { const t = tagManager.getTagInfo(req.params.name); if (t) res.json({ success: true, data: { name: t.name, value: t.value, actual_tag_id: t.actualTagId, chartable: t.chartable, unit: t.unit, dataType: t.dataType, protocolType: t.protocolType, description: t.description } }); else res.status(404).json({ success: false, error: 'Not found' }); });
app.post('/api/tag/:name/write', async (req, res) => {
    const t = tagManager.getTagInfo(req.params.name); if (!t) return res.status(404).json({ success: false, error: 'Not found' });
    const val = req.body?.value; if (val === undefined) return res.status(400).json({ success: false, error: 'Missing value' });
    if (t.protocolType === 'modbus') {
        const dev = tagManager.modbusDevices[t.modbusDeviceId]; if (!dev?.connected) return res.status(400).json({ success: false, error: 'Not connected' });
        try { await dev.writeRegister(t.modbusAddress, Number(val)); t.value = Number(val); io.emit('tag_update', { tag_name: t.name, value: t.value, unit: t.unit }); return res.json({ success: true }); }
        catch (e) { return res.status(500).json({ success: false, error: e.message }); }
    }
    return res.status(501).json({ success: false, error: 'Write not supported' });
});
app.get('/api/chartable-tags', (_, res) => res.json({ success: true, data: tagManager.getChartableTags().map(t => ({ name: t.name, actual_tag_id: t.actualTagId, unit: t.unit, page: t.page })) }));
app.get('/api/tags/page/:p', (req, res) => { const r = {}; tagManager.getTagsForPage(parseInt(req.params.p)).forEach(t => r[t.name] = { value: t.value, unit: t.unit, actual_tag_id: t.actualTagId, chartable: t.chartable }); res.json({ success: true, data: r }); });
app.get('/api/devices', (_, res) => res.json({ success: true, data: [...Object.values(tagManager.modbusDevices).map(d => d.getStatus()), ...Object.values(tagManager.iec104Devices).map(d => d.getStatus())] }));
app.get('/api/status', (_, res) => res.json({ success: true, data: { totalTags: Object.keys(tagManager.tags).length, modbusDevices: Object.keys(tagManager.modbusDevices).length, connectedModbus: Object.values(tagManager.modbusDevices).filter(d => d.connected).length, iec104Devices: Object.keys(tagManager.iec104Devices).length, connectedIEC104: Object.values(tagManager.iec104Devices).filter(d => d.connected).length } }));
app.get('/', requireLoginPage(), (_, res) => res.sendFile(path.join(__dirname, '../web/pages/dashboard.html')));

// Backward-compatible: allow `/monitoring.html` instead of `/pages/monitoring.html`
app.get('/:page.html', async (req, res, next) => {
    // Enforce login for all HTML pages; admin-only for user-interface.html
    _setNoStore(res);
    const page = String(req.params.page || '').toLowerCase();
    const user = await _fetchAuthMe(req);
    if (!user) return res.redirect(302, LOGIN_REDIRECT_URL);
    if (page === 'user-interface' && user.role !== 'administrator') return res.redirect(302, '/dashboard.html');

    const filePath = path.join(__dirname, '../web/pages', `${req.params.page}.html`);
    res.sendFile(filePath, (err) => (err ? next() : undefined));
});

// If someone hits `/pages/*.html`, redirect to `/*.html` so relative asset paths like `js/...` work.
app.get('/pages/:page', (req, res, next) => {
    const page = String(req.params.page || '');
    if (!page.toLowerCase().endsWith('.html')) return next();
    const qIndex = req.originalUrl.indexOf('?');
    const query = qIndex >= 0 ? req.originalUrl.slice(qIndex) : '';
    res.redirect(302, `/${page}${query}`);
});

app.get('/pages/*', (req, res) => res.sendFile(path.join(__dirname, '../web', req.path)));

// ═══════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
    await tagManager.loadFromExcel(CONFIG.excelPath);
    tagManager.compileExpressions();
    tagManager.buildModbusBatches();
    for (const d of Object.values(tagManager.modbusDevices)) d.connect();
    for (const d of Object.values(tagManager.iec104Devices)) d.connect();
    startUpdateLoop();
    server.listen(CONFIG.port, () => {
        console.log(`
╔═══════════════════════════════════════════════════════════╗
║     ⚡ SCADA Server (Modbus + IEC 104 Client)            ║
╠═══════════════════════════════════════════════════════════╣
║  🌐 Web:     http://192.168.1.2:${CONFIG.port}                      ║
║  🏷️  Tags:    ${Object.keys(tagManager.tags).length} total (${tagManager.calcTags.length} calculated)                        ║
║  📡 Modbus:  ${Object.keys(tagManager.modbusDevices).length} device(s)                                  ║
║  🔌 IEC104:  ${Object.keys(tagManager.iec104Devices).length} device(s)                                  ║
║  🔄 Reconnect: ${CONFIG.reconnect.maxAttempts === 0 ? '∞' : CONFIG.reconnect.maxAttempts} attempts, every ${CONFIG.reconnect.interval}ms         ║
║  ❤️  Health:  http://192.168.1.2:${CONFIG.port}/api/health           ║
╚═══════════════════════════════════════════════════════════╝
        `);
    });
})();

// ═══════════════════════════════════════════════════════════════════════════
// Shutdown
// ═══════════════════════════════════════════════════════════════════════════
const shutdown = async (sig) => {
    Logger.info(`${sig} — shutting down...`);
    if (updateTimeout) clearTimeout(updateTimeout);
    server.close(); io.close();
    for (const d of Object.values(tagManager.modbusDevices)) try { d.disconnect(); } catch (e) { /* */ }
    for (const d of Object.values(tagManager.iec104Devices)) try { d.disconnect(); } catch (e) { /* */ }
    process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { Logger.error('Uncaught:', e); shutdown('uncaughtException'); });
process.on('unhandledRejection', (r) => Logger.error('Unhandled:', r));
