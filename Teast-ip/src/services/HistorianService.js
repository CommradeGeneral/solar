/**
 * Historian Service
 * Records tag values to database at configured intervals
 * Supports deadband (exception-based) recording
 */

const EventEmitter = require('eventemitter3');
const sql = require('mssql/msnodesqlv8');
const { getLogger } = require('../utils/Logger');
const {
    convertFromRegisters,
    EquationParser,
    isModbusRegisterType,
    getModbusReadQuantity,
} = require('../utils/DataTypeConverter');
const registry = require('../utils/TagValueRegistry');
const { evaluateCalc, referencedTokens } = require('../utils/CalcEngine');

// OPC quality: 192 = Good, 0 = Bad. Used to mark "no data / device disconnected".
const QUALITY_BAD = 0;

/**
 * Determine if a value should be recorded based on deadband logic.
 * Operates on processedValue (after equation) because that's what the user sees.
 *
 * @param {number} currentValue - The new processed value
 * @param {number|null} lastStoredValue - The last value that was stored (null = first read)
 * @param {number} deadband - The ± threshold (0 = always record)
 * @returns {boolean}
 */
function shouldRecordByDeadband(currentValue, lastStoredValue, deadband) {
    // First reading ever — always record as baseline
    if (lastStoredValue === null || lastStoredValue === undefined) {
        return true;
    }
    // No deadband configured — always record
    if (!deadband || deadband <= 0) {
        return true;
    }
    if (!Number.isFinite(currentValue) || !Number.isFinite(lastStoredValue)) {
        return false;
    }
    // Check if the change exceeds deadband
    return Math.abs(currentValue - lastStoredValue) > deadband;
}

