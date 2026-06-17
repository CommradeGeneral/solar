/**
 * Database Manager
 * Manages SQL Server connections with retry logic and transaction support
 */

const sql = require('mssql/msnodesqlv8');
const EventEmitter = require('eventemitter3');
const { getLogger } = require('../utils/Logger');

// SQL Server error codes that are retryable
const RETRYABLE_ERROR_CODES = [
    'ETIMEOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTOPEN',
    'EREQUEST',
    -1,     // Connection error
    -2,     // Timeout
    1205,   // Deadlock
    1222,   // Lock request timeout
    8645,   // Timeout waiting for memory
    8651,   // Low memory condition
];

class DatabaseManager extends EventEmitter {
    constructor(config, options = {}) {
        super();
        this.config = config;
        this.pool = null;
        this.isConnected = false;
        this.reconnecting = false;
        this._connectionDownLogged = false;
        this._reconnectAttempt = 0;
        
        this.options = {
            maxRetries: options.maxRetries || 3,
            retryDelayMs: options.retryDelayMs || 5000,
            autoReconnect: options.autoReconnect !== false,
            // Backoff for reconnect scheduling (not query retries)
            reconnectMaxDelayMs: options.reconnectMaxDelayMs || 300000, // 5 min
            reconnectJitterPct: options.reconnectJitterPct || 0.2, // +/-20%
        };

        this.logger = getLogger().getServiceLogger('DatabaseManager');
        this.metrics = {
            queries: 0,
            errors: 0,
            retries: 0,
            transactions: 0,
        };
    }

    /**
     * Ensure auto-reconnect is scheduled (public wrapper).
     */
    scheduleReconnectNow() {
        try {
            if (this.options.autoReconnect && !this.reconnecting) {
                this._scheduleReconnect();
            }
        } catch {
            // Best-effort only
        }
    }

    /**
     * Connect to the database
     */
    async connect() {
        try {
            this.logger.info('Connecting to SQL Server...', { 
                server: this.config.server, 
                database: this.config.database 
            });

            this.pool = await sql.connect(this.config);
            this.isConnected = true;
            this._reconnectAttempt = 0;

            // Handle pool errors
            // Remove old listeners to prevent memory leak on reconnect
            this.pool.removeAllListeners('error');
            this.pool.setMaxListeners(20);
            
            this.pool.on('error', (err) => {
                this.logger.error('Database pool error', { error: err.message });
                this.isConnected = false;
                this._logConnectionDownOnce(err, { during: 'pool' });
                this.emit('error', err);
                
                if (this.options.autoReconnect && !this.reconnecting) {
                    this._scheduleReconnect();
                }
            });

            this.logger.info('Successfully connected to SQL Server');
            this._logConnectionRestored();
            this.emit('connected');
            return true;
        } catch (error) {
            this.isConnected = false;
            this._logConnectionDownOnce(error, { during: 'connect' });
            this.emit('error', error);
            // Keep retrying in background unless explicitly disabled.
            this.scheduleReconnectNow();
            throw error;
        }
    }

    /**
     * Disconnect from the database
     */
    async disconnect() {
        try {
            if (this.pool) {
                await this.pool.close();
                this.pool = null;
                this.isConnected = false;
                this.logger.info('Disconnected from SQL Server');
                this.emit('disconnected');
            }
        } catch (error) {
            this.logger.error('Error disconnecting from SQL Server', { error: error.message });
        }
    }

    /**
     * Schedule a reconnection attempt
     */
    _scheduleReconnect() {
        if (this.reconnecting) return;
        
        this.reconnecting = true;
        this._reconnectAttempt = Math.max(1, this._reconnectAttempt + 1);

        const base = this.options.retryDelayMs;
        const max = this.options.reconnectMaxDelayMs;
        // Exponential backoff with cap. attempt=1 -> base, 2 -> 2x, 3 -> 4x, ...
        const exp = Math.min(this._reconnectAttempt - 1, 10);
        let delay = Math.min(base * (2 ** exp), max);

        // Jitter to avoid thundering herd if multiple services restart together.
        const jitter = this.options.reconnectJitterPct;
        if (jitter > 0) {
            const factor = 1 + (Math.random() * 2 - 1) * jitter; // 1 +/- jitter
            delay = Math.max(0, Math.round(delay * factor));
        }

        if (this._reconnectAttempt === 1) {
            this.logger.info(`Scheduling reconnect in ${delay}ms`);
        } else {
            this.logger.debug(`Scheduling reconnect in ${delay}ms`, { attempt: this._reconnectAttempt });
        }

        setTimeout(async () => {
            try {
                await this.connect();
                this.reconnecting = false;
            } catch (error) {
                this.reconnecting = false;
                if (this.options.autoReconnect) {
                    this._scheduleReconnect();
                }
            }
        }, delay);
    }

