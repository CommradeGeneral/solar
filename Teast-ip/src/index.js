/**
 * Industrial Data Server
 * Main Entry Point
 * 
 * Features:
 * - IEC 60870-5-104 client (RTU / logger) support
 * - Modbus TCP/RTU support
 * - Analog & Discrete Alarm management
 * - Historian data logging
 * - REST API
 * - WebSocket for live updates
 */

const path = require('path');
const fs = require('fs');

// Load configuration first
const ConfigManager = require('./config/ConfigManager');
const configManager = new ConfigManager(process.env.CONFIG_PATH || './config.ini');
configManager.load();

// Initialize logger
const { initLogger, getLogger } = require('./utils/Logger');
const logger = initLogger({
    serviceName: configManager.get('General.ServiceName', 'IndustrialDataServer'),
    logPath: configManager.get('General.LogPath', './logs'),
    logLevel: configManager.get('General.LogLevel', 'info'),
    maxSizeMB: configManager.get('General.MaxLogSizeMB', 10),
    maxFiles: configManager.get('General.MaxLogFiles', 5),
});

// Import components
const DatabaseManager = require('./connections/DatabaseManager');
const Iec104ConnectionManager = require('./connections/Iec104ConnectionManager');
const ModbusConnectionManager = require('./connections/ModbusConnectionManager');
const AlarmService = require('./services/AlarmService');
const HistorianService = require('./services/HistorianService');
const RetentionService = require('./services/RetentionService');
const ApiServer = require('./api/ApiServer');
const WebSocketServer = require('./api/WebSocketServer');
const ExcelDeviceLoader = require('./utils/ExcelDeviceLoader');

// Global instances
let db = null;
let iec104Manager = null;
let modbusManager = null;
let alarmService = null;
let historianService = null;
let retentionService = null;
let apiServer = null;
let wsServer = null;
let excelDeviceLoader = null;

// Graceful shutdown flag
let isShuttingDown = false;

/**
 * Initialize all components
 */
