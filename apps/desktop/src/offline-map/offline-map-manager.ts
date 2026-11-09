import { app, dialog, type IpcMainInvokeEvent } from 'electron';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IpcHandler } from '../app/decorators/ipc-handler';
import { readAppSettings, updateAppSettingsSection } from '../settings/app-settings';
export interface OfflineMapStatus { type?:'mbtiles'|'obf'; updateMatched?:boolean; id:string; available:boolean; enabled:boolean; filePath:string; fileName:string; fileSize:number; lastModified:number; name:string; format:string; minZoom:number; maxZoom:number; bounds:string|null; error:string|null; schema?:'shortbread'|'openmaptiles'; vectorLayers?:string[]; updateAvailable?:boolean|null; updateChecked?:boolean; updateDate?:string|null; updateSource?:string|null; }
export interface OfflineMapCatalogueFile { fileName:string; fileType:'obf'|'mbtiles'; dateMs:number|null; source:string; url:string; }
export interface OfflineMapUpdateCheckResult { maps:OfflineMapStatus[]; checkedAt:string; filesFound:number; matchedMaps:number; unmatchedMaps:number; catalogueFiles:OfflineMapCatalogueFile[]; sourceErrors:string[]; }
interface RemoteMapFile { fileName:string; dateMs:number|null; source:string; fileType:'obf'|'mbtiles'; url:string; }
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
  await this.persistMaps(); if(errors.length)console.error('[OfflineMap] Some offline maps could not be added:',errors);
  return {maps:await this.getMaps(),errors};
 };
 @IpcHandler({name:'OfflineMap.getMaps'})
 readonly getMaps=async(_event?:IpcMainInvokeEvent):Promise<OfflineMapStatus[]>=>[...this.opened.values()].map(item=>({...item.status})).concat([...this.obfFiles.values()].map(item=>({...item})));
 @IpcHandler({name:'OfflineMap.checkForUpdates'})
 readonly checkForUpdates=async(_event?:IpcMainInvokeEvent):Promise<OfflineMapUpdateCheckResult>=>{
  const offlineSettings=(readAppSettings().offlineMaps??{}) as Record<string,unknown>;
  const defaultSources=[
   {url:'https://download.geofabrik.de/europe/austria.html',fileType:'mbtiles' as const,useForUpdates:true},
   {url:'https://www.limaps.org/tileserver.html',fileType:'mbtiles' as const,useForUpdates:true},
   {url:'https://shortbread-tiles.org/download/',fileType:'mbtiles' as const,useForUpdates:true},
   {url:'https://download.osmand.net/list.php',fileType:'obf' as const,useForUpdates:true},
   {url:'https://github.com/osmandapp/OsmAnd-resources',fileType:'obf' as const,useForUpdates:false}
  ];
  const savedSources=Array.isArray(offlineSettings.updateSources)?offlineSettings.updateSources:defaultSources;
  const sources=savedSources.filter((entry):entry is {url:string;fileType:'obf'|'mbtiles';useForUpdates:boolean}=>{
   if(!entry||typeof entry!=='object')return false;
   const source=entry as Record<string,unknown>;
   return typeof source.url==='string'&&(source.fileType==='obf'||source.fileType==='mbtiles')&&source.useForUpdates===true;
  }).map(source=>({name:(()=>{try{return new URL(source.url).hostname;}catch{return source.url;}})(),url:source.url,fileType:source.fileType}));
  const files:RemoteMapFile[]=[];const sourceErrors:string[]=[];
  const fetchPage=async(url:string):Promise<string>=>{
   const response=await fetch(url,{headers:{'User-Agent':'LumaScope offline map update checker'},signal:AbortSignal.timeout(20000)});
   if(!response.ok)throw new Error('HTTP '+response.status+' '+response.statusText);
   return response.text();
  };
  const parseDate=(text:string,fileName:string):number|null=>{
   let match=text.match(/\b(20\d{2})[-\\/](\d{2})[-\\/](\d{2})(?:[ T](\d{2}):(\d{2}))?/);
   if(match)return Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]),Number(match[4]??0),Number(match[5]??0));
   match=text.match(/\b(\d{2})\.(\d{2})\.(20\d{2})(?:[ ,]+(\d{2}):(\d{2}))?/);
   if(match)return Date.UTC(Number(match[3]),Number(match[2])-1,Number(match[1]),Number(match[4]??0),Number(match[5]??0));
   match=text.match(/\b(20\d{2})\/(\d{2})\b/);
   if(match)return Date.UTC(Number(match[1]),Number(match[2])-1,1);
   match=fileName.match(/(?:^|[-_])(20\d{2})[-_](\d{2})[-_](\d{2})(?:[-_.]|$)/);
   if(match)return Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]));
   return null;
  };
  const parseFiles=(html:string,baseUrl:string,source:string,fileType:'obf'|'mbtiles'):void=>{
   const anchors=html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
   for(const anchor of anchors){
    const href=anchor[1].replace(/&amp;/g,'&');const label=anchor[2].replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
    let fileName=label;
    try{fileName=decodeURIComponent(new URL(href,baseUrl).pathname.split('/').pop()||label);}catch{}
    const extensionPattern=fileType==='obf'?/\.obf(?:\.zip)?$/i:/\.mbtiles$/i;
    if(!extensionPattern.test(fileName)&&!extensionPattern.test(label))continue;
    if(!extensionPattern.test(fileName))fileName=label;
    const position=anchor.index??0;const rowStart=Math.max(html.lastIndexOf('<tr',position),html.lastIndexOf('<li',position));
    let rowEnd=html.indexOf('</tr>',position);const liEnd=html.indexOf('</li>',position);
    if(rowEnd<0||(liEnd>=0&&liEnd<rowEnd))rowEnd=liEnd;
    const context=html.slice(rowStart>=0?rowStart:Math.max(0,position-350),rowEnd>=0?rowEnd+5:Math.min(html.length,position+500));
    files.push({fileName,dateMs:parseDate(context,fileName),source,fileType,url:new URL(href,baseUrl).toString()});
   }
  };
  const tasks=sources.map(async source=>{
   try{
    const html=await fetchPage(source.url);parseFiles(html,source.url,source.name,source.fileType);
    if(source.url.includes('geofabrik.de')){
     const rawIndex=html.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*(?:raw directory index|directory index)\s*<\/a>/i);
     if(rawIndex){
      const indexUrl=new URL(rawIndex[1].replace(/&amp;/g,'&'),source.url).toString();
      const indexHtml=await fetchPage(indexUrl);parseFiles(indexHtml,indexUrl,source.name,source.fileType);
     }
    }
   }catch(error){sourceErrors.push(source.name+': '+(error instanceof Error?error.message:String(error)));}
  });
  await Promise.all(tasks);
  const normalize=(name:string):string=>name.split(/[\\/]/).pop()!.toLowerCase().replace(/\.zip$/i,'').normalize('NFKC') .replace(/\s+/g,' ').trim();
  const maps=[...this.opened.values()].map(value=>value.status).concat([...this.obfFiles.values()]);
  let matchedMaps=0;
  for(const item of maps){
   const key=normalize(item.fileName);
   // A catalogue entry is a match by filename and file type. A missing date
   // must not turn an existing download into an unmatched map.
   const matches=files.filter(file=>file.fileType===(item.type??'mbtiles')&&normalize(file.fileName)===key).sort((a,b)=>(b.dateMs??0)-(a.dateMs??0));
   const latest=matches[0];
   item.updateChecked=true;
   item.updateMatched=!!latest;
   if(latest)matchedMaps++;
   item.updateAvailable=latest?.dateMs!==null&&latest?.dateMs!==undefined?latest.dateMs>item.lastModified:null;
   item.updateDate=latest?.dateMs!==null&&latest?.dateMs!==undefined?new Date(latest.dateMs).toISOString():null;
   item.updateSource=latest?.source??null;
  }
  return {maps:await this.getMaps(),checkedAt:new Date().toISOString(),filesFound:files.length,matchedMaps,unmatchedMaps:maps.length-matchedMaps,catalogueFiles:files.map(file=>({...file})).sort((a,b)=>a.fileName.localeCompare(b.fileName)),sourceErrors};
 };
 @IpcHandler({name:'OfflineMap.setEnabled'})
 readonly setEnabled=async(_event:IpcMainInvokeEvent,id:string,enabled:boolean):Promise<OfflineMapStatus[]>=>{
  const item=this.opened.get(id); const obf=this.obfFiles.get(id);
  if(obf&&typeof enabled==='boolean'){
   // OBF regions are independent and may be active together.
   obf.enabled=enabled;this.enabledByPath.set(id,enabled);await this.persistMaps();
  }
  if(item&&typeof enabled==='boolean'){
   item.status.enabled=enabled;
   this.enabledByPath.set(id,enabled);
   if(!enabled&&this.activeId===id)this.activeId=null;
   await this.persistMaps();
  }
  return this.getMaps();
 };
 @IpcHandler({name:'OfflineMap.setAllEnabled'})
 readonly setAllEnabled=async(_event:IpcMainInvokeEvent,enabled:boolean):Promise<OfflineMapStatus[]>=>{
  if(typeof enabled!=='boolean')throw new Error('The Active state must be a boolean.');
  for(const [id,item] of this.opened){item.status.enabled=enabled;this.enabledByPath.set(id,enabled);}
  for(const [id,item] of this.obfFiles){item.enabled=enabled;this.enabledByPath.set(id,enabled);}
  if(!enabled)this.activeId=null;
  await this.persistMaps();
  return this.getMaps();
 };
 @IpcHandler({name:'OfflineMap.removeFile'})
 readonly removeFile=async(_event:IpcMainInvokeEvent,id:string):Promise<OfflineMapStatus[]>=>{
  const obf=this.obfFiles.get(id);if(obf)this.obfFiles.delete(id); const item=this.opened.get(id); if(item){item.database.close();this.opened.delete(id);if(this.activeId===id)this.activeId=null;} if(obf||item)await this.persistMaps(); return this.getMaps();
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
   const storedSettings=readAppSettings();
   let settings=(storedSettings.offlineMaps ?? storedSettings.Maps ?? {}) as {filePaths?:unknown;obfPaths?:unknown;filePath?:unknown;lastDirectory?:unknown;enabledByPath?:Record<string,unknown>};
   if(!Object.keys(settings).length){
    const legacyPath=join(app.getPath('userData'),'offline-map.json');
    if(existsSync(legacyPath)){
     settings=JSON.parse(readFileSync(legacyPath,'utf8')) as typeof settings;
     void updateAppSettingsSection('offlineMaps',settings as Record<string,unknown>).catch(error=>console.error('[OfflineMap] Could not migrate legacy map settings:',error));
    }
   }
   // Migrate the section name used by older builds. Both OsmAnd renderers
   // read the canonical lower-camel-case key.
   if(storedSettings.offlineMaps==null&&storedSettings.Maps!=null&&Object.keys(settings).length){
    void updateAppSettingsSection('offlineMaps',settings as Record<string,unknown>).catch(error=>console.error('[OfflineMap] Could not migrate map settings:',error));
   }
   if(typeof settings.lastDirectory==='string'&&existsSync(settings.lastDirectory))this.lastDirectory=settings.lastDirectory;
   const unifiedPaths:Record<string,boolean>={};
   const hasUnifiedPaths=!!settings.filePaths&&typeof settings.filePaths==='object'&&!Array.isArray(settings.filePaths);
   if(hasUnifiedPaths){
    for(const [path,enabled] of Object.entries(settings.filePaths as Record<string,unknown>))if(typeof enabled==='boolean')unifiedPaths[path]=enabled;
   }else{
    // One-time migration from the former split arrays and enabledByPath object.
    const mbtiles=Array.isArray(settings.filePaths)?settings.filePaths.filter((v):v is string=>typeof v==='string'):typeof settings.filePath==='string'?[settings.filePath]:[];
    const obf=Array.isArray(settings.obfPaths)?settings.obfPaths.filter((v):v is string=>typeof v==='string'):[];
    for(const path of [...mbtiles,...obf])unifiedPaths[path]=settings.enabledByPath?.[path]!==false;
   }
   for(const [path,enabled] of Object.entries(unifiedPaths)){
    this.enabledByPath.set(path,enabled);
    try{
     if(extname(path).toLowerCase()==='.obf')this.openObfFile(path);
     else if(extname(path).toLowerCase()==='.mbtiles')this.openFile(path);
    }catch(error){console.warn('[OfflineMap] Could not restore offline map:',path,error);}
   }
   if(!hasUnifiedPaths){
    void updateAppSettingsSection('offlineMaps',{filePaths:unifiedPaths}).catch(error=>console.error('[OfflineMap] Could not migrate offline map paths:',error));
   }
  }catch(error){console.error('[OfflineMap] Could not restore map list:',error);}
 }
 private persistMaps():Promise<void>{const filePaths:Record<string,boolean>={};for(const [path,item] of this.opened)filePaths[path]=item.status.enabled;for(const [path,item] of this.obfFiles)filePaths[path]=item.enabled;return updateAppSettingsSection('offlineMaps',{filePaths,lastDirectory:this.lastDirectory}).catch(error=>{console.error('[OfflineMap] Could not save map settings:',error);throw error;});}
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
