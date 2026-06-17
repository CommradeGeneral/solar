/**
 * Modbus Connection Manager
 * Manages Modbus TCP/RTU connections with thread-safe access and auto-reconnect
 */

const ModbusRTU = require('modbus-serial');
const { Mutex } = require('async-mutex');
const EventEmitter = require('eventemitter3');
const { getLogger } = require('../utils/Logger');

class ModbusConnectionManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.connections = new Map(); // device_id -> connection info
        this.mutexes = new Map();     // device_id -> mutex for thread-safe access
        
        this.options = {
            connectionTimeout: options.connectionTimeout || 5000,
            readTimeout: options.readTimeout || 3000,
            autoReconnect: options.autoReconnect !== false,
            reconnectInterval: options.reconnectInterval || 10000,
        };

        this.logger = getLogger().getServiceLogger('ModbusConnectionManager');
        this.reconnectTimers = new Map();
    }

    /**
     * Add a Modbus device configuration
     */
    addDevice(deviceId, config) {
        if (this.connections.has(deviceId)) {
            this.logger.warn(`Modbus device ${deviceId} already exists, updating config`);
        }

        this.connections.set(deviceId, {
            config: {
                type: config.connection_type || 'tcp',
                ip: config.ip_address,
                port: config.port || 502,
                unitId: config.unit_id || 1,
                // RTU settings
                serialPort: config.serial_port,
                baudRate: config.baud_rate || 9600,
                parity: config.parity || 'none',
                stopBits: config.stop_bits || 1,
                dataBits: config.data_bits || 8,
            },
            client: null,
            connected: false,
            reconnectAttempts: 0,
            lastError: null,
            metrics: {
                reads: 0,
                errors: 0,
                reconnects: 0,
            },
        });

        this.mutexes.set(deviceId, new Mutex());
        this.logger.info(`Added Modbus device configuration: ${deviceId}`, { 
            type: config.connection_type,
            host: config.ip_address 
        });
    }

    /**
     * Connect to a specific Modbus device
     */
    async connect(deviceId) {
        const deviceInfo = this.connections.get(deviceId);
        if (!deviceInfo) {
            throw new Error(`Modbus device ${deviceId} not found`);
        }

        const mutex = this.mutexes.get(deviceId);
        const release = await mutex.acquire();

        try {
            if (deviceInfo.connected && deviceInfo.client) {
                return true;
            }

            this.logger.info(`Connecting to Modbus device ${deviceId}...`);

            const client = new ModbusRTU();
            client.setTimeout(this.options.readTimeout);

            const config = deviceInfo.config;

            if (config.type === 'tcp') {
                await client.connectTCP(config.ip, { port: config.port });
            } else if (config.type === 'rtu') {
                await client.connectRTUBuffered(config.serialPort, {
                    baudRate: config.baudRate,
                    parity: config.parity,
                    stopBits: config.stopBits,
                    dataBits: config.dataBits,
                });
            } else {
                throw new Error(`Unknown connection type: ${config.type}`);
            }

            client.setID(config.unitId);

            deviceInfo.client = client;
            deviceInfo.connected = true;
            deviceInfo.reconnectAttempts = 0;
            deviceInfo.lastError = null;

            this.logger.info(`Successfully connected to Modbus device ${deviceId}`);
            this.emit('connected', { deviceId });

            return true;
        } catch (error) {
            deviceInfo.connected = false;
            deviceInfo.lastError = error.message;
            this.logger.error(`Failed to connect to Modbus device ${deviceId}`, { error: error.message });
            this.emit('error', { deviceId, error });

            if (this.options.autoReconnect) {
                this._scheduleReconnect(deviceId);
            }

            throw error;
        } finally {
            release();
        }
    }

    /**
     * Connect to all configured Modbus devices
     */
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
     * Disconnect from a specific Modbus device
     */
    async disconnect(deviceId) {
        const deviceInfo = this.connections.get(deviceId);
        if (!deviceInfo) return;

        // Cancel any pending reconnect
        if (this.reconnectTimers.has(deviceId)) {
            clearTimeout(this.reconnectTimers.get(deviceId));
            this.reconnectTimers.delete(deviceId);
        }

        const mutex = this.mutexes.get(deviceId);
        const release = await mutex.acquire();

        try {
            if (deviceInfo.client) {
                deviceInfo.client.close(() => {});
                deviceInfo.client = null;
            }
            deviceInfo.connected = false;
            this.logger.info(`Disconnected from Modbus device ${deviceId}`);
            this.emit('disconnected', { deviceId });
        } finally {
            release();
        }
    }

    /**
     * Disconnect from all Modbus devices
     */
    async disconnectAll() {
        for (const deviceId of this.connections.keys()) {
            await this.disconnect(deviceId);
        }
    }

    /**
     * Schedule reconnection attempt
     */
    _scheduleReconnect(deviceId) {
        const deviceInfo = this.connections.get(deviceId);
        if (!deviceInfo) return;

        // Clear existing timer
        if (this.reconnectTimers.has(deviceId)) {
            clearTimeout(this.reconnectTimers.get(deviceId));
        }

        deviceInfo.reconnectAttempts++;
        deviceInfo.metrics.reconnects++;

        this.logger.info(`Scheduling reconnect for Modbus device ${deviceId} in ${this.options.reconnectInterval}ms`, {
            attempt: deviceInfo.reconnectAttempts
        });

        const timer = setTimeout(async () => {
            this.reconnectTimers.delete(deviceId);
            try {
                await this.connect(deviceId);
            } catch (error) {
                // Reconnect will be rescheduled by connect() on failure
            }
        }, this.options.reconnectInterval);

        this.reconnectTimers.set(deviceId, timer);
    }

    /**
     * Read holding registers (4x) - thread-safe
     */
    async readHoldingRegisters(deviceId, address, quantity) {
        return this._read(deviceId, 'readHoldingRegisters', address, quantity);
    }

    /**
     * Read input registers (3x) - thread-safe
     */
    async readInputRegisters(deviceId, address, quantity) {
        return this._read(deviceId, 'readInputRegisters', address, quantity);
    }

    /**
     * Read coils (0x) - thread-safe
     */
    async readCoils(deviceId, address, quantity) {
        return this._read(deviceId, 'readCoils', address, quantity);
    }

    /**
     * Read discrete inputs (1x) - thread-safe
     */
    async readDiscreteInputs(deviceId, address, quantity) {
        return this._read(deviceId, 'readDiscreteInputs', address, quantity);
    }

    /**
     * Generic read function with mutex lock
     */
    async _read(deviceId, method, address, quantity) {
        const deviceInfo = this.connections.get(deviceId);
        if (!deviceInfo) {
            throw new Error(`Modbus device ${deviceId} not found`);
        }

        const mutex = this.mutexes.get(deviceId);
        const release = await mutex.acquire();

        try {
            if (!deviceInfo.connected || !deviceInfo.client) {
                throw new Error(`Modbus device ${deviceId} not connected`);
            }

            const result = await deviceInfo.client[method](address, quantity);
            deviceInfo.metrics.reads++;
            return result;
        } catch (error) {
            deviceInfo.metrics.errors++;
            deviceInfo.lastError = error.message;

            // Check if disconnected
            if (error.message.includes('Port Not Open') ||
                error.message.includes('Timed out') ||
                error.message.includes('ECONNRESET')) {
                const wasConnected = deviceInfo.connected;
                deviceInfo.connected = false;
                if (wasConnected) {
                    // Emit so listeners can react to runtime disconnects.
                    this.emit('disconnected', { deviceId, error, during: method });
                    this.emit('error', { deviceId, error, during: method });
                }
                if (this.options.autoReconnect) {
                    this._scheduleReconnect(deviceId);
                }
            }

            throw error;
        } finally {
            release();
        }
    }

    /**
     * Read based on register type string
     */
    async readByRegisterType(deviceId, registerType, address, quantity) {
        const type = registerType.toLowerCase().replace('x', '');
        
        switch (type) {
            case '0':
            case '0x':
                return this.readCoils(deviceId, address, quantity);
            case '1':
            case '1x':
                return this.readDiscreteInputs(deviceId, address, quantity);
            case '3':
            case '3x':
                return this.readInputRegisters(deviceId, address, quantity);
            case '4':
            case '4x':
                return this.readHoldingRegisters(deviceId, address, quantity);
            default:
                throw new Error(`Unknown register type: ${registerType}`);
        }
    }

    /**
     * Write single holding register
     */
    async writeRegister(deviceId, address, value) {
        const deviceInfo = this.connections.get(deviceId);
        if (!deviceInfo) {
            throw new Error(`Modbus device ${deviceId} not found`);
        }

        const mutex = this.mutexes.get(deviceId);
        const release = await mutex.acquire();

        try {
            if (!deviceInfo.connected || !deviceInfo.client) {
                throw new Error(`Modbus device ${deviceId} not connected`);
            }

            await deviceInfo.client.writeRegister(address, value);
        } finally {
            release();
        }
    }

    /**
     * Write single coil
     */
    async writeCoil(deviceId, address, value) {
        const deviceInfo = this.connections.get(deviceId);
        if (!deviceInfo) {
            throw new Error(`Modbus device ${deviceId} not found`);
        }

        const mutex = this.mutexes.get(deviceId);
        const release = await mutex.acquire();

        try {
            if (!deviceInfo.connected || !deviceInfo.client) {
                throw new Error(`Modbus device ${deviceId} not connected`);
            }

            await deviceInfo.client.writeCoil(address, value);
        } finally {
            release();
        }
    }

    /**
     * Get connection status for all devices
     */
    getStatus() {
        const status = {};
        for (const [deviceId, info] of this.connections) {
            status[deviceId] = {
                connected: info.connected,
                type: info.config.type,
                host: info.config.ip,
                port: info.config.port,
                unitId: info.config.unitId,
                lastError: info.lastError,
                metrics: { ...info.metrics },
            };
        }
        return status;
    }

    /**
     * Check if a specific device is connected
     */
    isConnected(deviceId) {
        const deviceInfo = this.connections.get(deviceId);
        return deviceInfo?.connected || false;
    }

    /**
     * Get list of all configured device IDs
     */
    getDeviceIds() {
        return Array.from(this.connections.keys());
    }
}

module.exports = ModbusConnectionManager;
