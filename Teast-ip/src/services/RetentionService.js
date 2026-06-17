/**
 * Retention Service
 * Deletes old data to prevent unbounded database growth.
 *
 * Tables:
 * - HistorianData (timestamp)
 * - AlarmEvents (event_timestamp) and AlarmHistory (triggered_at)
 * - SystemLogs (timestamp)
 */

const EventEmitter = require('eventemitter3');
const { getLogger } = require('../utils/Logger');

class RetentionService extends EventEmitter {
    constructor(options = {}) {
        super();

        this.options = {
            enabled: options.enabled !== false,
            // How often to run cleanup
            runIntervalMs: options.runIntervalMs || 6 * 60 * 60 * 1000, // every 6h
            initialDelayMs: options.initialDelayMs || 60 * 1000, // 1 min after startup
            // Retention windows (days). 0 or negative = disabled for that table.
            historianDays: options.historianDays ?? 30,
            alarmDays: options.alarmDays ?? 90,
            systemLogsDays: options.systemLogsDays ?? 14,
            // Delete in chunks to avoid long locks
            batchSize: options.batchSize || 10000,
            pauseMs: options.pauseMs || 100,
            // Safety: do not run forever in one cycle
            maxRunMs: options.maxRunMs || 10 * 60 * 1000, // 10 min
            // RevokedTokens housekeeping: remove already-expired (dead) JWTs.
            // Runs independently of `enabled` because it never deletes real data.
            revokedTokensCleanup: options.revokedTokensCleanup !== false,
            revokedTokensIntervalMs: options.revokedTokensIntervalMs || 6 * 60 * 60 * 1000, // every 6h
        };

        this.logger = getLogger().getServiceLogger('RetentionService');
        this.db = null;
        this.timer = null;
        this._revokedTokensTimer = null;
        this.isRunning = false;
    }

    async initialize(db) {
        this.db = db;
        this.logger.info('Retention Service initialized', {
            enabled: this.options.enabled,
            historianDays: this.options.historianDays,
            alarmDays: this.options.alarmDays,
            systemLogsDays: this.options.systemLogsDays,
            runIntervalMs: this.options.runIntervalMs,
        });
    }

    start() {
        // RevokedTokens housekeeping always runs (it only removes already-expired
        // JWTs, never real data) — even when data retention is disabled.
        this._startRevokedTokensCleanup();

        if (!this.options.enabled) {
            this.logger.info('Retention Service: data retention disabled (RevokedTokens cleanup still active)');
            return;
        }
        if (this.isRunning) return;
        this.isRunning = true;
        this.logger.info('Retention Service started');

        const run = async () => {
            try {
                await this.runOnce();
            } catch (err) {
                this.logger.error('Retention run failed', { error: err?.message || err });
            } finally {
                if (!this.isRunning) return;
                this.timer = setTimeout(run, this.options.runIntervalMs);
            }
        };

        this.timer = setTimeout(run, this.options.initialDelayMs);
    }