    /**
     * Check if error is retryable
     */
    _isRetryableError(error) {
        if (!error) return false;
        
        return RETRYABLE_ERROR_CODES.includes(error.code) ||
               RETRYABLE_ERROR_CODES.includes(error.number) ||
               error.message?.includes('timeout') ||
               error.message?.includes('connection');
    }

    /**
     * Log connection down only once until restored
     */
    _logConnectionDownOnce(error, meta = {}) {
        if (this._connectionDownLogged) return;
        this._connectionDownLogged = true;
        this.logger.error('Database connection lost', { 
            error: error?.message,
            code: error?.code,
            ...meta
        });
    }

    /**
     * Log connection restored once after being down
     */
    _logConnectionRestored() {
        if (!this._connectionDownLogged) return;
        this._connectionDownLogged = false;
        this.logger.info('Database connection restored');
    }

    /**
     * Execute a query with retry logic
     */
    async query(queryText, params = {}, options = {}) {
        const maxRetries = options.maxRetries || this.options.maxRetries;
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (!this.isConnected) {
                    await this.connect();
                }

                const request = this.pool.request();
                
                // Add parameters
                for (const [name, value] of Object.entries(params)) {
                    if (value && typeof value === 'object' && value.type) {
                        request.input(name, value.type, value.value);
                    } else {
                        request.input(name, value);
                    }
                }

                const result = await request.query(queryText);
                this.metrics.queries++;
                return result;
            } catch (error) {
                lastError = error;
                this.metrics.errors++;

                if (this._isRetryableError(error) && attempt < maxRetries) {
                    this.metrics.retries++;
                    this._logConnectionDownOnce(error, { during: 'query', attempt, maxRetries });
                    this.logger.warn(`Query failed, retrying (${attempt}/${maxRetries})`, {
                        error: error.message,
                        code: error.code
                    });
                    await this._sleep(this.options.retryDelayMs * attempt);
                } else {
                    // If we are giving up on a connection-like error, emit so listeners can react.
                    if (this._isRetryableError(error)) {
                        const wasDownLogged = this._connectionDownLogged;
                        this.isConnected = false;
                        if (!wasDownLogged) {
                            this._logConnectionDownOnce(error, { during: 'query-final' });
                            this.emit('error', error);
                        }
                    }
                    throw error;
                }
            }
        }

        throw lastError;
    }

    /**
     * Execute a stored procedure with retry logic
     */
    async execute(procedureName, params = {}, options = {}) {
        const maxRetries = options.maxRetries || this.options.maxRetries;
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (!this.isConnected) {
                    await this.connect();
                }

                const request = this.pool.request();
                
                // Add parameters
                for (const [name, param] of Object.entries(params)) {
                    if (param && typeof param === 'object') {
                        if (param.output) {
                            request.output(name, param.type, param.value);
                        } else if (param.type) {
                            request.input(name, param.type, param.value);
                        } else {
                            request.input(name, param);
                        }
                    } else {
                        request.input(name, param);
                    }
                }

                const result = await request.execute(procedureName);
                this.metrics.queries++;
                return result;
            } catch (error) {
                lastError = error;
                this.metrics.errors++;

                if (this._isRetryableError(error) && attempt < maxRetries) {
                    this.metrics.retries++;
                    this._logConnectionDownOnce(error, { during: 'execute', attempt, maxRetries, procedure: procedureName });
                    this.logger.warn(`Stored procedure failed, retrying (${attempt}/${maxRetries})`, {
                        procedure: procedureName,
                        error: error.message
                    });
                    await this._sleep(this.options.retryDelayMs * attempt);
                } else {
                    if (this._isRetryableError(error)) {
                        const wasDownLogged = this._connectionDownLogged;
                        this.isConnected = false;
                        if (!wasDownLogged) {
                            this._logConnectionDownOnce(error, { during: 'execute-final', procedure: procedureName });
                            this.emit('error', error);
                        }
                    }
                    throw error;
                }
            }
        }

        throw lastError;
    }

    /**
     * Execute multiple queries in a transaction
     */
    async transaction(operations) {
        if (!this.isConnected) {
            await this.connect();
        }

        const transaction = new sql.Transaction(this.pool);
        
        try {
            await transaction.begin();
            this.metrics.transactions++;

            const results = [];
            for (const operation of operations) {
                const request = new sql.Request(transaction);
                
                if (operation.params) {
                    for (const [name, value] of Object.entries(operation.params)) {
                        if (value && typeof value === 'object' && value.type) {
                            request.input(name, value.type, value.value);
                        } else {
                            request.input(name, value);
                        }
                    }
                }

                const result = await request.query(operation.query);
                results.push(result);
            }

            await transaction.commit();
            return results;
        } catch (error) {
            await transaction.rollback();
            this.logger.error('Transaction failed and rolled back', { error: error.message });
            throw error;
        }
    }

    /**
     * Batch insert with partial retry
     */
    async batchInsert(tableName, records, options = {}) {
        const batchSize = options.batchSize || 100;
        const results = { success: 0, failed: 0, errors: [] };

        for (let i = 0; i < records.length; i += batchSize) {
            const batch = records.slice(i, i + batchSize);
            
            try {
                const table = new sql.Table(tableName);
                table.create = false;

                // Setup columns from first record
                if (batch.length > 0 && options.columns) {
                    for (const col of options.columns) {
                        table.columns.add(col.name, col.type, col.options || {});
                    }
                }

                // Add rows
                for (const record of batch) {
                    table.rows.add(...Object.values(record));
                }

                const request = this.pool.request();
                await request.bulk(table);
                results.success += batch.length;
            } catch (error) {
                // Try individual inserts for failed batch
                for (const record of batch) {
                    try {
                        await this._insertSingleRecord(tableName, record, options.columns);
                        results.success++;
                    } catch (singleError) {
                        results.failed++;
                        results.errors.push({ record, error: singleError.message });
                    }
                }
            }
        }

        return results;
    }

    /**
     * Insert a single record
     */
    async _insertSingleRecord(tableName, record, columns) {
        const columnNames = columns ? columns.map(c => c.name) : Object.keys(record);
        const paramNames = columnNames.map(c => `@${c}`);
        
        const query = `INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES (${paramNames.join(', ')})`;
        
        const params = {};
        for (const col of columnNames) {
            params[col] = record[col];
        }

        return this.query(query, params);
    }

    /**
     * Utility sleep function
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get current metrics
     */
    getMetrics() {
        return { ...this.metrics };
    }

    /**
     * Get current connection status
     */
    getStatus() {
        return {
            connected: this.isConnected,
            reconnecting: this.reconnecting,
            server: this.config?.server,
            database: this.config?.database,
        };
    }


    /**
     * Reset metrics
     */
    resetMetrics() {
        this.metrics = {
            queries: 0,
            errors: 0,
            retries: 0,
            transactions: 0,
        };
    }

    /**
     * Get SQL types for convenience
     */
    static get Types() {
        return sql;
    }

    /**
     * Bulk insert using mssql Table object.
     * This is significantly faster for high-frequency inserts (historian data).
     */
    async bulk(table, options = {}) {
        const maxRetries = options.maxRetries || this.options.maxRetries;
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (!this.isConnected) {
                    await this.connect();
                }

                const request = this.pool.request();
                const result = await request.bulk(table);
                this.metrics.queries++;
                return result;
            } catch (error) {
                lastError = error;
                this.metrics.errors++;

                if (this._isRetryableError(error) && attempt < maxRetries) {
                    this.metrics.retries++;
                    this._logConnectionDownOnce(error, { during: 'bulk', attempt, maxRetries });
                    this.logger.warn(`Bulk insert failed, retrying (${attempt}/${maxRetries})`, {
                        error: error.message,
                        code: error.code
                    });
                    await this._sleep(this.options.retryDelayMs * attempt);
                } else {
                    if (this._isRetryableError(error)) {
                        const wasDownLogged = this._connectionDownLogged;
                        this.isConnected = false;
                        if (!wasDownLogged) {
                            this._logConnectionDownOnce(error, { during: 'bulk-final' });
                            this.emit('error', error);
                        }
                    }
                    throw error;
                }
            }
        }

        throw lastError;
    }
}

module.exports = DatabaseManager;
