/* ═══════════════════════════════════════════════════════════════
 * Multi-Tag Real-Time Chart System
 * Usage: <script src="../js/multi_chart.js"></script>
 * Requires: Chart.js (already loaded), main.js (ScadaClient)
 *
 * Click any chartable tag → it's added to a shared real-time chart.
 * Up to 10 tags plotted simultaneously. Remove/add freely.
 * ═══════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    /* ── Constants ────────────────────────────────────────────── */

    var MC_Log = window.SCADA_LOGGER ? window.SCADA_LOGGER('MultiChart') : console;

    var COLORS = [
        '#3498db', '#2ecc71', '#e74c3c', '#f39c12', '#9b59b6',
        '#1abc9c', '#e67e22', '#00d4ff', '#ff6b6b', '#c8d83f'
    ];

    var MAX_TAGS       = 10;
    var MAX_POINTS     = 120;   // 2 minutes of data at 1 s/sample
    var SAMPLE_MS      = 1000;  // sample every second
    var PANEL_HEIGHT   = 320;
    var MIN_PANEL_H    = 180;
    var MAX_PANEL_H    = 600;

    /* ── Main Class ──────────────────────────────────────────── */

    function MultiChartSystem() {
        this.tags        = new Map();      // tagName → { color, actualTagId, data[] }
        this.timeLabels  = [];
        this.chart       = null;
        this.panel       = null;
        this.canvas      = null;
        this.isOpen      = false;
        this.isMinimized = false;
        this.isPaused    = false;
        this.colorPool   = COLORS.slice(); // available colors
        this.samplerTimer = null;
        this.panelHeight  = PANEL_HEIGHT;

        this._hookChartSystem();
    }

    /* ── Panel DOM ───────────────────────────────────────────── */

    MultiChartSystem.prototype._createPanel = function () {
        if (document.getElementById('mcPanel')) return;

        var panel = document.createElement('div');
        panel.className = 'mc-panel';
        panel.id = 'mcPanel';
        panel.innerHTML =
            '<div class="mc-resize-handle" id="mcResizeHandle"></div>' +
            '<div class="mc-toolbar">' +
                '<span class="mc-title">\u{1F4CA} Multi-Tag</span>' +
                '<span class="mc-count" id="mcCount">0/' + MAX_TAGS + '</span>' +
                '<div class="mc-tags-area" id="mcTagsArea">' +
                    '<span class="mc-hint" id="mcHint">Click any tag value to add it here</span>' +
                '</div>' +
                '<div class="mc-controls">' +
                    '<button class="mc-btn" id="mcPauseBtn" title="Pause / Resume">\u23F8</button>' +
                    '<button class="mc-btn" id="mcClearBtn" title="Remove all tags">\u{1F5D1}</button>' +
                    '<button class="mc-btn mc-btn-close" id="mcCloseBtn" title="Close">\u2715</button>' +
                '</div>' +
            '</div>' +
            '<div class="mc-chart-wrap" id="mcChartWrap">' +
                '<canvas id="mcCanvas"></canvas>' +
            '</div>';

        document.body.appendChild(panel);
        this.panel  = panel;
        this.canvas = document.getElementById('mcCanvas');

        var self = this;
        document.getElementById('mcCloseBtn').addEventListener('click', function () { self.close(); });
        document.getElementById('mcClearBtn').addEventListener('click', function () { self.clearAll(); });
        document.getElementById('mcPauseBtn').addEventListener('click', function () { self._togglePause(); });

        this._setupResize();
    };

    /* ── Resize Handle ───────────────────────────────────────── */

    MultiChartSystem.prototype._setupResize = function () {
        var handle = document.getElementById('mcResizeHandle');
        if (!handle) return;

        var self = this;
        var startY, startH;

        function onMove(e) {
            var clientY = e.touches ? e.touches[0].clientY : e.clientY;
            var delta   = startY - clientY;
            var newH    = Math.min(MAX_PANEL_H, Math.max(MIN_PANEL_H, startH + delta));
            self.panelHeight = newH;
            self.panel.style.height = newH + 'px';
            document.body.style.paddingBottom = newH + 'px';
        }

        function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            // Re-enable page text selection after the drag ends.
            document.body.classList.remove('mc-resizing');
            if (self.chart) self.chart.resize();
        }

        handle.addEventListener('mousedown', function (e) {
            // Block the browser from text-selecting the page while dragging.
            e.preventDefault();
            document.body.classList.add('mc-resizing');
            startY = e.clientY; startH = self.panelHeight;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        handle.addEventListener('touchstart', function (e) {
            document.body.classList.add('mc-resizing');
            startY = e.touches[0].clientY; startH = self.panelHeight;
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onUp);
        }, { passive: true });
    };

    /* ── Hook into Existing ChartSystem ──────────────────────── */

    MultiChartSystem.prototype._hookChartSystem = function () {
        var self  = this;
        var tries = 0;

        var iv = setInterval(function () {
            tries++;
            if (tries > 60) { clearInterval(iv); return; } // give up after 30 s

            if (!window.ChartSystem) return;
            clearInterval(iv);

            window.ChartSystem.openChart = function (tagName, color, actualTagId) {
                self.addTag(tagName, actualTagId);
            };

            MC_Log.info('Hooked into ChartSystem.openChart');
        }, 500);
    };

    /* ── Color Pool ──────────────────────────────────────────── */

    MultiChartSystem.prototype._takeColor = function () {
        if (this.colorPool.length > 0) return this.colorPool.shift();
        // all used → recycle
        return COLORS[this.tags.size % COLORS.length];
    };

    MultiChartSystem.prototype._returnColor = function (c) {
        if (COLORS.indexOf(c) !== -1 && this.colorPool.indexOf(c) === -1) {
            this.colorPool.push(c);
        }
    };

    /* ── Add / Remove Tags ───────────────────────────────────── */

    MultiChartSystem.prototype.addTag = function (tagName, actualTagId) {
        // Create panel on first use (lazy init)
        if (!this.panel) this._createPanel();

        if (this.tags.has(tagName)) {
            this._toast(tagName + ' is already on the chart', '#f39c12');
            return;
        }
        if (this.tags.size >= MAX_TAGS) {
            this._toast('Maximum ' + MAX_TAGS + ' tags reached', '#e74c3c');
            return;
        }

        var color = this._takeColor();

        // Pad history with nulls so the new line starts "now"
        var padded = [];
        for (var i = 0; i < this.timeLabels.length; i++) padded.push(null);

        this.tags.set(tagName, {
            color: color,
            actualTagId: actualTagId,
            data: padded
        });

        this._renderChips();

        if (!this.isOpen) {
            this.open();
        } else {
            this._rebuildChart();
        }

        this._toast('Added: ' + tagName, color);
        MC_Log.info('Tag added:', tagName, '(' + this.tags.size + '/' + MAX_TAGS + ')');
    };

    MultiChartSystem.prototype.removeTag = function (tagName) {
        var info = this.tags.get(tagName);
        if (!info) return;

        this._returnColor(info.color);
        this.tags.delete(tagName);
        this._renderChips();

        if (this.tags.size === 0) {
            this.close();
        } else {
            this._rebuildChart();
        }

        MC_Log.info('Tag removed:', tagName);
    };

    MultiChartSystem.prototype.clearAll = function () {
        var self = this;
        this.tags.forEach(function (info) { self._returnColor(info.color); });
        this.tags.clear();
        this.timeLabels = [];
        this._renderChips();
        this.close();
    };

    /* ── Open Old Historical Modal ───────────────────────────── */

    /* ── Chips (tag badges in toolbar) ───────────────────────── */

    MultiChartSystem.prototype._renderChips = function () {
        var area = document.getElementById('mcTagsArea');
        var hint = document.getElementById('mcHint');
        var countEl = document.getElementById('mcCount');
        if (!area) return;

        // Update counter
        if (countEl) countEl.textContent = this.tags.size + '/' + MAX_TAGS;

        // Show hint when empty
        if (this.tags.size === 0) {
            area.innerHTML = '<span class="mc-hint" id="mcHint">Click any tag value to add it here</span>';
            return;
        }

        area.innerHTML = '';
        var self = this;

        this.tags.forEach(function (info, name) {
            var chip = document.createElement('span');
            chip.className = 'mc-tag-chip';
            chip.style.borderColor = info.color;

            // Current value preview
            var curVal = '--';
            if (window.scadaClient) {
                var v = window.scadaClient.getTagValue(name);
                if (v !== null && v !== undefined) {
                    curVal = (typeof v === 'number' && !Number.isInteger(v)) ? v.toFixed(1) : v;
                }
            }

            chip.innerHTML =
                '<span class="mc-tag-dot" style="background:' + info.color + ';color:' + info.color + '"></span>' +
                '<span class="mc-tag-name">' + name + '</span>' +
                '<span class="mc-tag-val">' + curVal + '</span>' +
                '<span class="mc-tag-remove" data-mc-tag="' + name + '" title="Remove">\u00D7</span>';

            chip.querySelector('.mc-tag-remove').addEventListener('click', function (e) {
                e.stopPropagation();
                self.removeTag(name);
            });

            area.appendChild(chip);
        });
    };

    /* ── Panel Open / Close / Minimize ───────────────────────── */

    MultiChartSystem.prototype.open = function () {
        this.isOpen = true;
        this.isMinimized = false;
        this.panel.classList.add('mc-open');
        this.panel.classList.remove('mc-minimized');
        this.panel.style.height = this.panelHeight + 'px';
        document.body.classList.add('mc-panel-open');
        document.body.classList.remove('mc-panel-minimized');
        document.body.style.paddingBottom = this.panelHeight + 'px';

        this._startSampling();
        this._rebuildChart();
    };

    MultiChartSystem.prototype.close = function () {
        this.isOpen = false;
        this.panel.classList.remove('mc-open', 'mc-minimized');
        document.body.classList.remove('mc-panel-open', 'mc-panel-minimized');
        document.body.style.paddingBottom = '';

        this._stopSampling();
        this._destroyChart();

        // Reset state
        var self = this;
        this.tags.forEach(function (info) { self._returnColor(info.color); });
        this.tags.clear();
        this.timeLabels = [];
        this.isPaused = false;
        var pb = document.getElementById('mcPauseBtn');
        if (pb) pb.textContent = '\u23F8';
        this._renderChips();
    };

    MultiChartSystem.prototype._toggleMinimize = function () {
        this.isMinimized = !this.isMinimized;
        this.panel.classList.toggle('mc-minimized', this.isMinimized);
        document.body.classList.toggle('mc-panel-minimized', this.isMinimized);

        if (this.isMinimized) {
            document.body.style.paddingBottom = '44px';
        } else {
            document.body.style.paddingBottom = this.panelHeight + 'px';
            if (this.chart) this.chart.resize();
        }

        var btn = document.getElementById('mcMinBtn');
        if (btn) btn.textContent = this.isMinimized ? '\u25A1' : '\u2500';
    };

    MultiChartSystem.prototype._togglePause = function () {
        this.isPaused = !this.isPaused;
        var btn = document.getElementById('mcPauseBtn');
        if (btn) {
            btn.textContent = this.isPaused ? '\u25B6' : '\u23F8';
            btn.classList.toggle('mc-btn-active', this.isPaused);
        }
    };

    /* ── Sampling Timer ──────────────────────────────────────── */

    MultiChartSystem.prototype._startSampling = function () {
        this._stopSampling();
        var self = this;
        this.samplerTimer = setInterval(function () {
            if (self.isPaused || self.isMinimized || self.tags.size === 0) return;
            self._sample();
        }, SAMPLE_MS);
    };

    MultiChartSystem.prototype._stopSampling = function () {
        if (this.samplerTimer) {
            clearInterval(this.samplerTimer);
            this.samplerTimer = null;
        }
    };

    MultiChartSystem.prototype._sample = function () {
        var now   = new Date();
        var label = now.toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        });

        this.timeLabels.push(label);
        if (this.timeLabels.length > MAX_POINTS) this.timeLabels.shift();

        var chipNeedsUpdate = false;

        this.tags.forEach(function (info, tagName) {
            var value = null;
            if (window.scadaClient) {
                var raw = window.scadaClient.getTagValue(tagName);
                if (typeof raw === 'number') value = raw;
            }
            info.data.push(value);
            if (info.data.length > MAX_POINTS) info.data.shift();
            // Cache latest value for chip display
            info._lastVal = value;
        });

        this._updateChart();

        // Update chip values every 5 seconds
        if (now.getSeconds() % 5 === 0) this._renderChips();
    };

    /* ── Chart.js Management ─────────────────────────────────── */

    MultiChartSystem.prototype._destroyChart = function () {
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    };

    MultiChartSystem.prototype._rebuildChart = function () {
        this._destroyChart();
        if (this.tags.size === 0) return;

        var datasets = [];
        this.tags.forEach(function (info, name) {
            datasets.push({
                label: name,
                data: info.data.slice(),
                borderColor: info.color,
                backgroundColor: hexToRgba(info.color, 0.08),
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHoverBackgroundColor: info.color,
                tension: 0.3,
                fill: false,
                spanGaps: true
            });
        });

        var ctx = this.canvas.getContext('2d');

        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: this.timeLabels.slice(),
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        display: false  // chips serve as legend
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        backgroundColor: 'rgba(10, 14, 23, 0.92)',
                        titleColor: '#00d4ff',
                        titleFont: { size: 11 },
                        bodyColor: '#e0e0e0',
                        bodyFont: { size: 11 },
                        borderColor: 'rgba(0, 212, 255, 0.2)',
                        borderWidth: 1,
                        padding: 10,
                        cornerRadius: 6,
                        callbacks: {
                            label: function (ctx) {
                                var v = ctx.parsed.y;
                                var label = ctx.dataset.label || '';
                                return ' ' + label + ': ' + (v !== null && v !== undefined ? v.toFixed(2) : '--');
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: {
                            color: '#ffffff',
                            maxTicksLimit: 10,
                            font: { size: 12, weight: '600' },
                            maxRotation: 0
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.18)',
                            drawBorder: false
                        }
                    },
                    y: {
                        ticks: {
                            color: '#ffffff',
                            font: { size: 12, weight: '600' },
                            padding: 8
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.18)',
                            drawBorder: false
                        }
                    }
                }
            }
        });
    };

    MultiChartSystem.prototype._updateChart = function () {
        if (!this.chart) {
            this._rebuildChart();
            return;
        }

        // Sync labels
        this.chart.data.labels = this.timeLabels.slice();

        // Sync each dataset's data array
        var i = 0;
        this.tags.forEach(function (info) {
            if (this.chart.data.datasets[i]) {
                this.chart.data.datasets[i].data = info.data.slice();
            }
            i++;
        }.bind(this));

        this.chart.update('none');  // no animation for performance
    };

    /* ── Toast ────────────────────────────────────────────────── */

    MultiChartSystem.prototype._toast = function (msg, bg) {
        bg = bg || '#3498db';
        var el = document.createElement('div');
        el.className = 'mc-toast';
        el.style.background = bg;
        el.textContent = msg;
        document.body.appendChild(el);

        setTimeout(function () {
            el.classList.add('mc-toast-out');
            setTimeout(function () { el.remove(); }, 300);
        }, 2000);
    };

    /* ── Helpers ──────────────────────────────────────────────── */

    function hexToRgba(hex, alpha) {
        var r = parseInt(hex.slice(1, 3), 16);
        var g = parseInt(hex.slice(3, 5), 16);
        var b = parseInt(hex.slice(5, 7), 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }

    /* ── Bootstrap ───────────────────────────────────────────── */

    function boot() {
        if (window._mcInstance) return;
        window._mcInstance = new MultiChartSystem();
        window.MultiChart  = window._mcInstance;
        MC_Log.info('Multi-Tag Chart System ready');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(boot, 500);
        });
    } else {
        setTimeout(boot, 500);
    }

})();
