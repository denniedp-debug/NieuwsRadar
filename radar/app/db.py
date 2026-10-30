import json
import os
import sqlite3
import threading

import numpy as np

DB_PATH = os.environ.get("RADAR_DB", "/data/radar.db")
_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,           -- Miniflux entry id
  cluster_id INTEGER,
  title TEXT, url TEXT, text TEXT, image TEXT,
  feed_title TEXT, site TEXT, category TEXT,
  origin TEXT, is_official INTEGER DEFAULT 0,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_entries_cluster ON entries(cluster_id);

CREATE TABLE IF NOT EXISTS clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT, category TEXT, image TEXT,
  created_at TEXT, updated_at TEXT,
  centroid BLOB, n_entries INTEGER DEFAULT 0, n_sources INTEGER DEFAULT 0,
  has_official INTEGER DEFAULT 0, max_cvss REAL,
  status TEXT DEFAULT 'waiting',          -- waiting | confirmed | official
  watch_hits TEXT DEFAULT '[]',
  summary TEXT, facts TEXT DEFAULT '[]', summarized_sources INTEGER DEFAULT 0,
  pushed INTEGER DEFAULT 0, push_reason TEXT, critical INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_clusters_updated ON clusters(updated_at);

CREATE TABLE IF NOT EXISTS alerts (          -- pushes buiten clusters (KEV, NCSC)
  key TEXT PRIMARY KEY, kind TEXT, title TEXT, message TEXT, url TEXT, at TEXT
);

CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
"""


def connect():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    cols = [r[1] for r in con.execute("PRAGMA table_info(clusters)")]
    for col, typ in (("title_nl", "TEXT"), ("teaser_nl", "TEXT"), ("lang", "TEXT"), ("translated_title", "TEXT"),
                     ("hidden", "INTEGER DEFAULT 0"), ("hide_reason", "TEXT"), ("hide_manual", "INTEGER DEFAULT 0")):
        if col not in cols:  # migratie van oudere databases
            con.execute(f"ALTER TABLE clusters ADD COLUMN {col} {typ}")
    ecols = [r[1] for r in con.execute("PRAGMA table_info(entries)")]
    if "full_text" not in ecols:
        con.execute("ALTER TABLE entries ADD COLUMN full_text TEXT")
    con.execute("""CREATE TABLE IF NOT EXISTS reads (
      device TEXT, cluster_id INTEGER, at TEXT, PRIMARY KEY (device, cluster_id))""")
    con.execute("""CREATE TABLE IF NOT EXISTS negatives (
      id INTEGER PRIMARY KEY AUTOINCREMENT, cluster_id INTEGER UNIQUE, title TEXT, vec BLOB, at TEXT)""")
    con.commit()
    return con


_con = None


def con():
    global _con
    with _lock:
        if _con is None:
            _con = connect()
        return _con


def get_state(key, default=None):
    row = con().execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_state(key, value):
    with _lock:
        con().execute(
            "INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )
        con().commit()


def vec_to_blob(v: np.ndarray) -> bytes:
    return v.astype(np.float32).tobytes()


def blob_to_vec(b: bytes) -> np.ndarray:
    return np.frombuffer(b, dtype=np.float32)