    stop() {
        this.isRunning = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this._revokedTokensTimer) {
            clearTimeout(this._revokedTokensTimer);
            this._revokedTokensTimer = null;
        }
    }

    /**
     * Periodically delete expired entries from dbo.RevokedTokens.
     * These are dead JWTs (already past expires_at): the token is invalid by
     * expiry anyway, so removing them is pure housekeeping with no data loss.
     */
    _startRevokedTokensCleanup() {
        if (!this.options.revokedTokensCleanup) return;
        if (this._revokedTokensTimer) return;

        const run = async () => {
            try {
                await this._cleanupRevokedTokens();
            } catch (err) {
                this.logger.error('RevokedTokens cleanup failed', { error: err?.message || err });
            } finally {
                this._revokedTokensTimer = setTimeout(run, this.options.revokedTokensIntervalMs);
            }
        };

        // First pass shortly after startup, then on its own interval.
        this._revokedTokensTimer = setTimeout(run, this.options.initialDelayMs);
    }

    async _cleanupRevokedTokens() {
        if (!this.db) return 0;
        // Delete in bounded batches to avoid long locks if the table is large.
        let total = 0;
        const deadline = Date.now() + this.options.maxRunMs;
        while (Date.now() < deadline) {
            const result = await this.db.query(
                `DELETE TOP (@batch) FROM dbo.RevokedTokens WHERE expires_at < GETDATE();`,
                { batch: this.options.batchSize }
            );
            const affected = Array.isArray(result?.rowsAffected) ? (result.rowsAffected[0] || 0) : 0;
            total += affected;
            if (affected === 0) break;
            await this._sleep(this.options.pauseMs);
        }
        if (total > 0) {
            this.logger.info('RevokedTokens cleanup deleted expired rows', { deleted: total });
        }
        return total;
    }

    async runOnce() {
        if (!this.db) throw new Error('RetentionService not initialized with db');

        const startedAt = Date.now();
        const deadline = startedAt + this.options.maxRunMs;

        const cutoffs = {
            historian: this._daysToCutoff(this.options.historianDays),
            alarm: this._daysToCutoff(this.options.alarmDays),
            systemLogs: this._daysToCutoff(this.options.systemLogsDays),
        };

        const summary = {
            historianDeleted: 0,
            alarmEventsDeleted: 0,
            alarmHistoryDeleted: 0,
            systemLogsDeleted: 0,
        };

        if (cutoffs.historian) {
            summary.historianDeleted += await this._deleteInBatches({
                label: 'HistorianData',
                deadline,
                query: `
                    DELETE TOP (@batch) FROM dbo.HistorianData
                    WHERE [timestamp] < @cutoff;
                `,
                params: { batch: this.options.batchSize, cutoff: cutoffs.historian },
            });
        }

        // AlarmEvents has FK to AlarmHistory, so delete events first, then history.
        if (cutoffs.alarm) {
            summary.alarmEventsDeleted += await this._deleteInBatches({
                label: 'AlarmEvents',
                deadline,
                query: `
                    DELETE TOP (@batch) e
                    FROM dbo.AlarmEvents e
                    LEFT JOIN dbo.AlarmHistory h ON e.alarm_history_id = h.id
                    WHERE e.event_timestamp < @cutoff
                       OR (h.id IS NOT NULL AND h.triggered_at < @cutoff);
                `,
                params: { batch: this.options.batchSize, cutoff: cutoffs.alarm },
            });

            summary.alarmHistoryDeleted += await this._deleteInBatches({
                label: 'AlarmHistory',
                deadline,
                query: `
                    DELETE TOP (@batch) FROM dbo.AlarmHistory
                    WHERE triggered_at < @cutoff;
                `,
                params: { batch: this.options.batchSize, cutoff: cutoffs.alarm },
            });
        }

        if (cutoffs.systemLogs) {
            summary.systemLogsDeleted += await this._deleteInBatches({
                label: 'SystemLogs',
                deadline,
                query: `
                    DELETE TOP (@batch) FROM dbo.SystemLogs
                    WHERE [timestamp] < @cutoff;
                `,
                params: { batch: this.options.batchSize, cutoff: cutoffs.systemLogs },
            });
        }

        const elapsedMs = Date.now() - startedAt;
        this.logger.info('Retention run complete', { ...summary, elapsedMs });
        return summary;
    }

    _daysToCutoff(days) {
        if (!Number.isFinite(days) || days <= 0) return null;
        const ms = days * 24 * 60 * 60 * 1000;
        return new Date(Date.now() - ms);
    }

    async _deleteInBatches({ label, query, params, deadline }) {
        let total = 0;

        while (Date.now() < deadline) {
            const result = await this.db.query(query, {
                batch: params.batch,
                cutoff: params.cutoff,
            });

            const affected = Array.isArray(result?.rowsAffected) ? (result.rowsAffected[0] || 0) : 0;
            total += affected;

            if (affected === 0) break;

            // Allow other work; reduce lock pressure.
            await this._sleep(this.options.pauseMs);
        }

        if (total > 0) {
            this.logger.info('Retention deleted rows', { table: label, deleted: total });
        }

        return total;
    }

    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

module.exports = RetentionService;