async function initialize() {
    logger.info('==============================================================');
    logger.info('        Industrial Data Server - Starting Up                  ');
    logger.info('==============================================================');

    // Ensure data directory exists
    const dataDir = path.dirname(configManager.get('General.StateFilePath', './data/last_alarm_states.json'));
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 1) Initialize IEC104 + Modbus managers first (so they can keep retrying independently)
    logger.info('Initializing IEC104 connections...');
    const iec104Config = configManager.getIec104Config();
    iec104Manager = new Iec104ConnectionManager(iec104Config);

    logger.info('Initializing Modbus connections...');
    const modbusConfig = configManager.getModbusConfig();
    modbusManager = new ModbusConnectionManager(modbusConfig);

    // Optional: load devices from Excel and keep watching for changes.
    const excelDevices = configManager.getExcelDevicesConfig();
    if (excelDevices.enabled) {
        excelDeviceLoader = new ExcelDeviceLoader({
            enabled: true,
            files: excelDevices.files.length > 0 ? excelDevices.files : [
                './excel-data/Analog_Alarm.xlsx',
                './excel-data/Discrete_Alarm.xlsx',
                './excel-data/History.xlsx',
            ],
            pollIntervalMs: excelDevices.pollIntervalMs,
            logger,
        });
        excelDeviceLoader.start(iec104Manager, modbusManager);
        logger.info('Excel device loader enabled', { pollIntervalMs: excelDevices.pollIntervalMs });
    }

    // 2) Initialize Database Connection (retry forever unless shutting down)
    logger.info('Initializing database connection...');
    const dbConfig = configManager.getDatabaseConfig();
    db = new DatabaseManager(dbConfig, {
        maxRetries: configManager.get('Database.MaxRetries', 3),
        retryDelayMs: configManager.get('Database.RetryDelayMs', 5000),
    });

    const formatError = (err) => {
        if (!err) return { message: 'Unknown error (null/undefined)' };
        if (typeof err === 'string') return { message: err };
        const out = {
            name: err.name,
            message: err.message,
            code: err.code,
            number: err.number,
            errno: err.errno,
        };
        if (err.originalError) {
            out.originalError = {
                message: err.originalError.message,
                code: err.originalError.code,
                number: err.originalError.number,
            };
        }
        if (err.precedingErrors) {
            out.precedingErrors = Array.isArray(err.precedingErrors)
                ? err.precedingErrors.slice(0, 5).map((e) => ({ message: e?.message, code: e?.code, number: e?.number }))
                : err.precedingErrors;
        }
        if (err.stack) out.stack = err.stack;
        // mssql sometimes stores useful text under "errors" or "info"
        if (err.errors) out.errors = err.errors;
        return out;
    };

    while (!isShuttingDown) {
        try {
            await db.connect();
            break;
        } catch (error) {
            const info = formatError(error);
            logger.error('Database connection failed; will retry', info);
            await sleep(configManager.get('Database.RetryDelayMs', 5000));
        }
    }


    console.log('11')
    // 3) Load devices from DB only when Excel loader is not used
    if (!excelDevices.enabled) {
        // Load IEC104 devices from database
        const iecResult = await db.execute('sp_GetActiveIEC104Devices');
        for (const dev of iecResult.recordset) {
            iec104Manager.addDevice(dev.device_id, {
                ip_address: dev.ip_address,
                port: dev.port,
                t1: dev.t1,
                t2: dev.t2,
                t3: dev.t3,
                k: dev.k,
                w: dev.w,
                gi_interval: dev.gi_interval,
            });
        }
        await iec104Manager.connectAll();

        // Load Modbus devices from database
        const modbusResult = await db.execute('sp_GetActiveModbusDevices');
        for (const device of modbusResult.recordset) {
            modbusManager.addDevice(device.device_id, {
                connection_type: device.connection_type,
                ip_address: device.ip_address,
                port: device.port,
                unit_id: device.unit_id,
                serial_port: device.serial_port,
                baud_rate: device.baud_rate,
                parity: device.parity,
                stop_bits: device.stop_bits,
                data_bits: device.data_bits,
            });
        }
        await modbusManager.connectAll();
    }

    console.log('ddddd')
    // 4. Initialize Alarm Service
    if (configManager.get('AlarmService.Enabled', true)) {
        logger.info('Initializing Alarm Service...');
        const alarmConfig = configManager.getAlarmServiceConfig();
        alarmService = new AlarmService({
            scanInterval: alarmConfig.scanInterval,
            consecutiveTrueCount: alarmConfig.consecutiveTrueCount,
            consecutiveFalseCount: alarmConfig.consecutiveFalseCount,
            chatterFilterMs: alarmConfig.chatterFilterMs,
            stateFilePath: configManager.get('General.StateFilePath'),
            bufferSize: alarmConfig.bufferSize,
        });
        await alarmService.initialize(db, iec104Manager, modbusManager);
    }

    // 5. Initialize Historian Service
    if (configManager.get('HistorianService.Enabled', true)) {
        logger.info('Initializing Historian Service...');
        const historianConfig = configManager.getHistorianServiceConfig();
        historianService = new HistorianService({
            batchSize: historianConfig.batchSize,
            flushInterval: historianConfig.flushInterval,
            bufferSize: historianConfig.bufferSize,
            defaultQuality: historianConfig.defaultQuality,
        });
        await historianService.initialize(db, iec104Manager, modbusManager);
    }

    // 5.5 Initialize Retention Service.
    // Always created: even when data retention is disabled, it still performs
    // safe housekeeping of expired RevokedTokens (dead JWTs) to prevent that
    // table from growing without bound. The data-deletion part respects
    // Retention.Enabled.
    retentionService = new RetentionService({
        enabled: configManager.get('Retention.Enabled', true),
        runIntervalMs: configManager.get('Retention.RunIntervalMs', 6 * 60 * 60 * 1000),
        initialDelayMs: configManager.get('Retention.InitialDelayMs', 60 * 1000),
        historianDays: configManager.get('Retention.HistorianDays', 30),
        alarmDays: configManager.get('Retention.AlarmDays', 90),
        systemLogsDays: configManager.get('Retention.SystemLogsDays', 14),
        batchSize: configManager.get('Retention.BatchSize', 10000),
        pauseMs: configManager.get('Retention.PauseMs', 100),
        maxRunMs: configManager.get('Retention.MaxRunMs', 10 * 60 * 1000),
        // RevokedTokens housekeeping (always-on, independent of Retention.Enabled)
        revokedTokensCleanup: configManager.get('Retention.RevokedTokensCleanup', true),
        revokedTokensIntervalMs: configManager.get('Retention.RevokedTokensIntervalMs', 6 * 60 * 60 * 1000),
    });
    await retentionService.initialize(db);

    // 6. Initialize API Server
    if (configManager.get('API.Enabled', true)) {
        logger.info('Initializing API Server...');
        const apiConfig = configManager.getApiConfig();
        apiServer = new ApiServer(apiConfig);
        apiServer.initialize({
            alarmService,
            historianService,
            db,
            iec104Manager,
            modbusManager,
            configManager,
        });
        await apiServer.start();
    }

    // 7. Initialize WebSocket Server
    if (configManager.get('WebSocket.Enabled', true) && apiServer) {
        logger.info('Initializing WebSocket Server...');
        const wsConfig = configManager.getWebSocketConfig();
        wsServer = new WebSocketServer(wsConfig);
        wsServer.initialize(apiServer.getServer(), alarmService);
    }

    // Start services
    logger.info('Starting services...');
    if (alarmService) alarmService.start();
    if (historianService) historianService.start();
    if (retentionService) retentionService.start();

    // Setup config reload watcher
    setupConfigReloadWatcher();

    logger.info('==============================================================');
    logger.info('        Industrial Data Server - Running                      ');
    logger.info('==============================================================');


    console.log('ended')
    logStartupSummary();
}

