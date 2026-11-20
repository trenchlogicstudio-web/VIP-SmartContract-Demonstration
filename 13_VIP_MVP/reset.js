// Copyright (c) 2026 Miloš Petrović (Trench Logic Studio) · SPDX-License-Identifier: MIT
// Reset only a recognized demo database. Stop the server before running this.
'use strict';
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH, open, transaction } = require('./src/store');

if (!fs.existsSync(DB_PATH)) {
  console.log('No demo database to reset.');
} else {
  const probe = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const columns = table => probe.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name);
    if (!columns('sessions').includes('armed_at_eur') || !columns('events').includes('prev_hash') ||
        !columns('guests').includes('display_name')) throw new Error('VIP_DB does not contain the VIP demo schema.');
  } finally { probe.close(); }
  const db = open(DB_PATH);
  try {
    transaction(db, () => {
      const tables = ['tick_receipts', 'ticks', 'credits', 'rollover', 'sessions', 'guests', 'events', 'settings'];
      for (const table of tables) db.exec('DELETE FROM ' + table);
      db.exec("DELETE FROM sqlite_sequence WHERE name IN ('ticks','credits','rollover','events')");
    });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    console.log('Demo data cleared. The next start seeds the reference quarter.');
  } finally { db.close(); }
}
