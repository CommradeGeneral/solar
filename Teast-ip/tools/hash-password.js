/**
 * Generate a bcrypt hash for a password.
 *
 * Usage:
 *   node tools/hash-password.js "MyPassword"
 */

const bcrypt = require('bcryptjs');

async function main() {
  const password = process.argv[2];
  if (!password) {
    console.error('Usage: node tools/hash-password.js "MyPassword"');
    process.exit(2);
  }

  const hash = await bcrypt.hash(String(password), 12);
  console.log(hash);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});

