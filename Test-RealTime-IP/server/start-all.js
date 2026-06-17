/*
 * Launches BOTH the SCADA server and the standalone ping-server with one command.
 * They still run as two SEPARATE Node processes (independent event loops), so the
 * ping workload has zero impact on the SCADA realtime loop — this launcher only
 * starts them together for convenience.
 *
 *   npm run start:all
 */

const { spawn } = require('child_process');
const path = require('path');

function run(label, file) {
  const child = spawn(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('exit', (code) => console.log(`[${label}] exited (code ${code})`));
  child.on('error', (err) => console.error(`[${label}] failed to start:`, err.message));
  return child;
}

const scada = run('scada', 'server.js');
const ping = run('ping', 'ping-server.js');

function shutdown() {
  try { scada.kill(); } catch (e) { /* */ }
  try { ping.kill(); } catch (e) { /* */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
