/**
 * Configuration Manager
 * Reads and manages configuration from INI file
 */

const fs = require('fs');
const path = require('path');
const ini = require('ini');
const EventEmitter = require('eventemitter3');

class ConfigManager extends EventEmitter {
    constructor(configPath = './config.ini') {
        super();
        this.configPath = path.resolve(configPath);
        this.config = null;
        this.lastModified = null;
        this.watchInterval = null;
    }

    /**
     * Load configuration from INI file
     */
    load() {
        try {
            if (!fs.existsSync(this.configPath)) {
                throw new Error(`Configuration file not found: ${this.configPath}`);
            }

            const content = fs.readFileSync(this.configPath, 'utf-8');
            this.config = ini.parse(content);
            this.lastModified = fs.statSync(this.configPath).mtime;

            // Parse and normalize values
            this._normalizeConfig();

            return this.config;
        } catch (error) {
            throw new Error(`Failed to load configuration: ${error.message}`);
        }
    }

    /**
     * Normalize configuration values (convert strings to appropriate types)
     */
    _normalizeConfig() {
        const booleans = ['true', 'false', 'yes', 'no', '1', '0'];
        
        const isSensitiveKey = (key) => /password|secret|token/i.test(key);

        const parseValue = (value, key) => {
            if (isSensitiveKey(key)) {
                return typeof value === 'string' ? value : String(value);
            }
            if (typeof value !== 'string') return value;
            
            const lower = value.toLowerCase();
            if (lower === 'true' || lower === 'yes' || lower === '1') return true;
            if (lower === 'false' || lower === 'no' || lower === '0') return false;
            
            const num = Number(value);
            if (!isNaN(num) && value.trim() !== '') return num;
            
            return value;
        };

        const normalizeObject = (obj) => {
            for (const key in obj) {
                if (typeof obj[key] === 'object' && obj[key] !== null) {
                    normalizeObject(obj[key]);
                } else {
                    obj[key] = parseValue(obj[key], key);
                }
            }
        };

        normalizeObject(this.config);
    }

    /**
     * Get a configuration value by path (e.g., 'Database.Server')
     */
    get(path, defaultValue = null) {
        const keys = path.split('.');
        let value = this.config;

        for (const key of keys) {
            if (value && typeof value === 'object' && key in value) {
                value = value[key];
            } else {
                return defaultValue;
            }
        }

        return value !== undefined ? value : defaultValue;
    }

    /**
     * Get entire section
     */
    getSection(section) {
        return this.config[section] || {};
    }

    /**
     * Start watching for configuration changes
     */
    startWatching(intervalMs = 5000) {
        this.watchInterval = setInterval(() => {
            this._checkForChanges();
        }, intervalMs);
    }

    /**
     * Stop watching for configuration changes
     */
    stopWatching() {
        if (this.watchInterval) {
            clearInterval(this.watchInterval);
            this.watchInterval = null;
        }
    }

    /**
     * Check for configuration file changes
     */
    _checkForChanges() {
        try {
            const stats = fs.statSync(this.configPath);
            if (stats.mtime > this.lastModified) {
                const oldConfig = { ...this.config };
                this.load();
                this.emit('configChanged', { oldConfig, newConfig: this.config });
            }
        } catch (error) {
            this.emit('error', error);
        }
    }

    /**
     * Check for reload flag file
     */
    checkReloadFlag() {
        const flagPath = this.get('General.ReloadFlagPath', './data/reload_flag.txt');
        try {
            if (fs.existsSync(flagPath)) {
                fs.unlinkSync(flagPath);
                const oldConfig = { ...this.config };
                this.load();
                this.emit('configReloaded', { oldConfig, newConfig: this.config });
                return true;
            }
        } catch (error) {
            this.emit('error', error);
        }
        return false;
    }

    /**
     * Get database configuration
     */
    getDatabaseConfig() {
        const db = this.getSection('Database');
        const useWindowsAuth = db.UseWindowsAuth === true;
        const driverName =
            typeof db.Driver === 'string' && db.Driver.trim() !== ''
                ? db.Driver.trim()
                : null;
        const options = {
            encrypt: db.Encrypt || false,
            trustServerCertificate: db.TrustServerCertificate !== false,
            enableArithAbort: true,
        };

        if (useWindowsAuth) {
            options.trustedConnection = true;
        }

        const baseConfig = {
            server: db.Server || '192.168.1.2',
            database: db.Database || 'IndustrialDB',
            ...(useWindowsAuth
                ? { driver: 'msnodesqlv8' }
                : { user: db.User, password: db.Password }),
            options,
            pool: {
                min: db.PoolMin || 2,
                max: db.PoolMax || 10,
            },
            connectionTimeout: db.ConnectionTimeout || 30000,
            requestTimeout: db.RequestTimeout || 60000,
        };

        if (useWindowsAuth && driverName) {
            baseConfig.connectionString =
                `Driver={${driverName}};` +
                `Server=${baseConfig.server};` +
                `Database=${baseConfig.database};` +
                `Trusted_Connection=Yes;` +
                `TrustServerCertificate=Yes;`;
        }

        return baseConfig;
    }

