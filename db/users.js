'use strict';
// Per-person login accounts, replacing the old shared-passcode-per-role
// system. Passwords are never stored or logged in plaintext — only a
// bcrypt hash. `role` is the same string every other role-based check in
// the app already reads from req.session.role (see lib/request-context.js),
// so nothing downstream of login needed to change.
const bcrypt = require('bcryptjs');
const { query } = require('./pool');

const VALID_ROLES = ['admin', 'partner', 'sales_director', 'associate'];

function normalizeUsername(u) {
  return (u || '').trim().toLowerCase();
}

async function getUserByUsername(username) {
  const { rows } = await query(
    `SELECT id, username, password_hash, display_name, role, active FROM app_users WHERE username = $1`,
    [normalizeUsername(username)]);
  return rows[0] || null;
}

// Returns the user row (minus password_hash) on success, null on any
// failure (unknown username, wrong password, deactivated account) — the
// caller shouldn't need to distinguish why, to avoid leaking which
// usernames exist.
async function verifyLogin(username, password) {
  const user = await getUserByUsername(username);
  if (!user || !user.active) return null;
  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) return null;
  const { password_hash, ...safe } = user;
  return safe;
}

async function listUsers() {
  const { rows } = await query(
    `SELECT id, username, display_name, role, active, to_char(created_at, 'YYYY-MM-DD') AS created_at
     FROM app_users ORDER BY created_at ASC`);
  return rows;
}

async function createUser({ username, password, displayName, role }) {
  if (!VALID_ROLES.includes(role)) throw new Error('Invalid role: ' + role);
  if (!username || !password) throw new Error('Username and password are required');
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO app_users (username, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, display_name, role, active, created_at`,
    [normalizeUsername(username), hash, displayName || username, role]);
  return rows[0];
}

async function resetPassword(id, newPassword) {
  if (!newPassword) throw new Error('New password is required');
  const hash = await bcrypt.hash(newPassword, 10);
  await query(`UPDATE app_users SET password_hash = $1, updated_at = now() WHERE id = $2`, [hash, id]);
}

async function setActive(id, active) {
  await query(`UPDATE app_users SET active = $1, updated_at = now() WHERE id = $2`, [!!active, id]);
}

async function deleteUser(id) {
  await query(`DELETE FROM app_users WHERE id = $1`, [id]);
}

module.exports = {
  VALID_ROLES,
  getUserByUsername, verifyLogin, listUsers,
  createUser, resetPassword, setActive, deleteUser,
};
