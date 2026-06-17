/**
 * Seed Admin User
 *
 * Usage (PowerShell):
 *   $env:ADMIN_USERNAME='HA'
 *   $env:ADMIN_PASSWORD='HA1234'
 *   node tools/seed-admin.js
 *
 * Notes:
 * - Requires DB schema from database/04_auth_users.sql to be applied first.
 * - Uses bcrypt hash (not reversible encryption).
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
  const username = (process.env.ADMIN_USERNAME || 'HA').trim();
  const password = process.env.ADMIN_PASSWORD || 'H@$$@N1234';


  if (!username || !password) {
    console.error('Missing ADMIN_USERNAME or ADMIN_PASSWORD env vars.');
    process.exit(2);
  }

  const dbConfig = getDbConfig();
  console.log('--------')
  const pool = await sql.connect(dbConfig);

  try {
    const passwordHash = await bcrypt.hash(password, 12);

    await pool
      .request()
      .input('username', sql.NVarChar(50), username)
      .input('password_hash', sql.NVarChar(255), passwordHash)
      .query(`
        IF EXISTS (SELECT 1 FROM dbo.Users WHERE username = @username)
        BEGIN
          UPDATE dbo.Users
            SET password_hash = @password_hash,
                role = 'administrator',
                is_active = 1,
                updated_at = GETDATE()
          WHERE username = @username;
        END
        ELSE
        BEGIN
          INSERT INTO dbo.Users (username, password_hash, role, is_active)
          VALUES (@username, @password_hash, 'administrator', 1);
        END
      `);

    console.log(`✅ Admin user ensured: ${username}`);
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err?.message || err);
  process.exit(1);
});

