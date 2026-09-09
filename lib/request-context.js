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

// Role -> a fixed per-unit price substituted for one customer+product+date
// window, query-time only (stored data is never touched, and no other role
// is affected). Requested for one external viewer: KHAN's GH23000 sales
// between 1 Jan and 31 Aug 2026 should read as if the unit price had been
// 650 RUB all along, with every downstream total (order/demand sums, top
// products, top customers, monthly trend) recomputed to match. The two
// customer ids are KHAN's counterparty records in the old and new MoySklad
// accounts respectively (this window predates the account cutover, so only
// the old-account id actually has matching rows, but both are listed for
// safety). See db/moysklad-queries.js's positionOverrideExprs/sumKopecksExpr
// for how this is applied in SQL.
const PRICE_OVERRIDE = {
  associate: {
    customerIds: ['1c74c10c-a5df-11f1-0a80-17c2000e0226', '12c5ec28-dd9a-11f0-0a80-019a001ac5a2'],
    productBaseNames: ['ELFBAR GH23000', 'ELFBAR GH23000 Disposable 850mAh Planet Edition'],
    fromDate: '2026-01-01 00:00:00',
    toDate: '2026-08-31 23:59:59',
    fixedPriceKopecks: 65000, // 650 RUB
  },
};

// Display-only labels for each internal role key — the role key itself
// (used everywhere above, and by every role === 'x' check elsewhere in the
// app) never changes, only what's shown for it on screen (e.g. the Manage
// Users page). Renamed per request: the "sales_director" role (floored to
// 1 Sept 2026, per ROLE_MIN_DATE above) now reads as "Employee", and the
// "associate" role (KHAN's price override, per PRICE_OVERRIDE above) now
// reads as "Sales Director".
const ROLE_LABELS = {
  admin: 'Admin',
  partner: 'Partner',
  sales_director: 'Employee',
  associate: 'Sales Director',
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

function getPriceOverride() {
  const role = getRole();
  return role ? (PRICE_OVERRIDE[role] || null) : null;
}

module.exports = { runWithRole, getRole, getMinDate, getPriceOverride, ROLE_MIN_DATE, PRICE_OVERRIDE, ROLE_LABELS };
