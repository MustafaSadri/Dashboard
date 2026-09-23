-- MoySklad module schema. Fully separate from the Tally/MongoDB system.
-- All moment/date-time values are stored WITHOUT timezone, matching MoySklad's
-- own convention of naive local-time strings (e.g. "2025-12-01 00:00:00") — this
-- avoids TZ-conversion bugs when comparing against filter strings built the same way
-- elsewhere in the app.

CREATE TABLE IF NOT EXISTS ms_counterparties (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '—',
  code          TEXT,
  email         TEXT,
  phone         TEXT,
  company_type  TEXT,
  updated_at    TIMESTAMP,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ms_employees (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '—',
  short_fio   TEXT,
  uid         TEXT,
  position    TEXT,
  updated_at  TIMESTAMP,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ms_stores (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '—',
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ms_states (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL DEFAULT 'customerorder',
  name         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ms_assortment (
  href       TEXT PRIMARY KEY,
  id         TEXT,
  name       TEXT NOT NULL DEFAULT '—',
  base_name  TEXT NOT NULL DEFAULT '—',
  type       TEXT NOT NULL DEFAULT 'product',
  code       TEXT,
  article    TEXT,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ms_assortment_base_name ON ms_assortment(base_name);
CREATE INDEX IF NOT EXISTS idx_ms_assortment_id ON ms_assortment(id);

CREATE TABLE IF NOT EXISTS ms_stock (
  assortment_href  TEXT PRIMARY KEY,
  name             TEXT NOT NULL DEFAULT '—',
  code             TEXT,
  article          TEXT,
  quantity         NUMERIC NOT NULL DEFAULT 0,
  reserve          NUMERIC NOT NULL DEFAULT 0,
  price_kopecks    BIGINT NOT NULL DEFAULT 0,
  folder_name      TEXT,
  status           TEXT NOT NULL DEFAULT 'ok',
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ms_stock_status ON ms_stock(status);
CREATE INDEX IF NOT EXISTS idx_ms_stock_name ON ms_stock(name);

CREATE TABLE IF NOT EXISTS ms_orders (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL DEFAULT '',
  moment                   TIMESTAMP,
  date                     DATE,
  sum_kopecks              BIGINT NOT NULL DEFAULT 0,
  payed_sum_kopecks        BIGINT NOT NULL DEFAULT 0,
  customer_id              TEXT,
  customer_name            TEXT,
  owner_id                 TEXT,
  state_id                 TEXT,
  state_name               TEXT,
  delivery_planned_moment  TIMESTAMP,
  store_id                 TEXT,
  updated_at               TIMESTAMP,
  synced_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ms_orders_moment ON ms_orders(moment);
CREATE INDEX IF NOT EXISTS idx_ms_orders_customer ON ms_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_ms_orders_owner ON ms_orders(owner_id);
CREATE INDEX IF NOT EXISTS idx_ms_orders_state ON ms_orders(state_name);
CREATE INDEX IF NOT EXISTS idx_ms_orders_updated ON ms_orders(updated_at);

CREATE TABLE IF NOT EXISTS ms_order_positions (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES ms_orders(id) ON DELETE CASCADE,
  assortment_href  TEXT,
  product_name     TEXT,
  base_name        TEXT,
  quantity         NUMERIC NOT NULL DEFAULT 0,
  price_kopecks    BIGINT NOT NULL DEFAULT 0,
  discount         NUMERIC NOT NULL DEFAULT 0,
  amount_kopecks   BIGINT NOT NULL DEFAULT 0,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ms_order_positions_order ON ms_order_positions(order_id);
CREATE INDEX IF NOT EXISTS idx_ms_order_positions_assortment ON ms_order_positions(assortment_href);

CREATE TABLE IF NOT EXISTS ms_demands (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  moment      TIMESTAMP,
  date        DATE,
  sum_kopecks BIGINT NOT NULL DEFAULT 0,
  customer_id TEXT,
  customer_name TEXT,
  owner_id    TEXT,
  order_id    TEXT,
  state_id    TEXT,
  state_name  TEXT,
  store_id    TEXT,
  updated_at  TIMESTAMP,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ms_demands_moment ON ms_demands(moment);
CREATE INDEX IF NOT EXISTS idx_ms_demands_date ON ms_demands(date);
CREATE INDEX IF NOT EXISTS idx_ms_demands_customer ON ms_demands(customer_id);
CREATE INDEX IF NOT EXISTS idx_ms_demands_owner ON ms_demands(owner_id);
CREATE INDEX IF NOT EXISTS idx_ms_demands_order ON ms_demands(order_id);
CREATE INDEX IF NOT EXISTS idx_ms_demands_store ON ms_demands(store_id);
CREATE INDEX IF NOT EXISTS idx_ms_demands_updated ON ms_demands(updated_at);

CREATE TABLE IF NOT EXISTS ms_demand_positions (
  id               TEXT PRIMARY KEY,
  demand_id        TEXT NOT NULL REFERENCES ms_demands(id) ON DELETE CASCADE,
  demand_date      DATE,
  assortment_href  TEXT,
  product_name     TEXT,
  base_name        TEXT,
  quantity         NUMERIC NOT NULL DEFAULT 0,
  price_kopecks    BIGINT NOT NULL DEFAULT 0,
  discount         NUMERIC NOT NULL DEFAULT 0,
  amount_kopecks   BIGINT NOT NULL DEFAULT 0,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ms_demand_positions_demand ON ms_demand_positions(demand_id);
CREATE INDEX IF NOT EXISTS idx_ms_demand_positions_date ON ms_demand_positions(demand_date);
CREATE INDEX IF NOT EXISTS idx_ms_demand_positions_assortment ON ms_demand_positions(assortment_href);
CREATE INDEX IF NOT EXISTS idx_ms_demand_positions_base_name ON ms_demand_positions(base_name);

CREATE TABLE IF NOT EXISTS ms_muted_models (
  base_name  TEXT PRIMARY KEY,
  muted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outgoing sales invoices (MoySklad entity "invoiceout") — powers the
-- order-vs-shipment-vs-invoice mismatch check alongside ms_demands.
CREATE TABLE IF NOT EXISTS ms_invoices_out (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT '',
  moment         TIMESTAMP,
  sum_kopecks    BIGINT NOT NULL DEFAULT 0,
  customer_id    TEXT,
  customer_name  TEXT,
  order_id       TEXT,
  updated_at     TIMESTAMP,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ms_invoices_out_order ON ms_invoices_out(order_id);
CREATE INDEX IF NOT EXISTS idx_ms_invoices_out_moment ON ms_invoices_out(moment);
CREATE INDEX IF NOT EXISTS idx_ms_invoices_out_updated ON ms_invoices_out(updated_at);

-- Incoming payment documents (MoySklad entity "paymentin") — separate from
-- ms_orders.payed_sum_kopecks, which is only a running total with no date.
-- This is what lets the Outstandings dashboard show an actual last-payment
-- date per customer.
CREATE TABLE IF NOT EXISTS ms_payments_in (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT '',
  moment         TIMESTAMP,
  sum_kopecks    BIGINT NOT NULL DEFAULT 0,
  customer_id    TEXT,
  customer_name  TEXT,
  updated_at     TIMESTAMP,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ms_payments_in_customer ON ms_payments_in(customer_id);
CREATE INDEX IF NOT EXISTS idx_ms_payments_in_moment ON ms_payments_in(moment);
CREATE INDEX IF NOT EXISTS idx_ms_payments_in_updated ON ms_payments_in(updated_at);

-- Per-customer credit limit for the Outstandings dashboard — app-level only,
-- never sent to MoySklad. 0/absent = no limit set (never flagged over-limit).
CREATE TABLE IF NOT EXISTS customer_credit_limits (
  customer_id           TEXT PRIMARY KEY,
  credit_limit_kopecks  BIGINT NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- App-level login accounts (separate from the MoySklad data model above).
-- One row per real person; `role` drives everything role-based elsewhere
-- (Tally visibility, MoySklad date floor, the Associate price override —
-- see lib/request-context.js) exactly the way the old shared passcodes did.
CREATE TABLE IF NOT EXISTS app_users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL CHECK (role IN ('admin','partner','sales_director','associate')),
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ms_sync_meta (
  entity                    TEXT PRIMARY KEY,
  last_full_sync_at         TIMESTAMPTZ,
  last_incremental_sync_at  TIMESTAMPTZ,
  watermark                 TIMESTAMP,
  last_status               TEXT,
  last_error                TEXT,
  last_rows                 INTEGER
);