    /**
     * Get API configuration
     */
    getApiConfig() {
        const api = this.getSection('API');
        return {
            enabled: api.Enabled !== false,
            port: api.Port || 3000,
            host: api.Host || '0.0.0.0',
            cors: {
                enabled: api.EnableCors !== false,
                origins: api.CorsOrigins === '*' ? '*' : (api.CorsOrigins || '*').split(',').map(s => s.trim()),
            },
            rateLimit: api.RateLimitPerMinute || 0,
            jwt: {
                secret: api.JwtSecret || 'change-this-secret',
                // Backward compatible: support hours or days.
                // If both are set, days wins.
                expirationDays: api.JwtExpirationDays || null,
                expirationHours: api.JwtExpirationHours || 24,
            },
        };
    }

    /**
     * Get WebSocket configuration
     */
    getWebSocketConfig() {
        const ws = this.getSection('WebSocket');
        return {
            enabled: ws.Enabled !== false,
            path: ws.Path || '/ws',
            heartbeatInterval: ws.HeartbeatIntervalMs || 30000,
            clientTimeout: ws.ClientTimeoutMs || 60000,
            maxClients: ws.MaxClients || 0,
        };
    }

    /**
     * Get Alarm Service configuration
     */
    getAlarmServiceConfig() {
        const alarm = this.getSection('AlarmService');
        return {
            enabled: alarm.Enabled !== false,
            scanInterval: alarm.ScanIntervalMs || 500,
            consecutiveTrueCount: alarm.ConsecutiveTrueCount || 3,
            consecutiveFalseCount: alarm.ConsecutiveFalseCount || 3,
            chatterFilterMs: alarm.ChatterFilterMs || 1000,
            batchSize: alarm.BatchSize || 50,
            bufferSize: alarm.BufferSize || 1000,
            threadPoolSize: alarm.ThreadPoolSize || 2,
        };
    }

    /**
     * Get Historian Service configuration
     */
    getHistorianServiceConfig() {
        const historian = this.getSection('HistorianService');
        return {
            enabled: historian.Enabled !== false,
            batchSize: historian.BatchSize || 100,
            flushInterval: historian.FlushIntervalMs || 5000,
            bufferSize: historian.BufferSize || 10000,
            threadPoolSize: historian.ThreadPoolSize || 2,
            defaultQuality: historian.DefaultQuality || 192,
        };
    }

    /**
     * Get IEC 60870-5-104 client configuration (defaults / fallbacks).
     * Per-device timers come from the IEC104Devices table / Excel sheet.
     */
    getIec104Config() {
        const iec = this.getSection('IEC104');
        return {
            connectionTimeout: iec.ConnectionTimeoutMs || 10000,
            autoReconnect: iec.AutoReconnect !== false,
            reconnectInterval: iec.ReconnectIntervalMs || 10000,
            defaultPort: iec.DefaultPort || 2404,
            t1: iec.T1 || 15,
            t2: iec.T2 || 10,
            t3: iec.T3 || 20,
            k: iec.K || 12,
            w: iec.W || 8,
            giInterval: iec.GiInterval || 60,
        };
    }

    /**
     * Get Modbus configuration
     */
    getModbusConfig() {
        const modbus = this.getSection('Modbus');
        return {
            connectionTimeout: modbus.ConnectionTimeoutMs || 5000,
            readTimeout: modbus.ReadTimeoutMs || 3000,
            autoReconnect: modbus.AutoReconnect !== false,
            reconnectInterval: modbus.ReconnectIntervalMs || 10000,
        };
    }

    /**
     * Excel device loading configuration (optional)
     *
     * [ExcelDevices]
     * Enabled=true|false
     * Files=./excel-data/Analog_Alarm.xlsx,./excel-data/Discrete_Alarm.xlsx,./excel-data/History.xlsx
     * PollIntervalMs=10000
     */
    getExcelDevicesConfig() {
        const excel = this.getSection('ExcelDevices');
        const filesRaw = excel.Files || '';
        const files = String(filesRaw)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);

        return {
            enabled: excel.Enabled === true,
            files,
            pollIntervalMs: excel.PollIntervalMs || 10000,
        };
    }

    /**
     * Emergency administrator (break-glass) credentials.
     * Stored in config.ini and NOT persisted to DB.
     *
     * [EmergencyAdmin]
     * Enabled=true|false
     * Username=...
     * Password=... (not recommended)
     * PasswordHash=... (bcrypt hash, recommended)
     */
    getEmergencyAdminConfig() {
        const ea = this.getSection('EmergencyAdmin');
        return {
            enabled: ea.Enabled === true,
            username: ea.Username ? String(ea.Username).trim() : '',
            password: ea.Password != null ? String(ea.Password) : '',
            passwordHash: ea.PasswordHash != null ? String(ea.PasswordHash) : '',
        };
    }
}

module.exports = ConfigManager;
