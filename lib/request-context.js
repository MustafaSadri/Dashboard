'use strict';
// Carries the current request's role for the life of that request, so deep
// call sites (the MoySklad shim, the shared cached() helper) can read "who's
// asking" without threading a parameter through every function in between.
// Set once per request in server.js's auth-guard middleware; read anywhere
// downstream in the same async chain via AsyncLocalStorage.
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// Role -> earliest visible `moment` (MoySklad's naive local-time format,
// matching every other date filter in this app). null/undefined = no floor.
const ROLE_MIN_DATE = {
  sales_director: '2026-09-01 00:00:00',
};

function runWithRole(role, fn) {
  return als.run({ role }, fn);
}

function getRole() {
  return als.getStore()?.role || null;
}

function getMinDate() {
  const role = getRole();
  return role ? (ROLE_MIN_DATE[role] || null) : null;
}

module.exports = { runWithRole, getRole, getMinDate, ROLE_MIN_DATE };
