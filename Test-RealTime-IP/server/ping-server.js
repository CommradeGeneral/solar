/*
 * ───────────────────────────────────────────────────────────────────────────
 *  STANDALONE PING MONITOR  (separate from the SCADA server — zero impact on it)
 * ───────────────────────────────────────────────────────────────────────────
 *  Reads config/ping_devices.xlsx ("Devices" sheet: group_id, name, ip_address,
 *  enabled), ICMP-pings each enabled IP on a timer, and serves the result at
 *  GET /api/ping (CORS enabled) so the Solar page can show NOSIGNAL per box.
 *
 *  Run it as its own process:   node server/ping-server.js
 *  (or:  npm run ping-server)   — default port 5001, override with PING_PORT.
 *
 *  This process never touches the Modbus/IEC-104 SCADA server.
 */

const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const express = require('express');
const cors = require('cors');
const ExcelJS = require('exceljs');

const CONFIG = {
  port: parseInt(process.env.PING_PORT || '5001', 10),
  excelPath: path.join(__dirname, '../config/ping_devices.xlsx'),
  intervalMs: parseInt(process.env.PING_INTERVAL_MS || '5000', 10),
  timeoutMs: parseInt(process.env.PING_TIMEOUT_MS || '1000', 10),
  concurrency: parseInt(process.env.PING_CONCURRENCY || '12', 10),
};

const isWin = os.platform() === 'win32';

// group_id -> { group_id, name, ip, up, lastChange }
const status = new Map();
let lastDevices = [];   // last successfully-read device list (survives a locked file)

// ─── Read the device list from the Excel ───
async function loadDevices() {
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(CONFIG.excelPath);
    const ws = wb.getWorksheet('Devices');
    if (!ws) return lastDevices;

    const header = ws.getRow(1).values.slice(1).map(h => String(h || '').trim().toLowerCase());
    const ci = name => header.indexOf(name);
    const gi = ci('group_id'), ni = ci('name'), ii = ci('ip_address'), ei = ci('enabled');

    const out = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const v = ws.getRow(r).values;
      const group_id = gi >= 0 ? String(v[gi + 1] || '').trim() : '';
      const ip = ii >= 0 ? String(v[ii + 1] || '').trim() : '';
      const name = ni >= 0 ? String(v[ni + 1] || '').trim() : group_id;
      const enabledRaw = ei >= 0 ? String(v[ei + 1] ?? 'yes').trim().toLowerCase() : 'yes';
      const enabled = !['no', 'false', '0', 'off'].includes(enabledRaw);
      if (!group_id || !ip || !enabled) continue;   // blank ip / disabled → not monitored
      out.push({ group_id, name, ip });
    }
    lastDevices = out;
    return out;
  } catch (e) {
    // File missing or locked (open in Excel) → reuse the last good list.
    return lastDevices;
  }
}

// ─── Ping a single host (resolves true if reachable) ───
function pingOne(ip) {
  return new Promise(resolve => {
    const cmd = isWin
      ? `ping -n 1 -w ${CONFIG.timeoutMs} ${ip}`
      : `ping -c 1 -W ${Math.max(1, Math.round(CONFIG.timeoutMs / 1000))} ${ip}`;
    exec(cmd, { timeout: CONFIG.timeoutMs + 1500, windowsHide: true }, (err, stdout) => {
      // Windows `ping` can exit 0 even on "Destination host unreachable", so also
      // require a TTL= reply line. On *nix a 0 exit code means a reply was received.
      const out = String(stdout || '');
      const ok = isWin ? /ttl[=\s]/i.test(out) : !err;
      resolve(ok);
    });
  });
}

// ─── Run pings with bounded concurrency, then update the status map ───
async function pingCycle() {
  const devices = await loadDevices();
  const present = new Set(devices.map(d => d.group_id));

  // Drop boxes that were removed / blanked in the Excel.
  for (const key of [...status.keys()]) if (!present.has(key)) status.delete(key);

  let idx = 0;
  async function worker() {
    while (idx < devices.length) {
      const d = devices[idx++];
      const up = await pingOne(d.ip);
      const prev = status.get(d.group_id);
      const changed = !prev || prev.up !== up;
      status.set(d.group_id, {
        group_id: d.group_id,
        name: d.name,
        ip: d.ip,
        up,
        lastChange: changed ? new Date().toISOString() : (prev ? prev.lastChange : new Date().toISOString()),
      });
    }
  }
  const n = Math.min(CONFIG.concurrency, devices.length || 1);
  await Promise.all(Array.from({ length: n }, worker));
}

async function loopForever() {
  for (;;) {
    try { await pingCycle(); } catch (e) { /* keep looping */ }
    await new Promise(r => setTimeout(r, CONFIG.intervalMs));
  }
}

// ─── HTTP API ───
const app = express();
app.use(cors());

app.get('/api/ping', (_, res) => {
  res.json({ success: true, data: [...status.values()], timestamp: new Date().toISOString() });
});

app.get('/api/ping/health', (_, res) => {
  res.json({ success: true, monitored: status.size, intervalMs: CONFIG.intervalMs });
});

app.listen(CONFIG.port, () => {
  console.log(`🛰️  Ping monitor on http://192.168.1.2:${CONFIG.port}/api/ping  (every ${CONFIG.intervalMs}ms, reading ${path.basename(CONFIG.excelPath)})`);
  loopForever();
});
