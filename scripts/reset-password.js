// Usage: node scripts/reset-password.js teacher@school.com NewPassword123
require('dotenv').config({ quiet: true });
const { openDb } = require('../src/db');
const { hashPassword, normalizeEmail } = require('../src/auth');

(async () => {
  const [email, password] = process.argv.slice(2);
  if (!email || !password || password.length < 8) {
    console.error('Usage: node scripts/reset-password.js <email> <new password (8+ chars)>');
    process.exit(1);
  }
  const db = openDb(process.env.DATABASE_FILE || './data/markcalc.db');
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizeEmail(email));
  if (!user) {
    console.error('No teacher with that email.');
    process.exit(1);
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  console.log(`Password updated for ${email}.`);
})();