/**
 * Log startup summary
 */
function logStartupSummary() {
    const apiConfig = configManager.getApiConfig();
    const wsConfig = configManager.getWebSocketConfig();

    logger.info('');
    logger.info('------------------------------');
    logger.info('        STARTUP SUMMARY       ');
    logger.info('------------------------------');
    logger.info(`Database:        Connected`);
    logger.info(`IEC104 Devices:  ${iec104Manager?.getDeviceIds()?.length || 0} configured`);
    logger.info(`Modbus Devices:  ${modbusManager?.getDeviceIds()?.length || 0} configured`);
    logger.info(`Alarm Service:   ${alarmService ? 'Running' : 'Disabled'}`);
    logger.info(`Historian:       ${historianService ? 'Running' : 'Disabled'}`);

    if (apiServer) {
        logger.info(`API:             http://${apiConfig.host}:${apiConfig.port}/api`);
    }
    if (wsServer) {
        logger.info(`WebSocket:       ws://${apiConfig.host}:${apiConfig.port}${wsConfig.path}`);
    }

    logger.info('------------------------------');
    logger.info('');
}

/**
 * Setup configuration reload watcher
 */
function setupConfigReloadWatcher() {
    const reloadFlagPath = configManager.get('General.ReloadFlagPath', './data/reload_flag.txt');

    setInterval(async () => {
        if (fs.existsSync(reloadFlagPath)) {
            logger.info('Reload flag detected, reloading configuration...');
            try {
                fs.unlinkSync(reloadFlagPath);
                configManager.load();

                if (alarmService) await alarmService.reloadConfiguration();
                if (historianService) await historianService.reloadConfiguration();

                logger.info('Configuration reloaded successfully');
            } catch (error) {
                logger.error('Failed to reload configuration', { error: error.message });
            }
        }
    }, 5000);
}

/**
 * Graceful shutdown
 */
async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`Received ${signal}, starting graceful shutdown...`);

    try {
        // Stop services first
        if (alarmService) {
            logger.info('Stopping Alarm Service...');
            await alarmService.stop();
        }

        if (historianService) {
            logger.info('Stopping Historian Service...');
            await historianService.stop();
        }

        if (retentionService) {
            logger.info('Stopping Retention Service...');
            retentionService.stop();
        }

        // Close WebSocket connections
        if (wsServer) {
            logger.info('Closing WebSocket connections...');
            wsServer.close();
        }

        // Stop API server
        if (apiServer) {
            logger.info('Stopping API Server...');
            await apiServer.stop();
        }

        // Disconnect from IEC104 devices
        if (iec104Manager) {
            logger.info('Disconnecting from IEC104 devices...');
            await iec104Manager.disconnectAll();
        }

        // Disconnect from Modbus devices
        if (modbusManager) {
            logger.info('Disconnecting from Modbus devices...');
            await modbusManager.disconnectAll();
        }

        if (excelDeviceLoader) {
            excelDeviceLoader.stop();
            excelDeviceLoader = null;
        }

        // Close database connection
        if (db) {
            logger.info('Closing database connection...');
            await db.disconnect();
        }

        logger.info('Graceful shutdown complete');
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown', { error: error.message });
        process.exit(1);
    }
}

function handleProcessLevelError(kind, errorLike) {
    const error =
        errorLike instanceof Error
            ? errorLike
            : new Error(typeof errorLike === 'string' ? errorLike : JSON.stringify(errorLike));

    logger.error(`Process-level ${kind}`, {
        error: error.message,
        stack: error.stack,
    });

    const exitOnUnhandledError = configManager.get('General.ExitOnUnhandledError', false) === true;
    if (exitOnUnhandledError) {
        shutdown(kind);
    } else {
        logger.warn(`Continuing after ${kind} because General.ExitOnUnhandledError=false`);
    }
}

// Handle shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    handleProcessLevelError('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
    handleProcessLevelError('unhandledRejection', reason);
});

// Start the server
initialize().catch((error) => {
    logger.error('Failed to initialize server', { error: error.message, stack: error.stack });
    process.exit(1);
});
