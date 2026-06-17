/**
 * Logger Utility
 * Structured logging with rotating file support and console output
 */

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

class Logger {
    constructor(options = {}) {
        this.serviceName = options.serviceName || 'IndustrialDataServer';
        this.logPath = options.logPath || './logs';
        this.logLevel = options.logLevel || 'info';
        this.maxSize = options.maxSizeMB ? `${options.maxSizeMB}m` : '10m';
        this.maxFiles = options.maxFiles || 5;

        // Ensure log directory exists
        if (!fs.existsSync(this.logPath)) {
            fs.mkdirSync(this.logPath, { recursive: true });
        }

        this._createLogger();
    }

    _createLogger() {
        // Custom format for structured logging
        const customFormat = winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
            winston.format.errors({ stack: true }),
            winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
                let logMessage = `${timestamp} [${level.toUpperCase().padEnd(5)}] [${service || this.serviceName}]`;
                
                if (typeof message === 'object') {
                    logMessage += ` ${JSON.stringify(message)}`;
                } else {
                    logMessage += ` ${message}`;
                }

                if (Object.keys(meta).length > 0) {
                    logMessage += ` ${JSON.stringify(meta)}`;
                }

                return logMessage;
            })
        );

        // Console format with colors
        const consoleFormat = winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
            winston.format.colorize({ all: true }),
            winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
                let logMessage = `${timestamp} [${service || this.serviceName}] ${message}`;
                
                if (Object.keys(meta).length > 0 && meta.error) {
                    logMessage += `\n  Error: ${meta.error}`;
                    if (meta.stack) logMessage += `\n  Stack: ${meta.stack}`;
                }

                return logMessage;
            })
        );

        // Create transports
        const transports = [
            // Console transport
            new winston.transports.Console({
                format: consoleFormat,
                level: this.logLevel,
            }),

            // Rotating file transport - All logs
            new DailyRotateFile({
                filename: path.join(this.logPath, '%DATE%-combined.log'),
                datePattern: 'YYYY-MM-DD',
                maxSize: this.maxSize,
                maxFiles: this.maxFiles,
                format: customFormat,
                level: this.logLevel,
            }),

            // Rotating file transport - Errors only
            new DailyRotateFile({
                filename: path.join(this.logPath, '%DATE%-error.log'),
                datePattern: 'YYYY-MM-DD',
                maxSize: this.maxSize,
                maxFiles: this.maxFiles,
                format: customFormat,
                level: 'error',
            }),
        ];

        this.logger = winston.createLogger({
            level: this.logLevel,
            defaultMeta: { service: this.serviceName },
            transports,
        });

        // Create service-specific loggers
        this.serviceLoggers = {};
    }

    /**
     * Get or create a service-specific logger
     */
    getServiceLogger(serviceName) {
        if (!this.serviceLoggers[serviceName]) {
            // Create service-specific file transport
            const serviceTransport = new DailyRotateFile({
                filename: path.join(this.logPath, `%DATE%-${serviceName.toLowerCase()}.log`),
                datePattern: 'YYYY-MM-DD',
                maxSize: this.maxSize,
                maxFiles: this.maxFiles,
                format: winston.format.combine(
                    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
                    winston.format.printf(({ timestamp, level, message, ...meta }) => {
                        let logMessage = `${timestamp} [${level.toUpperCase().padEnd(5)}] ${message}`;
                        if (Object.keys(meta).length > 0 && !meta.service) {
                            logMessage += ` ${JSON.stringify(meta)}`;
                        }
                        return logMessage;
                    })
                ),
                level: this.logLevel,
            });

            this.serviceLoggers[serviceName] = {
                transport: serviceTransport,
                log: (level, message, meta = {}) => {
                    this.logger.log(level, message, { service: serviceName, ...meta });
                    serviceTransport.log({ level, message, ...meta });
                },
            };
        }

        return {
            debug: (message, meta) => this.serviceLoggers[serviceName].log('debug', message, meta),
            info: (message, meta) => this.serviceLoggers[serviceName].log('info', message, meta),
            warn: (message, meta) => this.serviceLoggers[serviceName].log('warn', message, meta),
            error: (message, meta) => this.serviceLoggers[serviceName].log('error', message, meta),
        };
    }

    // Convenience methods
    debug(message, meta = {}) {
        this.logger.debug(message, meta);
    }

    info(message, meta = {}) {
        this.logger.info(message, meta);
    }

    warn(message, meta = {}) {
        this.logger.warn(message, meta);
    }

    error(message, meta = {}) {
        this.logger.error(message, meta);
    }

    /**
     * Log metrics
     */
    metric(name, value, unit = '', meta = {}) {
        this.logger.info(`METRIC: ${name}=${value}${unit}`, { metric: true, ...meta });
    }

    /**
     * Log with timing
     */
    startTimer(label) {
        const start = process.hrtime.bigint();
        return {
            end: (message, meta = {}) => {
                const end = process.hrtime.bigint();
                const durationMs = Number(end - start) / 1000000;
                this.logger.info(`${message || label} [${durationMs.toFixed(2)}ms]`, { duration: durationMs, ...meta });
            }
        };
    }

    /**
     * Create child logger with additional default metadata
     */
    child(meta) {
        return {
            debug: (message, additionalMeta = {}) => this.debug(message, { ...meta, ...additionalMeta }),
            info: (message, additionalMeta = {}) => this.info(message, { ...meta, ...additionalMeta }),
            warn: (message, additionalMeta = {}) => this.warn(message, { ...meta, ...additionalMeta }),
            error: (message, additionalMeta = {}) => this.error(message, { ...meta, ...additionalMeta }),
        };
    }
}

// Singleton instance
let instance = null;

module.exports = {
    Logger,
    
    /**
     * Initialize the global logger
     */
    initLogger(options) {
        instance = new Logger(options);
        return instance;
    },

    /**
     * Get the global logger instance
     */
    getLogger() {
        if (!instance) {
            instance = new Logger();
        }
        return instance;
    },
};