class HistorianService extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            batchSize: options.batchSize || 100,
            flushInterval: options.flushInterval || 5000,
            bufferSize: options.bufferSize || 10000,
            defaultQuality: options.defaultQuality || 192, // OPC Good
            // When DB is down for a long time, avoid a tight fail-loop on every flushInterval.
            flushBackoffMaxMs: options.flushBackoffMaxMs || 300000, // 5 min
        };

        this.logger = getLogger().getServiceLogger('HistorianService');
        this.equationParser = new EquationParser();
        
        // Dependencies (injected)
        this.db = null;
        this.iec104Manager = null;
        this.modbusManager = null;

        // Historian tags configuration
        this.tags = new Map(); // tag_id -> tag config
        this.tagsByName = new Map(); // tag_name -> tag config
        
        // Group tags by reading cycle (normal periodic recording)
        // cycle_ms -> { normalTags: Tag[], deadbandBaselineTags: Tag[] }
        // normalTags are read+recorded on cycle boundary.
        // deadbandBaselineTags are read via deadband timer, but still get a baseline record on cycle boundary
        // using the latest sampled value (no extra device read).
        this.cycleGroups = new Map();
        this.cycleTimers = new Map(); // cycle_ms -> timer

        // Deadband: group tags by fast check cycle
        this.deadbandGroups = new Map(); // check_cycle_ms -> [tags with deadband]
        this.deadbandTimers = new Map(); // check_cycle_ms -> timer

        // Deadband state: track last stored value per tag for deadband comparison
        // Key: tag_id, Value: { lastStoredValue, lastStoredAt }
        this.deadbandState = new Map();

        // Latest sampled values for tags (updated on every read, even if not recorded)
        // Key: tag_id, Value: { rawValue, processedValue, sampledAt }
        this.latestValues = new Map();

        // Epoch used for cycle-boundary scheduling (relative to server start)
        this._cycleEpochMs = null;

        // Backpressure (avoid burning CPU / dropping tons of data when DB is down)
        this._bufferHighWatermark = Math.floor(this.options.bufferSize * 0.95);
        this._lastBackpressureWarnAt = 0;

        // Data buffer
        this.dataBuffer = [];
        this.flushTimer = null;
        this._flushBackoffMs = this.options.flushInterval;
        this._nextFlushAllowedAt = 0;
        this._lastFlushWarnAt = 0;
        this._flushInProgress = false;

        // Service state
        this.isRunning = false;
        
        // Metrics
        this.metrics = {
            reads: 0,
            writes: 0,
            errors: 0,
            bufferedRecords: 0,
            deadbandSkipped: 0,
            deadbandRecorded: 0,
        };
    }

    /**
     * Initialize the historian service
     */
    async initialize(db, iec104Manager, modbusManager) {
        this.db = db;
        this.iec104Manager = iec104Manager;
        this.modbusManager = modbusManager;

        this.logger.info('Initializing Historian Service...');

        // Load historian tags from database
        await this.loadHistorianTags();

        this.logger.info('Historian Service initialized', {
            tags: this.tags.size,
            cycles: this.cycleGroups.size,
            deadbandGroups: this.deadbandGroups.size,
        });
    }

    /**
     * Load historian tags from database
     */
    async loadHistorianTags() {
        try {
            const result = await this.db.execute('sp_GetActiveHistorianTags');
            const recordset = Array.isArray(result?.recordset) ? result.recordset : [];

            // Defensive fallback: if the stored procedure is stale (missing new columns),
            // patch deadband fields from HistorianTags so runtime behavior still works.
            if (recordset.length > 0) {
                const first = recordset[0];
                const missingDeadbandColumns =
                    !Object.prototype.hasOwnProperty.call(first, 'deadband') ||
                    !Object.prototype.hasOwnProperty.call(first, 'deadband_check_cycle_s');

                if (missingDeadbandColumns) {
                    try {
                        const extras = await this.db.query(
                            'SELECT tag_id, deadband, deadband_check_cycle_s FROM dbo.HistorianTags WHERE is_enabled = 1'
                        );
                        const extraMap = new Map((extras?.recordset || []).map((r) => [r.tag_id, r]));
                        let patchedRows = 0;

                        for (const row of recordset) {
                            const ex = extraMap.get(row.tag_id);
                            if (!ex) continue;
                            if (row.deadband == null) row.deadband = ex.deadband;
                            if (row.deadband_check_cycle_s == null) row.deadband_check_cycle_s = ex.deadband_check_cycle_s;
                            patchedRows++;
                        }

                        this.logger.warn(
                            'sp_GetActiveHistorianTags missing deadband columns; patched from dbo.HistorianTags. Re-apply database/02_stored_procedures.sql to fix permanently.',
                            { patchedRows }
                        );
                    } catch (e) {
                        this.logger.error('Failed to patch deadband columns from dbo.HistorianTags', {
                            error: e?.message,
                        });
                    }
                }
            }
            
            this.tags.clear();
            this.tagsByName.clear();
            this.cycleGroups.clear();
            this.deadbandGroups.clear();
            this.deadbandState.clear();
            this.latestValues.clear();

            for (const row of recordset) {
                // Normalize for runtime comparisons (DB may return different casing / whitespace)
                row.protocol_type = (row.protocol_type || '').toString().trim().toLowerCase();
                row.iec104_device_id = row.iec104_device_id != null ? row.iec104_device_id.toString().trim() : row.iec104_device_id;
                row.modbus_device_id = row.modbus_device_id != null ? row.modbus_device_id.toString().trim() : row.modbus_device_id;
                if (row.reading_cycle_ms != null) row.reading_cycle_ms = Number(row.reading_cycle_ms);
                if (row.deadband != null) row.deadband = Number(row.deadband);
                if (row.deadband_check_cycle_s != null) row.deadband_check_cycle_s = Number(row.deadband_check_cycle_s);

                this.tags.set(row.tag_id, row);
                if (row.tag_name) {
                    this.tagsByName.set(String(row.tag_name), row);
                }

                const deadband = row.deadband || 0;
                const checkCycleS = row.deadband_check_cycle_s || 0;
                const hasDeadband = deadband > 0;
                const hasDeadbandCheck = hasDeadband && checkCycleS > 0;

                // Always attach the tag to its reading_cycle group so baselines are synchronized.
                // If the tag also has deadband_check_cycle_s, we will NOT re-read it at baseline time;
                // we will record baseline from latestValues instead.
                const cycleMs = row.reading_cycle_ms || 60000;
                if (!this.cycleGroups.has(cycleMs)) {
                    this.cycleGroups.set(cycleMs, { normalTags: [], deadbandBaselineTags: [] });
                }
                const group = this.cycleGroups.get(cycleMs);
                if (hasDeadbandCheck) {
                    group.deadbandBaselineTags.push(row);
                } else {
                    group.normalTags.push(row);
                }

                if (hasDeadband) {
                    // Initialize state for any deadband-enabled tag.
                    if (!this.deadbandState.has(row.tag_id)) {
                        this.deadbandState.set(row.tag_id, {
                            lastStoredValue: null,
                            lastStoredAt: null,
                        });
                    }
                }

                if (hasDeadbandCheck) {
                    const checkCycleMs = Math.max(Math.round(checkCycleS * 1000), 1000);
                    if (!this.deadbandGroups.has(checkCycleMs)) {
                        this.deadbandGroups.set(checkCycleMs, []);
                    }
                    this.deadbandGroups.get(checkCycleMs).push(row);
                }
            }

            // Register IEC104 common (ASDU) addresses for General Interrogation.
            if (this.iec104Manager) {
                for (const tag of this.tags.values()) {
                    if (tag.protocol_type === 'iec104' && tag.iec104_device_id != null && tag.iec104_asdu_address != null) {
                        this.iec104Manager.addCommonAddress(tag.iec104_device_id, tag.iec104_asdu_address);
                    }
                }
            }

            this.logger.info('Historian tags loaded', {
                total: this.tags.size,
                cycles: Array.from(this.cycleGroups.keys()),
                deadbandCycles: Array.from(this.deadbandGroups.keys()),
                deadbandTags: this.deadbandState.size,
            });
        } catch (error) {
            this.logger.error('Failed to load historian tags', { error: error.message });
            throw error;
        }
    }

    /**
     * Debug-only: expose internal grouping to API status for troubleshooting.
     */
    getDebugStatus() {
        const cycleGroups = [];
        for (const [cycleMs, group] of this.cycleGroups.entries()) {
            cycleGroups.push({
                cycleMs,
                readTags: group?.normalTags?.length || 0,
                baselineFromDeadbandTags: group?.deadbandBaselineTags?.length || 0,
            });
        }

        const deadbandGroups = [];
        for (const [checkMs, tags] of this.deadbandGroups.entries()) {
            deadbandGroups.push({ checkMs, tags: tags?.length || 0 });
        }

        return {
            totalTags: this.tags.size,
            cycleGroups,
            deadbandGroups,
            epochMs: this._cycleEpochMs,
            latestValuesCount: this.latestValues.size,
        };
    }

    /**
     * Reload configuration (hot reload)
     */
    async reloadConfiguration() {
        this.logger.info('Reloading historian configuration...');
        
        // Stop current timers
        this._stopCycleTimers();
        this._stopDeadbandTimers();
        
        // Flush any buffered data
        await this._flushBuffer();
        
        // Reload tags
        await this.loadHistorianTags();
        
        // Restart if was running
        if (this.isRunning) {
            this._startCycleTimers();
            this._startDeadbandTimers();
        }

        this.emit('configReloaded');
        this.logger.info('Historian configuration reloaded');
    }

    /**
     * Start the historian service
     */
    start() {
        if (this.isRunning) {
            this.logger.warn('Historian Service already running');
            return;
        }

        this.isRunning = true;
        this.logger.info('Starting Historian Service');
        if (this._cycleEpochMs === null) {
            this._cycleEpochMs = Date.now();
        }

        // Start cycle timers for each group
        this._startCycleTimers();

        // Start deadband fast-check timers
        this._startDeadbandTimers();

        // Start flush timer
        this._startFlushTimer();

        this.emit('started');
    }

    /**
     * Stop the historian service
     */
    async stop() {
        if (!this.isRunning) return;

        this.isRunning = false;
        
        // Stop all timers
        this._stopCycleTimers();
        this._stopDeadbandTimers();
        this._stopFlushTimer();

        // Flush remaining data
        await this._flushBuffer();

        this.logger.info('Historian Service stopped');
        this.emit('stopped');
    }

    // =========================================================
    // Normal reading cycle timers
    // =========================================================

    /**
     * Start timers for each reading cycle
     */
    _startCycleTimers() {
        for (const [cycleMs, group] of this.cycleGroups) {
            const normalCount = group?.normalTags?.length || 0;
            const deadbandBaselineCount = group?.deadbandBaselineTags?.length || 0;
            this.logger.info(
                `Starting cycle timer: ${cycleMs}ms (read=${normalCount}, baselineFromDeadband=${deadbandBaselineCount})`
            );

            const scheduleNext = () => {
                if (!this.isRunning) return;
                const epoch = this._cycleEpochMs ?? Date.now();
                const now = Date.now();
                const elapsed = Math.max(0, now - epoch);
                const delay = cycleMs - (elapsed % cycleMs || 0);
                const t = setTimeout(run, delay);
                this.cycleTimers.set(cycleMs, t);
            };

            const run = async () => {
                const tickTs = new Date();
                try {
                    if (normalCount > 0) {
                        await this._readCycleGroup(cycleMs, group.normalTags, false, tickTs);
                    }
                    if (deadbandBaselineCount > 0) {
                        this._recordDeadbandBaselines(group.deadbandBaselineTags, tickTs);
                    }
                } finally {
                    if (!this.isRunning) return;
                    scheduleNext();
                }
            };

            scheduleNext(); // first tick happens at epoch + N*cycleMs (synchronized)
        }
    }

    /**
     * Stop all cycle timers
     */
    _stopCycleTimers() {
        for (const timer of this.cycleTimers.values()) {
            clearTimeout(timer);
        }
        this.cycleTimers.clear();
    }

    // =========================================================
    // Deadband fast-check timers
    // =========================================================

    /**
     * Start timers for deadband fast-check cycles
     */
    _startDeadbandTimers() {
        for (const [checkCycleMs, tags] of this.deadbandGroups) {
            this.logger.info(`Starting deadband check timer: ${checkCycleMs}ms for ${tags.length} tags`);

            const run = async () => {
                try {
                    await this._readCycleGroup(checkCycleMs, tags, true);
                } finally {
                    if (!this.isRunning) return;
                    const nextTimer = setTimeout(run, checkCycleMs);
                    this.deadbandTimers.set(checkCycleMs, nextTimer);
                }
            };

            const timer = setTimeout(run, 0);
            this.deadbandTimers.set(checkCycleMs, timer);
        }
    }

    /**
     * Stop all deadband timers
     */
    _stopDeadbandTimers() {
        for (const timer of this.deadbandTimers.values()) {
            clearTimeout(timer);
        }
        this.deadbandTimers.clear();
    }

    /**
     * Record baseline points (reading_cycle) for tags that are read via deadband timer.
     * Uses latestValues to avoid an extra device read at the cycle boundary.
     */
    _recordDeadbandBaselines(tags, timestamp) {
        if (!tags || tags.length === 0) return;

        for (const tag of tags) {
            // Device disconnected → record an explicit NULL (Bad) point instead of
            // re-writing the stale cached value.
            if (!this._isTagDeviceConnected(tag)) {
                this._bufferNullRecord(tag, timestamp);
                const offState = this.deadbandState.get(tag.tag_id);
                if (offState) {
                    offState.lastStoredValue = null; // force record of the first value after reconnect
                    offState.lastStoredAt = timestamp;
                }
                continue;
            }

            const latest = this.latestValues.get(tag.tag_id);
            if (!latest) continue;
            if (!Number.isFinite(latest.processedValue)) continue;

            this._bufferRecord(tag, latest.rawValue, latest.processedValue, timestamp);

            const state = this.deadbandState.get(tag.tag_id);
            if (state) {
                state.lastStoredValue = latest.processedValue;
                state.lastStoredAt = timestamp;
            }
        }
    }

    // =========================================================
    // Flush timer
    // =========================================================

    /**
     * Start flush timer
     */
    _startFlushTimer() {
        this.flushTimer = setInterval(async () => {
            if (this._nextFlushAllowedAt && Date.now() < this._nextFlushAllowedAt) {
                return;
            }
            if (this.dataBuffer.length > 0) {
                this._requestFlush();
            }
        }, this.options.flushInterval);
    }

    /**
     * Trigger a flush if one is not already in progress.
     * Keeps read loops responsive under high-frequency logging rates.
     */
    _requestFlush() {
        if (this._flushInProgress) return;
        if (this._nextFlushAllowedAt && Date.now() < this._nextFlushAllowedAt) return;

        this._flushInProgress = true;
        void this._flushBuffer().finally(() => {
            this._flushInProgress = false;
        });
    }

    /**
     * Stop flush timer
     */
    _stopFlushTimer() {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
    }

    // =========================================================
    // Reading logic
    // =========================================================

    /**
     * Read tags for a specific cycle group
     * @param {number} cycleMs - The cycle interval in ms
     * @param {Array} tags - Tags to read
     * @param {boolean} isDeadbandCheck - If true, apply deadband filtering before buffering
     */
    async _readCycleGroup(cycleMs, tags, isDeadbandCheck, timestampOverride = null) {
        const timestamp = timestampOverride || new Date();

        // Backpressure: if buffer is nearly full (typically due to DB down),
        // skip reads to avoid continuous churn and data loss.
        if (this.dataBuffer.length >= this._bufferHighWatermark) {
            const now = Date.now();
            if (now - this._lastBackpressureWarnAt > 60000) {
                this._lastBackpressureWarnAt = now;
                this.logger.warn('Historian backpressure: buffer near full, skipping reads', {
                    buffered: this.dataBuffer.length,
                    bufferSize: this.options.bufferSize,
                    cycleMs,
                    isDeadbandCheck,
                });
            }
            return;
        }

        // Group by protocol / device
        const iec104Tags = new Map();
        const modbusTags = new Map();
        const internalTags = [];

        for (const tag of tags) {
            if (tag.protocol_type === 'iec104' && tag.iec104_device_id) {
                if (!iec104Tags.has(tag.iec104_device_id)) {
                    iec104Tags.set(tag.iec104_device_id, []);
                }
                iec104Tags.get(tag.iec104_device_id).push(tag);
            } else if (tag.protocol_type === 'modbus' && tag.modbus_device_id) {
                if (!modbusTags.has(tag.modbus_device_id)) {
                    modbusTags.set(tag.modbus_device_id, []);
                }
                modbusTags.get(tag.modbus_device_id).push(tag);
            } else if (tag.protocol_type === 'internal' || tag.protocol_type === 'calc') {
                internalTags.push(tag);
            }
        }

        // Read from IEC104 devices (cached values)
        for (const [deviceId, iecTagList] of iec104Tags) {
            this._readIec104Tags(deviceId, iecTagList, timestamp, isDeadbandCheck);
        }

        // Read from Modbus devices
        for (const [deviceId, modbusTagList] of modbusTags) {
            await this._readModbusTags(deviceId, modbusTagList, timestamp, isDeadbandCheck);
        }

        // Compute internal/calc tags last (after device values are published this cycle)
        if (internalTags.length > 0) {
            this._readInternalTags(internalTags, timestamp, isDeadbandCheck);
        }

        // Check if buffer needs flushing
        if (this.dataBuffer.length >= this.options.batchSize) {
            this._requestFlush();
        }
    }

    /**
     * Read tags from an IEC104 device (from the live value cache).
     */
    _readIec104Tags(deviceId, tags, timestamp, isDeadbandCheck) {
        if (!this.iec104Manager.isConnected(deviceId)) {
            // Device down: record an explicit NULL on the reading cycle.
            if (!isDeadbandCheck) {
                for (const tag of tags) this._bufferNullRecord(tag, timestamp);
            }
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

                this._handleReading(tag, rawValue, processedValue, timestamp, isDeadbandCheck);
                this.metrics.reads++;
            } catch (tagError) {
                this.logger.debug(`Error reading IEC104 tag ${tag.tag_name}`, { error: tagError.message });
            }
        }
    }

    /**
     * Compute internal "calc" tags from other tags' latest values.
     * e.g. actual-power = INV003_InverterRunningStopped * INV003_PowerFactor
     */
    _readInternalTags(tags, timestamp, isDeadbandCheck) {
        for (const tag of tags) {
            try {
                const expr = tag.calc || tag.equation;
                if (!expr) continue;

                const dependencyNames = referencedTokens(expr);
                const fallbackMaxAgeMs = Math.max(Number(tag.reading_cycle_ms) || 0, 5000) * 2;
                const hasStaleDependency = dependencyNames.some((name) => !this._isRegistryValueFresh(name, fallbackMaxAgeMs));
                if (hasStaleDependency) continue;

                const value = evaluateCalc(expr, (name) => registry.get(name));
                // Skip until all referenced source tags are available.
                if (value === null || value === undefined || !Number.isFinite(value)) continue;

                this._handleReading(tag, value, value, timestamp, isDeadbandCheck);
                this.metrics.reads++;
            } catch (calcError) {
                this.logger.debug(`Error computing internal tag ${tag.tag_name}`, { error: calcError.message });
            }
        }
    }

    _isRegistryValueFresh(tagName, fallbackMaxAgeMs = 10000) {
        const entry = registry.getEntry(tagName);
        if (!entry || !Number.isFinite(entry.ts)) return false;

        const sourceTag = this.tagsByName.get(String(tagName));
        const sourceCycleMs = Math.max(Number(sourceTag?.reading_cycle_ms) || 0, 0);
        const sourceDeadbandMs = Math.max(Number(sourceTag?.deadband_check_cycle_s) || 0, 0) * 1000;
        const sourceMaxAgeMs = Math.max(sourceCycleMs, sourceDeadbandMs, fallbackMaxAgeMs, 5000) * 2;

        return (Date.now() - entry.ts) <= sourceMaxAgeMs;
    }

    /**
     * Read tags from a Modbus device
     */
    async _readModbusTags(deviceId, tags, timestamp, isDeadbandCheck) {
        if (!this.modbusManager.isConnected(deviceId)) {
            // Device down: record an explicit NULL on the reading cycle (not on the
            // fast deadband check, to avoid spamming nulls).
            if (!isDeadbandCheck) {
                for (const tag of tags) this._bufferNullRecord(tag, timestamp);
            }
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

                this._handleReading(tag, rawValue, processedValue, timestamp, isDeadbandCheck);
                this.metrics.reads++;
            } catch (error) {
                this.logger.debug(`Error reading Modbus tag ${tag.tag_name}`, { error: error.message });
                this.metrics.errors++;
            }
        }
    }

    // =========================================================
    // Deadband decision + buffering
    // =========================================================

    /**
     * Handle a reading — decide whether to buffer it based on deadband or normal cycle
     */
    _handleReading(tag, rawValue, processedValue, timestamp, isDeadbandCheck) {
        // Guard: skip invalid values (null/undefined/NaN/Infinity and non-numeric types)
        if (processedValue === null || processedValue === undefined) {
            this.logger.debug(`Skipping invalid value for tag ${tag.tag_name}`, { rawValue, processedValue });
            return;
        }

        // HistorianData.value is FLOAT, so normalize common non-number types.
        if (typeof processedValue === 'boolean') {
            processedValue = processedValue ? 1 : 0;
        } else if (typeof processedValue !== 'number') {
            const n = Number(processedValue);
            if (!Number.isFinite(n)) {
                this.logger.debug(`Skipping non-numeric value for tag ${tag.tag_name}`, { rawValue, processedValue });
                return;
            }
            processedValue = n;
        }

        if (!Number.isFinite(processedValue)) {
            this.logger.debug(`Skipping non-finite value for tag ${tag.tag_name}`, { rawValue, processedValue });
            return;
        }

        // Publish the latest value so internal/calc tags can reference it by name.
        registry.set(tag.tag_name, processedValue);

        // raw_value column is FLOAT nullable; normalize booleans too.
        if (typeof rawValue === 'boolean') {
            rawValue = rawValue ? 1 : 0;
        } else if (rawValue != null && typeof rawValue !== 'number') {
            const rn = Number(rawValue);
            rawValue = Number.isFinite(rn) ? rn : null;
        } else if (typeof rawValue === 'number' && !Number.isFinite(rawValue)) {
            rawValue = null;
        }

        const deadband = tag.deadband || 0;
        const hasDeadband = deadband > 0 && (tag.deadband_check_cycle_s || 0) > 0;

        // Cache latest sampled values only for deadband-check tags (needed for synchronized baselines without extra reads).
        if (isDeadbandCheck && hasDeadband) {
            this.latestValues.set(tag.tag_id, {
                rawValue,
                processedValue,
                sampledAt: timestamp,
            });
        }

            if (isDeadbandCheck) {
                // ── Fast deadband-check read ──
                if (!hasDeadband) return; // shouldn't happen, but guard

                const state = this.deadbandState.get(tag.tag_id);
                if (!state) return;

                if (shouldRecordByDeadband(processedValue, state.lastStoredValue, deadband)) {
                // Value changed beyond deadband — record it
                this._bufferRecord(tag, rawValue, processedValue, timestamp);
                state.lastStoredValue = processedValue;
                state.lastStoredAt = timestamp;
                this.metrics.deadbandRecorded++;
            } else {
                // Baseline logging is handled by the synchronized reading_cycle timers.
                this.metrics.deadbandSkipped++;
            }
            } else {
                // ── Normal reading_cycle read ──
                if (hasDeadband) {
                    const state = this.deadbandState.get(tag.tag_id);
                    if (state && state.lastStoredAt && tag.reading_cycle_ms > 0) {
                        const elapsed = timestamp.getTime() - state.lastStoredAt.getTime();
                        if (elapsed < tag.reading_cycle_ms) {
                            return;
                        }
                    }
                    this._bufferRecord(tag, rawValue, processedValue, timestamp);
                    if (state) {
                        state.lastStoredValue = processedValue;
                        state.lastStoredAt = timestamp;
                    }
            } else {
                // No deadband — always record on cycle
                this._bufferRecord(tag, rawValue, processedValue, timestamp);
            }
        }
    }

    /**
     * Buffer a record for batch insert
     */
    _bufferRecord(tag, rawValue, processedValue, timestamp) {
        if (this.dataBuffer.length >= this.options.bufferSize) {
            this.logger.warn('Historian buffer full, dropping oldest record');
            // Avoid Array.shift() in tight loops (O(n)). Drop a chunk.
            const dropCount = Math.max(1, Math.floor(this.options.bufferSize * 0.1));
            this.dataBuffer.splice(0, Math.min(dropCount, this.dataBuffer.length));
        }

        this.dataBuffer.push({
            tag_id: tag.tag_id,
            tag_name: tag.tag_name,
            value: processedValue,
            raw_value: rawValue,
            quality: this.options.defaultQuality,
            timestamp: timestamp,
        });

        this.metrics.bufferedRecords = this.dataBuffer.length;
    }

    /**
     * Buffer a NULL (Bad-quality) record — used when a tag's device is
     * disconnected, so the historian shows a gap / explicit "no data" instead
     * of repeating the last good value.
     */
    _bufferNullRecord(tag, timestamp) {
        if (this.dataBuffer.length >= this.options.bufferSize) {
            const dropCount = Math.max(1, Math.floor(this.options.bufferSize * 0.1));
            this.dataBuffer.splice(0, Math.min(dropCount, this.dataBuffer.length));
        }

        this.dataBuffer.push({
            tag_id: tag.tag_id,
            tag_name: tag.tag_name,
            value: null,
            raw_value: null,
            quality: QUALITY_BAD,
            timestamp: timestamp,
        });

        this.metrics.bufferedRecords = this.dataBuffer.length;
    }

    /**
     * Is the device that feeds this tag currently connected?
     * Internal/calc tags are not device-bound (treated as connected).
     */
    _isTagDeviceConnected(tag) {
        if (tag.protocol_type === 'modbus') {
            return this.modbusManager ? this.modbusManager.isConnected(tag.modbus_device_id) : false;
        }
        if (tag.protocol_type === 'iec104') {
            return this.iec104Manager ? this.iec104Manager.isConnected(tag.iec104_device_id) : false;
        }
        return true;
    }

    // =========================================================
    // Flush to database (parameterized — no SQL injection)
    // =========================================================

    /**
     * Flush buffer to database
     */
    async _flushBuffer() {
        if (this.dataBuffer.length === 0) return;

        const records = [...this.dataBuffer];
        this.dataBuffer = [];
        this.metrics.bufferedRecords = 0;

        try {
            // Insert in batches
            for (let i = 0; i < records.length; i += this.options.batchSize) {
                const batch = records.slice(i, i + this.options.batchSize);
                await this._insertBatch(batch);
            }

            this.metrics.writes += records.length;
            this.logger.debug(`Flushed ${records.length} historian records`);

            // Reset backoff on success
            this._flushBackoffMs = this.options.flushInterval;
            this._nextFlushAllowedAt = 0;
        } catch (error) {
            this.logger.error('Failed to flush historian buffer', { 
                error: error.message,
                records: records.length 
            });
            
            // Put failed records back in buffer (at front)
            this.dataBuffer = [...records, ...this.dataBuffer].slice(0, this.options.bufferSize);
            this.metrics.bufferedRecords = this.dataBuffer.length;
            this.metrics.errors++;

            // Backoff flush attempts to avoid: flush -> fail -> requeue -> flush -> fail ... loop
            this._flushBackoffMs = Math.min(
                Math.max(this._flushBackoffMs * 2, this.options.flushInterval),
                this.options.flushBackoffMaxMs
            );
            this._nextFlushAllowedAt = Date.now() + this._flushBackoffMs;

            // Throttle warning spam while DB is down
            const now = Date.now();
            if (now - this._lastFlushWarnAt > 60000) {
                this._lastFlushWarnAt = now;
                this.logger.warn('Historian flush backed off (DB may be down)', {
                    nextAttemptMs: this._flushBackoffMs,
                    bufferedRecords: this.dataBuffer.length,
                });
            }
        }
    }

    /**
     * Insert a batch of records using parameterized query (safe from SQL injection)
     */
    async _insertBatch(records) {
        // SQL Server bulk insert (faster and avoids huge query strings)
        const table = new sql.Table('dbo.HistorianData');
        table.create = false;
        table.columns.add('tag_id', sql.Int, { nullable: false });
        table.columns.add('tag_name', sql.NVarChar(100), { nullable: false });
        // value is nullable: a NULL value (with Bad quality) marks "device disconnected".
        table.columns.add('value', sql.Float, { nullable: true });
        table.columns.add('raw_value', sql.Float, { nullable: true });
        table.columns.add('quality', sql.Int, { nullable: false });
        table.columns.add('timestamp', sql.DateTime2, { nullable: false });
        // NOTE: SQL Server bulk insert does not reliably apply DEFAULT constraints.
        // Provide created_at explicitly to avoid "Cannot insert NULL into column 'created_at'".
        table.columns.add('created_at', sql.DateTime2, { nullable: false });

        for (const r of records) {
            table.rows.add(
                r.tag_id,
                r.tag_name,
                r.value,
                r.raw_value == null ? null : r.raw_value,
                r.quality,
                r.timestamp,
                new Date()
            );
        }

        await this.db.bulk(table);
    }

    /**
     * Get data type size
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
     * Query historical data
     */
    async queryData(tagId, fromDate, toDate, options = {}) {
        try {
            const result = await this.db.execute('sp_GetHistorianData', {
                tag_id: tagId,
                from_date: fromDate,
                to_date: toDate,
                page: options.page || 1,
                page_size: options.pageSize || 1000,
            });

            return result.recordset;
        } catch (error) {
            this.logger.error('Failed to query historian data', { error: error.message });
            throw error;
        }
    }

    /**
     * Get current metrics
     */
    getMetrics() {
        return { ...this.metrics };
    }

    /**
     * Get tag information
     */
    getTags() {
        return Array.from(this.tags.values());
    }
}

module.exports = HistorianService;
