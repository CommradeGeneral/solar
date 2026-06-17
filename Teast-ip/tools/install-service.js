/**
 * Windows Service Installer
 * Installs the Industrial Data Server as a Windows Service
 *
 * Usage (run as Administrator):
 *   node tools/install-service.js
 *
 * Prerequisites:
 *   npm install node-windows
 */

const path = require('path');
const childProcess = require('child_process');

let Service;
try {
    Service = require('node-windows').Service;
} catch (e) {
    console.error('node-windows is not installed. Run:');
    console.error('  npm install node-windows');
    process.exit(1);
}

// Windows service DisplayName and service key name.
// Use a unique name to avoid collisions with previous installs.
const SERVICE_NAME = 'database_of_largedredging';
// Service id (SCM key). node-windows may still suffix ".exe" internally; that's OK.
const SERVICE_ID = 'database_of_largedredging';

function scQuery(name) {
    try {
        return childProcess.execSync(`sc query "${name}"`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    } catch (e) {
        const stderr = e?.stderr ? e.stderr.toString() : '';
        const stdout = e?.stdout ? e.stdout.toString() : '';
        return `${stdout}\n${stderr}`.trim();
    }
}

// Service configuration
const svc = new Service({
    name: SERVICE_NAME,
    id: SERVICE_ID,
    description: 'Industrial Alarm & Historian Server with Siemens S7 and Modbus support',
    script: path.resolve(__dirname, '../src/index.js'),

    // Working directory
    workingDirectory: path.resolve(__dirname, '..'),

    // Restart on crash
    abortOnError: false,

    // Wait 2 seconds before restarting after crash
    wait: 2,

    // Max restarts before giving up (0 = unlimited)
    grow: 0.5,       // restart delay growth factor
    maxRestarts: 10,  // within the same restart window

    // Environment variables
    env: [
        {
            name: 'NODE_ENV',
            value: 'production',
        },
        {
            name: 'CONFIG_PATH',
            value: path.resolve(__dirname, '../config.ini'),
        },
    ],

    // Keep wrapper logs under project folder (helps when running as a service)
    logpath: path.resolve(__dirname, '../logs'),

    // node-windows may otherwise serialize an undefined value into the WinSW XML
    // (e.g. <argument>undefined</argument>) which can break wrapper argument parsing.
    stopparentfirst: false,
});

// Listen for install events
svc.on('install', () => {
    console.log('');
    console.log('=============================================');
    console.log('  Service installed successfully!');
    console.log('=============================================');
    console.log('');
    console.log(`  Service Name: ${SERVICE_NAME}`);
    console.log('  Status:       Installed');
    console.log('');
    console.log(`  To start:     net start ${SERVICE_NAME}`);
    console.log(`  To stop:      net stop ${SERVICE_NAME}`);
    console.log('  To remove:    node tools/uninstall-service.js');
    console.log('');
    console.log(`  Verify (SC):  sc query "${SERVICE_ID}"`);
    console.log('');

    // Start the service immediately
    svc.start();
    console.log('  Starting service...');
});

svc.on('start', () => {
    console.log('  Service started!');
});

svc.on('alreadyinstalled', () => {
    console.log('Service is already installed.');
    console.log('To reinstall, first run: node tools/uninstall-service.js');
    console.log('');
    console.log('SC query output:');
    console.log(scQuery(SERVICE_ID));
});

svc.on('error', (err) => {
    console.error('Error:', err);
});

// Run installation
console.log('Installing Industrial Data Server as Windows Service...');
console.log(`Script: ${svc.script}`);
console.log('');
svc.install();
