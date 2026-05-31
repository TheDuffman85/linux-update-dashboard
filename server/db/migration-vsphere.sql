CREATE TABLE IF NOT EXISTS vsphere_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  username TEXT NOT NULL,
  encrypted_password TEXT NOT NULL,
  tls_mode TEXT NOT NULL DEFAULT 'strict',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vm_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  vsphere_connection_id INTEGER NOT NULL REFERENCES vsphere_connections(id) ON DELETE RESTRICT,
  vm_moref TEXT NOT NULL,
  vm_name TEXT,
  snapshot_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating',
  created_before_history_id INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

ALTER TABLE systems ADD COLUMN vsphere_connection_id INTEGER REFERENCES vsphere_connections(id) ON DELETE SET NULL;
ALTER TABLE systems ADD COLUMN vsphere_vm_moref TEXT;
ALTER TABLE systems ADD COLUMN vsphere_vm_name TEXT;
ALTER TABLE systems ADD COLUMN snapshot_before_upgrade INTEGER NOT NULL DEFAULT 0;
ALTER TABLE systems ADD COLUMN snapshot_quiesce INTEGER NOT NULL DEFAULT 1;
ALTER TABLE systems ADD COLUMN snapshot_memory INTEGER NOT NULL DEFAULT 0;
ALTER TABLE systems ADD COLUMN snapshot_retention_hours INTEGER NOT NULL DEFAULT 72;
