'use strict';
// Customer Outstandings (receivables) dashboard — who owes how much, when
// they last paid, and an optional per-customer credit limit. Always floored
// to CUTOVER regardless of role: this is scoped to the new MoySklad account's
// data by design, not a role-based restriction (see lib/request-context.js
// for that separate mechanism).
const { query } = require('./pool');

const CUTOVER = '2026-09-01 00:00:00';

async function getCreditLimits() {
  const { rows } = await query('SELECT customer_id, credit_limit_kopecks FROM customer_credit_limits');
  const map = {};
  rows.forEach(r => { map[r.customer_id] = Number(r.credit_limit_kopecks) || 0; });
  return map;
}

async function setCreditLimit(customerId, limitRub) {
  const kopecks = Math.max(0, Math.round((Number(limitRub) || 0) * 100));
  await query(
    `INSERT INTO customer_credit_limits (customer_id, credit_limit_kopecks, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (customer_id) DO UPDATE SET credit_limit_kopecks = $2, updated_at = now()`,
    [customerId, kopecks]);
}

// One row per customer with at least one order since 1 Sept 2026 — everyone,
// not just who currently owes: a customer who has paid off everything shows
// with outstanding=0/paidUp=true rather than disappearing from the list.
async function getOutstandingSummary() {
  const ordersRes = await query(`
    SELECT o.customer_id, COALESCE(cp.name, o.customer_name) AS customer_name,
           SUM(o.sum_kopecks) AS total_sum,
           SUM(o.payed_sum_kopecks) AS total_paid,
           SUM(GREATEST(o.sum_kopecks - o.payed_sum_kopecks, 0)) AS outstanding,
           COUNT(*) AS order_count,
           to_char(MAX(o.moment), 'YYYY-MM-DD') AS last_order_date
    FROM ms_orders o
    LEFT JOIN ms_counterparties cp ON cp.id = o.customer_id
    WHERE o.moment >= $1::timestamp AND o.customer_id IS NOT NULL
    GROUP BY o.customer_id, COALESCE(cp.name, o.customer_name)
    ORDER BY outstanding DESC, total_sum DESC
  `, [CUTOVER]);

  const paymentsRes = await query(`
    SELECT customer_id, to_char(MAX(moment), 'YYYY-MM-DD') AS last_payment_date,
           SUM(sum_kopecks) AS total_received
    FROM ms_payments_in
    WHERE moment >= $1::timestamp AND customer_id IS NOT NULL
    GROUP BY customer_id
  `, [CUTOVER]);
  const lastPaymentMap = {};
  const totalReceivedMap = {};
  paymentsRes.rows.forEach(r => {
    lastPaymentMap[r.customer_id] = r.last_payment_date;
    totalReceivedMap[r.customer_id] = Number(r.total_received) || 0;
  });

  const limits = await getCreditLimits();

  return ordersRes.rows.map(r => {
    const outstandingRub = Number(r.outstanding) / 100;
    const limitRub = (limits[r.customer_id] || 0) / 100;
    return {
      customerId: r.customer_id,
      customerName: r.customer_name || '—',
      totalSum: Number(r.total_sum) / 100,
      totalPaid: Number(r.total_paid) / 100,
      totalReceived: (totalReceivedMap[r.customer_id] || 0) / 100,
      outstanding: outstandingRub,
      paidUp: outstandingRub <= 0,
      orderCount: Number(r.order_count),
      lastOrderDate: r.last_order_date,
      lastPaymentDate: lastPaymentMap[r.customer_id] || null,
      creditLimit: limitRub,
      overLimit: limitRub > 0 && outstandingRub > limitRub,
    };
  });
}

// Recent incoming-payment activity across every customer — a live feed of
// who paid what, when. Defaults to the 25 most recent since 1 Sept 2026.
async function getRecentPayments(limit = 25) {
  const { rows } = await query(`
    SELECT p.id, p.name, to_char(p.moment, 'YYYY-MM-DD') AS date,
           p.sum_kopecks, p.customer_id, COALESCE(cp.name, p.customer_name) AS customer_name
    FROM ms_payments_in p
    LEFT JOIN ms_counterparties cp ON cp.id = p.customer_id
    WHERE p.moment >= $1::timestamp
    ORDER BY p.moment DESC
    LIMIT $2
  `, [CUTOVER, limit]);
  return rows.map(r => ({
    id: r.id, name: r.name, date: r.date,
    sum: Number(r.sum_kopecks) / 100,
    customerId: r.customer_id,
    customerName: r.customer_name || '—',
  }));
}

// Full order + payment history for one customer, since 1 Sept 2026 — powers
// the click-through detail view.
async function getCustomerDetail(customerId) {
  const [cpRes, ordersRes, paymentsRes, limits] = await Promise.all([
    query('SELECT id, name FROM ms_counterparties WHERE id = $1', [customerId]),
    query(`
      SELECT id, name, to_char(moment, 'YYYY-MM-DD') AS date, sum_kopecks, payed_sum_kopecks, state_name
      FROM ms_orders WHERE customer_id = $1 AND moment >= $2::timestamp
      ORDER BY moment DESC
    `, [customerId, CUTOVER]),
    query(`
      SELECT id, name, to_char(moment, 'YYYY-MM-DD') AS date, sum_kopecks
      FROM ms_payments_in WHERE customer_id = $1 AND moment >= $2::timestamp
      ORDER BY moment DESC
    `, [customerId, CUTOVER]),
    getCreditLimits(),
  ]);

  const orders = ordersRes.rows.map(r => ({
    id: r.id, name: r.name, date: r.date,
    sum: Number(r.sum_kopecks) / 100,
    paid: Number(r.payed_sum_kopecks) / 100,
    outstanding: Math.max(0, Number(r.sum_kopecks) - Number(r.payed_sum_kopecks)) / 100,
    state: r.state_name || '—',
  }));
  const payments = paymentsRes.rows.map(r => ({
    id: r.id, name: r.name, date: r.date, sum: Number(r.sum_kopecks) / 100,
  }));

  const totalSum = orders.reduce((a, o) => a + o.sum, 0);
  const totalPaid = orders.reduce((a, o) => a + o.paid, 0);
  const outstanding = orders.reduce((a, o) => a + o.outstanding, 0);

  return {
    customerId,
    customerName: cpRes.rows[0]?.name || '—',
    totalSum, totalPaid, outstanding,
    lastOrderDate: orders[0]?.date || null,
    lastPaymentDate: payments[0]?.date || null,
    creditLimit: (limits[customerId] || 0) / 100,
    orders, payments,
  };
}

module.exports = { CUTOVER, getOutstandingSummary, getRecentPayments, getCustomerDetail, setCreditLimit, getCreditLimits };
