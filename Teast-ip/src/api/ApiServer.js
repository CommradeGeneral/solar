/**
 * REST API Routes
 * Provides endpoints for alarms, historian, and system status
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getLogger } = require('../utils/Logger');

const AUTH_COOKIE_NAME = 'ids_token';

// ─────────────────────────────────────────────────────────────────────────────
// Timezone helpers — msnodesqlv8 + DATETIME2 stored as local time via GETDATE()
//
// SQL Server stores timestamps using GETDATE() which returns the *local* server
// time (e.g. UTC+3).  The msnodesqlv8 driver reads DATETIME2 columns (which
// carry no timezone metadata) and wraps the raw value in a JS Date whose
// internal ms-since-epoch treats the raw value as UTC.  The result is that
// every timestamp appears 3 h ahead of what was actually recorded.
//
//  Stored in DB  : 2026-06-17 09:00:00  (local, UTC+3)
//  Driver returns: Date @ 09:00:00 UTC   ← wrong — should be 06:00:00 UTC
//
// The same offset also affects filtering: if a caller sends a UTC ISO string
// for from/to, mssql will forward the UTC value to SQL Server, but the stored
// timestamps are local, so the WHERE clause is 3 h off.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the local UTC offset in milliseconds.
 * For UTC+3: getTimezoneOffset() = -180  →  offsetMs = -10 800 000
 * Called per-request so it adapts to DST transitions automatically.
 */
function _tzOffsetMs() {
    return new Date().getTimezoneOffset() * 60 * 1000;
}

/**
 * Convert a DATETIME2 Date returned by msnodesqlv8 (incorrectly stamped as
 * UTC) to the correct UTC ISO-8601 string.
 *
 * @param {Date|*} date - Value from a DB result-set field
 * @returns {string|null}
 */
function dbDateToIso(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) {
        return (typeof date === 'string' ? date : null);
    }
    // Shift the "fake-UTC" ms back by the local offset to obtain real UTC ms.
    // UTC+3 example: stored 09:00 read as 09:00Z → 09:00 - 3h = 06:00Z  ✓
    return new Date(date.getTime() + _tzOffsetMs()).toISOString();
}

/**
 * Convert an incoming UTC ISO string (or Date) into a Date that, when sent
 * by msnodesqlv8 to SQL Server, will match DATETIME2 values stored via
 * GETDATE() (local time).
 *
 * @param {string|Date|null} value
 * @returns {Date|null}
 */
function isoToDbDate(value) {
    if (!value) return null;
    const d = (value instanceof Date) ? value : new Date(value);
    if (isNaN(d.getTime())) return null;
    // Shift the UTC ms forward by the local offset to produce a "fake-UTC"
    // Date whose raw value equals the local time SQL Server stored.
    // UTC+3 example: caller sends 06:00Z → 06:00 + 3h = 09:00 "fake-UTC"
    //                SQL Server sees 09:00, matching stored 09:00 local  ✓
    return new Date(d.getTime() - _tzOffsetMs());
}

/**
 * Walk a plain DB result-set row and replace every Date field with a
 * correctly-offset ISO string using dbDateToIso().
 *
 * @param {object} record
 * @returns {object}
 */
function fixRecordDates(record) {
    if (!record || typeof record !== 'object') return record;
    const out = { ...record };
    for (const [k, v] of Object.entries(out)) {
        if (v instanceof Date) out[k] = dbDateToIso(v);
    }
    return out;
}

class ApiServer {
    constructor(options = {}) {
        this.options = {
            port: options.port || 3000,
            host: options.host || '0.0.0.0',
            cors: options.cors || { enabled: true, origins: '*' },
            rateLimit: options.rateLimit || 0,
            jwt: options.jwt || { secret: 'change-this-secret', expirationHours: 24, expirationDays: null },
        };

        this.app = express();
        this.server = null;
        this.logger = getLogger().getServiceLogger('ApiServer');

        // Services (injected)
        this.alarmService = null;
        this.historianService = null;
        this.db = null;
        this.iec104Manager = null;
        this.modbusManager = null;

        this._setupMiddleware();
    }

    /**
     * Initialize API with services
     */
    initialize(services) {
        this.alarmService = services.alarmService;
        this.historianService = services.historianService;
        this.db = services.db;
        this.iec104Manager = services.iec104Manager;
        this.modbusManager = services.modbusManager;
        this.configManager = services.configManager || null;

        this._setupRoutes();
        this._setupErrorHandler();
    }

