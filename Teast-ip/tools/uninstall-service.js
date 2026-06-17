/**
 * Windows Service Uninstaller
 * Removes the Industrial Data Server Windows Service
 *
 * Usage (run as Administrator):
 *   node tools/uninstall-service.js
 */

const path = require('path');

let Service;
try {
    Service = require('node-windows').Service;
} catch (e) {
    console.error('node-windows is not installed. Run:');
    console.error('  npm install node-windows');
    process.exit(1);
}

const SERVICE_NAME = 'database_of_largedredging';
const SERVICE_ID = 'database_of_largedredging';

const svc = new Service({
    name: SERVICE_NAME,
    id: SERVICE_ID,
    script: path.resolve(__dirname, '../src/index.js'),
});

svc.on('uninstall', () => {
    console.log('');
    console.log('=============================================');
    console.log('  Service uninstalled successfully!');
    console.log('=============================================');
    console.log('');
});

svc.on('alreadyuninstalled', () => {
    console.log('Service is not currently installed.');
});

svc.on('error', (err) => {
    console.error('Error:', err);
});

console.log('Uninstalling Industrial Data Server service...');
svc.uninstall();
