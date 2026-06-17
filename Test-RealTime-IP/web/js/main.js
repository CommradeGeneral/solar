/**
 * SCADA Client - Main JavaScript
 * With PLC Notifications & Chart Integration (actual_tag_id support)
 */

class ScadaClient {
    constructor() {
        this.socket = null;
        this.connected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 2000;
        this.tags = {};
        this.tagMeta = {}; // 🔥 Store tag metadata (actual_tag_id, chartable, etc.)
        this.serverUrl = this.getServerUrl();
        this.plcStatuses = {};
        this.plcLastSeen = {};
        this.plcStaleTimeoutMs = 10000;
        this.plcStaleCheckIntervalMs = 2000;
        this.notifiedPLCs = new Set();
        this.notificationRetentionMs = 24 * 60 * 60 * 1000; // 24h
        this.notificationCleanupIntervalMs = 60 * 60 * 1000; // 1h
        this.computedTags = new Set(['depth']);
        this._clockInterval = null;
        this._staleMonitorInterval = null;
        this._notifCleanupInterval = null;
        
        this.init();
    }

    getServerUrl() {
        const host = window.location.hostname || '192.168.1.2';
        const port = 5000;
        return `${window.location.protocol}//${host}:${port}`;
    }

    init() {
        this.createNotificationContainer();
        this.connectWebSocket();
        this.startClock();
        this.setupEventListeners();
        this.setupNavToggle();
        this.setupHeaderLogo();
        this.resetGaugeFills();
        this.checkStoredNotifications();
        this.startPLCStaleMonitor();
        this.startNotificationCleanup();
    }

    createNotificationContainer() {
        if (!document.getElementById('notificationContainer')) {
            const container = document.createElement('div');
            container.id = 'notificationContainer';
            container.className = 'notification-container';
            document.body.appendChild(container);
        }
    }

    showPLCNotification(plc, isDisconnected) {
        const container = document.getElementById('notificationContainer');
        if (!container) return;

        const notifId = `notif-${plc.id}`;
        let existingNotif = document.getElementById(notifId);

        if (isDisconnected) {
            let disconnectedPLCs = JSON.parse(localStorage.getItem('disconnectedPLCs') || '{}');
            disconnectedPLCs[plc.id] = { ...plc, ts: Date.now() };
            localStorage.setItem('disconnectedPLCs', JSON.stringify(disconnectedPLCs));

            if (!existingNotif) {
                const notif = document.createElement('div');
                notif.id = notifId;
                notif.className = 'plc-notification disconnected';
                notif.innerHTML = `
                    <div class="notif-icon">⚠️</div>
                    <div class="notif-content">
                        <div class="notif-title">PLC Disconnected</div>
                        <div class="notif-message">${plc.name}</div>
                        <div class="notif-ip">${plc.ip}</div>
                    </div>
                    <button class="notif-close" onclick="scadaClient.dismissNotification('${plc.id}')">&times;</button>
                `;
                container.appendChild(notif);
                setTimeout(() => notif.classList.add('show'), 10);
            }
        } else {
            if (existingNotif) {
                existingNotif.classList.remove('show');
                setTimeout(() => existingNotif.remove(), 300);
            }
            
            let disconnectedPLCs = JSON.parse(localStorage.getItem('disconnectedPLCs') || '{}');
            delete disconnectedPLCs[plc.id];
            localStorage.setItem('disconnectedPLCs', JSON.stringify(disconnectedPLCs));

            this.showReconnectedNotification(plc);
        }
    }

    showReconnectedNotification(plc) {
        const container = document.getElementById('notificationContainer');
        if (!container) return;

        const notif = document.createElement('div');
        notif.className = 'plc-notification connected';
        notif.innerHTML = `
            <div class="notif-icon">✅</div>
            <div class="notif-content">
                <div class="notif-title">PLC Connected</div>
                <div class="notif-message">${plc.name}</div>
            </div>
        `;
        container.appendChild(notif);
        
        setTimeout(() => notif.classList.add('show'), 10);
        
        setTimeout(() => {
            notif.classList.remove('show');
            setTimeout(() => notif.remove(), 300);
        }, 3000);
    }

