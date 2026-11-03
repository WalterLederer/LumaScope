export interface DBMigration {
  name: string;
  query: string;
}

// @formatter:off
export const createMigrationTable = `
CREATE TABLE IF NOT EXISTS migrations (
  name TEXT NOT NULL
);
`;

export const getMigrationRecords = `SELECT * FROM migrations ORDER BY rowid;`;

export const insertMigrationRecord = `INSERT INTO migrations (name) VALUES (:name);`;

export const clearCacheRecords = `DELETE FROM cache_files WHERE storage_type_id = 1;`;

export const findFullSizeCacheFiles = `
SELECT source_name, source_tag, target_path, storage_type_id
FROM cache_files
WHERE source_tag LIKE '%-full-%' AND storage_type_id = 1;
`;

export const findThumbnailCacheFiles = `
SELECT source_name, source_tag, target_path, storage_type_id
FROM cache_files
WHERE source_tag NOT LIKE '%-full-%' AND storage_type_id = 1;
`;

export const findCacheFiles = `
SELECT source_name, source_tag, target_path, storage_type_id
FROM cache_files;
`;

export const findCacheFilesForSource = `
SELECT source_name, source_tag, target_path, storage_type_id
FROM cache_files
WHERE source_name = :sourceName
ORDER BY ttl DESC;
`;

export const deleteCacheFile = `
DELETE FROM cache_files WHERE source_name = :sourceName AND source_tag = :sourceTag;
`;

export const insertCacheFile = `
INSERT INTO cache_files (
  source_name,
  source_tag,
  source_size,
  updated_at,
  target_path,
  ttl,
  storage_type_id
)
VALUES(
  :sourceName,
  :sourceTag,
  :sourceSize,
  :updatedAt,
  :targetPath,
  :ttl,
  :storageTypeId
);
`;

export const findCacheFile = `
SELECT * FROM cache_files WHERE source_name = :sourceName AND source_tag = :sourceTag;
`;

export const dbMigrations: DBMigration[] = [
  {
    name: 'createCacheTableV1',
    query: `
CREATE TABLE IF NOT EXISTS cache_files (
  source_name TEXT NOT NULL,
  source_tag TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  target_path TEXT NOT NULL,
  ttl INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_cache_files_search ON cache_files (source_name, source_tag);
    `
  },
  {
    name: 'addCacheStorageTypeV2',
    query: `
ALTER TABLE cache_files ADD COLUMN storage_type TEXT NOT NULL DEFAULT 'central';
    `
  },
  {
    name: 'createCacheVolumeSettingsV3',
    query: `
CREATE TABLE IF NOT EXISTS cache_volume_settings (
  volume_root TEXT PRIMARY KEY COLLATE NOCASE,
  sidecar_enabled INTEGER NOT NULL DEFAULT 1
);
    `
  },
  {
    name: 'renameConvertedStorageToParallelV4',
    query: `
UPDATE cache_files SET storage_type = 'parallel' WHERE storage_type = 'converted';
    `
  },
  {
    name: 'normalizeCacheStorageTypeIdsV5',
    query: `
CREATE TABLE IF NOT EXISTS cache_storage_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

INSERT OR IGNORE INTO cache_storage_types (id, name) VALUES
  (1, 'central'),
  (2, 'sidecar'),
  (3, 'parallel');

ALTER TABLE cache_files ADD COLUMN storage_type_id INTEGER NOT NULL DEFAULT 1;

UPDATE cache_files
SET storage_type_id = CASE storage_type
  WHEN 'central' THEN 1
  WHEN 'sidecar' THEN 2
  WHEN 'parallel' THEN 3
  WHEN 'converted' THEN 3
  ELSE 1
END;

ALTER TABLE cache_files DROP COLUMN storage_type;
CREATE INDEX IF NOT EXISTS idx_cache_files_storage_type_id ON cache_files (storage_type_id);
    `
  },
  {
    name: 'addCacheStorageTypeForeignKeyV6',
    query: `
CREATE TABLE cache_files_new (
  source_name TEXT NOT NULL,
  source_tag TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  target_path TEXT NOT NULL,
  ttl INTEGER NOT NULL,
  storage_type_id INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (storage_type_id) REFERENCES cache_storage_types(id),
  UNIQUE (source_name, source_tag)
);

INSERT INTO cache_files_new (
  source_name, source_tag, source_size, updated_at, target_path, ttl, storage_type_id
)
SELECT
  source_name, source_tag, source_size, updated_at, target_path, ttl, storage_type_id
FROM cache_files;

DROP TABLE cache_files;
ALTER TABLE cache_files_new RENAME TO cache_files;
CREATE INDEX IF NOT EXISTS idx_cache_files_storage_type_id ON cache_files (storage_type_id);
    `
  },
  {
    name: 'createPhotoMetadataSchemaV7',
    query: `
CREATE TABLE IF NOT EXISTS paths (
  id INTEGER PRIMARY KEY,
  folder_path TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS coordinate_sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
INSERT OR IGNORE INTO coordinate_sources (id, name) VALUES
  (1, 'EXIF'), (2, 'XMP'), (3, 'GPX'), (4, 'Manual'), (5, 'External');

CREATE TABLE IF NOT EXISTS location_names (
  id INTEGER PRIMARY KEY,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  place_name TEXT NOT NULL,
  country_code TEXT,
  region TEXT,
  locality TEXT,
  provider TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(latitude, longitude, provider)
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  path_id INTEGER NOT NULL REFERENCES paths(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL COLLATE NOCASE,
  file_size INTEGER NOT NULL DEFAULT 0,
  modified_at REAL NOT NULL DEFAULT 0,
  is_hdr INTEGER NOT NULL DEFAULT 0 CHECK (is_hdr IN (0, 1)),
  thumbnail_cache_id INTEGER REFERENCES cache_storage_types(id),
  thumbnail_cache_version TEXT,
  fullsize_cache_id INTEGER REFERENCES cache_storage_types(id),
  fullsize_cache_version TEXT,
  latitude REAL,
  longitude REAL,
  altitude_m REAL,
  gps_timestamp INTEGER,
  direction_deg REAL,
  coordinate_source_id INTEGER REFERENCES coordinate_sources(id),
  location_name_id INTEGER REFERENCES location_names(id),
  UNIQUE(path_id, file_name)
);
CREATE INDEX IF NOT EXISTS idx_photos_path_id ON photos(path_id);
CREATE INDEX IF NOT EXISTS idx_photos_hdr ON photos(is_hdr);
`
  }
];
// @formatter:on
