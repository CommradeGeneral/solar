/**
 * Alarm Service
 * Handles both Analog and Discrete alarms with anti-chatter and state management
 */

const EventEmitter = require('eventemitter3');
const fs = require('fs');
const path = require('path');
const { getLogger } = require('../utils/Logger');
const {
    convertFromRegisters,
    EquationParser,
    isModbusRegisterType,
    getModbusReadQuantity,
} = require('../utils/DataTypeConverter');
const registry = require('../utils/TagValueRegistry');
const {
    AlarmStateCodes,
    AlarmStateNames,
    AlarmEventType,
    LimitMode,
    checkAlarmCondition,
    AlarmTagState 
} = require('../models/AlarmState');

class AlarmService extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            scanInterval: options.scanInterval || 500,
            consecutiveTrueCount: options.consecutiveTrueCount || 3,
            consecutiveFalseCount: options.consecutiveFalseCount || 3,
            chatterFilterMs: options.chatterFilterMs || 1000,
            stateFilePath: options.stateFilePath || './data/last_alarm_states.json',
            batchSize: options.batchSize || 50,
        };

        this.logger = getLogger().getServiceLogger('AlarmService');
        this.equationParser = new EquationParser();
        
        // Dependencies (injected)
        this.db = null;
        this.iec104Manager = null;
        this.modbusManager = null;

        // Alarm tags configuration
        this.analogTags = new Map();    // tag_id -> tag config
        this.discreteTags = new Map();  // tag_id -> tag config
        
        // Runtime states
        this.alarmStates = new Map();   // "type:id" -> AlarmTagState

        // Service state
        this.isRunning = false;
        this.scanTimer = null;
        
        // Metrics
        this.metrics = {
            scans: 0,
            reads: 0,
            errors: 0,
            alarmsTriggered: 0,
            alarmsEnded: 0,
        };

        // Reading buffer (deque-like)
        this.readingBuffer = [];
        this.maxBufferSize = options.bufferSize || 1000;
    }

    /**
     * Initialize the alarm service
     */
    async initialize(db, iec104Manager, modbusManager) {
        this.db = db;
        this.iec104Manager = iec104Manager;
        this.modbusManager = modbusManager;

        this.logger.info('Initializing Alarm Service...');
       
        // Load alarm tags from database
        await this.loadAlarmTags();

        // Load last saved states
        this.loadLastStates();

        this.logger.info('Alarm Service initialized', {
            analogTags: this.analogTags.size,
            discreteTags: this.discreteTags.size,
            savedStates: this.alarmStates.size,
        });
    }

    /**
     * Load alarm tags from database
     */
    async loadAlarmTags() {
        
        try {
            // Load Analog Alarm Tags
            const analogResult = await this.db.execute('sp_GetActiveAnalogAlarmTags');
            this.analogTags.clear();
            console.log(analogResult.recordset);
            for (const row of analogResult.recordset) {
                this.analogTags.set(row.id, {
                    ...row,
                    consecutiveTrueCount: row.consecutive_true_count || this.options.consecutiveTrueCount,
                    consecutiveFalseCount: row.consecutive_false_count || this.options.consecutiveFalseCount,
                    chatterFilterMs: row.chatter_filter_ms || this.options.chatterFilterMs,
                });

                // Initialize state if not exists
                const stateKey = `analog:${row.id}`;
                if (!this.alarmStates.has(stateKey)) {
                    this.alarmStates.set(stateKey, new AlarmTagState(row.id, 'analog'));
                }
            }

            // Load Discrete Alarm Tags
            const discreteResult = await this.db.execute('sp_GetActiveDiscreteAlarmTags');
            this.discreteTags.clear();
            for (const row of discreteResult.recordset) {
                this.discreteTags.set(row.id, {
                    ...row,
                    consecutiveTrueCount: row.consecutive_true_count || this.options.consecutiveTrueCount,
                    consecutiveFalseCount: row.consecutive_false_count || this.options.consecutiveFalseCount,
                    chatterFilterMs: row.chatter_filter_ms || this.options.chatterFilterMs,
                });

                const stateKey = `discrete:${row.id}`;
                if (!this.alarmStates.has(stateKey)) {
                    this.alarmStates.set(stateKey, new AlarmTagState(row.id, 'discrete'));
                }
            }

            // Register IEC104 common (ASDU) addresses so the connection manager
            // interrogates them. Done after both maps are built.
            this._registerIec104Addresses();

            this.logger.info('Alarm tags loaded from database', {
                analog: this.analogTags.size,
                discrete: this.discreteTags.size,
            });
        } catch (error) {
            this.logger.error('Failed to load alarm tags', { error: error.message });
            throw error;
        }
    }

    /**
     * Register the ASDU (common) addresses used by IEC104 tags with the
     * connection manager, so General Interrogation targets them.
     */
    _registerIec104Addresses() {
        if (!this.iec104Manager) return;
        const register = (tag) => {
            if (tag.protocol_type === 'iec104' && tag.iec104_device_id != null && tag.iec104_asdu_address != null) {
                this.iec104Manager.addCommonAddress(tag.iec104_device_id, tag.iec104_asdu_address);
            }
        };
        for (const tag of this.analogTags.values()) register(tag);
        for (const tag of this.discreteTags.values()) register(tag);
    }

    /**
     * Reload alarm configuration (hot reload)
     */
    async reloadConfiguration() {
        this.logger.info('Reloading alarm configuration...');
        
        // Save current states before reload
        this.saveLastStates();
        
        // Reload tags
        await this.loadAlarmTags();
        
        // Reset consecutive counters for all states
        for (const state of this.alarmStates.values()) {
            state.resetCounters();
        }

        this.emit('configReloaded');
        this.logger.info('Alarm configuration reloaded');
    }

    /**
     * Start the alarm service
     */
    start() {
        if (this.isRunning) {
            this.logger.warn('Alarm Service already running');
            return;
        }

        this.isRunning = true;
        this.logger.info('Starting Alarm Service', { scanInterval: this.options.scanInterval });

        this._scheduleScan();
        this.emit('started');
    }

    /**
     * Stop the alarm service
     */
    async stop() {
        if (!this.isRunning) return;

        this.isRunning = false;
        
        if (this.scanTimer) {
            clearTimeout(this.scanTimer);
            this.scanTimer = null;
        }

        // Save states before stopping
        this.saveLastStates();

        this.logger.info('Alarm Service stopped');
        this.emit('stopped');
    }

    /**
     * Schedule next scan
     */
    _scheduleScan() {
        if (!this.isRunning) return;

        this.scanTimer = setTimeout(async () => {
            try {
                await this._scanAlarms();
            } catch (error) {
                this.logger.error('Scan error', { error: error.message });
                this.metrics.errors++;
            }
            this._scheduleScan();
        }, this.options.scanInterval);
    }

    /**
     * Main scan loop
     */
    async _scanAlarms() {
        this.metrics.scans++;
        const startTime = Date.now();

        // Group tags by IEC104/Modbus device for efficient reading
        const iec104Reads = this._groupTagsByIec104();
        const modbusReads = this._groupTagsByModbus();

        // Read from IEC104 devices (cached values)
        for (const [deviceId, tags] of iec104Reads) {
            try {
                this._readIec104Tags(deviceId, tags);
            } catch (error) {
                this.logger.warn(`Failed to read from IEC104 ${deviceId}`, { error: error.message });
            }
        }

        // Read from Modbus devices
        for (const [deviceId, tags] of modbusReads) {
            try {
                await this._readModbusTags(deviceId, tags);
            } catch (error) {
                this.logger.warn(`Failed to read from Modbus ${deviceId}`, { error: error.message });
            }
        }

        // Process buffered readings
        await this._processReadings();

        const elapsed = Date.now() - startTime;
        if (elapsed > this.options.scanInterval * 0.8) {
            this.logger.warn('Scan taking too long', { elapsed, interval: this.options.scanInterval });
        }
    }

    /**
     * Group tags by IEC104 device ID
     */
    _groupTagsByIec104() {
        const groups = new Map();

        const addTag = (tag, type) => {
            if (tag.protocol_type !== 'iec104' || !tag.iec104_device_id) return;

            if (!groups.has(tag.iec104_device_id)) {
                groups.set(tag.iec104_device_id, []);
            }
            groups.get(tag.iec104_device_id).push({ ...tag, alarmType: type });
        };

        for (const tag of this.analogTags.values()) {
            addTag(tag, 'analog');
        }
        for (const tag of this.discreteTags.values()) {
            addTag(tag, 'discrete');
        }

        return groups;
    }

    /**
     * Group tags by Modbus device ID
     */
    _groupTagsByModbus() {
        const groups = new Map();

        const addTag = (tag, type) => {
            if (tag.protocol_type !== 'modbus' || !tag.modbus_device_id) return;
            
            if (!groups.has(tag.modbus_device_id)) {
                groups.set(tag.modbus_device_id, []);
            }
            groups.get(tag.modbus_device_id).push({ ...tag, alarmType: type });
        };

        for (const tag of this.analogTags.values()) {
            addTag(tag, 'analog');
        }
        for (const tag of this.discreteTags.values()) {
            addTag(tag, 'discrete');
        }

        return groups;
    }

    /**
     * Read tags from an IEC104 device (from the live value cache).
     */
    _readIec104Tags(deviceId, tags) {
        if (!this.iec104Manager.isConnected(deviceId)) {
            return;
        }

        for (const tag of tags) {
            try {
                const rawValue = this.iec104Manager.readPoint(
                    deviceId,
                    tag.iec104_asdu_address,
                    tag.iec104_ioa
                );

                // Not received yet — skip until the point arrives.
                if (rawValue === null || rawValue === undefined) continue;

                const processedValue = tag.equation
                    ? this.equationParser.apply(tag.equation, rawValue)
                    : rawValue;

                this._bufferReading(tag, rawValue, processedValue);
                this.metrics.reads++;
            } catch (tagError) {
                this.logger.debug(`Error reading IEC104 tag ${tag.tag_name}`, { error: tagError.message });
            }
        }
    }

    /**
     * Read tags from a Modbus device
     */
    async _readModbusTags(deviceId, tags) {
        if (!this.modbusManager.isConnected(deviceId)) {
            return;
        }

        for (const tag of tags) {
            try {
                // Bit-level addressing (e.g. 281.12 -> register 281, bit 12) only
                // applies to 16-bit register types (3x/4x). Coils/discrete are already bits.
                const bit = (tag.bit_offset != null && tag.bit_offset !== '')
                    ? Number(tag.bit_offset)
                    : null;
                const useBit = bit != null && Number.isFinite(bit) && isModbusRegisterType(tag.register_type);

                const quantity = getModbusReadQuantity(
                    tag.data_type,
                    tag.register_count,
                    useBit ? bit : null
                );

                const result = await this.modbusManager.readByRegisterType(
                    deviceId,
                    tag.register_type,
                    tag.modbus_address,
                    quantity
                );

                const rawValue = convertFromRegisters(result, tag.data_type, quantity, {
                    wordOrder: tag.word_order,
                    bitOffset: useBit ? bit : null,
                });
                const processedValue = tag.equation
                    ? this.equationParser.apply(tag.equation, rawValue)
                    : rawValue;

                this._bufferReading(tag, rawValue, processedValue);
                this.metrics.reads++;
            } catch (error) {
                this.logger.debug(`Error reading Modbus tag ${tag.tag_name}`, { error: error.message });
            }
        }
    }

    /**
     * Buffer a reading for processing
     */
    _bufferReading(tag, rawValue, processedValue) {
        // Publish the latest value so internal/calc tags can reference it by name.
        registry.set(tag.tag_name, processedValue);

        if (this.readingBuffer.length >= this.maxBufferSize) {
            this.readingBuffer.shift(); // Remove oldest
        }

        this.readingBuffer.push({
            tag,
            rawValue,
            processedValue,
            timestamp: new Date(),
        });
    }

    /**
     * Process buffered readings
     */
    async _processReadings() {
        const readings = [...this.readingBuffer];
        this.readingBuffer = [];

        const triggeredAlarms = [];
        const endedAlarms = [];

        for (const reading of readings) {
            const { tag, rawValue, processedValue, timestamp } = reading;
            const stateKey = `${tag.alarmType}:${tag.id}`;
            const state = this.alarmStates.get(stateKey);

            if (!state) continue;

            state.currentValue = processedValue;
            state.rawValue = rawValue;
            state.lastReadAt = timestamp;

            // Check alarm condition
            let isAlarmCondition;
            if (tag.alarmType === 'analog') {
                isAlarmCondition = checkAlarmCondition(
                    processedValue,
                    tag.limit_value,
                    tag.limit_mode
                );
            } else {
                // Discrete alarm
                isAlarmCondition = tag.limit_mode === 'High' 
                    ? Boolean(processedValue)
                    : !Boolean(processedValue);
            }

            // Update consecutive counters
            if (isAlarmCondition) {
                state.consecutiveTrueCount++;
                state.consecutiveFalseCount = 0;
            } else {
                state.consecutiveFalseCount++;
                state.consecutiveTrueCount = 0;
            }

            // Check for state transitions
            const wasActive = state.isActive();
            
            // Trigger alarm if consecutive true count reached
            if (!wasActive && 
                state.consecutiveTrueCount >= tag.consecutiveTrueCount &&
                state.canChangeState(tag.chatterFilterMs)) {
                
                triggeredAlarms.push({ tag, state, value: processedValue });
            }
            
            // End alarm if consecutive false count reached
            if (wasActive && 
                state.consecutiveFalseCount >= tag.consecutiveFalseCount &&
                state.canChangeState(tag.chatterFilterMs)) {
                
                endedAlarms.push({ tag, state, value: processedValue });
            }
        }

        // Process triggered alarms
        for (const { tag, state, value } of triggeredAlarms) {
            await this._triggerAlarm(tag, state, value);
        }

        // Process ended alarms
        for (const { tag, state, value } of endedAlarms) {
            await this._endAlarm(tag, state, value);
        }
    }

    /**
     * Trigger an alarm
     */
    async _triggerAlarm(tag, state, value) {
        try {
            const result = await this.db.execute('sp_TriggerAlarm', {
                alarm_type: tag.alarmType,
                tag_id: tag.id,
                tag_name: tag.tag_name,
                alarm_class: tag.alarm_class,
                alarm_number: tag.alarm_number,
                alarm_text: tag.alarm_text,
                alarm_severity: tag.alarm_type || 'alarm',
                trigger_value: value,
                limit_value: tag.limit_value,
                limit_mode: tag.limit_mode,
                additional_text1: tag.additional_text1,
                additional_text2: tag.additional_text2,
            });

            const historyId = result.recordset[0]?.alarm_history_id;
            state.trigger(value, historyId);

            this.metrics.alarmsTriggered++;
            this.logger.info(`Alarm TRIGGERED: ${tag.tag_name}`, {
                value,
                limit: tag.limit_value,
                historyId,
            });

            this.emit('alarmTriggered', {
                tagId: tag.id,
                tagName: tag.tag_name,
                alarmType: tag.alarmType,
                value,
                state: state.toJSON(),
            });
        } catch (error) {
            this.logger.error(`Failed to trigger alarm ${tag.tag_name}`, { error: error.message });
        }
    }

    /**
     * End an alarm
     */
    async _endAlarm(tag, state, value) {
        try {
            await this.db.execute('sp_EndAlarm', {
                alarm_type: tag.alarmType,
                tag_id: tag.id,
                tag_name: tag.tag_name,
                end_value: value,
            });

            state.end(value);

            this.metrics.alarmsEnded++;
            this.logger.info(`Alarm ENDED: ${tag.tag_name}`, { value });

            this.emit('alarmEnded', {
                tagId: tag.id,
                tagName: tag.tag_name,
                alarmType: tag.alarmType,
                value,
                state: state.toJSON(),
            });
        } catch (error) {
            this.logger.error(`Failed to end alarm ${tag.tag_name}`, { error: error.message });
        }
    }

    /**
     * Acknowledge an alarm
     */
    async acknowledgeAlarm(alarmType, tagId, user) {
        const stateKey = `${alarmType}:${tagId}`;
        const state = this.alarmStates.get(stateKey);

        if (!state || !state.needsAcknowledgment()) {
            return false;
        }

        try {
            const tag = alarmType === 'analog' 
                ? this.analogTags.get(tagId)
                : this.discreteTags.get(tagId);

            await this.db.execute('sp_AcknowledgeAlarm', {
                alarm_type: alarmType,
                tag_id: tagId,
                acknowledged_by: user,
            });

            state.acknowledge(user);

            this.logger.info(`Alarm ACKNOWLEDGED: ${tag?.tag_name || tagId}`, { user });

            this.emit('alarmAcknowledged', {
                tagId,
                alarmType,
                user,
                state: state.toJSON(),
            });

            return true;
        } catch (error) {
            this.logger.error(`Failed to acknowledge alarm`, { error: error.message });
            throw error;
        }
    }

    /**
     * Get data type size in bytes
     */
    _getDataTypeSize(dataType) {
        const type = dataType?.toLowerCase() || 'int';
        const sizes = {
            'bool': 1, 'byte': 1, 'sint': 1, 'usint': 1,
            'int': 2, 'uint': 2, 'word': 2,
            'dint': 4, 'udint': 4, 'dword': 4, 'real': 4, 'float': 4,
            'lreal': 8, 'double': 8,
        };
        return sizes[type] || 2;
    }

    /**
     * Save alarm states to file
     */
    saveLastStates() {
        try {
            const dir = path.dirname(this.options.stateFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const states = {};
            for (const [key, state] of this.alarmStates) {
                states[key] = state.toJSON();
            }

            fs.writeFileSync(
                this.options.stateFilePath,
                JSON.stringify(states, null, 2)
            );

            this.logger.debug('Alarm states saved to file');
        } catch (error) {
            this.logger.error('Failed to save alarm states', { error: error.message });
        }
    }

    /**
     * Load alarm states from file
     */
    loadLastStates() {
        try {
            if (!fs.existsSync(this.options.stateFilePath)) {
                return;
            }

            const content = fs.readFileSync(this.options.stateFilePath, 'utf-8');
            const states = JSON.parse(content);

            for (const [key, data] of Object.entries(states)) {
                const state = AlarmTagState.fromJSON(data);
                this.alarmStates.set(key, state);
            }

            this.logger.info('Loaded alarm states from file', { count: Object.keys(states).length });
        } catch (error) {
            this.logger.warn('Failed to load alarm states', { error: error.message });
        }
    }

    /**
     * Get all active alarms
     */
    getActiveAlarms() {
        const active = [];
        console.log(this.alarmStates)
        for (const [key, state] of this.alarmStates) {
            if (state.isActive() || state.stateCode === AlarmStateCodes.INACTIVE_ACK) {
                const [type, id] = key.split(':');
                const tag = type === 'analog' 
                    ? this.analogTags.get(parseInt(id))
                    : this.discreteTags.get(parseInt(id));
                
                active.push({
                    ...state.toJSON(),
                    tag: tag ? {
                        id: tag.id,
                        name: tag.tag_name,
                        class: tag.alarm_class,
                        text: tag.alarm_text,
                        severity: tag.alarm_type,
                    } : null,
                });
            }
        }
        return active;
    }

    /**
     * Get current metrics
     */
    getMetrics() {
        return { ...this.metrics };
    }
}

module.exports = AlarmService;
