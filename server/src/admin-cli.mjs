// Grants and revokes admin access from the server's shell; the admin pages
// cannot raise anyone's role. Run with the service's environment, e.g.
//   sudo -u scientify env $(sudo cat /etc/scientify-collab.env | xargs) node src/admin-cli.mjs list
//   ... node src/admin-cli.mjs grant 13800000000 owner      (owner or viewer)
//   ... node src/admin-cli.mjs revoke 13800000000

import { readConfig } from './config.mjs';
import { createDb, initDb } from './db.mjs';
import { normalizePhone } from './sms.mjs';

const ROLES = ['owner', 'viewer'];
const [command, phoneArg, roleArg = 'owner'] = process.argv.slice(2);
const db = createDb(readConfig());
try {
  await initDb(db);
  if (command === 'list') {
    const result = await db.query(
      'SELECT phone, admin_role, password_hash IS NOT NULL AS has_password FROM users WHERE admin_role IS NOT NULL ORDER BY phone',
    );
    for (const row of result.rows)
      console.log(`${row.phone}\t${row.admin_role}${row.has_password ? '' : '\t(no password yet: use 忘记密码 on the admin page)'}`);
    if (!result.rows.length) console.log('No administrators.');
  } else if (command === 'grant' || command === 'revoke') {
    const phone = normalizePhone(phoneArg);
    if (command === 'grant' && !ROLES.includes(roleArg)) throw new Error(`Role must be one of ${ROLES.join(', ')}`);
    const result = await db.query('UPDATE users SET admin_role = $2 WHERE phone = $1 RETURNING password_hash IS NOT NULL AS has_password', [
      phone,
      command === 'grant' ? roleArg : null,
    ]);
    if (!result.rows[0]) throw new Error('No account with that number; sign in once from the desktop app first.');
    if (command === 'revoke') await db.query('DELETE FROM admin_sessions WHERE user_id = (SELECT id FROM users WHERE phone = $1)', [phone]);
    console.log(command === 'grant' ? `${phone} is now ${roleArg}.` : `${phone} is no longer an administrator.`);
    if (command === 'grant' && !result.rows[0].has_password)
      console.log('This account has no password yet: on the /admin sign-in page, use 忘记密码 to set one with an SMS code.');
  } else {
    console.log('Usage: node src/admin-cli.mjs list | grant <phone> [owner|viewer] | revoke <phone>');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