    dismissNotification(plcId) {
        const notif = document.getElementById(`notif-${plcId}`);
        if (notif) {
            notif.classList.remove('show');
            setTimeout(() => notif.remove(), 300);
        }
    }

    checkStoredNotifications() {
        const disconnectedPLCs = JSON.parse(localStorage.getItem('disconnectedPLCs') || '{}');
        const now = Date.now();
        const cleaned = {};

        Object.values(disconnectedPLCs).forEach(plc => {
            const ts = plc.ts || 0;
            if (!ts || (now - ts) <= this.notificationRetentionMs) {
                cleaned[plc.id] = plc;
                this.showPLCNotification(plc, true);
            }
        });

        localStorage.setItem('disconnectedPLCs', JSON.stringify(cleaned));
    }

    connectWebSocket() {
        try {
            this.socket = io(this.serverUrl, {
                transports: ['websocket', 'polling'],
                reconnection: true,
                reconnectionAttempts: this.maxReconnectAttempts,
                reconnectionDelay: this.reconnectDelay,
                timeout: 10000
            });

            this.socket.on('connect', () => {
                console.log('[SCADA] WebSocket connected');
                this.connected = true;
                this.reconnectAttempts = 0;
            });

            this.socket.on('disconnect', (reason) => {
                console.log('[SCADA] WebSocket disconnected:', reason);
                this.connected = false;
                this.clearAllNotifications();
                this.markAllPLCsDisconnected();
                this.updateConnectionStatus();
            });

            this.socket.on('init', (data) => {
                console.log('[SCADA] Received init data');
                if (data.simulation) {
                    console.log('[SCADA] Running in SIMULATION MODE');
                    this.showSimulationBanner();
                }
                
                // 🔥 Store tag metadata
                if (data.tagMeta) {
                    this.tagMeta = data.tagMeta;
                    console.log(`[SCADA] Loaded metadata for ${Object.keys(this.tagMeta).length} tags`);
                }
                
                this.updatePLCStatus(data.plcs);
                this.updateAllTags(data.tags);
            });

            this.socket.on('tag_updates', (updates) => {
                updates.forEach(update => {
                    this.updateTag(update);
                    
                    // 🔥 Update chart if open
                    if (window.ChartSystem && update.chartable) {
                        window.ChartSystem.updateData(update.tag_name, update.value);
                    }
                });
                this.updateLastUpdateTime();
            });

            this.socket.on('tag_update', (update) => {
                this.updateTag(update);
                this.updateLastUpdateTime();
            });

            this.socket.on('plc_status', (statuses) => {
                this.updatePLCStatus(statuses);
            });

            this.socket.on('connect_error', (error) => {
                console.error('[SCADA] Connection error:', error.message);
                this.reconnectAttempts++;
                this.markAllPLCsDisconnected();
                this.updateConnectionStatus();
                if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                    this.fallbackToPolling();
                }
            });

        } catch (e) {
            console.error('[SCADA] WebSocket initialization error:', e);
            this.fallbackToPolling();
        }
    }

    showSimulationBanner() {
        if (!document.getElementById('simBanner')) {
            const banner = document.createElement('div');
            banner.id = 'simBanner';
            banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#ff9800;color:#000;text-align:center;padding:5px;font-weight:bold;z-index:9999;';
            banner.textContent = '⚠️ SIMULATION MODE - No real PLC connection';
            document.body.prepend(banner);
        }
    }

    fallbackToPolling() {
        console.log('[SCADA] Starting HTTP polling fallback');
        if (this.pollingInterval) clearInterval(this.pollingInterval);
        this.pollingInterval = setInterval(() => {
            this.fetchTagsViaHTTP();
        }, 1000);
    }

    async fetchTagsViaHTTP() {
        try {
            const response = await fetch(`${this.serverUrl}/api/tags`);
            const data = await response.json();
            if (data.success) {
                Object.entries(data.data).forEach(([tagName, value]) => {
                    this.updateTagValue(tagName, value);
                });
                this.updateLastUpdateTime();
            }
            
            const plcResponse = await fetch(`${this.serverUrl}/api/plcs`);
            const plcData = await plcResponse.json();
            if (plcData.success) {
                this.updatePLCStatus(plcData.data);
            }
        } catch (e) {
            console.error('[SCADA] HTTP polling error:', e);
            this.markAllPLCsDisconnected();
            this.updateConnectionStatus();
        }
    }

    getCurrentPage() {
        const path = window.location.pathname;
        const match = path.match(/page(\d+)/);
        return match ? parseInt(match[1]) : null;
    }

    updateConnectionStatus() {
        const statusContainer = document.querySelector('.connection-status');
        const statusIndicator = document.getElementById('connStatus');
        const statusText = document.getElementById('connText');
        
        const disconnectedPLCs = Object.values(this.plcStatuses).filter(plc => !plc.connected);
        const allConnected = disconnectedPLCs.length === 0 && Object.keys(this.plcStatuses).length > 0;

        if (statusContainer) {
            statusContainer.style.display = allConnected ? 'none' : 'flex';
        }
        
        if (statusIndicator) {
            statusIndicator.className = 'status-indicator ' + (allConnected ? 'connected' : 'disconnected');
        }
        
        if (statusText) {
            if (allConnected) {
                statusText.textContent = 'All PLCs Connected';
            } else if (disconnectedPLCs.length > 0) {
                const names = disconnectedPLCs.map(p => p.name || p.id).join(', ');
                statusText.textContent = `Disconnected: ${names}`;
            } else {
                statusText.textContent = 'Connecting...';
            }
        }
    }

    updatePLCStatus(plcs) {
        if (!plcs) return;
        
        plcs.forEach(plc => {
            const previousStatus = this.plcStatuses[plc.id];
            this.plcStatuses[plc.id] = plc;
            this.plcLastSeen[plc.id] = Date.now();
            
            if (previousStatus) {
                if (previousStatus.connected && !plc.connected) {
                    this.showPLCNotification(plc, true);
                } else if (!previousStatus.connected && plc.connected) {
                    this.showPLCNotification(plc, false);
                }
            } else if (!plc.connected) {
                this.showPLCNotification(plc, true);
            } else {
                const disconnectedPLCs = JSON.parse(localStorage.getItem('disconnectedPLCs') || '{}');
                const hasStoredDisconnect = !!disconnectedPLCs[plc.id];
                const existingNotif = document.getElementById(`notif-${plc.id}`);
                if (hasStoredDisconnect || existingNotif) {
                    this.showPLCNotification(plc, false);
                }
            }
        });

        this.updateConnectionStatus();

        this.renderPLCStatus(Object.values(this.plcStatuses));
    }

    renderPLCStatus(plcs) {
        const plcContainer = document.getElementById('plcStatusContainer');
        if (plcContainer) {
            plcContainer.innerHTML = plcs.map(plc => `
                <div class="plc-card ${plc.connected ? 'online' : 'offline'}">
                    <div class="plc-indicator"></div>
                    <div class="plc-info">
                        <div class="plc-name">${plc.name}</div>
                        <div class="plc-ip">${plc.ip}</div>
                        <div class="plc-status-text">${plc.connected ? (plc.simulation ? 'Simulation' : 'Connected') : 'Disconnected'}</div>
                    </div>
                </div>
            `).join('');
        }
    }

    markAllPLCsDisconnected() {
        const plcs = Object.values(this.plcStatuses);
        if (plcs.length === 0) return;

        let changed = false;
        plcs.forEach(plc => {
            if (plc.connected) {
                const updated = { ...plc, connected: false };
                this.plcStatuses[plc.id] = updated;
                this.showPLCNotification(updated, true);
                changed = true;
            }
        });

        if (changed) {
            this.renderPLCStatus(Object.values(this.plcStatuses));
        }
    }

    startPLCStaleMonitor() {
        if (this._staleMonitorInterval) clearInterval(this._staleMonitorInterval);
        this._staleMonitorInterval = setInterval(() => {
            const now = Date.now();
            let changed = false;

            Object.values(this.plcStatuses).forEach(plc => {
                const lastSeen = this.plcLastSeen[plc.id] || 0;
                if (plc.connected && lastSeen && (now - lastSeen) > this.plcStaleTimeoutMs) {
                    const updated = { ...plc, connected: false };
                    this.plcStatuses[plc.id] = updated;
                    this.showPLCNotification(updated, true);
                    changed = true;
                }
            });

            if (changed) {
                this.updateConnectionStatus();
                this.renderPLCStatus(Object.values(this.plcStatuses));
            }
        }, this.plcStaleCheckIntervalMs);
    }

    startNotificationCleanup() {
        if (this._notifCleanupInterval) clearInterval(this._notifCleanupInterval);
        this._notifCleanupInterval = setInterval(() => {
            const disconnectedPLCs = JSON.parse(localStorage.getItem('disconnectedPLCs') || '{}');
            const now = Date.now();
            let changed = false;

            Object.values(disconnectedPLCs).forEach(plc => {
                const ts = plc.ts || 0;
                if (ts && (now - ts) > this.notificationRetentionMs) {
                    delete disconnectedPLCs[plc.id];
                    this.dismissNotification(plc.id);
                    changed = true;
                }
            });

            if (changed) {
                localStorage.setItem('disconnectedPLCs', JSON.stringify(disconnectedPLCs));
            }
        }, this.notificationCleanupIntervalMs);
    }

    updateAllTags(tags) {
        if (!tags) return;
        Object.entries(tags).forEach(([tagName, value]) => {
            this.updateTagValue(tagName, value);
        });
        this.computeDepthFromBridgeTide();
    }

    updateTag(update) {
        // 🔥 Store metadata if provided
        if (update.actual_tag_id !== undefined) {
            if (!this.tagMeta[update.tag_name]) {
                this.tagMeta[update.tag_name] = {};
            }
            this.tagMeta[update.tag_name].actual_tag_id = update.actual_tag_id;
            this.tagMeta[update.tag_name].chartable = update.chartable;
        }
        
        this.updateTagValue(update.tag_name, update.value, update.unit);
    }

    updateTagValue(tagName, value, unit, options) {
        if (!options || !options.force) {
            if (this.computedTags.has(tagName)) {
                this.tags[tagName] = value;
                return;
            }
        }
        const escapedTagName = CSS.escape(tagName);
        const elements = document.querySelectorAll(`.${escapedTagName}`);
        const taggedElements = document.querySelectorAll(`[data-tag="${tagName}"]`);
        
        elements.forEach(element => {
            // 🔥 Add actual_tag_id as data attribute for chart
            const meta = this.tagMeta[tagName];
            if (meta && meta.actual_tag_id) {
                element.setAttribute('data-actual-tag-id', meta.actual_tag_id);
                element.setAttribute('data-chartable', meta.chartable ? 'true' : 'false');
            }
            
            if (element.classList.contains('bool-indicator')) {
                this.updateBooleanIndicator(element, value);
            } else {
                const valueSpan = element.classList.contains('value') ? element : element.querySelector('.value');
                const displayValue = (value !== null && value !== undefined)
                    ? (typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(2) : value)
                    : '--';

                if (valueSpan) {
                    valueSpan.textContent = displayValue;
                } else if (element.tagName.toLowerCase() === 'text' || element.children.length === 0) {
                    element.textContent = displayValue;
                }
            }

            if (element.classList.contains('gauge-value')) {
                this.updateGaugeVisual(element, value);
            }

            if (tagName === 'DREDGE_ARM_ANGLE' && typeof value === 'number') {
                // 0 = water level, increasing values rotate counter-clockwise
                element.style.setProperty('--arm-angle', `${-value}deg`);
                element.classList.remove('animated');
            }
        });

        taggedElements.forEach(element => {
            const meta = this.tagMeta[tagName];
            if (meta && meta.actual_tag_id) {
                element.setAttribute('data-actual-tag-id', meta.actual_tag_id);
                element.setAttribute('data-chartable', meta.chartable ? 'true' : 'false');
            }
        });
        
        this.tags[tagName] = value;

        if (tagName === 'Bridge_Angle' || tagName === 'Tide') {
            this.computeDepthFromBridgeTide();
        }
    }

    computeDepthFromBridgeTide() {
        const angle = Number(this.tags['Bridge_Angle']);
        const tide = Number(this.tags['Tide']);

        if (!Number.isFinite(angle) || !Number.isFinite(tide)) {
            this.updateTagValue('depth', '--', undefined, { force: true });
            return;
        }

        const depth = 42 * Math.sin(angle * Math.PI / 180) - tide + 2;
        this.updateTagValue('depth', depth, undefined, { force: true });
    }

    updateGaugeVisual(valueElement, rawValue) {
        const card = valueElement.closest('.gauge-card');
        if (!card) return;

        const fill = card.querySelector('.gauge-fill');
        if (!fill) return;

        const isMissing = rawValue === null || rawValue === undefined || rawValue === '' || rawValue === '--';
        let numericValue = Number(rawValue);

        const min = Number(card.dataset.min ?? 0);
        const max = Number(card.dataset.max ?? 100);
        if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return;

        if (isMissing || !Number.isFinite(numericValue)) {
            let totalLengthMissing = parseFloat(fill.getAttribute('stroke-dasharray'));
            if (!Number.isFinite(totalLengthMissing) || totalLengthMissing <= 0) {
                totalLengthMissing = fill.getTotalLength();
                fill.setAttribute('stroke-dasharray', totalLengthMissing);
            }
            fill.setAttribute('stroke-dashoffset', String(totalLengthMissing));
            fill.style.stroke = '';
            return;
        }

        const clamped = Math.min(Math.max(numericValue, min), max);
        const ratio = (clamped - min) / (max - min);

        let totalLength = parseFloat(fill.getAttribute('stroke-dasharray'));
        if (!Number.isFinite(totalLength) || totalLength <= 0) {
            totalLength = fill.getTotalLength();
            fill.setAttribute('stroke-dasharray', totalLength);
        }

        const dashOffset = totalLength * (1 - ratio);
        fill.setAttribute('stroke-dashoffset', String(dashOffset));

        const color = this.getGaugeColor(card, clamped, min, max);
        if (color) {
            fill.style.stroke = color;
        }
    }

    getGaugeColor(card, value, min, max) {
        const rawStops = card.dataset.colorStops;
        if (!rawStops) return '';

        const stops = rawStops
            .split(',')
            .map(pair => pair.trim())
            .filter(Boolean)
            .map(pair => {
                const [posRaw, colorRaw] = pair.split(':').map(p => p.trim());
                const pos = Number(posRaw);
                return Number.isFinite(pos) && colorRaw ? { pos, color: colorRaw } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.pos - b.pos);

        if (stops.length === 0) return '';

        const pct = ((value - min) / (max - min)) * 100;
        let chosen = stops[0].color;
        for (const stop of stops) {
            if (pct >= stop.pos) {
                chosen = stop.color;
            } else {
                break;
            }
        }
        return chosen;
    }

    updateBooleanIndicator(element, value) {
        const isActive = value === 1 || value === true || value === '1';
        
        element.classList.remove('active', 'inactive');
        element.classList.add(isActive ? 'active' : 'inactive');
        
        const light = element.querySelector('.indicator-light');
        if (light) {
            light.classList.remove('on', 'off');
            light.classList.add(isActive ? 'on' : 'off');
        }
    }

    updateLastUpdateTime() {
        const updateTimeElement = document.getElementById('updateTime');
        if (updateTimeElement) {
            const now = new Date();
            const timeStr = now.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: true
            });
            updateTimeElement.textContent = `Last Update: ${timeStr}`;
        }
    }

    startClock() {
        const clockElement = document.getElementById('clock');
        if (clockElement) {
            const updateClock = () => {
                const now = new Date();
                const options = {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: true
                };
                clockElement.textContent = now.toLocaleString('en-US', options);
            };
            updateClock();
            if (this._clockInterval) clearInterval(this._clockInterval);
            this._clockInterval = setInterval(updateClock, 1000);
        }
    }

    setupEventListeners() {
        const currentPath = window.location.pathname;
        document.querySelectorAll('.nav-link').forEach(link => {
            const href = link.getAttribute('href');
            if (href && (href === currentPath || currentPath.includes(href.replace('.html', '')))) {
                link.classList.add('active');
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && !this.connected) {
                if (this.socket) {
                    this.socket.connect();
                }
            }
        });
    }

    resetGaugeFills() {
        document.querySelectorAll('.gauge-value').forEach(element => {
            this.updateGaugeVisual(element, null);
        });
    }

    setupNavToggle() {
        const nav = document.querySelector('.main-nav');
        if (!nav) {
            return;
        }

        const header = document.querySelector('.header');
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'nav-toggle';

        if (!nav.id) {
            nav.id = 'mainNav';
        }
        toggle.setAttribute('aria-controls', nav.id);

        const applyState = (collapsed) => {
            document.body.classList.toggle('nav-collapsed', collapsed);
            toggle.setAttribute('aria-expanded', String(!collapsed));
            toggle.textContent = collapsed ? 'Menu ▸' : 'Menu ▾';
        };

        const storedCollapsed = localStorage.getItem('navCollapsed') === '1';
        applyState(storedCollapsed);

        toggle.addEventListener('click', () => {
            const collapsed = !document.body.classList.contains('nav-collapsed');
            applyState(collapsed);
            localStorage.setItem('navCollapsed', collapsed ? '1' : '0');
        });

        if (header) {
            header.appendChild(toggle);
        } else {
            nav.parentNode.insertBefore(toggle, nav);
        }
    }

    setupHeaderLogo() {
        const logo = document.querySelector('.logo');
        if (!logo || logo.querySelector('img')) {
            return;
        }

        const img = document.createElement('img');
        img.className = 'header-logo';
        img.src = '../images/HA.PNG';
        img.alt = 'HA Logo';

        logo.prepend(img);
    }

    // 🔥 Get tag metadata (for chart)
    getTagMeta(tagName) {
        return this.tagMeta[tagName] || null;
    }

    // 🔥 Get actual_tag_id for a tag
    getActualTagId(tagName) {
        const meta = this.tagMeta[tagName];
        return meta ? meta.actual_tag_id : null;
    }

    // 🔥 Check if tag is chartable
    isChartable(tagName) {
        const meta = this.tagMeta[tagName];
        return meta ? meta.chartable : false;
    }

    async writeTagValue(tagName, value) {
        const url = `${this.serverUrl}/api/tag/${encodeURIComponent(tagName)}/write`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value })
        });

        let data = null;
        try {
            data = await response.json();
        } catch (e) {
            data = null;
        }

        if (!response.ok || !data || !data.success) {
            const message = (data && data.error) ? data.error : 'Write failed';
            throw new Error(message);
        }

        return data;
    }

    getTagValue(tagName) {
        return this.tags[tagName];
    }

    isConnected() {
        return this.connected;
    }

    clearAllNotifications() {
        localStorage.removeItem('disconnectedPLCs');
        const container = document.getElementById('notificationContainer');
        if (container) {
            container.innerHTML = '';
        }
    }

    destroy() {
        if (this._clockInterval) { clearInterval(this._clockInterval); this._clockInterval = null; }
        if (this._staleMonitorInterval) { clearInterval(this._staleMonitorInterval); this._staleMonitorInterval = null; }
        if (this._notifCleanupInterval) { clearInterval(this._notifCleanupInterval); this._notifCleanupInterval = null; }
        if (this.pollingInterval) { clearInterval(this.pollingInterval); this.pollingInterval = null; }
        if (this.socket) { this.socket.disconnect(); this.socket = null; }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Clean up previous instance if exists (e.g. SPA navigation / hot reload)
    if (window.scadaClient && typeof window.scadaClient.destroy === 'function') {
        window.scadaClient.destroy();
    }
    window.scadaClient = new ScadaClient();
    console.log('[SCADA] Client initialized');
});