    /**
     * Setup middleware
     */
    _setupMiddleware() {
        // Security headers
        this.app.use(helmet({
            contentSecurityPolicy: false,
        }));

        // Cookies (httpOnly JWT)
        this.app.use(cookieParser());

        // CORS
        if (this.options.cors.enabled) {
            this.app.use(cors({
                origin: this.options.cors.origins,
                credentials: true,
            }));
        }

        // Body parsing
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));

        // Rate limiting
        if (this.options.rateLimit > 0) {
            const limiter = rateLimit({
                windowMs: 60 * 1000, // 1 minute
                max: this.options.rateLimit,
                message: { error: 'Too many requests, please try again later' },
            });
            this.app.use(limiter);
        }

        // Request logging
        this.app.use((req, res, next) => {
            const start = Date.now();
            res.on('finish', () => {
                const duration = Date.now() - start;
                this.logger.debug(`${req.method} ${req.path}`, {
                    status: res.statusCode,
                    duration: `${duration}ms`,
                });
            });
            next();
        });
    }

    /**
     * Get JWT expiration in seconds
     */
    _getJwtExpirationSeconds() {
        const days = this.options.jwt?.expirationDays;
        if (Number.isFinite(days) && days > 0) {
            return Math.floor(days * 24 * 60 * 60);
        }
        const hours = this.options.jwt?.expirationHours;
        if (Number.isFinite(hours) && hours > 0) {
            return Math.floor(hours * 60 * 60);
        }
        return 30 * 24 * 60 * 60;
    }

    _getAuthCookieOptions() {
        const maxAgeMs = this._getJwtExpirationSeconds() * 1000;
        return {
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
            maxAge: maxAgeMs,
            path: '/',
        };
    }

    async _isTokenRevoked(jti) {
        if (!this.db) return false;
        try {
            const result = await this.db.query(
                `SELECT TOP 1 1 AS revoked
                 FROM dbo.RevokedTokens
                 WHERE jti = @jti AND expires_at > GETDATE();`,
                { jti }
            );
            return (result?.recordset || []).length > 0;
        } catch (err) {
            this.logger.warn('Token revocation check failed', { error: err?.message || err });
            return true;
        }
    }

    /**
     * Auth middleware: verifies JWT from httpOnly cookie + checks revocation list.
     */
    _authRequired() {
        return async (req, res, next) => {
            const token = req.cookies?.[AUTH_COOKIE_NAME];
            if (!token) return res.status(401).json({ error: 'Not authenticated' });

            let decoded;
            try {
                decoded = jwt.verify(token, this.options.jwt.secret);
            } catch {
                res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
                return res.status(401).json({ error: 'Invalid token' });
            }

            if (!decoded?.jti) {
                res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
                return res.status(401).json({ error: 'Invalid token' });
            }

            const revoked = await this._isTokenRevoked(decoded.jti);
            if (revoked) {
                res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
                return res.status(401).json({ error: 'Session ended' });
            }

            req.user = decoded;
            next();
        };
    }

    /**
     * Page auth middleware: same as _authRequired but redirects to /login.
     */
    _pageAuthRequired() {
        return async (req, res, next) => {
            const token = req.cookies?.[AUTH_COOKIE_NAME];
            if (!token) return res.redirect('/login');

            let decoded;
            try {
                decoded = jwt.verify(token, this.options.jwt.secret);
            } catch {
                res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
                return res.redirect('/login');
            }

            if (!decoded?.jti) {
                res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
                return res.redirect('/login');
            }

            const revoked = await this._isTokenRevoked(decoded.jti);
            if (revoked) {
                res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
                return res.redirect('/login');
            }

            req.user = decoded;
            next();
        };
    }

    _adminRequired() {
        return (req, res, next) => {
            if (!req.user || req.user.role !== 'administrator') {
                return res.status(403).json({ error: 'Admin only' });
            }
            next();
        };
    }

    /**
     * Setup routes
     */
    _setupRoutes() {
        const router = express.Router();

        // Static assets & pages (optional)
        const publicDir = path.join(__dirname, '..', 'public');
        this.app.use('/static', express.static(publicDir));

        // ==================== Health & Status ====================

        router.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
            });
        });

        router.get('/status', (req, res) => {
            res.json({
                server: {
                    uptime: process.uptime(),
                    memory: process.memoryUsage(),
                    timestamp: new Date().toISOString(),
                },
                services: {
                    alarm: {
                        running: this.alarmService?.isRunning || false,
                        metrics: this.alarmService?.getMetrics() || {},
                    },
                    historian: {
                        running: this.historianService?.isRunning || false,
                        metrics: this.historianService?.getMetrics() || {},
                        debug: this.historianService?.getDebugStatus?.() || {},
                    },
                },
                connections: {
                    iec104: this.iec104Manager?.getStatus() || {},
                    modbus: this.modbusManager?.getStatus() || {},
                    database: this.db?.getStatus?.() || { connected: false },
                },
            });
        });

        // ==================== Authentication ====================

        router.post('/auth/login', async (req, res, next) => {
            try {
                const { username, password } = req.body || {};
                if (!username || !password) {
                    return res.status(400).json({ error: 'username and password are required' });
                }

                // 0) Emergency break-glass admin (not stored in DB, so it can't be deleted or shown in UI)
                try {
                    const emergency = this.configManager?.getEmergencyAdminConfig?.();
                    if (emergency?.enabled) {
                        const u = String(username).trim();
                        if (emergency.username && u.toLowerCase() === emergency.username.toLowerCase()) {
                            let ok = false;
                            if (emergency.passwordHash) {
                                ok = await bcrypt.compare(String(password), String(emergency.passwordHash));
                            } else if (emergency.password) {
                                ok = String(password) === String(emergency.password);
                            }

                            if (ok) {
                                const jti = uuidv4();
                                const expiresInSeconds = this._getJwtExpirationSeconds();
                                const token = jwt.sign(
                                    { sub: 0, username: emergency.username, role: 'administrator', jti, emergency: true },
                                    this.options.jwt.secret,
                                    { expiresIn: expiresInSeconds }
                                );
                                res.cookie(AUTH_COOKIE_NAME, token, this._getAuthCookieOptions());
                                return res.json({
                                    ok: true,
                                    user: { id: 0, username: emergency.username, role: 'administrator', emergency: true },
                                    expiresInSeconds,
                                });
                            }
                        }
                    }
                } catch {
                    // ignore emergency auth errors; fall back to DB auth
                }

                const result = await this.db.query(
                    `SELECT TOP 1 id, username, password_hash, role, is_active
                     FROM dbo.Users
                     WHERE username = @username;`,
                    { username: String(username).trim() }
                );

                const user = (result?.recordset || [])[0];
                if (!user || !user.is_active) {
                    return res.status(401).json({ error: 'Invalid credentials' });
                }

                const ok = await bcrypt.compare(String(password), String(user.password_hash));
                if (!ok) {
                    return res.status(401).json({ error: 'Invalid credentials' });
                }

                const jti = uuidv4();
                const expiresInSeconds = this._getJwtExpirationSeconds();
                const token = jwt.sign(
                    { sub: user.id, username: user.username, role: user.role, jti },
                    this.options.jwt.secret,
                    { expiresIn: expiresInSeconds }
                );

                // Best-effort last login update
                this.db.query(
                    `UPDATE dbo.Users SET last_login_at = GETDATE(), updated_at = GETDATE() WHERE id = @id;`,
                    { id: user.id }
                ).catch(() => { });

                res.cookie(AUTH_COOKIE_NAME, token, this._getAuthCookieOptions());
                res.json({
                    ok: true,
                    user: { id: user.id, username: user.username, role: user.role },
                    expiresInSeconds,
                });
            } catch (err) {
                next(err);
            }
        });

        router.post('/auth/logout', this._authRequired(), async (req, res, next) => {
            try {
                const token = req.cookies?.[AUTH_COOKIE_NAME];
                let decoded;
                try {
                    decoded = jwt.verify(token, this.options.jwt.secret);
                } catch {
                    res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
                    return res.json({ ok: true });
                }

                res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
                res.json({ ok: true });

                // Revoke token asynchronously (non-blocking) for faster logout response
                const jti = decoded?.jti;
                const userId = decoded?.sub != null ? Number(decoded.sub) : null;
                const expiresAt = new Date((decoded?.exp ? decoded.exp * 1000 : Date.now()));

                if (jti) {
                    // Fire and forget - don't await this
                    this.db.query(
                        `IF NOT EXISTS (SELECT 1 FROM dbo.RevokedTokens WHERE jti = @jti)
                         INSERT INTO dbo.RevokedTokens (jti, user_id, expires_at, reason)
                         VALUES (@jti, @user_id, @expires_at, 'logout');`,
                        { jti, user_id: userId, expires_at: expiresAt }
                    ).catch((err) => {
                        this.logger.error('Failed to record token revocation', {
                            error: err.message,
                            jti
                        });
                    });
                }
            } catch (err) {
                next(err);
            }
        });

        router.get('/auth/me', this._authRequired(), (req, res) => {
            res.json({
                ok: true,
                user: {
                    id: req.user?.sub,
                    username: req.user?.username,
                    role: req.user?.role,
                },
            });
        });

        router.get('/users', this._authRequired(), this._adminRequired(), async (req, res, next) => {
            try {
                const result = await this.db.query(
                    `SELECT id, username, role, is_active, last_login_at, created_at, updated_at
                     FROM dbo.Users
                     ORDER BY created_at DESC;`
                );
                res.json({ ok: true, users: result.recordset || [] });
            } catch (err) {
                next(err);
            }
        });

        router.post('/users', this._authRequired(), this._adminRequired(), async (req, res, next) => {
            try {
                const { username, password, role } = req.body || {};
                if (!username || !password) {
                    return res.status(400).json({ error: 'username and password are required' });
                }

                const normalizedRole = String(role || 'viewer').toLowerCase();
                if (!['administrator', 'viewer'].includes(normalizedRole)) {
                    return res.status(400).json({ error: 'role must be administrator or viewer' });
                }

                const passwordHash = await bcrypt.hash(String(password), 12);

                const result = await this.db.query(
                    `INSERT INTO dbo.Users (username, password_hash, role, is_active)
                     OUTPUT INSERTED.id, INSERTED.username, INSERTED.role, INSERTED.is_active, INSERTED.created_at
                     VALUES (@username, @password_hash, @role, 1);`,
                    {
                        username: String(username).trim(),
                        password_hash: passwordHash,
                        role: normalizedRole,
                    }
                );

                res.status(201).json({ ok: true, user: (result.recordset || [])[0] || null });
            } catch (err) {
                const msg = String(err?.message || '').toLowerCase();
                if (msg.includes('unique') || msg.includes('duplicate')) {
                    return res.status(409).json({ error: 'Username already exists' });
                }
                next(err);
            }
        });

        router.delete('/users/:id', this._authRequired(), this._adminRequired(), async (req, res, next) => {
            try {
                const id = Number(req.params.id);
                if (!Number.isFinite(id)) {
                    return res.status(400).json({ error: 'Invalid id' });
                }
                if (req.user?.sub && Number(req.user.sub) === id) {
                    return res.status(400).json({ error: 'Cannot delete your own user' });
                }

                // Hard delete: remove dependent revoked tokens first (FK), then delete the user row.
                const result = await this.db.query(
                    `DELETE FROM dbo.RevokedTokens WHERE user_id = @id;
                     DELETE FROM dbo.Users WHERE id = @id;`,
                    { id }
                );

                const affectedUser = Array.isArray(result?.rowsAffected) ? (result.rowsAffected[1] || 0) : 0;
                if (affectedUser === 0) return res.status(404).json({ error: 'User not found' });
                res.json({ ok: true });
            } catch (err) {
                next(err);
            }
        });

        router.post('/users/:id/reset-password', this._authRequired(), this._adminRequired(), async (req, res, next) => {
            try {
                const id = Number(req.params.id);
                if (!Number.isFinite(id)) {
                    return res.status(400).json({ error: 'Invalid id' });
                }

                const { newPassword } = req.body || {};
                if (!newPassword || String(newPassword).length < 4) {
                    return res.status(400).json({ error: 'newPassword is required (min 4 chars)' });
                }

                const passwordHash = await bcrypt.hash(String(newPassword), 12);

                const result = await this.db.query(
                    `UPDATE dbo.Users
                     SET password_hash = @password_hash,
                         updated_at = GETDATE()
                     WHERE id = @id AND is_active = 1;`,
                    { id, password_hash: passwordHash }
                );

                const affected = Array.isArray(result?.rowsAffected) ? (result.rowsAffected[0] || 0) : 0;
                if (affected === 0) return res.status(404).json({ error: 'User not found' });

                res.json({ ok: true });
            } catch (err) {
                next(err);
            }
        });

        // ==================== Alarms ====================

        router.get('/alarms/active', this._authRequired(), async (req, res, next) => {
            try {
                const alarms = this.alarmService?.getActiveAlarms() || [];
                res.json({ alarms, count: alarms.length });
            } catch (error) {
                next(error);
            }
        });

        router.get('/alarms/history', this._authRequired(), async (req, res, next) => {
            try {
                const { page = 1, pageSize = 50, type, class: alarmClass, from, to } = req.query;

                // isoToDbDate converts the caller's UTC ISO strings into Date objects
                // whose raw value equals the local time stored by GETDATE(), so the
                // WHERE triggered_at BETWEEN @from_date AND @to_date is correct.
                const result = await this.db.execute('sp_GetAlarmHistory', {
                    page: parseInt(page),
                    page_size: parseInt(pageSize),
                    alarm_type: type || null,
                    alarm_class: alarmClass || null,
                    from_date: isoToDbDate(from),
                    to_date: isoToDbDate(to),
                });

                // fixRecordDates corrects every Date field in each row (triggered_at,
                // acknowledged_at, ended_at, …) from "fake-UTC" back to real UTC ISO.
                res.json({
                    alarms: (result.recordsets[0] || []).map(fixRecordDates),
                    totalCount: result.recordsets[1]?.[0]?.total_count || 0,
                    page: parseInt(page),
                    pageSize: parseInt(pageSize),
                });
            } catch (error) {
                next(error);
            }
        });

        router.post('/alarms/:type/:id/acknowledge', this._authRequired(), async (req, res, next) => {
            try {
                const { type, id } = req.params;
                const user = req.user?.username || req.body?.user || 'unknown';

                const success = await this.alarmService.acknowledgeAlarm(type, parseInt(id), user);

                if (success) {
                    res.json({ success: true, message: 'Alarm acknowledged' });
                } else {
                    res.status(400).json({ error: 'Alarm not found or already acknowledged' });
                }
            } catch (error) {
                next(error);
            }
        });

        router.get('/alarms/tags', this._authRequired(), async (req, res, next) => {
            try {
                const analogTags = Array.from(this.alarmService?.analogTags?.values() || []);
                const discreteTags = Array.from(this.alarmService?.discreteTags?.values() || []);

                res.json({
                    analog: analogTags,
                    discrete: discreteTags,
                    totalCount: analogTags.length + discreteTags.length,
                });
            } catch (error) {
                next(error);
            }
        });

        // ==================== Historian ====================

        router.get('/historian/data', this._authRequired(), async (req, res, next) => {
            try {
                const { tagId, from, to, page = 1, pageSize = 1000 } = req.query;

                if (!from || !to) {
                    return res.status(400).json({ error: 'from and to dates are required' });
                }

                const data = await this.historianService?.queryData(
                    tagId ? parseInt(tagId) : null,
                    new Date(from),
                    new Date(to),
                    { page: parseInt(page), pageSize: parseInt(pageSize) }
                );

                res.json({
                    data: data || [],
                    count: data?.length || 0,
                    page: parseInt(page),
                    pageSize: parseInt(pageSize),
                });
            } catch (error) {
                next(error);
            }
        });

        router.get('/historian/tags', this._authRequired(), async (req, res, next) => {
            try {
                const tags = this.historianService?.getTags() || [];
                res.json({ tags, count: tags.length });
            } catch (error) {
                next(error);
            }
        });

        // ==================== Connections ====================

        router.get('/connections/iec104', (req, res) => {
            res.json(this.iec104Manager?.getStatus() || {});
        });

        router.get('/connections/modbus', (req, res) => {
            res.json(this.modbusManager?.getStatus() || {});
        });

        router.post('/connections/iec104/:id/reconnect', async (req, res, next) => {
            try {
                const { id } = req.params;
                await this.iec104Manager?.connect(id);
                res.json({ success: true, message: `Reconnecting to IEC104 device ${id}` });
            } catch (error) {
                next(error);
            }
        });

        router.post('/connections/modbus/:id/reconnect', async (req, res, next) => {
            try {
                const { id } = req.params;
                await this.modbusManager?.connect(id);
                res.json({ success: true, message: `Reconnecting to Modbus ${id}` });
            } catch (error) {
                next(error);
            }
        });

        // ==================== System ====================

        router.post('/system/reload', async (req, res, next) => {
            try {
                await this.alarmService?.reloadConfiguration();
                await this.historianService?.reloadConfiguration();
                res.json({ success: true, message: 'Configuration reloaded' });
            } catch (error) {
                next(error);
            }
        });

        router.get('/system/metrics', this._authRequired(), (req, res) => {
            res.json({
                alarm: this.alarmService?.getMetrics() || {},
                historian: this.historianService?.getMetrics() || {},
                database: this.db?.getMetrics() || {},
                process: {
                    uptime: process.uptime(),
                    memory: process.memoryUsage(),
                    cpu: process.cpuUsage(),
                },
            });
        });

        // Mount router
        this.app.use('/api', router);

        // Optional UI routes (can be served from this server)
        this.app.get('/', (req, res) => res.redirect('/login'));
        this.app.get('/login', (req, res) => {
            // Prevent caching so the browser Back button doesn't show stale "logged-in" state.
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.sendFile(path.join(publicDir, 'login.html'));
        });
        this.app.get('/user-interface', this._pageAuthRequired(), (req, res) => {
            // Prevent BFCache/back navigation from showing protected content after logout.
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.sendFile(path.join(publicDir, 'user-interface.html'));
        });
        this.app.get('/alarm', this._pageAuthRequired(), (req, res) => {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.sendFile(path.join(publicDir, 'alarm.html'));
        });

        // ==================== Legacy Historian (chart.js compatibility) ====================
        // Matches web/js/chart.js query parameters:
        // /history?tag_id=..&start_day=..&start_month=..&start_hour=..&start_minute=..&end_day=..&end_month=..&end_hour=..&end_minute=..
        this.app.get('/history', this._authRequired(), async (req, res, next) => {
            try {
                const {
                    tag_id,
                    start_day, start_month, start_hour, start_minute, start_year,
                    end_day, end_month, end_hour, end_minute, end_year,
                } = req.query;

                const missing =
                    start_day == null || start_month == null || start_hour == null || start_minute == null ||
                    end_day == null || end_month == null || end_hour == null || end_minute == null;

                if (missing) {
                    return res.status(400).json({ error: 'start_* and end_* parameters are required' });
                }

                const now = new Date();
                const sy = start_year ? parseInt(start_year, 10) : now.getFullYear();
                const ey = end_year ? parseInt(end_year, 10) : now.getFullYear();

                const sd = parseInt(start_day, 10);
                const sm = parseInt(start_month, 10);
                const sh = parseInt(start_hour, 10);
                const smin = parseInt(start_minute, 10);

                const ed = parseInt(end_day, 10);
                const em = parseInt(end_month, 10);
                const eh = parseInt(end_hour, 10);
                const emin = parseInt(end_minute, 10);

                if (
                    [sy, ey, sd, sm, sh, smin, ed, em, eh, emin].some((v) => Number.isNaN(v))
                ) {
                    return res.status(400).json({ error: 'Invalid numeric date parameters' });
                }

                // new Date(y, m, d, h, min) constructs a LOCAL-time Date.
                // msnodesqlv8 forwards the UTC value of a Date to SQL Server,
                // so we shift it by the local offset to make SQL Server see the
                // correct local timestamp that was stored via GETDATE().
                const fromDate = isoToDbDate(new Date(sy, sm - 1, sd, sh, smin, 0, 0));
                const toDate = isoToDbDate(new Date(ey, em - 1, ed, eh, emin, 59, 999));

                if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
                    return res.status(400).json({ error: 'Invalid date range' });
                }

                // Map the UI resolution label to a bucket size in seconds.
                // When a known resolution is supplied we aggregate server-side
                // (one query, bounded point count) instead of pulling raw rows.
                const RESOLUTION_SECONDS = {
                    '10s': 10, '1m': 60, '5m': 300, '15m': 900,
                    '1h': 3600, '6h': 21600, '1d': 86400,
                };
                const resolutionParam = (req.query.resolution || '').toString().trim();
                const intervalSeconds = RESOLUTION_SECONDS[resolutionParam] || null;
                const maxPoints = req.query.max_points
                    ? Math.min(Math.max(parseInt(req.query.max_points, 10) || 5000, 1), 20000)
                    : 5000;

                // rows = ascending [{ timestamp, value, ... }]. Built once here,
                // then serialized either as binary (format=bin) or JSON below.
                let rows;
                let aggregated = false;

                if (intervalSeconds) {
                    // Aggregated / downsampled path
                    aggregated = true;
                    const result = await this.db.execute('sp_GetHistorianDataAggregated', {
                        tag_id: tag_id ? parseInt(tag_id, 10) : null,
                        from_date: fromDate,
                        to_date: toDate,
                        interval_seconds: intervalSeconds,
                        max_points: maxPoints,
                    });
                    rows = result.recordset || []; // already ascending
                } else {
                    // Raw path: the client caches the whole range in memory and
                    // does all zoom/pan locally, so we return everything in a
                    // SINGLE query. (The old page-by-page OFFSET loop was O(n^2)
                    // and was the real cause of the slowness.)
                    // A generous ceiling guards against runaway memory.
                    const MAX_RAW_ROWS = 5000000;

                    const result = await this.db.execute('sp_GetHistorianData', {
                        tag_id: tag_id ? parseInt(tag_id, 10) : null,
                        from_date: fromDate,
                        to_date: toDate,
                        page: 1,
                        page_size: MAX_RAW_ROWS,
                    });

                    rows = result.recordset || [];
                    // The proc returns DESC; reverse to ascending (cheaper than sort).
                    rows.reverse();
                }

                // Binary response: Float64 pairs [t0, v0, t1, v1, ...] in ms epoch.
                // ~4x smaller than JSON and the client skips JSON.parse entirely,
                // so it scales to far more points.
                if ((req.query.format || '').toString() === 'bin') {
                    const n = rows.length;
                    const buf = Buffer.allocUnsafe(n * 16);
                    let off = 0;
                    for (let i = 0; i < n; i++) {
                        const r = rows[i];
                        // Apply the same UTC offset correction as dbDateToIso() so the
                        // binary payload carries the real UTC epoch milliseconds.
                        const rawTs = r.timestamp instanceof Date
                            ? r.timestamp.getTime()
                            : new Date(r.timestamp).getTime();
                        const t = rawTs + _tzOffsetMs();
                        buf.writeDoubleLE(t, off); off += 8;
                        buf.writeDoubleLE(Number(r.value), off); off += 8;
                    }
                    res.set('Content-Type', 'application/octet-stream');
                    res.set('X-Point-Count', String(n));
                    return res.send(buf);
                }

                // JSON fallback (kept for compatibility with any other caller).
                // dbDateToIso() corrects the "fake-UTC" timestamps from msnodesqlv8.
                const payload = rows.map((row) => (aggregated ? {
                    DateTime: dbDateToIso(row.timestamp),
                    Value: row.value,
                    Min: row.min_value,
                    Max: row.max_value,
                    SampleCount: row.sample_count,
                } : {
                    DateTime: dbDateToIso(row.timestamp),
                    Value: row.value,
                }));

                res.json(payload);
            } catch (error) {
                next(error);
            }
        });

        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({ error: 'Not found' });
        });
    }

    /**
     * Setup error handler
     */
    _setupErrorHandler() {
        this.app.use((err, req, res, next) => {
            this.logger.error('API Error', {
                error: err.message,
                path: req.path,
                method: req.method,
            });

            res.status(err.status || 500).json({
                error: err.message || 'Internal server error',
            });
        });
    }

    /**
     * Start the API server
     */
    start() {
        return new Promise((resolve, reject) => {
            this.server = this.app.listen(this.options.port, this.options.host, () => {
                this.logger.info(`API Server started on http://${this.options.host}:${this.options.port}`);
                resolve();
            });

            this.server.on('error', (error) => {

                this.logger.error('API Server error', { error: error.message });
                reject(error);
            });
        });
    }

    /**
     * Stop the API server
     */
    stop() {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.logger.info('API Server stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    /**
     * Get Express app (for WebSocket attachment)
     */
    getApp() {
        return this.app;
    }

    /**
     * Get HTTP server
     */
    getServer() {
        return this.server;
    }
}

module.exports = ApiServer;
