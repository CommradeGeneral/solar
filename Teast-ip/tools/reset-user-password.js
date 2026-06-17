/**
 * Reset a user's password (offline / emergency).
 *
 * Usage (PowerShell):
 *   $env:RESET_USERNAME='HA'
 *   $env:RESET_PASSWORD='NewStrongPassword'
 *   node tools/reset-user-password.js
 *
 * Notes:
 * - Uses bcrypt hash (not reversible).
 * - Requires dbo.Users table from database/04_auth_users.sql.
 */

const path = require('path');
const fs = require('fs');
const ini = require('ini');
const sql = require('mssql/msnodesqlv8');
const bcrypt = require('bcryptjs');

const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve(__dirname, '../config.ini');

function normalizeBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === '1';
}

function getDbConfig() {
  let configFromIni = {};
  if (fs.existsSync(CONFIG_PATH)) {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    configFromIni = ini.parse(content);
  }
  const db = configFromIni.Database || {};
  const useWindowsAuth = normalizeBool(db.UseWindowsAuth);

  return {
    server: db.Server || '192.168.1.2',
    database: db.Database || 'IndustrialDB',
    ...(useWindowsAuth
      ? { driver: 'msnodesqlv8' }
      : {
          user: db.User || 'sa',
          password: db.Password != null ? String(db.Password) : 'YourPassword123!',
        }),
    options: {
      encrypt: db.Encrypt || false,
      trustServerCertificate: db.TrustServerCertificate !== false,
      ...(useWindowsAuth ? { trustedConnection: true } : {}),
    },
  };
}

async function main() {
  const username = (process.env.RESET_USERNAME || '').trim();
  const password = process.env.RESET_PASSWORD || '';

  if (!username || !password) {
    console.error('Missing RESET_USERNAME or RESET_PASSWORD env vars.');
    process.exit(2);
  }

  const dbConfig = getDbConfig();
  const pool = await sql.connect(dbConfig);

  try {
    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool
      .request()
      .input('username', sql.NVarChar(50), username)
      .input('password_hash', sql.NVarChar(255), passwordHash)
      .query(`
        UPDATE dbo.Users
          SET password_hash = @password_hash,
              is_active = 1,
              updated_at = GETDATE()
        WHERE username = @username;
        SELECT @@ROWCOUNT AS affected;
      `);

    const affected = result?.recordset?.[0]?.affected || 0;
    if (!affected) {
      console.error(`User not found: ${username}`);
      process.exit(3);
    }

    console.log(`✅ Password reset for: ${username}`);
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error('Reset failed:', err?.message || err);
  process.exit(1);
});

