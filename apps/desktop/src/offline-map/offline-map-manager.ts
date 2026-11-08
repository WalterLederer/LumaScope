import { app, dialog, type IpcMainInvokeEvent } from 'electron';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { readAppSettings, updateAppSettingsSection } from '../settings/app-settings';
export interface OfflineMapStatus { type?:'mbtiles'|'obf'; id:string; available:boolean; enabled:boolean; filePath:string; fileName:string; fileSize:number; lastModified:number; name:string; format:string; minZoom:number; maxZoom:number; bounds:string|null; error:string|null; schema?:'shortbread'|'openmaptiles'; vectorLayers?:string[]; }
export interface OfflineMapImportResult { maps:OfflineMapStatus[]; errors:string[]; }
interface OpenOfflineMap { database:DatabaseSync; tileStatement:ReturnType<DatabaseSync['prepare']>; status:OfflineMapStatus; bounds:[number,number,number,number]; area:number; }
const EMPTY_STATUS:OfflineMapStatus={id:'',available:false,enabled:false,filePath:'',fileName:'',fileSize:0,lastModified:0,name:'',format:'',minZoom:0,maxZoom:0,bounds:null,error:null};
export class OfflineMapManager {
 private readonly opened=new Map<string,OpenOfflineMap>();
 private readonly obfFiles=new Map<string,OfflineMapStatus>();
 private activeId:string|null=null;
 private readonly enabledByPath=new Map<string,boolean>();
 private tileDiagnosticsCount=0;
 private lastDirectory=app.getPath('documents');
 constructor(){this.restoreMaps();}
 @IpcHandler({name:'OfflineMap.chooseFile'})
 readonly chooseFile=async(_event:IpcMainInvokeEvent):Promise<OfflineMapImportResult>=>{
  const result=await dialog.showOpenDialog({title:'Add offline maps',defaultPath:this.lastDirectory,properties:['openFile','multiSelections'],filters:[{name:'Offline maps',extensions:['mbtiles','obf']}]});
  if(result.canceled||!result.filePaths.length)return {maps:await this.getMaps(),errors:[]};
  this.lastDirectory=dirname(result.filePaths[0]);
  const errors:string[]=[];
  for(const filePath of result.filePaths){try{if(extname(filePath).toLowerCase()==='.obf')this.openObfFile(filePath);else this.openFile(filePath);}catch(error){errors.push(filePath+': '+(error instanceof Error?error.message:String(error)));}}
  this.persistMaps(); if(errors.length)console.error('[OfflineMap] Some MBTiles files could not be added:',errors);
  return {maps:await this.getMaps(),errors};
 };
 @IpcHandler({name:'OfflineMap.getMaps'})
 readonly getMaps=async(_event?:IpcMainInvokeEvent):Promise<OfflineMapStatus[]>=>[...this.opened.values()].map(item=>({...item.status})).concat([...this.obfFiles.values()].map(item=>({...item})));
 @IpcHandler({name:'OfflineMap.setEnabled'})
 readonly setEnabled=async(_event:IpcMainInvokeEvent,id:string,enabled:boolean):Promise<OfflineMapStatus[]>=>{
  const item=this.opened.get(id); const obf=this.obfFiles.get(id);
  if(obf&&typeof enabled==='boolean'){
   if(enabled)for(const [otherId,other] of this.obfFiles){if(otherId!==id){other.enabled=false;this.enabledByPath.set(otherId,false);}}
   obf.enabled=enabled;this.enabledByPath.set(id,enabled);this.persistMaps();
  }
  if(item&&typeof enabled==='boolean'){
   item.status.enabled=enabled;
   this.enabledByPath.set(id,enabled);
   if(!enabled&&this.activeId===id)this.activeId=null;
   this.persistMaps();
  }
  return this.getMaps();
 };
 @IpcHandler({name:'OfflineMap.removeFile'})
 readonly removeFile=async(_event:IpcMainInvokeEvent,id:string):Promise<OfflineMapStatus[]>=>{
  const obf=this.obfFiles.get(id);if(obf)this.obfFiles.delete(id); const item=this.opened.get(id); if(item){item.database.close();this.opened.delete(id);if(this.activeId===id)this.activeId=null;} if(obf||item)this.persistMaps(); return this.getMaps();
 };
 @IpcHandler({name:'OfflineMap.getStatus'})
 readonly getStatus=async(_event?:IpcMainInvokeEvent):Promise<OfflineMapStatus>=>{const item=this.activeId?this.opened.get(this.activeId):null;return item?{...item.status}:{...EMPTY_STATUS};};
 @IpcHandler({name:'OfflineMap.selectForCoordinates'})
 readonly selectForCoordinates=async(_event:IpcMainInvokeEvent,latitude:number,longitude:number):Promise<OfflineMapStatus|null>=>{
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180)return null;
  const matches=[...this.opened.values()].filter(item=>item.status.enabled&&longitude>=item.bounds[0]&&longitude<=item.bounds[2]&&latitude>=item.bounds[1]&&latitude<=item.bounds[3]).sort((a,b)=>a.area-b.area);
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
  try{
   let settings=(readAppSettings().offlineMaps ?? {}) as {filePaths?:unknown;obfPaths?:unknown;filePath?:unknown;lastDirectory?:unknown;enabledByPath?:Record<string,unknown>};
   if(!Object.keys(settings).length){
    const legacyPath=join(app.getPath('userData'),'offline-map.json');
    if(existsSync(legacyPath)){
     settings=JSON.parse(readFileSync(legacyPath,'utf8')) as typeof settings;
     void updateAppSettingsSection('Maps',settings as Record<string,unknown>);
    }
   }
   if(typeof settings.lastDirectory==='string'&&existsSync(settings.lastDirectory))this.lastDirectory=settings.lastDirectory;
   if(settings.enabledByPath&&typeof settings.enabledByPath==='object')for(const [path,enabled] of Object.entries(settings.enabledByPath))if(typeof enabled==='boolean')this.enabledByPath.set(path,enabled);
   const paths=Array.isArray(settings.filePaths)?settings.filePaths.filter((v):v is string=>typeof v==='string'):typeof settings.filePath==='string'?[settings.filePath]:[];
   for(const path of paths){try{this.openFile(path);}catch(error){console.warn('[OfflineMap] Could not restore MBTiles:',path,error);}}
   const obfPaths=Array.isArray(settings.obfPaths)?settings.obfPaths.filter((v):v is string=>typeof v==='string'):[];
   for(const path of obfPaths){try{this.openObfFile(path);}catch(error){console.warn('[OfflineMap] Could not restore OBF:',path,error);}}
  }catch(error){console.error('[OfflineMap] Could not restore map list:',error);}
 }
 private persistMaps():void{void updateAppSettingsSection('Maps',{filePaths:[...this.opened.values()].map(item=>item.status.filePath),obfPaths:[...this.obfFiles.values()].map(item=>item.filePath),enabledByPath:Object.fromEntries([...this.opened].map(([path,item])=>[path,item.status.enabled]).concat([...this.obfFiles].map(([path,item])=>[path,item.enabled]))),lastDirectory:this.lastDirectory}).catch(error=>console.error('[OfflineMap] Could not save map settings:',error));}
 private openObfFile(filePath:string):void{
  const absolutePath=resolve(filePath);if(extname(absolutePath).toLowerCase()!=='.obf')throw new Error('The selected file must have the .obf extension.');
  if(!existsSync(absolutePath))throw new Error('The selected OBF file does not exist.');if(this.obfFiles.has(absolutePath))return;
  const fileStats=statSync(absolutePath);if(!fileStats.isFile()||fileStats.size<=0)throw new Error('The selected OBF file is empty or invalid.');
  const fileName=basename(absolutePath);const status:OfflineMapStatus={type:'obf',id:absolutePath,available:true,enabled:this.enabledByPath.get(absolutePath)??true,filePath:absolutePath,fileName,fileSize:fileStats.size,lastModified:fileStats.mtimeMs,name:fileName.replace(/\\.obf$/i,''),format:'OBF',minZoom:0,maxZoom:22,bounds:null,error:null};
  this.obfFiles.set(absolutePath,status);
 }
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
   const vectorLayers=(layers as Array<{id?:unknown}>).map(layer=>typeof layer.id==='string'?layer.id:'').filter(Boolean);
   const layerIds=new Set(vectorLayers);
   const isShortbread=['land','streets','water_polygons'].every(id=>layerIds.has(id));
   const isOpenMapTiles=layerIds.has('transportation')&&layerIds.has('water')&&(layerIds.has('landcover')||layerIds.has('landuse'));
   if(!isShortbread&&!isOpenMapTiles)throw new Error('Unsupported MBTiles vector schema. Expected Shortbread (land, streets, water_polygons) or OpenMapTiles (transportation, water, landcover/landuse). Available layers: '+vectorLayers.join(', ')+'.');
   const schema:'shortbread'|'openmaptiles'=isShortbread?'shortbread':'openmaptiles';
   const raw=(metadata.get('bounds')??'').split(',').map(Number);
   const bounds=raw.length===4&&raw.every(Number.isFinite)&&raw[0]>=-180&&raw[2]<=180&&raw[1]>=-90&&raw[3]<=90&&raw[0]<raw[2]&&raw[1]<raw[3]?raw as [number,number,number,number]:null;
   if(!bounds)throw new Error('The MBTiles file has missing or invalid geographic bounds metadata.');
   const tileStatement=database.prepare('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?');
   const sample=database.prepare('SELECT tile_data FROM tiles LIMIT 1').get() as {tile_data?:Uint8Array}|undefined;
   if(!sample?.tile_data||Buffer.from(sample.tile_data).subarray(0,2).toString('hex')!=='1f8b')throw new Error('The MBTiles tiles are not gzip-compressed PBF data.');
   const fileStats=statSync(absolutePath);
   const status:OfflineMapStatus={type:'mbtiles',id:absolutePath,available:true,enabled:this.enabledByPath.get(absolutePath)??true,filePath:absolutePath,fileName:basename(absolutePath),fileSize:fileStats.size,lastModified:fileStats.mtimeMs,name:metadata.get('name')??absolutePath.split(/[\\/]/).pop()??'Offline map',format,minZoom,maxZoom,bounds:bounds.join(','),error:null,schema,vectorLayers};
   this.opened.set(absolutePath,{database,tileStatement,status,bounds,area:(bounds[2]-bounds[0])*(bounds[3]-bounds[1])});if(!this.activeId&&status.enabled)this.activeId=absolutePath;
  }catch(error){database.close();throw error;}
 }
}
