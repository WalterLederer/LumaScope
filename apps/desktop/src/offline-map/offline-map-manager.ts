import { app, dialog, type IpcMainInvokeEvent } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IpcHandler } from '../app/decorators/ipc-handler';
export interface OfflineMapStatus { id:string; available:boolean; filePath:string; fileName:string; name:string; format:string; minZoom:number; maxZoom:number; bounds:string|null; error:string|null; }
export interface OfflineMapImportResult { maps:OfflineMapStatus[]; errors:string[]; }
interface OpenOfflineMap { database:DatabaseSync; tileStatement:ReturnType<DatabaseSync['prepare']>; status:OfflineMapStatus; bounds:[number,number,number,number]; area:number; }
const EMPTY_STATUS:OfflineMapStatus={id:'',available:false,filePath:'',fileName:'',name:'',format:'',minZoom:0,maxZoom:0,bounds:null,error:null};
export class OfflineMapManager {
 private readonly settingsPath=resolve(app.getPath('userData'),'offline-map.json');
 private readonly opened=new Map<string,OpenOfflineMap>();
 private activeId:string|null=null;
 private tileDiagnosticsCount=0;
 private lastDirectory=app.getPath('documents');
 constructor(){this.restoreMaps();}
 @IpcHandler({name:'OfflineMap.chooseFile'})
 readonly chooseFile=async(_event:IpcMainInvokeEvent):Promise<OfflineMapImportResult>=>{
  const result=await dialog.showOpenDialog({title:'Add offline MBTiles maps',defaultPath:this.lastDirectory,properties:['openFile','multiSelections'],filters:[{name:'MBTiles database',extensions:['mbtiles']}]});
  if(result.canceled||!result.filePaths.length)return {maps:await this.getMaps(),errors:[]};
  this.lastDirectory=dirname(result.filePaths[0]);
  const errors:string[]=[];
  for(const filePath of result.filePaths){try{this.openFile(filePath);}catch(error){errors.push(filePath+': '+(error instanceof Error?error.message:String(error)));}}
  this.persistMaps(); if(errors.length)console.error('[OfflineMap] Some MBTiles files could not be added:',errors);
  return {maps:await this.getMaps(),errors};
 };
 @IpcHandler({name:'OfflineMap.getMaps'})
 readonly getMaps=async(_event?:IpcMainInvokeEvent):Promise<OfflineMapStatus[]>=>[...this.opened.values()].map(item=>({...item.status}));
 @IpcHandler({name:'OfflineMap.removeFile'})
 readonly removeFile=async(_event:IpcMainInvokeEvent,id:string):Promise<OfflineMapStatus[]>=>{
  const item=this.opened.get(id); if(item){item.database.close();this.opened.delete(id);if(this.activeId===id)this.activeId=null;this.persistMaps();} return this.getMaps();
 };
 @IpcHandler({name:'OfflineMap.getStatus'})
 readonly getStatus=async(_event?:IpcMainInvokeEvent):Promise<OfflineMapStatus>=>{const item=this.activeId?this.opened.get(this.activeId):null;return item?{...item.status}:{...EMPTY_STATUS};};
 @IpcHandler({name:'OfflineMap.selectForCoordinates'})
 readonly selectForCoordinates=async(_event:IpcMainInvokeEvent,latitude:number,longitude:number):Promise<OfflineMapStatus|null>=>{
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180)return null;
  const matches=[...this.opened.values()].filter(item=>longitude>=item.bounds[0]&&longitude<=item.bounds[2]&&latitude>=item.bounds[1]&&latitude<=item.bounds[3]).sort((a,b)=>a.area-b.area);
  const selected=matches[0]??null;this.activeId=selected?.status.id??null;return selected?{...selected.status}:null;
 };
 getTile(z:number,x:number,xyzY:number,mapId?:string|null):Uint8Array|null{
  const opened=mapId?this.opened.get(mapId):(this.activeId?this.opened.get(this.activeId):null);
  if(!opened||z<opened.status.minZoom||z>opened.status.maxZoom)return null;
  const dimension=2**z;if(x<0||x>=dimension||xyzY<0||xyzY>=dimension)return null;
  const tmsY=dimension-1-xyzY;const row=opened.tileStatement.get(z,x,tmsY) as {tile_data?:Uint8Array}|undefined;
  const tile=row?.tile_data?Buffer.from(row.tile_data):null;
  if(this.tileDiagnosticsCount<12){console.info('[OfflineMap] Tile lookup:',{map:opened.status.name,z,x,xyzY,tmsY,found:tile!==null,bytes:tile?.byteLength??0});this.tileDiagnosticsCount++;}
  return tile;
 }
 private restoreMaps():void{
  if(!existsSync(this.settingsPath))return;
  try{const settings=JSON.parse(readFileSync(this.settingsPath,'utf8')) as {filePaths?:unknown;filePath?:unknown;lastDirectory?:unknown};
   if(typeof settings.lastDirectory==='string'&&existsSync(settings.lastDirectory))this.lastDirectory=settings.lastDirectory;
   const paths=Array.isArray(settings.filePaths)?settings.filePaths.filter((v):v is string=>typeof v==='string'):typeof settings.filePath==='string'?[settings.filePath]:[];
   for(const path of paths){try{this.openFile(path);}catch(error){console.warn('[OfflineMap] Could not restore MBTiles:',path,error);}}
  }catch(error){console.error('[OfflineMap] Could not restore map list:',error);}
 }
 private persistMaps():void{writeFileSync(this.settingsPath,JSON.stringify({filePaths:[...this.opened.values()].map(item=>item.status.filePath),lastDirectory:this.lastDirectory},null,2),'utf8');}
 private openFile(filePath:string):void{
  const absolutePath=resolve(filePath);if(extname(absolutePath).toLowerCase()!=='.mbtiles')throw new Error('The selected file must have the .mbtiles extension.');
  if(!existsSync(absolutePath))throw new Error('The selected MBTiles file does not exist.');if(this.opened.has(absolutePath))return;
  const database=new DatabaseSync(absolutePath,{readOnly:true});
  try{
   database.exec('PRAGMA query_only = ON;');
   const hasMetadata=database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type IN ('table','view') AND name='metadata'").get();
   const hasTiles=database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type IN ('table','view') AND name='tiles'").get();
   if(!hasMetadata||!hasTiles)throw new Error('The SQLite file is not a valid MBTiles database (metadata or tiles table missing).');
   const rows=database.prepare('SELECT name,value FROM metadata').all() as Array<{name:string;value:string}>;const metadata=new Map(rows.map(item=>[item.name,item.value]));
   const format=metadata.get('format')?.toLowerCase()??'';if(format!=='pbf')throw new Error('Unsupported MBTiles format "'+(format||'missing')+'". Expected vector tiles (pbf).');
   const minZoom=Number(metadata.get('minzoom')),maxZoom=Number(metadata.get('maxzoom'));
   if(!Number.isInteger(minZoom)||!Number.isInteger(maxZoom)||minZoom<0||maxZoom>22||minZoom>maxZoom)throw new Error('The MBTiles zoom metadata is missing or invalid.');
   let layers:unknown;try{layers=(JSON.parse(metadata.get('json')??'{}') as {vector_layers?:unknown}).vector_layers;}catch{throw new Error('The MBTiles vector-layer metadata contains invalid JSON.');}
   if(!Array.isArray(layers)||!layers.length)throw new Error('The MBTiles file does not contain valid vector_layers metadata.');
   const layerIds=new Set((layers as Array<{id?:unknown}>).map(layer=>typeof layer.id==='string'?layer.id:''));
   const missingLayers=['land','streets','water_polygons'].filter(id=>!layerIds.has(id));
   if(missingLayers.length)throw new Error('The MBTiles schema is not compatible with the Shortbread map style. Missing layers: '+missingLayers.join(', ')+'.');
   const raw=(metadata.get('bounds')??'').split(',').map(Number);
   const bounds=raw.length===4&&raw.every(Number.isFinite)&&raw[0]>=-180&&raw[2]<=180&&raw[1]>=-90&&raw[3]<=90&&raw[0]<raw[2]&&raw[1]<raw[3]?raw as [number,number,number,number]:null;
   if(!bounds)throw new Error('The MBTiles file has missing or invalid geographic bounds metadata.');
   const tileStatement=database.prepare('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?');
   const sample=database.prepare('SELECT tile_data FROM tiles LIMIT 1').get() as {tile_data?:Uint8Array}|undefined;
   if(!sample?.tile_data||Buffer.from(sample.tile_data).subarray(0,2).toString('hex')!=='1f8b')throw new Error('The MBTiles tiles are not gzip-compressed PBF data.');
   const status:OfflineMapStatus={id:absolutePath,available:true,filePath:absolutePath,fileName:basename(absolutePath),name:metadata.get('name')??absolutePath.split(/[\\/]/).pop()??'Offline map',format,minZoom,maxZoom,bounds:bounds.join(','),error:null};
   this.opened.set(absolutePath,{database,tileStatement,status,bounds,area:(bounds[2]-bounds[0])*(bounds[3]-bounds[1])});if(!this.activeId)this.activeId=absolutePath;
  }catch(error){database.close();throw error;}
 }
}
