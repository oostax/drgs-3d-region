CREATE TABLE IF NOT EXISTS schema_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO schema_meta(key,value) VALUES('schema_version','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
CREATE TABLE IF NOT EXISTS sources(
  id TEXT PRIMARY KEY,name TEXT NOT NULL,region_id TEXT NOT NULL,territory_id TEXT,url TEXT NOT NULL UNIQUE,
  adapter TEXT NOT NULL,source_kind TEXT NOT NULL,status TEXT NOT NULL,interval_seconds INTEGER NOT NULL,
  languages_json TEXT NOT NULL DEFAULT '[]',topics_json TEXT NOT NULL DEFAULT '[]',coverage_json TEXT NOT NULL DEFAULT '[]',
  fetch_allowed INTEGER NOT NULL DEFAULT 0,ai_allowed INTEGER NOT NULL DEFAULT 0,display_allowed INTEGER NOT NULL DEFAULT 0,
  rights_note TEXT NOT NULL DEFAULT '',provenance_url TEXT NOT NULL,last_attempt_at TEXT,last_success_at TEXT,
  latest_publication_at TEXT,error TEXT,etag TEXT,last_modified TEXT,next_attempt_at TEXT,consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_coverage(
  territory_id TEXT NOT NULL,source_id TEXT NOT NULL,coverage_level TEXT NOT NULL,
  last_success_at TEXT,latest_publication_at TEXT,PRIMARY KEY(territory_id,source_id),
  FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS documents(
  id TEXT PRIMARY KEY,source_id TEXT NOT NULL,external_id TEXT,canonical_url TEXT NOT NULL,title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',body TEXT,content_hash TEXT NOT NULL,published_at TEXT NOT NULL,edited_at TEXT,
  deleted_at TEXT,last_seen_at TEXT NOT NULL,fetched_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',
  analysis_status TEXT NOT NULL DEFAULT 'pending',analysis_error TEXT,analysis_attempts INTEGER NOT NULL DEFAULT 0,
  analysis_next_attempt_at TEXT,
  FOREIGN KEY(source_id) REFERENCES sources(id),UNIQUE(source_id,external_id),UNIQUE(source_id,canonical_url)
);
CREATE TABLE IF NOT EXISTS document_versions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,document_id TEXT NOT NULL,content_hash TEXT NOT NULL,title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',body TEXT,observed_at TEXT NOT NULL,meaningful INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,UNIQUE(document_id,content_hash)
);
CREATE TABLE IF NOT EXISTS document_usefulness(
  document_id TEXT PRIMARY KEY,data_json TEXT NOT NULL,assessed_at TEXT NOT NULL,
  FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY,legacy_id TEXT UNIQUE,region_id TEXT NOT NULL,territory_id TEXT,canonical_key TEXT NOT NULL,
  title TEXT NOT NULL,summary TEXT NOT NULL,category TEXT NOT NULL,topic TEXT NOT NULL,state TEXT NOT NULL,
  severity TEXT NOT NULL,confidence TEXT NOT NULL,source_kind TEXT NOT NULL,event_time TEXT,published_at TEXT NOT NULL,
  last_evidence_at TEXT NOT NULL,last_meaningful_at TEXT NOT NULL,closed_at TEXT,address TEXT,longitude REAL,latitude REAL,
  precision TEXT NOT NULL,location_confidence TEXT NOT NULL,activity_kind TEXT NOT NULL,explicit_activity INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,reviewed INTEGER NOT NULL DEFAULT 0,
  notify_eligible INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_documents(
  event_id TEXT NOT NULL,document_id TEXT NOT NULL,relation TEXT NOT NULL,similarity REAL,
  PRIMARY KEY(event_id,document_id),FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS event_evidence(
  id TEXT PRIMARY KEY,event_id TEXT NOT NULL,document_id TEXT,source_id TEXT,label TEXT NOT NULL,url TEXT NOT NULL,
  published_at TEXT,observed_at TEXT NOT NULL,event_time TEXT,quote TEXT,source_kind TEXT NOT NULL,supports TEXT NOT NULL,
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS event_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL,state TEXT NOT NULL,at TEXT NOT NULL,label TEXT NOT NULL,source_url TEXT,
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS event_aliases(alias TEXT PRIMARY KEY,event_id TEXT NOT NULL,FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY,kind TEXT NOT NULL,source_id TEXT,dedupe_key TEXT UNIQUE,status TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,run_after TEXT NOT NULL,started_at TEXT,finished_at TEXT,error TEXT,payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS checkpoints(source_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(source_id,key));
CREATE TABLE IF NOT EXISTS revisions(
  revision INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL,operation TEXT NOT NULL,notify_eligible INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_state(
  id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL,heartbeat_at TEXT,last_success_at TEXT,message TEXT NOT NULL DEFAULT '',pid INTEGER,started_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sources_due ON sources(status,next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_documents_source_published ON documents(source_id,published_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_region_time ON events(region_id,last_evidence_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_territory_time ON events(territory_id,last_evidence_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_location ON events(longitude,latitude);
CREATE INDEX IF NOT EXISTS idx_revisions_event ON revisions(event_id,revision);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status,priority DESC,run_after);
