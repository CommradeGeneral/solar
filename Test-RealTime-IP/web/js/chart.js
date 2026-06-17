// 
//  Modern Real-Time & Historical Chart System
// Integrated with SCADA Server (actual_tag_id support)
// 

// Disable chart system on pages that opt out
if (
    window.DISABLE_CHARTS === true ||
    document.documentElement?.dataset?.disableCharts === 'true' ||
    document.body?.dataset?.disableCharts === 'true'
) {
    console.info(' Chart System disabled for this page.');
} else if (typeof window.CHART_SYSTEM_LOADED !== 'undefined') {
    console.warn(' Chart System already loaded, skipping...');
} else {
window.CHART_SYSTEM_LOADED = true;

// 
// Configuration
// 4049474

const VIEWPORT_CONFIG = {
    maxDays: 2,
    minMinutes: 40,
    defaultDays: 2,
    minWidthPercent: 1,
};

const ZOOM_CONFIG = {
    minMinutes: 20,        // allow zooming down to near-raw detail
    maxMinutes: 2880,     // fallback only; zoom-out cap is the full selected range
    defaultMinutes: 2880,
    zoomStep: 1.2,
    panSpeed: 0.1
};

// All raw points are cached in memory once; the chart only ever draws up to
// this many points (min/max decimated) so Chart.js stays smooth. Raise it if
// your machine handles more without lag.
const MAX_DISPLAY_POINTS = 3000;

// Hard-stop exports above this size to avoid browser hangs and unstable Excel
// generation for very large historical ranges.
const EXPORT_MAX_POINTS = 50000;
const EXPORT_LIMIT_MESSAGE = 'Export limit exceeded. Maximum allowed range is 50000 Points. Please reduce the selected time range and try again.';

function inferDefaultApiBaseUrl() {
    // Default: call the data server directly.
    // Local dev convention: UI on :5000, API on :3000.
    try {
        const { protocol, hostname, port, origin } = window.location;
        const islocalhost = hostname === '192.168.1.2';
        if (islocalhost) {
            return `${protocol}//${hostname}:3000`;
        }
        return origin;
    } catch {
        return window.location.origin;
    }
}

const API_CONFIG = {
    // Override from HTML if needed: window.API_BASE_URL = 'http://192.168.1.2:3000'
    baseURL: (window.API_BASE_URL || inferDefaultApiBaseUrl()),
    endpoints: {
        history: '/history'
    }
};


const CHART_CONFIG = {
    maxDataPoints: 60,
    updateInterval: 1000,
    colors: {
        primary: '#3498db',
        success: '#2ecc71',
        warning: '#f39c12',
        danger: '#e74c3c',
        purple: '#9b59b6',
        info: '#17a2b8'
    }
};

// 
// Global Chart Storage & Timeline State
// 

const charts = {};
const chartData = {};
let currentChartMode = 'realtime';
let currentOpenField = null;

const timelineState = {
    fullRange: { start: null, end: null },
    viewportRange: { start: null, end: null },
    currentResolution: null,
    isLoading: false,
    fullData: {
        labels: [],
        values: [],
        timestamps: [],
        loaded: false
    },
    lastViewportDuration: 2880 * 60 * 1000
};

// 
// Resolution Calculator
// 

function calculateResolution(startDate, endDate) {
    const timeRangeMs = new Date(endDate) - new Date(startDate);
    const days = timeRangeMs / (24 * 60 * 60 * 1000);
    const hours = timeRangeMs / (60 * 60 * 1000);
    
    let resolution, label;
    
    if (days > 180) {
        resolution = '1d'; label = 'Daily';
    } else if (days > 30) {
        resolution = '6h'; label = '6-Hour';
    } else if (days > 7) {
        resolution = '1h'; label = 'Hourly';
    } else if (days > 1) {
        resolution = '15m'; label = '15-Min';
    } else if (hours > 6) {
        resolution = '5m'; label = '5-Min';
    } else if (hours > 1) {
        resolution = '1m'; label = '1-Min';
    } else {
        resolution = '10s'; label = '10-Sec';
    }
    
    return { interval: resolution, label: label };
}

// 
// Smart Viewport Calculator
// 

function calculateSmartViewport(fullStartDate, fullEndDate) {
    const fullStart = new Date(fullStartDate).getTime();
    const fullEnd = new Date(fullEndDate).getTime();
    const totalRangeMs = fullEnd - fullStart;
    const totalDays = totalRangeMs / (24 * 60 * 60 * 1000);
    
    let viewportDays = Math.min(VIEWPORT_CONFIG.defaultDays, totalDays);
    const viewportMs = viewportDays * 24 * 60 * 60 * 1000;
    
    const viewportStart = new Date(fullEnd - viewportMs);
    const viewportEnd = new Date(fullEnd);
    
    return {
        start: viewportStart,
        end: viewportEnd,
        days: viewportDays
    };
}

// 
//  Get actual_tag_id from scadaClient or element
// 

function getActualTagId(fieldName) {
    // 1. Try from chartData (stored when opening modal)
    if (chartData[fieldName] && chartData[fieldName].actualTagId) {
        return chartData[fieldName].actualTagId;
    }
    
    // 2. Try from scadaClient
    if (window.scadaClient && window.scadaClient.getActualTagId) {
        const tagId = window.scadaClient.getActualTagId(fieldName);
        if (tagId) return tagId;
    }
    
    // 3. Try from DOM element data attribute
    const element = document.querySelector(`.${CSS.escape(fieldName)}`);
    if (element) {
        const attrId = element.getAttribute('data-actual-tag-id');
        if (attrId) return parseInt(attrId);
    }
    
    console.warn(` No actual_tag_id found for: ${fieldName}`);
    return null;
}

// 
// Create Modal
// 

function createChartModal() {
    if (document.getElementById('chartModal')) return;
    
    const modalHTML = `
        <div id="chartModal" class="chart-modal">
            <div class="chart-modal-content">
                <div class="chart-modal-header">
                    <h2 id="chartTitle"> Real-Time Chart</h2>
                    <div class="chart-controls">
                        <div style="display: inline-flex; background: rgba(52, 152, 219, 0.1); border-radius: 8px; padding: 5px; margin-right: 10px;">
                            <button id="modeRealtime" class="chart-btn mode-btn active" style="padding: 8px 15px;">
                                 Real-time
                            </button>
                            <button id="modeHistorical" class="chart-btn mode-btn" style="padding: 8px 15px;">
                                 Historical
                            </button>
                        </div>
                        
                        <button id="resetZoom" class="chart-btn"> Reset</button>
                        <button id="toggleGrid" class="chart-btn"> Grid</button>
                        <button id="downloadChart" class="chart-btn"> Save</button>
                         <button id="exportExcel" class="chart-btn"> Excel</button>
                         <button id="closeModal" class="chart-btn close-btn">X</button>
                    </div>
                </div>
                
                <div id="historicalControls" class="historical-controls" style="display: none;">
                    <div style="display: flex; gap: 15px; align-items: end; flex-wrap: wrap;">
                        <div>
                            <label> Start Date:</label>
                            <input type="date" id="startDate" class="date-input">
                        </div>
                        <div>
                            <label> Start Time:</label>
                            <input type="time" id="startTime" class="time-input" value="00:00">
                        </div>
                        <div>
                            <label> End Date:</label>
                            <input type="date" id="endDate" class="date-input">
                        </div>
                        <div>
                            <label> End Time:</label>
                            <input type="time" id="endTime" class="time-input" value="23:59">
                        </div>
                        <button id="loadHistorical" class="chart-btn" style="padding: 10px 25px; background: linear-gradient(135deg, #2ecc71 0%, #27ae60 100%);">
                            Load Data
                        </button>
                        <div id="loadingIndicator" style="display: none; color: #3498db; font-weight: 600;">
                            Loading...
                        </div>
                        <div id="tagIdDisplay" style="color: #95a5a6; font-size: 12px; padding: 10px;">
                            Tag ID: <span id="currentTagId">--</span>
                        </div>
                    </div>
                </div>
                
                <div class="chart-stats" style="padding: 10px 0; gap: 10px;">
                    <div class="stat-box" style="padding: 6px 12px;">
                        <span class="stat-label" style="font-size: 10px;">Max</span>
                        <span id="statMax" class="stat-value" style="font-size: 16px;">-</span>
                    </div>
                    <div class="stat-box" style="padding: 6px 12px;">
                        <span class="stat-label" style="font-size: 10px;">Min</span>
                        <span id="statMin" class="stat-value" style="font-size: 16px;">-</span>
                    </div>
                    <div class="stat-box" style="padding: 6px 12px;">
                        <span class="stat-label" style="font-size: 10px;">Avg</span>
                        <span id="statAvg" class="stat-value" style="font-size: 16px;">-</span>
                    </div>
                    <div class="stat-box" id="statCurrentBox" style="padding: 6px 12px;">
                        <span class="stat-label" style="font-size: 10px;">Current</span>
                        <span id="statCurrent" class="stat-value" style="font-size: 16px;">-</span>
                    </div>
                    <div class="stat-box" id="statCountBox" style="padding: 6px 12px;">
                        <span class="stat-label" style="font-size: 10px;">Points</span>
                        <span id="statCount" class="stat-value" style="font-size: 16px;">0</span>
                    </div>
                </div>
                
                <div class="chart-container" style="margin-bottom: 12px;">
                    <canvas id="mainChart"></canvas>
                </div>
                
                <div id="timelineSliderContainer" class="timeline-slider-modern" style="display: none;">
                    <div class="timeline-header">
                        <div class="timeline-title">
                            <span class="timeline-icon"></span>
                            TIMELINE NAVIGATOR
                            <span style="margin-left: 10px; font-size: 9px; color: #7f8c8d;">
                                (Scroll=Zoom | Drag=Pan)
                            </span>
                        </div>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <div id="zoomDurationLabel" class="resolution-badge" style="background: linear-gradient(135deg, #e74c3c, #c0392b);">
                                2 days
                            </div>
                            <div id="resolutionLabel" class="resolution-badge">
                                Auto
                            </div>
                        </div>
                    </div>
                    
                    <div class="timeline-track">
                        <div class="timeline-background">
                            <div class="timeline-label-start" id="fullRangeStart">--</div>
                            <div class="timeline-label-end" id="fullRangeEnd">--</div>
                            
                            <div class="timeline-viewport" id="viewportRect">
                                <div class="viewport-info">
                                    <span id="viewportStart">--</span>
                                    <span>/</span>
                                    <span id="viewportEnd">--</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="chart-footer" style="padding: 8px 0;">
                    <div class="time-range">
                        <label style="font-size: 12px;"> Range:</label>
                        <select id="timeRange" style="padding: 5px 10px; font-size: 12px;">
                            <option value="30">30s</option>
                            <option value="60" selected>60s</option>
                            <option value="120">2min</option>
                            <option value="300">5min</option>
                        </select>
                    </div>
                    <div class="chart-legend">
                        <label style="font-size: 12px;">
                            <input type="checkbox" id="showLine" checked> Line
                        </label>
                        <label style="font-size: 12px;">
                            <input type="checkbox" id="showFill" checked> Fill
                        </label>
                        <label style="font-size: 12px;">
                            <input type="checkbox" id="showPoints" checked> Points
                        </label>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHTML);
    attachModalEvents();
}

// 
// Modal Event Handlers
// 

function attachModalEvents() {
    document.getElementById('closeModal').addEventListener('click', closeChartModal);
    
    document.getElementById('modeRealtime').addEventListener('click', () => switchChartMode('realtime'));
    document.getElementById('modeHistorical').addEventListener('click', () => switchChartMode('historical'));
    
    document.getElementById('loadHistorical').addEventListener('click', () => {
        initializeTimeline();
    });
    
    document.getElementById('resetZoom').addEventListener('click', () => {
        if (charts.main) {
            if (currentChartMode === 'historical') {
                if (timelineState.fullRange.start && timelineState.fullRange.end) {
                    // Reset to the full-range overview (rendered locally from cache).
                    timelineState.viewportRange.start = new Date(timelineState.fullRange.start);
                    timelineState.viewportRange.end = new Date(timelineState.fullRange.end);
                    timelineState.lastViewportDuration =
                        timelineState.fullRange.end - timelineState.fullRange.start;

                    updateTimelineLabels();
                    updateViewportPosition();
                    updateViewportFromFullData();
                }
            } else {
                charts.main.resetZoom();
            }
        }
    });
    
    document.getElementById('toggleGrid').addEventListener('click', () => {
        if (charts.main) {
            const gridDisplay = charts.main.options.scales.x.grid.display;
            charts.main.options.scales.x.grid.display = !gridDisplay;
            charts.main.options.scales.y.grid.display = !gridDisplay;
            charts.main.update();
        }
    });
    
    document.getElementById('downloadChart').addEventListener('click', () => {
        if (charts.main) {
            const link = document.createElement('a');
            link.download = `chart_${Date.now()}.png`;
            link.href = charts.main.toBase64Image();
            link.click();
        }
    });
    
    document.getElementById('exportExcel').addEventListener('click', () => {
        exportChartToExcel();
    });
    
    document.getElementById('timeRange').addEventListener('change', (e) => {
        CHART_CONFIG.maxDataPoints = parseInt(e.target.value);
        if (currentOpenField && chartData[currentOpenField]) {
            const data = chartData[currentOpenField];
            while (data.labels.length > CHART_CONFIG.maxDataPoints) {
                data.labels.shift();
                data.values.shift();
            }
            updateChart();
        }
        updateChartStats();
    });
    
    ['showLine', 'showFill', 'showPoints'].forEach(id => {
        document.getElementById(id).addEventListener('change', updateChartDisplay);
    });
    
    document.getElementById('chartModal').addEventListener('click', (e) => {
        if (e.target.id === 'chartModal') {
            closeChartModal();
        }
    });
    
    setDefaultDates();
}

function switchChartMode(mode) {
    currentChartMode = mode;
    
    const realtimeBtn = document.getElementById('modeRealtime');
    const historicalBtn = document.getElementById('modeHistorical');
    const historicalControls = document.getElementById('historicalControls');
    const sliderContainer = document.getElementById('timelineSliderContainer');
    const statCurrentBox = document.getElementById('statCurrentBox');
    const statCountBox = document.getElementById('statCountBox');
    
    if (mode === 'realtime') {
        realtimeBtn.classList.add('active');
        historicalBtn.classList.remove('active');
        historicalControls.style.display = 'none';
        
        if (sliderContainer) {
            sliderContainer.style.display = 'none';
        }
        
        if (statCurrentBox) statCurrentBox.style.display = 'flex';
        if (statCountBox) statCountBox.style.display = 'flex';
        
        if (currentOpenField && chartData[currentOpenField]) {
            chartData[currentOpenField].labels = [];
            chartData[currentOpenField].values = [];
            updateChart();
        }

        realtimeLatest = null;
        startRealtimeSampler();

    } else {
        stopRealtimeSampler();
        realtimeBtn.classList.remove('active');
        historicalBtn.classList.add('active');
        historicalControls.style.display = 'block';
        
        if (statCurrentBox) statCurrentBox.style.display = 'none';
        
        // Show actual_tag_id
        const tagId = getActualTagId(currentOpenField);
        const tagIdDisplay = document.getElementById('currentTagId');
        if (tagIdDisplay) {
            tagIdDisplay.textContent = tagId || 'Not Available';
        }
    }
}

function setDefaultDates() {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    document.getElementById('startDate').value = yesterday;
    document.getElementById('endDate').value = today;
}

// 
// Initialize Timeline & Load Historical Data
// 

async function initializeTimeline() {
    const startDate = document.getElementById('startDate').value;
    const endDate = document.getElementById('endDate').value;
    const startTime = document.getElementById('startTime').value;
    const endTime = document.getElementById('endTime').value;
    
    if (!startDate || !endDate) {
        alert(' Please select start and end dates');
        return;
    }
    
    //  Check for actual_tag_id
    const tagId = getActualTagId(currentOpenField);
    if (!tagId) {
        alert('This tag does not have an actual_tag_id for historical data.\nOnly analog tags (Int, Real, DInt, etc.) can have historical charts.');
        return;
    }
    
    const startDateObj = new Date(`${startDate}T${startTime || '00:00'}:00`);
    const endDateObj = new Date(`${endDate}T${endTime || '23:59'}:59`);
    
    const now = new Date();
    if (endDateObj > now) {
        endDateObj.setTime(now.getTime());
    }
    
    timelineState.fullRange.start = new Date(startDateObj);
    timelineState.fullRange.end = new Date(endDateObj);

    // Initial view = the whole selected range (overview). Zooming/panning
    // re-fetches finer detail for the visible window (detail-on-demand).
    timelineState.viewportRange.start = new Date(startDateObj);
    timelineState.viewportRange.end = new Date(endDateObj);
    timelineState.lastViewportDuration = endDateObj - startDateObj;
    
    console.log(` Timeline initialized:
        Field: ${currentOpenField}
        actual_tag_id: ${tagId}
        Full: ${startDateObj.toLocaleString()} - ${endDateObj.toLocaleString()}`);
    
    const sliderContainer = document.getElementById('timelineSliderContainer');
    if (sliderContainer && currentChartMode === 'historical') {
        sliderContainer.style.display = 'block';
        updateTimelineLabels();
    }
    
    await loadHistoricalData();
}

// Guards against rendering a stale response if loadHistoricalData is
// triggered again (e.g. re-opening the chart) before the previous finishes.
let historyLoadSeq = 0;

async function loadHistoricalData() {
    const mySeq = ++historyLoadSeq;
    timelineState.isLoading = true;

    try {
        if (!currentOpenField || !chartData[currentOpenField]) {
            alert('No chart data available');
            timelineState.isLoading = false;
            return;
        }
        
        //  Get actual_tag_id
        const tagId = getActualTagId(currentOpenField);
        
        if (!tagId) {
            alert('No actual_tag_id available for this field');
            timelineState.isLoading = false;
            return;
        }
        
        if (!timelineState.fullRange.start || !timelineState.fullRange.end) {
            alert(' Full range not initialized');
            timelineState.isLoading = false;
            return;
        }

        // Drop the previously cached range BEFORE loading a new one, so repeated
        // "Load Data" clicks never pile up old data in memory.
        timelineState.fullData.timestamps = [];
        timelineState.fullData.values = [];
        timelineState.fullData.labels = [];
        timelineState.fullData.loaded = false;

        // Fetch the WHOLE selected range once (raw, no resolution param) and
        // cache it in memory. All zoom/pan afterwards is done locally from this
        // cache - no further API calls.
        const startDateObj = new Date(timelineState.fullRange.start);
        const endDateObj = new Date(timelineState.fullRange.end);

        const startDay = startDateObj.getDate();
        const startMonth = startDateObj.getMonth() + 1;
        const startYear = startDateObj.getFullYear();
        const startHour = startDateObj.getHours();
        const startMinute = startDateObj.getMinutes();

        const endDay = endDateObj.getDate();
        const endMonth = endDateObj.getMonth() + 1;
        const endYear = endDateObj.getFullYear();
        const endHour = endDateObj.getHours();
        const endMinute = endDateObj.getMinutes();

        //  Build API URL with actual_tag_id. format=bin asks the server for a
        //  compact binary payload (Float64 [t,v] pairs) instead of JSON - ~4x
        //  smaller and no JSON.parse cost, so the browser handles far more points.
        const apiUrl = `${API_CONFIG.baseURL}${API_CONFIG.endpoints.history}?` +
                       `tag_id=${tagId}&` +
                      `start_day=${startDay}&start_month=${startMonth}&start_year=${startYear}&start_hour=${startHour}&start_minute=${startMinute}&` +
                      `end_day=${endDay}&end_month=${endMonth}&end_year=${endYear}&end_hour=${endHour}&end_minute=${endMinute}&` +
                      `format=bin`;

        console.log(` API Request:
            URL: ${apiUrl}
            actual_tag_id: ${tagId}
            Field: ${currentOpenField}`);
        
        const loadingIndicator = document.getElementById('loadingIndicator');
        if (loadingIndicator) loadingIndicator.style.display = 'block';
        
        const response = await fetch(apiUrl, {
            method: 'GET',
            credentials: 'include'
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                throw new Error('HTTP 401 - not authenticated. Please log in again.');
            }
            throw new Error(`HTTP ${response.status}`);
        }
        
        const contentType = response.headers.get('content-type') || '';

        // Cache the whole range as parallel numeric arrays. Timestamps are kept
        // as epoch-ms numbers (not Date objects) so a million points stay light
        // (~16 MB) and slicing on zoom/pan is fast. Labels are NOT built here -
        // they are formatted lazily only for the few thousand displayed points.
        let timestamps;
        let values;

        if (contentType.includes('application/octet-stream')) {
            // Binary path: Float64 pairs [t0, v0, t1, v1, ...] - no JSON.parse,
            // no intermediate objects, so huge datasets stay fast and light.
            const buf = await response.arrayBuffer();
            if (mySeq !== historyLoadSeq) return;

            const arr = new Float64Array(buf);
            const k = arr.length >> 1;
            timestamps = new Array(k);
            values = new Array(k);
            for (let i = 0; i < k; i++) {
                timestamps[i] = arr[2 * i];
                values[i] = arr[2 * i + 1];
            }
        } else {
            // JSON fallback (server that doesn't support format=bin).
            const responseData = await response.json();
            if (mySeq !== historyLoadSeq) return;

            const historicalData = Array.isArray(responseData) ? responseData : (responseData.data || []);
            const n = historicalData.length;
            timestamps = new Array(n);
            values = new Array(n);
            let k = 0;
            for (let i = 0; i < n; i++) {
                const point = historicalData[i];
                const dateTimeValue = point.DateTime || point.datetime;
                const value = point.Value !== undefined ? point.Value : point.value;
                if (!dateTimeValue) continue;
                const t = new Date(dateTimeValue).getTime();
                if (Number.isNaN(t)) continue;
                timestamps[k] = t;
                values[k] = parseFloat(value) || 0;
                k++;
            }
            timestamps.length = k;
            values.length = k;
        }

        if (!values || values.length === 0) {
            console.warn(' No data received');
            if (loadingIndicator) loadingIndicator.style.display = 'none';
            timelineState.isLoading = false;
            return;
        }

        timelineState.fullData.timestamps = timestamps; // ascending epoch-ms
        timelineState.fullData.values = values;
        timelineState.fullData.labels = [];             // built lazily per view
        timelineState.fullData.loaded = true;

        console.log(`Cached ${values.length} raw points in memory`);

        if (mySeq === historyLoadSeq) updateViewportFromFullData();

    } catch (error) {
        console.error('?Error:', error);
        alert(`?Error: ${error.message}`);
    } finally {
        if (mySeq === historyLoadSeq) {
            const loadingIndicator = document.getElementById('loadingIndicator');
            if (loadingIndicator) loadingIndicator.style.display = 'none';
            timelineState.isLoading = false;
        }
    }
}

// Format an epoch-ms timestamp into a chart label (built lazily, only for
// the points actually displayed).
function formatTimestampLabel(t) {
    return new Date(t).toLocaleString('en-GB', {
        year: '2-digit',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

// First index whose timestamp is >= target (ascending array).
function lowerBound(arr, target) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] < target) lo = mid + 1; else hi = mid;
    }
    return lo;
}

// First index whose timestamp is > target (ascending array).
function upperBound(arr, target) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= target) lo = mid + 1; else hi = mid;
    }
    return lo;
}

// Reduce the slice [lo, hi) to at most maxPoints for display using LTTB
// (Largest Triangle Three Buckets). It keeps the visual shape cleaner than
// min/max buckets when zoomed far out on noisy data.
function decimateForDisplay(ts, vals, lo, hi, maxPoints) {
    const labels = [];
    const values = [];
    const count = hi - lo;

    if (count <= 0) return { labels, values };

    if (count <= maxPoints) {
        for (let i = lo; i < hi; i++) {
            labels.push(formatTimestampLabel(ts[i]));
            values.push(vals[i]);
        }
        return { labels, values };
    }

    const threshold = Math.max(3, maxPoints);
    const bucketSize = (count - 2) / (threshold - 2);
    let selectedIndex = lo;

    labels.push(formatTimestampLabel(ts[selectedIndex]));
    values.push(vals[selectedIndex]);

    for (let bucket = 0; bucket < threshold - 2; bucket++) {
        const rangeStart = lo + 1 + Math.floor(bucket * bucketSize);
        const rangeEnd = lo + 1 + Math.floor((bucket + 1) * bucketSize);
        const nextRangeStart = lo + 1 + Math.floor((bucket + 1) * bucketSize);
        const nextRangeEnd = lo + 1 + Math.floor((bucket + 2) * bucketSize);

        const clampedRangeEnd = Math.min(rangeEnd, hi - 1);
        const clampedNextStart = Math.min(nextRangeStart, hi - 1);
        const clampedNextEnd = Math.min(nextRangeEnd, hi);

        let avgX = 0;
        let avgY = 0;
        const avgCount = clampedNextEnd - clampedNextStart;
        if (avgCount > 0) {
            for (let i = clampedNextStart; i < clampedNextEnd; i++) {
                avgX += ts[i];
                avgY += vals[i];
            }
            avgX /= avgCount;
            avgY /= avgCount;
        } else {
            avgX = ts[hi - 1];
            avgY = vals[hi - 1];
        }

        const selectedX = ts[selectedIndex];
        const selectedY = vals[selectedIndex];
        let maxArea = -1;
        let maxAreaIndex = rangeStart;

        for (let i = rangeStart; i < clampedRangeEnd; i++) {
            const area = Math.abs(
                (selectedX - avgX) * (vals[i] - selectedY) -
                (selectedX - ts[i]) * (avgY - selectedY)
            );
            if (area > maxArea) {
                maxArea = area;
                maxAreaIndex = i;
            }
        }

        labels.push(formatTimestampLabel(ts[maxAreaIndex]));
        values.push(vals[maxAreaIndex]);
        selectedIndex = maxAreaIndex;
    }

    labels.push(formatTimestampLabel(ts[hi - 1]));
    values.push(vals[hi - 1]);

    return { labels, values };
}

function updateViewportFromFullData() {
    if (!timelineState.fullData.loaded) return;
    if (!timelineState.viewportRange.start || !timelineState.viewportRange.end) return;

    const ts = timelineState.fullData.timestamps;
    const vals = timelineState.fullData.values;

    const viewportStart = timelineState.viewportRange.start.getTime();
    const viewportEnd = timelineState.viewportRange.end.getTime();

    // Binary-search the visible slice, then decimate it for display.
    const lo = lowerBound(ts, viewportStart);
    const hi = upperBound(ts, viewportEnd);

    const { labels, values } = decimateForDisplay(ts, vals, lo, hi, MAX_DISPLAY_POINTS);

    const fieldData = chartData[currentOpenField];
    if (fieldData) {
        fieldData.labels = labels;
        fieldData.values = values;
    }

    if (charts.main) {
        charts.main.data.labels = labels;
        charts.main.data.datasets[0].data = values;

        // Clean thin line for historical: no area fill, no per-point dots and
        // no curve smoothing - otherwise dense data renders as a solid "block".
        const ds = charts.main.data.datasets[0];
        ds.fill = false;
        ds.pointRadius = 0;
        ds.borderWidth = 1.2;
        ds.tension = 0;

        if (charts.main.resetZoom) {
            charts.main.resetZoom('none');
        }

        charts.main.options.scales.x.min = undefined;
        charts.main.options.scales.x.max = undefined;

        charts.main.update('none');
    }

    // Reflect how many raw points fall in the current window.
    const resLabel = document.getElementById('resolutionLabel');
    if (resLabel) {
        resLabel.textContent = `${(hi - lo).toLocaleString()} pts`;
    }

    updateChartStats();
}

// 
// Open Chart Modal -  Now with actual_tag_id
// 

function openChartModal(fieldName, color, actualTagId) {
    currentOpenField = fieldName;
    
    // Reset state
    timelineState.fullRange.start = null;
    timelineState.fullRange.end = null;
    timelineState.viewportRange.start = null;
    timelineState.viewportRange.end = null;
    timelineState.fullData.labels = [];
    timelineState.fullData.values = [];
    timelineState.fullData.timestamps = [];
    timelineState.fullData.loaded = false;
    timelineState.lastViewportDuration = 2880 * 60 * 1000;
    
    const sliderContainer = document.getElementById('timelineSliderContainer');
    if (sliderContainer) {
        sliderContainer.style.display = 'none';
    }
    
    //  Get actual_tag_id if not provided
    if (!actualTagId) {
        actualTagId = getActualTagId(fieldName);
    }
    
    if (!chartData[fieldName]) {
        chartData[fieldName] = {
            labels: [],
            values: [],
            color: color || CHART_CONFIG.colors.primary,
            actualTagId: actualTagId //  Store actual_tag_id
        };
    } else {
        chartData[fieldName].labels = [];
        chartData[fieldName].values = [];
        chartData[fieldName].color = color || chartData[fieldName].color;
        chartData[fieldName].actualTagId = actualTagId; //  Update actual_tag_id
    }
    
    console.log(` Opening chart for: ${fieldName}, actual_tag_id: ${actualTagId}`);
    
    // Ensure modal exists (some pages render content dynamically / user may click early)
    if (!document.getElementById('chartModal')) {
        try { createChartModal(); } catch (e) { console.warn('Failed to create chart modal', e); }
    }

    const modalEl = document.getElementById('chartModal');
    const titleEl = document.getElementById('chartTitle');

    if (!modalEl || !titleEl) {
        console.warn('Chart modal elements missing; cannot open chart.', { modalEl, titleEl });
        return;
    }

    modalEl.style.display = 'flex';
    titleEl.textContent = ` ${formatFieldName(fieldName)}`;
    
    switchChartMode('realtime');
    createChart(fieldName);
    
    if (!window.viewportDragInitialized) {
        setTimeout(() => {
            initializeViewportDrag();
            window.viewportDragInitialized = true;
        }, 500);
    }
}

// 
// Create Chart
// 

function createChart(fieldName) {
    const canvas = document.getElementById('mainChart');
    if (!canvas) {
        console.warn('Chart canvas #mainChart not found; aborting chart creation.');
        return;
    }
    const ctx = canvas.getContext('2d');
    
    if (charts.main) {
        charts.main.destroy();
    }
    
    const data = chartData[fieldName];
    
    charts.main = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.labels,
            datasets: [{
                label: formatFieldName(fieldName),
                data: data.values,
                borderColor: data.color,
                backgroundColor: hexToRgba(data.color, 0.1),
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointRadius: 3,
                pointHoverRadius: 6,
                pointBackgroundColor: data.color,
                pointBorderColor: '#fff',
                pointBorderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        color: '#ecf0f1',
                        font: { size: 13, weight: '600' },
                        padding: 10
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.85)',
                    titleColor: '#3498db',
                    bodyColor: '#ecf0f1',
                    borderColor: '#3498db',
                    borderWidth: 2,
                    padding: 12,
                    displayColors: true,
                    callbacks: {
                        label: function(context) {
                            return `${context.dataset.label}: ${context.parsed.y.toFixed(2)}`;
                        }
                    }
                },
                zoom: {
                    zoom: {
                        wheel: { enabled: false },
                        pinch: { enabled: false },
                        mode: 'x'
                    },
                    pan: {
                        enabled: false,
                        mode: 'x'
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        display: true,
                        color: 'rgba(255, 255, 255, 0.15)',
                        lineWidth: 1
                    },
                    ticks: {
                        color: '#ecf0f1',
                        font: { size: 11, weight: '600' },
                        maxRotation: 45,
                        autoSkip: true,
                        maxTicksLimit: 12
                    },
                    title: {
                        display: true,
                        text: 'Time',
                        color: '#3498db',
                        font: { size: 13, weight: 'bold' }
                    }
                },
                y: {
                    grid: {
                        display: true,
                        color: 'rgba(255, 255, 255, 0.15)',
                        lineWidth: 1
                    },
                    ticks: {
                        color: '#ecf0f1',
                        font: { size: 11, weight: '600' },
                        callback: function(value) {
                            return value.toFixed(2);
                        }
                    },
                    title: {
                        display: true,
                        text: 'Value',
                        color: '#3498db',
                        font: { size: 13, weight: 'bold' }
                    }
                }
            },
            animation: {
                duration: 300
            }
        }
    });
    
    updateChartStats();
    setupCustomWheelZoom(canvas);
    setupLeftClickPan(canvas);
}

// 
// Wheel Zoom & Pan
// 

function setupCustomWheelZoom(canvas) {
    canvas.removeEventListener('wheel', handleCustomWheelZoom);
    canvas.addEventListener('wheel', handleCustomWheelZoom, { passive: false });
}

function handleCustomWheelZoom(e) {
    e.preventDefault();
    
    if (currentChartMode !== 'historical') return;
    if (!timelineState.fullData.loaded) return;
    if (!timelineState.viewportRange.start || !timelineState.viewportRange.end) return;
    
    const currentStart = timelineState.viewportRange.start.getTime();
    const currentEnd = timelineState.viewportRange.end.getTime();
    const currentDuration = currentEnd - currentStart;
    const currentCenter = (currentStart + currentEnd) / 2;
    
    const zoomIn = e.deltaY < 0;
    const zoomFactor = ZOOM_CONFIG.zoomStep;
    
    let newDurationMs = zoomIn ? currentDuration / zoomFactor : currentDuration * zoomFactor;
    
    const minDuration = ZOOM_CONFIG.minMinutes * 60 * 1000;
    // Zoom-out is capped at the full selected range so the chart can show the
    // entire period as an overview.
    const maxDuration = timelineState.fullRange.end - timelineState.fullRange.start;
    
    if (newDurationMs < minDuration) newDurationMs = minDuration;
    if (newDurationMs > maxDuration) newDurationMs = maxDuration;
    
    if (Math.abs(newDurationMs - currentDuration) < 1000) return;
    
    let newStart = new Date(currentCenter - newDurationMs / 2);
    let newEnd = new Date(currentCenter + newDurationMs / 2);
    
    if (newStart < timelineState.fullRange.start) {
        newStart = new Date(timelineState.fullRange.start);
        newEnd = new Date(newStart.getTime() + newDurationMs);
    }
    if (newEnd > timelineState.fullRange.end) {
        newEnd = new Date(timelineState.fullRange.end);
        newStart = new Date(newEnd.getTime() - newDurationMs);
    }
    
    timelineState.viewportRange.start = newStart;
    timelineState.viewportRange.end = newEnd;
    timelineState.lastViewportDuration = newDurationMs;
    
    updateViewportLabels();
    updateViewportPosition();
    updateViewportFromFullData();  // re-render locally from the in-memory cache
}

let isLeftClickPanning = false;
let leftPanStartX = 0;
let leftPanStartViewportStart = null;
let leftPanStartViewportEnd = null;

function setupLeftClickPan(canvas) {
    canvas.addEventListener('mousedown', (e) => {
        if (e.button === 0) {
            if (currentChartMode !== 'historical') return;
            if (!timelineState.fullData.loaded) return;
            
            isLeftClickPanning = true;
            leftPanStartX = e.clientX;
            leftPanStartViewportStart = new Date(timelineState.viewportRange.start);
            leftPanStartViewportEnd = new Date(timelineState.viewportRange.end);
            
            canvas.style.cursor = 'grabbing';
            e.preventDefault();
        }
    });
    
    canvas.addEventListener('mousemove', (e) => {
        if (!isLeftClickPanning) return;
        
        const deltaX = e.clientX - leftPanStartX;
        const canvasWidth = canvas.getBoundingClientRect().width;
        const panRatio = deltaX / canvasWidth;
        const duration = leftPanStartViewportEnd - leftPanStartViewportStart;
        const timeShift = -panRatio * duration;
        
        let newStart = new Date(leftPanStartViewportStart.getTime() + timeShift);
        let newEnd = new Date(leftPanStartViewportEnd.getTime() + timeShift);
        
        if (newStart < timelineState.fullRange.start) {
            newStart = new Date(timelineState.fullRange.start);
            newEnd = new Date(newStart.getTime() + duration);
        }
        if (newEnd > timelineState.fullRange.end) {
            newEnd = new Date(timelineState.fullRange.end);
            newStart = new Date(newEnd.getTime() - duration);
        }
        
        timelineState.viewportRange.start = newStart;
        timelineState.viewportRange.end = newEnd;
        
        updateViewportLabels();
        updateViewportPosition();
    });
    
    const endLeftClickPan = () => {
        if (isLeftClickPanning) {
            isLeftClickPanning = false;
            canvas.style.cursor = 'default';
            updateViewportFromFullData();  // re-render locally from cache
        }
    };
    
    canvas.addEventListener('mouseup', endLeftClickPan);
    canvas.addEventListener('mouseleave', endLeftClickPan);
}

function closeChartModal() {
    document.getElementById('chartModal').style.display = 'none';

    // Stop the live sampler and drop the real-time buffer for this field.
    stopRealtimeSampler();
    realtimeLatest = null;
    if (currentOpenField && chartData[currentOpenField]) {
        chartData[currentOpenField].labels = [];
        chartData[currentOpenField].values = [];
    }

    currentOpenField = null;

    if (charts.main) {
        charts.main.destroy();
        charts.main = null;
    }

    // Free the cached historical raw points from memory as soon as we close.
    console.log(`[Chart] closed → cleared ${(timelineState.fullData.timestamps.length || 0).toLocaleString()} cached points from memory`);
    timelineState.fullData.labels = [];
    timelineState.fullData.values = [];
    timelineState.fullData.timestamps = [];
    timelineState.fullData.loaded = false;
}

// 
// Update Chart Data (Real-time)
// 

// Latest value received for the open field. The server only pushes a tag when
// it changes (deadband) + a full refresh every few seconds, so drawing on each
// event makes stable tags look choppy / batched. Instead we just remember the
// latest value here and let a fixed-rate sampler plot one point per tick.
let realtimeLatest = null;
let realtimeTimer = null;

function updateChartData(fieldName, value) {
    if (currentChartMode !== 'realtime') return;
    if (fieldName !== currentOpenField) return;

    const v = parseFloat(value);
    if (!Number.isNaN(v)) realtimeLatest = v;
}

// Plot one point every CHART_CONFIG.updateInterval ms, regardless of how often
// the server pushes — giving a steady, controllable cadence (default 1s).
function startRealtimeSampler() {
    stopRealtimeSampler();

    // Seed with the current value so the first point appears immediately.
    if (realtimeLatest === null && window.scadaClient && currentOpenField) {
        const cur = window.scadaClient.getTagValue(currentOpenField);
        const cv = parseFloat(cur);
        if (!Number.isNaN(cv)) realtimeLatest = cv;
    }

    realtimeTimer = setInterval(() => {
        if (currentChartMode !== 'realtime') return;
        if (realtimeLatest === null) return;
        if (!currentOpenField || !chartData[currentOpenField]) return;

        const data = chartData[currentOpenField];
        data.labels.push(new Date().toLocaleTimeString());
        data.values.push(realtimeLatest);

        while (data.labels.length > CHART_CONFIG.maxDataPoints) {
            data.labels.shift();
            data.values.shift();
        }

        updateChart();
    }, CHART_CONFIG.updateInterval);
}

function stopRealtimeSampler() {
    if (realtimeTimer) {
        clearInterval(realtimeTimer);
        realtimeTimer = null;
    }
}

// Change the real-time draw cadence (ms) at runtime, e.g. from the console:
//   ChartSystem.setRealtimeInterval(500)
function setRealtimeInterval(ms) {
    CHART_CONFIG.updateInterval = Math.max(100, parseInt(ms, 10) || 1000);
    if (realtimeTimer) startRealtimeSampler(); // restart with the new interval
}

function updateChart() {
    if (charts.main && document.getElementById('chartModal').style.display === 'flex') {
        if (!currentOpenField || !chartData[currentOpenField]) return;
        
        const data = chartData[currentOpenField];
        charts.main.data.labels = data.labels;
        charts.main.data.datasets[0].data = data.values;
        charts.main.update('none');
        updateChartStats();
    }
}

function updateChartStats() {
    if (!currentOpenField || !chartData[currentOpenField]) return;
    
    const data = chartData[currentOpenField];
    const values = data.values;
    
    if (values.length === 0) {
        document.getElementById('statMax').innerText = '-';
        document.getElementById('statMin').innerText = '-';
        document.getElementById('statAvg').innerText = '-';
        if (document.getElementById('statCurrent')) document.getElementById('statCurrent').innerText = '-';
        if (document.getElementById('statCount')) document.getElementById('statCount').innerText = '0';
        return;
    }
    
    const max = Math.max(...values);
    const min = Math.min(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const current = values[values.length - 1];
    
    document.getElementById('statMax').innerText = max.toFixed(2);
    document.getElementById('statMin').innerText = min.toFixed(2);
    document.getElementById('statAvg').innerText = avg.toFixed(2);
    
    if (document.getElementById('statCurrent')) document.getElementById('statCurrent').innerText = current.toFixed(2);
    if (document.getElementById('statCount')) document.getElementById('statCount').innerText = values.length;
}

// 
// Timeline Helpers
// 

function updateTimelineLabels() {
    const fullStart = document.getElementById('fullRangeStart');
    const fullEnd = document.getElementById('fullRangeEnd');
    
    if (fullStart && timelineState.fullRange.start) {
        fullStart.textContent = formatTimelineDate(timelineState.fullRange.start);
    }
    if (fullEnd && timelineState.fullRange.end) {
        fullEnd.textContent = formatTimelineDate(timelineState.fullRange.end);
    }
    
    updateViewportLabels();
    updateViewportPosition();
}

function updateViewportLabels() {
    const viewStart = document.getElementById('viewportStart');
    const viewEnd = document.getElementById('viewportEnd');
    
    if (viewStart && timelineState.viewportRange.start) {
        viewStart.textContent = formatTimelineDate(timelineState.viewportRange.start);
    }
    if (viewEnd && timelineState.viewportRange.end) {
        viewEnd.textContent = formatTimelineDate(timelineState.viewportRange.end);
    }
    
    updateZoomDurationLabel();
}

function updateZoomDurationLabel() {
    const zoomLabel = document.getElementById('zoomDurationLabel');
    if (!zoomLabel) return;
    
    if (!timelineState.viewportRange.start || !timelineState.viewportRange.end) {
        zoomLabel.textContent = '2 days';
        return;
    }
    
    const durationMs = timelineState.viewportRange.end - timelineState.viewportRange.start;
    const durationMinutes = durationMs / (60 * 1000);
    const durationHours = durationMinutes / 60;
    const durationDays = durationHours / 24;
    
    let displayText;
    
    if (durationMinutes < 60) {
        displayText = `${Math.round(durationMinutes)} min`;
    } else if (durationHours < 24) {
        displayText = `${durationHours.toFixed(1)} hrs`;
    } else {
        displayText = `${durationDays.toFixed(1)} days`;
    }
    
    zoomLabel.textContent = displayText;
}

function updateViewportPosition() {
    const viewport = document.getElementById('viewportRect');
    if (!viewport) return;
    
    if (!timelineState.fullRange.start || !timelineState.fullRange.end) return;
    if (!timelineState.viewportRange.start || !timelineState.viewportRange.end) return;
    
    const fullStart = timelineState.fullRange.start.getTime();
    const fullEnd = timelineState.fullRange.end.getTime();
    const viewStart = timelineState.viewportRange.start.getTime();
    const viewEnd = timelineState.viewportRange.end.getTime();
    
    const totalRange = fullEnd - fullStart;
    const leftPercent = ((viewStart - fullStart) / totalRange) * 100;
    const widthPercent = ((viewEnd - viewStart) / totalRange) * 100;
    
    viewport.style.left = `${leftPercent}%`;
    viewport.style.width = `${widthPercent}%`;
}

function formatTimelineDate(date) {
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    
    return `${day}/${month} ${hours}:${minutes}`;
}

// 
// Viewport Drag
// 

let isDragging = false;
let dragStartX = 0;
let dragStartLeft = 0;

function initializeViewportDrag() {
    const viewport = document.getElementById('viewportRect');
    if (!viewport) return;
    
    viewport.addEventListener('mousedown', (e) => {
        isDragging = true;
        dragStartX = e.clientX;
        
        const rect = viewport.getBoundingClientRect();
        const parent = viewport.parentElement.getBoundingClientRect();
        dragStartLeft = ((rect.left - parent.left) / parent.width) * 100;
        
        viewport.style.cursor = 'grabbing';
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        
        const parent = document.getElementById('viewportRect').parentElement.getBoundingClientRect();
        const deltaX = e.clientX - dragStartX;
        const deltaPercent = (deltaX / parent.width) * 100;
        
        let newLeft = dragStartLeft + deltaPercent;
        
        if (newLeft < 0) newLeft = 0;
        const currentWidth = parseFloat(document.getElementById('viewportRect').style.width);
        if (newLeft + currentWidth > 100) newLeft = 100 - currentWidth;
        
        document.getElementById('viewportRect').style.left = `${newLeft}%`;
        updateViewportRangeFromPosition(newLeft, currentWidth);
    });
    
    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            document.getElementById('viewportRect').style.cursor = 'move';
            updateViewportFromFullData();  // re-render locally from cache
        }
    });
}

function updateViewportRangeFromPosition(leftPercent, widthPercent) {
    if (!timelineState.fullRange.start || !timelineState.fullRange.end) return;
    
    const fullStart = timelineState.fullRange.start.getTime();
    const fullEnd = timelineState.fullRange.end.getTime();
    const totalRange = fullEnd - fullStart;
    
    const viewStart = fullStart + (totalRange * leftPercent / 100);
    const viewEnd = viewStart + (totalRange * widthPercent / 100);
    
    timelineState.viewportRange.start = new Date(viewStart);
    timelineState.viewportRange.end = new Date(viewEnd);
    
    const viewStartEl = document.getElementById('viewportStart');
    const viewEndEl = document.getElementById('viewportEnd');
    
    if (viewStartEl) viewStartEl.textContent = formatTimelineDate(timelineState.viewportRange.start);
    if (viewEndEl) viewEndEl.textContent = formatTimelineDate(timelineState.viewportRange.end);
}

function updateChartDisplay() {
    if (!charts.main) return;
    
    const dataset = charts.main.data.datasets[0];
    
    dataset.borderWidth = document.getElementById('showLine').checked ? 2 : 0;
    dataset.fill = document.getElementById('showFill').checked;
    dataset.pointRadius = document.getElementById('showPoints').checked ? 3 : 0;
    
    charts.main.update();
}

// 
// Excel Export
// 

function exportChartToExcel() {
    if (!currentOpenField || !chartData[currentOpenField]) {
        alert('No chart data to export!');
        return;
    }
    
    let labels, values;
    
    if (currentChartMode === 'historical' && timelineState.fullData.loaded) {
        const pointCount = timelineState.fullData.timestamps.length;
        if (pointCount === 0) {
            alert('No data available to export!');
            return;
        }
        if (pointCount > EXPORT_MAX_POINTS) {
            showExportLimitMessage();
            return;
        }

        labels = timelineState.fullData.timestamps.map(formatTimestampLabel);
        values = timelineState.fullData.values;
    } else {
        const fieldData = chartData[currentOpenField];
        labels = fieldData.labels;
        values = fieldData.values;
    }
    
    if (!labels || labels.length === 0) {
        alert('No data available to export!');
        return;
    }

    if (labels.length > EXPORT_MAX_POINTS) {
        showExportLimitMessage();
        return;
    }

    if (typeof XLSX !== 'undefined') {
        exportToXLSX(labels, values);
    } else {
        exportToCSV(labels, values);
    }
}

// Min / max / mean over a possibly huge array in a single pass. Avoids
// Math.max(...arr) / Math.min(...arr), whose argument-spread overflows the
// call stack on arrays of hundreds of thousands of elements.
function computeStats(values) {
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === null || v === undefined || Number.isNaN(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
        n++;
    }
    if (n === 0) return { min: 0, max: 0, avg: 0, count: 0 };
    return { min, max, avg: sum / n, count: n };
}

function exportToCSV(labels, values) {
    const fieldName = formatFieldName(currentOpenField);

    let csvContent = `SCADA Chart Export\n`;
    csvContent += `Field,${fieldName}\n`;
    csvContent += `Mode,${currentChartMode === 'historical' ? 'Historical' : 'Real-time'}\n`;
    csvContent += `Export Date,${new Date().toLocaleString()}\n`;
    csvContent += `Total Points,${values.length}\n\n`;

    const stats = computeStats(values);
    if (stats.count > 0) {
        csvContent += `Statistics\n`;
        csvContent += `Maximum,${stats.max.toFixed(2)}\n`;
        csvContent += `Minimum,${stats.min.toFixed(2)}\n`;
        csvContent += `Average,${stats.avg.toFixed(2)}\n\n`;
    }

    csvContent += `Timestamp,Value\n`;

    // Build rows in an array and join once - far lighter than `+=` per row.
    const rows = new Array(labels.length);
    for (let i = 0; i < labels.length; i++) {
        const v = values[i];
        rows[i] = `"${labels[i]}",${(v === null || v === undefined) ? '' : v}`;
    }
    csvContent += rows.join('\n') + '\n';

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const filename = `${fieldName.replace(/\s+/g, '_')}_${Date.now()}.csv`;
    
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    
    showExportNotification(`?Exported ${values.length} points to CSV!`);
}

function exportToXLSX(labels, values) {
    const fieldName = formatFieldName(currentOpenField);
    
    const wb = XLSX.utils.book_new();

    function applyExcelFormulas(sheet) {
        if (!sheet || !sheet['!ref']) return;
        const range = XLSX.utils.decode_range(sheet['!ref']);
        for (let r = range.s.r; r <= range.e.r; r++) {
            for (let c = range.s.c; c <= range.e.c; c++) {
                const addr = XLSX.utils.encode_cell({ r, c });
                const cell = sheet[addr];
                if (!cell || typeof cell.v !== 'string') continue;
                const raw = cell.v.trim();
                if (!raw.startsWith('=')) continue;
                cell.f = raw.slice(1);
                delete cell.v;
                delete cell.w;
                cell.t = 'n';
            }
        }
    }
    
    const stats = computeStats(values);
    const max = stats.max;
    const min = stats.min;
    const avg = stats.avg;

    const summaryData = [
        ['SCADA Chart Export'],
        [''],
        ['Field', fieldName],
        ['Mode', currentChartMode === 'historical' ? 'Historical' : 'Real-time'],
        ['Export Date', new Date().toLocaleString()],
        ['Total Points', values.length],
        [''],
        ['Statistics'],
        ['Maximum', max.toFixed(2)],
        ['Minimum', min.toFixed(2)],
        ['Average', avg.toFixed(2)]
    ];
    
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    applyExcelFormulas(summarySheet);
    XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');
    
    const dataRows = [['Timestamp', 'Value']];
    for (let i = 0; i < labels.length; i++) {
        dataRows.push([labels[i], values[i] || '']);
    }
    
    const dataSheet = XLSX.utils.aoa_to_sheet(dataRows);
    applyExcelFormulas(dataSheet);
    dataSheet['!cols'] = [{ wch: 22 }, { wch: 15 }];
    
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Data');
    
    const filename = `${fieldName.replace(/\s+/g, '_')}_${Date.now()}.xlsx`;
    XLSX.writeFile(wb, filename);
    
    showExportNotification(`?Exported ${values.length} points to Excel!`);
}

function showExportNotification(message) {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed; top: 20px; right: 20px; padding: 15px 25px;
        background: linear-gradient(135deg, #27ae60, #2ecc71);
        color: white; border-radius: 10px; font-weight: bold; z-index: 10001;
        box-shadow: 0 5px 20px rgba(0,0,0,0.3);
    `;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

function showExportLimitMessage() {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed; top: 20px; right: 20px; max-width: 460px; padding: 15px 25px;
        background: linear-gradient(135deg, #c0392b, #e74c3c);
        color: white; border-radius: 10px; font-weight: bold; z-index: 10001;
        box-shadow: 0 5px 20px rgba(0,0,0,0.3);
    `;
    notification.textContent = EXPORT_LIMIT_MESSAGE;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 300);
    }, 5000);
}

// 
// Helpers
// 

function formatFieldName(fieldName) {
    return fieldName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function addToMultiChart(tagName, actualTagId) {
    const id = parseInt(actualTagId);

    if (window.MultiChart && typeof window.MultiChart.addTag === 'function') {
        window.MultiChart.addTag(tagName, id);
        return true;
    }

    if (window.ChartSystem && typeof window.ChartSystem.openChart === 'function') {
        window.ChartSystem.openChart(tagName, '#3498db', id);
        return true;
    }

    return false;
}

function openLegacyChart(tagName, actualTagId) {
    openChartModal(tagName, '#3498db', parseInt(actualTagId));

    // Seed an initial realtime point if available (some pages don't push updates immediately)
    try {
        let v = null;
        if (window.scadaClient && typeof window.scadaClient.getTagValue === 'function') {
            v = window.scadaClient.getTagValue(tagName);
        }
        if (v === null || v === undefined) {
            const el = document.querySelector(`.${CSS.escape(tagName)}`) || document.getElementById(`val_${tagName}`);
            if (el) v = el.textContent;
        }
        if (v !== null && v !== undefined && window.ChartSystem && typeof window.ChartSystem.updateData === 'function') {
            window.ChartSystem.updateData(tagName, v);
        }
    } catch (e) { /* ignore */ }
}

function makeSvgChartable(element, tagName, actualTagId) {
    element.setAttribute('data-chart-enabled', 'true');

    try {
        element.style.cursor = 'pointer';
    } catch (e) {
        // ignore styling failures in some SVG contexts
    }

    // Click the value ?open the legacy (historical-capable) modal.
    element.addEventListener('click', () => {
        openLegacyChart(tagName, actualTagId);
    });

    if (element.getAttribute('data-chart-icons-added') === '1') return;
    element.setAttribute('data-chart-icons-added', '1');

    const parent = element.parentNode;
    if (!parent || typeof parent.appendChild !== 'function') return;

    const svgNS = 'http://www.w3.org/2000/svg';

    const multiIcon = document.createElementNS(svgNS, 'text');
    multiIcon.textContent = '+';
    multiIcon.setAttribute('font-size', '18');
    multiIcon.setAttribute('font-family', 'Rajdhani, sans-serif');
    multiIcon.setAttribute('text-anchor', 'start');
    multiIcon.setAttribute('data-chart-icon', 'multi');
    multiIcon.style.cursor = 'pointer';
    multiIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        addToMultiChart(tagName, actualTagId);
    });

    parent.appendChild(multiIcon);

    const positionIcons = () => {
        try {
            const bbox = element.getBBox();
            const y = element.getAttribute('y') || String(bbox.y + bbox.height);
            const startX = bbox.x + bbox.width + 8;
            multiIcon.setAttribute('x', String(startX));
            multiIcon.setAttribute('y', String(y));
        } catch (e) {
            // getBBox can fail if element not renderable yet
        }
    };

    requestAnimationFrame(positionIcons);

    if (element.getAttribute('data-chart-icons-watch') !== '1') {
        element.setAttribute('data-chart-icons-watch', '1');
        const observer = new MutationObserver(() => requestAnimationFrame(positionIcons));
        observer.observe(element, { childList: true, characterData: true, subtree: true });
    }
}

// 
//  Make Analog Elements Chartable
// 

function makeChartable() {
    // Find all elements with data-actual-tag-id attribute
    const chartableElements = document.querySelectorAll('[data-chartable="true"], [data-actual-tag-id]');
    
    chartableElements.forEach(element => {
        if (element.hasAttribute('data-chart-enabled')) return;
        
        const actualTagId = element.getAttribute('data-actual-tag-id');
        if (!actualTagId) return;
        
        // Prefer the explicit data-tag attribute — it holds the exact, full tag
        // name (which may contain spaces or slashes, e.g. "WS001_Wind Speed").
        // Falling back to the class name is unreliable for such names because the
        // browser splits a multi-word class into several tokens.
        let tagName = element.getAttribute('data-tag') || element.getAttribute('data-tag-name');
        if (!tagName) {
            const classList = Array.from(element.classList);
            tagName = classList.find(cls => cls !== 'value' && cls !== 'analog-display' && !cls.includes('-'));
        }
        
        if (!tagName) return;
        
        if (element.namespaceURI === 'http://www.w3.org/2000/svg') {
            makeSvgChartable(element, tagName, actualTagId);
            return;
        }

        element.setAttribute('data-chart-enabled', 'true');
        
        // Distinctive "+" badge for Multi-Chart, pinned to the bottom-left of the
        // card (styled in chart.css) so it's clearly separate from clicking the
        // value itself (which opens the normal chart).
        const icon = document.createElement('span');
        icon.className = 'mc-add-icon';
        icon.textContent = '+';
        icon.title = 'Add to Multi-Chart';

        icon.addEventListener('click', (e) => {
            e.stopPropagation();
            addToMultiChart(tagName, actualTagId);
        });
        
        element.style.cursor = 'pointer';
        element.style.transition = 'all 0.3s';
        
        element.addEventListener('mouseenter', () => {
            element.style.transform = 'scale(1.05)';
            element.style.textShadow = '0 0 10px #3498db';
        });
        
        element.addEventListener('mouseleave', () => {
            element.style.transform = 'scale(1)';
            element.style.textShadow = 'none';
        });
        
        element.addEventListener('click', () => {
            openLegacyChart(tagName, actualTagId);
        });
        
        // Insert icons as siblings (NOT children). main.js updates `.textContent` on the
        // value span, which would remove any child nodes (icons) otherwise.
        icon.setAttribute('data-chart-icon', 'multi');

        let legacyIcon = element.nextElementSibling;
        if (!(legacyIcon && legacyIcon.getAttribute('data-chart-icon') === 'multi')) {
            element.insertAdjacentElement('afterend', icon);
            legacyIcon = icon;
        }

    });
    
    console.log(`?Made ${chartableElements.length} elements chartable`);
}

// 
// Initialize
// 

document.addEventListener('DOMContentLoaded', () => {
    console.log(' Initializing Chart System...');
    
    setTimeout(() => {
        createChartModal();
        makeChartable();
        console.log('?Chart System Ready!');
    }, 1500);
});

// Re-init on DOM changes (debounced to avoid hammering on rapid tag updates)
let _chartableDebounce = null;
const chartObserver = new MutationObserver(() => {
    if (_chartableDebounce) clearTimeout(_chartableDebounce);
    _chartableDebounce = setTimeout(makeChartable, 2000);
});

chartObserver.observe(document.body, { childList: true, subtree: true });

// 
// Export for External Use
// 

window.ChartSystem = {
    updateData: updateChartData,
    openChart: openChartModal,
    closeChart: closeChartModal,
    switchMode: switchChartMode,
    loadHistorical: loadHistoricalData,
    exportToExcel: exportChartToExcel,
    chartData: chartData,
    getActualTagId: getActualTagId,
    makeChartable: makeChartable,
    setRealtimeInterval: setRealtimeInterval
};

} // End of guard


