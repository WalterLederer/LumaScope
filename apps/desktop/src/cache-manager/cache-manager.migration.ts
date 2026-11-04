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
  thumbnail_cache_version INTEGER,
  fullsize_cache_id INTEGER REFERENCES cache_storage_types(id),
  fullsize_cache_version INTEGER,
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
  },
  {
    name: 'seedUnknownLocationNameV9',
    query: `
INSERT OR IGNORE INTO location_names
  (id, latitude, longitude, place_name, country_code, region, locality, provider, updated_at)
VALUES
  (0, 999, 999, 'Unknown', NULL, NULL, NULL, 'system', 0);
`
  },
  {
    name: 'storeThumbnailCacheVersionAsIntegerV10',
    query: `
ALTER TABLE photos ADD COLUMN thumbnail_cache_version_code INTEGER;
UPDATE photos
SET thumbnail_cache_version_code = CASE
  WHEN thumbnail_cache_version = 'sidecar-thumbnail-v2' THEN 2
  ELSE NULL
END;
ALTER TABLE photos DROP COLUMN thumbnail_cache_version;
ALTER TABLE photos RENAME COLUMN thumbnail_cache_version_code TO thumbnail_cache_version;
`
  },
  {
    name: 'storeFullSizeCacheVersionAsIntegerV11',
    query: `
ALTER TABLE photos ADD COLUMN fullsize_cache_version_code INTEGER;
UPDATE photos
SET fullsize_cache_version_code = CASE fullsize_cache_version
  WHEN 'jxr-full-uhdr' THEN 10
  WHEN 'avif-full-uhdr' THEN 11
  WHEN 'heif-full-uhdr' THEN 12
  WHEN 'heic-full-uhdr' THEN 13
  WHEN 'hdr-full-uhdr' THEN 14
  WHEN 'exr-full-uhdr-v2' THEN 15
  WHEN 'tif-full-hdr-v6' THEN 16
  WHEN 'tiff-full-hdr-v6' THEN 17
  ELSE NULL
END;
ALTER TABLE photos DROP COLUMN fullsize_cache_version;
ALTER TABLE photos RENAME COLUMN fullsize_cache_version_code TO fullsize_cache_version;
`
  },
  {
    name: 'useNullForUnknownPhotoLocationsV12',
    query: `
UPDATE photos SET location_name_id = NULL WHERE location_name_id = 0;
`
  },
  {
    name: 'deduplicateLocationNamesV13',
    query: `
BEGIN IMMEDIATE;

-- Repoint every photo to the lowest ID for its normalized location name.
UPDATE photos
SET location_name_id = (
  SELECT MIN(candidate.id)
  FROM location_names AS current
  JOIN location_names AS candidate
    ON lower(trim(candidate.place_name)) = lower(trim(current.place_name))
   AND lower(trim(COALESCE(candidate.country_code, ''))) = lower(trim(COALESCE(current.country_code, '')))
   AND lower(trim(COALESCE(candidate.region, ''))) = lower(trim(COALESCE(current.region, '')))
   AND lower(trim(COALESCE(candidate.locality, ''))) = lower(trim(COALESCE(current.locality, '')))
   AND lower(trim(COALESCE(candidate.provider, ''))) = lower(trim(COALESCE(current.provider, '')))
  WHERE current.id = photos.location_name_id
)
WHERE location_name_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM location_names WHERE id = photos.location_name_id);

-- Remove duplicate rows only after all photo references have been redirected.
DELETE FROM location_names
WHERE id NOT IN (
  SELECT MIN(id)
  FROM location_names
  GROUP BY
    lower(trim(place_name)),
    lower(trim(COALESCE(country_code, ''))),
    lower(trim(COALESCE(region, ''))),
    lower(trim(COALESCE(locality, ''))),
    lower(trim(COALESCE(provider, '')))
);

-- Prevent future duplicates regardless of coordinate differences or letter casing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_location_names_normalized_unique
ON location_names (
  lower(trim(place_name)),
  lower(trim(COALESCE(country_code, ''))),
  lower(trim(COALESCE(region, ''))),
  lower(trim(COALESCE(locality, ''))),
  lower(trim(COALESCE(provider, '')))
);

COMMIT;
`
  },
  {
    name: 'storeFullAddressAndStreetInLocationNamesV14',
    query: `
BEGIN IMMEDIATE;

ALTER TABLE location_names ADD COLUMN display_name TEXT;
ALTER TABLE location_names ADD COLUMN street TEXT;

-- Include the full address and street in the identity key so distinct streets
-- and addresses are not merged just because their place/locality fields match.
DROP INDEX IF EXISTS idx_location_names_normalized_unique;
CREATE UNIQUE INDEX idx_location_names_normalized_unique
ON location_names (
  lower(trim(place_name)),
  lower(trim(COALESCE(country_code, ''))),
  lower(trim(COALESCE(region, ''))),
  lower(trim(COALESCE(locality, ''))),
  lower(trim(COALESCE(street, ''))),
  lower(trim(COALESCE(display_name, ''))),
  lower(trim(COALESCE(provider, '')))
);

COMMIT;
`
  },
  {
    name: 'trackReverseGeocodingLookupStatusV15',
    query: `
ALTER TABLE photos ADD COLUMN location_lookup_error TEXT;
ALTER TABLE photos ADD COLUMN location_lookup_attempted_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_photos_location_lookup_status
ON photos (location_name_id, location_lookup_attempted_at);
`
  }

];
// @formatter:on
