import { app, dialog, type IpcMainInvokeEvent } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IpcHandler } from '../app/decorators/ipc-handler';

export interface OfflineMapStatus {
  available: boolean;
  filePath: string | null;
  name: string | null;
  format: string | null;
  minZoom: number | null;
  maxZoom: number | null;
  bounds: string | null;
  error: string | null;
}

interface OpenOfflineMap {
  database: DatabaseSync;
  tileStatement: ReturnType<DatabaseSync['prepare']>;
  status: OfflineMapStatus;
}

const EMPTY_STATUS: OfflineMapStatus = {
  available: false,
  filePath: null,
  name: null,
  format: null,
  minZoom: null,
  maxZoom: null,
  bounds: null,
  error: null
};

export class OfflineMapManager {
  private readonly settingsPath = join(app.getPath('userData'), 'offline-map.json');
  private opened: OpenOfflineMap | null = null;
  private status: OfflineMapStatus = { ...EMPTY_STATUS };
  private tileDiagnosticsCount = 0;

  constructor() {
    this.restoreSelection();
  }

  @IpcHandler({ name: 'OfflineMap.chooseFile' })
  readonly chooseFile = async (_event: IpcMainInvokeEvent): Promise<OfflineMapStatus> => {
    const result = await dialog.showOpenDialog({
      title: 'Select offline MBTiles map',
      defaultPath: this.status.filePath ?? undefined,
      properties: [ 'openFile' ],
      filters: [
        { name: 'MBTiles database', extensions: [ 'mbtiles' ] },
        { name: 'SQLite database', extensions: [ 'sqlite', 'db' ] }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) return this.getStatus();

    try {
      this.openFile(result.filePaths[0]);
      writeFileSync(this.settingsPath, JSON.stringify({ filePath: this.status.filePath }, null, 2), 'utf8');
    } catch (error) {
      this.status = { ...this.status, error: error instanceof Error ? error.message : String(error) };
    }

    return this.getStatus();
  };

  @IpcHandler({ name: 'OfflineMap.getStatus' })
  readonly getStatus = async (_event?: IpcMainInvokeEvent): Promise<OfflineMapStatus> => ({ ...this.status });

  getTile(z: number, x: number, xyzY: number): Uint8Array | null {
    const opened = this.opened;
    if (!opened || z < opened.status.minZoom! || z > opened.status.maxZoom!) return null;

    const dimension = 2 ** z;
    if (x < 0 || x >= dimension || xyzY < 0 || xyzY >= dimension) return null;

    // MBTiles stores TMS rows; MapLibre requests XYZ rows.
    const tmsY = dimension - 1 - xyzY;
    const row = opened.tileStatement.get(z, x, tmsY) as { tile_data?: Uint8Array } | undefined;
    const tile = row?.tile_data ? Buffer.from(row.tile_data) : null;
    if (this.tileDiagnosticsCount < 12) {
      console.info('[OfflineMap] Tile lookup:', { z, x, xyzY, tmsY, found: tile !== null, bytes: tile?.byteLength ?? 0 });
      this.tileDiagnosticsCount++;
    }
    return tile;
  }

  private restoreSelection(): void {
    if (!existsSync(this.settingsPath)) return;
    try {
      const settings = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as { filePath?: unknown };
      if (typeof settings.filePath === 'string' && settings.filePath.trim()) {
        this.openFile(settings.filePath);
      }
    } catch (error) {
      this.status = { ...EMPTY_STATUS, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private openFile(filePath: string): void {
    const absolutePath = resolve(filePath);
    if (extname(absolutePath).toLowerCase() !== '.mbtiles') {
      throw new Error('The selected file must have the .mbtiles extension.');
    }
    if (!existsSync(absolutePath)) throw new Error('The selected MBTiles file does not exist.');

    const database = new DatabaseSync(absolutePath, { readOnly: true });
    try {
      database.exec('PRAGMA query_only = ON;');
      const hasMetadata = database.prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'metadata'"
      ).get();
      const hasTiles = database.prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'tiles'"
      ).get();
      if (!hasMetadata || !hasTiles) throw new Error('The SQLite file is not a valid MBTiles database (metadata or tiles table missing).');

      const metadataRows = database.prepare('SELECT name, value FROM metadata').all() as Array<{ name: string; value: string }>;
      const metadata = new Map(metadataRows.map(item => [item.name, item.value]));
      const format = metadata.get('format')?.toLowerCase() ?? '';
      if (format !== 'pbf') throw new Error(`Unsupported MBTiles format "${format || 'missing'}". Expected vector tiles (pbf).`);

      const minZoom = Number(metadata.get('minzoom'));
      const maxZoom = Number(metadata.get('maxzoom'));
      if (!Number.isInteger(minZoom) || !Number.isInteger(maxZoom) || minZoom < 0 || maxZoom > 22 || minZoom > maxZoom) {
        throw new Error('The MBTiles zoom metadata is missing or invalid.');
      }

      let vectorLayers: unknown;
      try {
        const json = JSON.parse(metadata.get('json') ?? '{}') as { vector_layers?: unknown };
        vectorLayers = json.vector_layers;
      } catch {
        throw new Error('The MBTiles vector-layer metadata contains invalid JSON.');
      }
      if (!Array.isArray(vectorLayers) || vectorLayers.length === 0) {
        throw new Error('The MBTiles file does not contain valid vector_layers metadata.');
      }

      const tileStatement = database.prepare(
        'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
      );
      const sample = database.prepare('SELECT tile_data FROM tiles LIMIT 1').get() as { tile_data?: Uint8Array } | undefined;
      if (!sample?.tile_data || Buffer.from(sample.tile_data).subarray(0, 2).toString('hex') !== '1f8b') {
        throw new Error('The MBTiles tiles are not gzip-compressed PBF data.');
      }

      const next: OpenOfflineMap = {
        database,
        tileStatement,
        status: {
          available: true,
          filePath: absolutePath,
          name: metadata.get('name') ?? 'Offline map',
          format,
          minZoom,
          maxZoom,
          bounds: metadata.get('bounds') ?? null,
          error: null
        }
      };

      const previous = this.opened;
      this.tileDiagnosticsCount = 0;
      this.opened = next;
      this.status = next.status;
      previous?.database.close();
    } catch (error) {
      database.close();
      throw error;
    }
  }
}
