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
  }
];
// @formatter:on
