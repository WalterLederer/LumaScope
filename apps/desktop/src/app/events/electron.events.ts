import {
  captureApiSupport,
  enumerateMonitors,
  ScreenCapture
} from '@screen-capture/node';
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, IpcMainInvokeEvent, nativeImage, screen, shell } from 'electron';
import { encodeExr, init as initExr } from 'exrs';
import { CaptureFormat, CapturePreview, CaptureResult, CaptureSources, CaptureTarget, FileListing, supportedFileExtensions } from 'internal-api';
import Vips from 'wasm-vips';
import { execFileSync } from 'node:child_process';
import koffi from 'koffi';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Injector } from '../../injector/injector';
import App from '../app';
import { IpcRegistry } from '../decorators/ipc-registry';
import { captureLoupeFrame, releaseLoupeFrame, sampleLoupeRectangle, sampleLoupeRegion } from '../loupe-capture';

let exrInitPromise: Promise<void> | undefined;
let vipsInitPromise: Promise<typeof Vips> | undefined;

interface ExternalProcessCall {
  id: number;
  timestamp: number;
  programName: string;
  commandLine: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
}

const externalProcessCalls: ExternalProcessCall[] = [];
let nextExternalProcessCallId = 1;

const publishExternalProcessCall = (call: ExternalProcessCall): void => {
  externalProcessCalls.push(call);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('Profiling.externalProcessCall', call);
    }
  }
};

const runExternalProcessSync = (
  command: string,
  args: readonly string[],
  options: { encoding?: BufferEncoding; windowsHide?: boolean; timeout?: number; env?: NodeJS.ProcessEnv; stdio?: 'pipe' | 'inherit' }
): Buffer | string => {
  const commandLine = [command, ...args].map(value => JSON.stringify(value)).join(' ');
  const startedAt = Date.now();
  const timestamp = startedAt;
  const programName = path.basename(command);
  try {
    const result = execFileSync(command, [...args], options);
    const durationMs = Date.now() - startedAt;
    const call: ExternalProcessCall = {
      id: nextExternalProcessCallId++,
      timestamp,
      programName,
      commandLine,
      durationMs,
      exitCode: 0,
      signal: null
    };
    publishExternalProcessCall(call);
    return result;
  } catch (error) {
    const processError = error as NodeJS.ErrnoException & { status?: number | null; signal?: string | null };
    const durationMs = Date.now() - startedAt;
    const call: ExternalProcessCall = {
      id: nextExternalProcessCallId++,
      timestamp,
      programName,
      commandLine,
      durationMs,
      exitCode: processError.status ?? null,
      signal: processError.signal ?? null
    };
    publishExternalProcessCall(call);
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[ExternalProcess] EXIT ${programName} code=${processError.status ?? 'unknown'} signal=${processError.signal ?? 'none'} duration=${durationMs}ms: ${errorMessage}`);
    throw error;
  }
};

const halfToFloat = (half: number): number => {
  const sign = (half & 0x8000) !== 0 ? -1 : 1;
  const exponent = (half >> 10) & 0x1f;
  const fraction = half & 0x03ff;
  if (exponent === 0) {
    return fraction === 0 ? sign * 0 : sign * 2 ** -14 * (fraction / 1024);
  }
  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : NaN;
  }
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
};


interface CapturedHdrFrame {
  targetKey: string;
  width: number;
  height: number;
  buffer: Buffer;
}

let cachedHdrFrame: CapturedHdrFrame | null = null;

const captureTargetKey = (target: CaptureTarget, ownerWindow?: Electron.BrowserWindow | null): string =>
  target.kind === 'monitor'
    ? `monitor:${target.index}`
    : target.kind === 'window'
      ? `window:${target.handle}`
      : target.kind === 'rectangle'
        ? 'rectangle'
        : target.includeLightMatterWindows ? `top-window:include-light-matter:${ownerWindow?.id ?? 'default'}` : 'top-window';

interface Win32Rect {
  Left: number;
  Top: number;
  Right: number;
  Bottom: number;
}

interface Win32MonitorInfoEx {
  cbSize: number;
  rcMonitor: Win32Rect;
  rcWork: Win32Rect;
  dwFlags: number;
  szDevice: string;
}

interface Win32NativeApi {
  Rect: unknown;
  MonitorInfoEx: unknown;
  PathInfo: unknown;
  SourceName: unknown;
  AdvancedColorInfo: unknown;
  AdvancedColorInfo2: unknown;
  user32: {
    IsWindow: (handle: number) => number;
    IsWindowVisible: (handle: number) => number;
    IsIconic: (handle: number) => number;
    EnumWindows: (callback: (handle: number, lParam: number) => number, lParam: number) => number;
    GetWindowTextW: (handle: number, text: Buffer, maxCount: number) => number;
    GetClassNameW: (handle: number, text: Buffer, maxCount: number) => number;
    GetWindowThreadProcessId: (handle: number, processId: number[]) => number;
    GetWindowRect: (handle: number, rect: Win32Rect) => number;
    GetWindow: (handle: number, command: number) => number;
    GetWindowLongPtrW: (handle: number, index: number) => number | bigint;
    MonitorFromWindow: (handle: number, flags: number) => number;
    GetMonitorInfoW: (monitor: number, info: Win32MonitorInfoEx) => number;
    SetProcessDpiAwarenessContext: (context: number) => number;
    GetDisplayConfigBufferSizes: (flags: number, pathCount: number[], modeCount: number[]) => number;
    QueryDisplayConfig: (
      flags: number,
      pathCount: number[],
      paths: Buffer,
      modeCount: number[],
      modes: Buffer,
      currentTopologyId: null
    ) => number;
    GetSourceName: (request: Record<string, unknown>) => number;
    GetAdvancedColorInfo: (request: Record<string, unknown>) => number;
    GetAdvancedColorInfo2: (request: Record<string, unknown>) => number;
  };
  dwmapi: {
    DwmGetWindowAttribute: (handle: number, attribute: number, rect: Win32Rect, size: number) => number;
  };
}

let cachedWin32NativeApi: Win32NativeApi | null = null;

const getWin32NativeApi = (): Win32NativeApi => {
  if (cachedWin32NativeApi) return cachedWin32NativeApi;

  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');

  const Rect = koffi.struct('LightMatterNativeRect', {
    Left: 'int32_t',
    Top: 'int32_t',
    Right: 'int32_t',
    Bottom: 'int32_t'
  });
  const MonitorInfoEx = koffi.struct('LightMatterNativeMonitorInfoEx', {
    cbSize: 'uint32_t',
    rcMonitor: Rect,
    rcWork: Rect,
    dwFlags: 'uint32_t',
    szDevice: koffi.array('char16_t', 32, 'String')
  });

  const Luid = koffi.struct('LightMatterDisplayLuid', {
    LowPart: 'uint32_t',
    HighPart: 'int32_t'
  });
  const DisplayHeader = koffi.struct('LightMatterDisplayHeader', {
    type: 'uint32_t',
    size: 'uint32_t',
    adapterId: Luid,
    id: 'uint32_t'
  });
  const DisplayPathSource = koffi.struct('LightMatterDisplayPathSource', {
    adapterId: Luid,
    id: 'uint32_t',
    modeInfoIdx: 'uint32_t',
    statusFlags: 'uint32_t'
  });
  const DisplayPathTarget = koffi.struct('LightMatterDisplayPathTarget', {
    adapterId: Luid,
    id: 'uint32_t',
    modeInfoIdx: 'uint32_t',
    outputTechnology: 'uint32_t',
    rotation: 'uint32_t',
    scaling: 'uint32_t',
    refreshNumerator: 'uint32_t',
    refreshDenominator: 'uint32_t',
    scanLineOrdering: 'uint32_t',
    targetAvailable: 'int32_t',
    statusFlags: 'uint32_t'
  });
  const PathInfo = koffi.struct('LightMatterDisplayPathInfo', {
    sourceInfo: DisplayPathSource,
    targetInfo: DisplayPathTarget,
    flags: 'uint32_t'
  });
  const SourceName = koffi.struct('LightMatterDisplaySourceName', {
    header: DisplayHeader,
    viewGdiDeviceName: koffi.array('char16_t', 32, 'String')
  });
  const AdvancedColorInfo = koffi.struct('LightMatterAdvancedColorInfo', {
    header: DisplayHeader,
    value: 'uint32_t',
    colorEncoding: 'uint32_t',
    bitsPerColorChannel: 'uint32_t'
  });
  const AdvancedColorInfo2 = koffi.struct('LightMatterAdvancedColorInfo2', {
    header: DisplayHeader,
    value: 'uint32_t',
    colorEncoding: 'uint32_t',
    bitsPerColorChannel: 'uint32_t',
    activeColorMode: 'uint32_t'
  });

  const EnumWindowsProc = koffi.proto('int32_t __stdcall LightMatterNativeEnumWindowsProc(uintptr_t hWnd, intptr_t lParam)');
  const api: Win32NativeApi = {
    Rect,
    MonitorInfoEx,
    PathInfo,
    SourceName,
    AdvancedColorInfo,
    AdvancedColorInfo2,
    user32: {
      IsWindow: user32.func('int32_t __stdcall IsWindow(uintptr_t hWnd)'),
      IsWindowVisible: user32.func('int32_t __stdcall IsWindowVisible(uintptr_t hWnd)'),
      IsIconic: user32.func('int32_t __stdcall IsIconic(uintptr_t hWnd)'),
      EnumWindows: user32.func('int32_t __stdcall EnumWindows(LightMatterNativeEnumWindowsProc *callback, intptr_t lParam)'),
      GetWindowTextW: user32.func('int32_t __stdcall GetWindowTextW(uintptr_t hWnd, _Out_ char16_t *text, int32_t maxCount)'),
      GetClassNameW: user32.func('int32_t __stdcall GetClassNameW(uintptr_t hWnd, _Out_ char16_t *className, int32_t maxCount)'),
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32_t *processId)'),
      GetWindowRect: user32.func('int32_t __stdcall GetWindowRect(uintptr_t hWnd, _Out_ LightMatterNativeRect *rect)'),
      GetWindow: user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32_t command)'),
      GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t hWnd, int32_t index)'),
      MonitorFromWindow: user32.func('uintptr_t __stdcall MonitorFromWindow(uintptr_t hWnd, uint32_t flags)'),
      GetMonitorInfoW: user32.func('int32_t __stdcall GetMonitorInfoW(uintptr_t monitor, _Inout_ LightMatterNativeMonitorInfoEx *info)'),
      SetProcessDpiAwarenessContext: user32.func('int32_t __stdcall SetProcessDpiAwarenessContext(intptr_t value)'),
      GetDisplayConfigBufferSizes: user32.func('int32_t __stdcall GetDisplayConfigBufferSizes(uint32_t flags, _Out_ uint32_t *pathCount, _Out_ uint32_t *modeCount)'),
      QueryDisplayConfig: user32.func('int32_t __stdcall QueryDisplayConfig(uint32_t flags, _Inout_ uint32_t *pathCount, _Out_ LightMatterDisplayPathInfo *paths, _Inout_ uint32_t *modeCount, _Out_ void *modes, void *currentTopologyId)'),
      GetSourceName: user32.func('int32_t __stdcall DisplayConfigGetDeviceInfo(_Inout_ LightMatterDisplaySourceName *requestPacket)'),
      GetAdvancedColorInfo: user32.func('int32_t __stdcall DisplayConfigGetDeviceInfo(_Inout_ LightMatterAdvancedColorInfo *requestPacket)'),
      GetAdvancedColorInfo2: user32.func('int32_t __stdcall DisplayConfigGetDeviceInfo(_Inout_ LightMatterAdvancedColorInfo2 *requestPacket)')
    },
    dwmapi: {
      DwmGetWindowAttribute: dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(uintptr_t hWnd, uint32_t attribute, _Out_ LightMatterNativeRect *value, uint32_t size)')
    }
  };

  // Keep the callback type reachable so Koffi retains its native trampoline.
  void EnumWindowsProc;
  cachedWin32NativeApi = api;
  return api;
};

interface CaptureWindowState {
  exists: boolean;
  minimized: boolean;
}

const queryCaptureWindowState = (handle: number): CaptureWindowState => {
  if (!Number.isSafeInteger(handle) || handle <= 0) {
    throw new Error('The selected application window has an invalid handle.');
  }
  const { user32 } = getWin32NativeApi();
  return {
    exists: user32.IsWindow(handle) !== 0,
    minimized: user32.IsIconic(handle) !== 0
  };
};

const captureHdrFrame = async (target: CaptureTarget): Promise<CapturedHdrFrame> => {
  if (process.platform !== 'win32') {
    throw new Error('HDR capture is currently supported on Windows only.');
  }
  if (target?.kind !== 'monitor' && target?.kind !== 'window') {
    throw new Error('Choose a monitor or application window to capture.');
  }
  if (target.kind === 'window') {
    const state = queryCaptureWindowState(target.handle);
    if (!state.exists) {
      throw new Error(
        'The selected application window no longer exists. Refresh the capture sources and select it again.'
      );
    }
    if (state.minimized) {
      throw new Error(
        'The selected application window is minimized. Restore it before capturing.'
      );
    }
  }

  const targetKey = captureTargetKey(target);
  const options = target.kind === 'monitor' ? { monitorIndex: target.index } : { windowHandle: target.handle };
  const captureCapabilities = captureApiSupport();
  const capture = new ScreenCapture({
    ...options,
    colorFormat: 'rgba16F' as unknown as ConstructorParameters<typeof ScreenCapture>[0]['colorFormat'],
    cursorCapture: false,
    // Windows 10 build 19045 does not expose IsBorderRequired. Leave the
    // optional setting untouched there and keep the system-default border.
    ...(captureCapabilities.borderSettings ? { drawBorder: false } : {}),
    minimumUpdateIntervalMs: 0
  });
  if (!captureCapabilities.borderSettings) {
  }
  let phase = 'initialize capture';
  const logPhase = (nextPhase: string): void => {
    phase = nextPhase;
  };
  try {
    logPhase('start native capture session');
    await capture.start();
    logPhase('wait for first FP16 frame');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const frame = await Promise.race([
      capture.nextFrame(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Timed out waiting for the HDR capture frame.')), 10000);
      })
    ]).finally(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    });
    if (!frame) {
      throw new Error('The selected capture source is no longer available.');
    }
    logPhase('validate FP16 frame');
    if (
      frame.colorFormat !== 'rgba16F' || frame.rowPitch !== frame.width * 8
      || frame.buffer.byteLength !== frame.width * frame.height * 8
    ) {
      throw new Error('The capture did not return the expected packed FP16 HDR frame.');
    }
    const captured: CapturedHdrFrame = {
      targetKey,
      width: frame.width,
      height: frame.height,
      buffer: Buffer.from(frame.buffer)
    };
    cachedHdrFrame = captured;

    logPhase(`FP16 HDR frame ready (${frame.width}x${frame.height})`);
    return captured;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[HDR Capture] Failed during "${phase}": ${message}`);
  } finally {
    await capture.stop().catch(() => undefined);
  }
};

const getForegroundWindowHandle = (): { handle: number; processId: number } => {
  const { user32 } = getWin32NativeApi();
  let foreground: { handle: number; processId: number } | null = null;

  const visitWindow = (handle: number): number => {
    if (user32.IsWindowVisible(handle) === 0 || user32.IsIconic(handle) !== 0) return 1;

    const processIdOut = [0];
    user32.GetWindowThreadProcessId(handle, processIdOut);
    const processId = Number(processIdOut[0]) || 0;
    if (processId === 0) return 1;

    // EnumWindows is ordered by Z-order. Ignore owned/tool windows and tiny helper surfaces.
    if (user32.GetWindow(handle, 4) !== 0) return 1; // GW_OWNER
    const extendedStyle = Number(user32.GetWindowLongPtrW(handle, -20)); // GWL_EXSTYLE
    if ((extendedStyle & 0x00000080) !== 0) return 1; // WS_EX_TOOLWINDOW

    const rect: Win32Rect = { Left: 0, Top: 0, Right: 0, Bottom: 0 };
    if (user32.GetWindowRect(handle, rect) === 0
      || rect.Right - rect.Left < 160 || rect.Bottom - rect.Top < 120) return 1;

    const titleBuffer = Buffer.alloc(2048);
    if (user32.GetWindowTextW(handle, titleBuffer, titleBuffer.length / 2) <= 0) return 1;

    const classBuffer = Buffer.alloc(512);
    user32.GetClassNameW(handle, classBuffer, classBuffer.length / 2);
    const className = String(koffi.decode(classBuffer, 'char16_t')).trim();
    if (className === 'Progman' || className === 'WorkerW'
      || className === 'Shell_TrayWnd' || className === 'Shell_SecondaryTrayWnd') return 1;

    foreground = { handle, processId };
    return 0;
  };

  const result = user32.EnumWindows(visitWindow, 0);
  if (result === 0 && foreground === null) {
    throw new Error('Windows stopped enumerating windows before a foreground application window was found.');
  }
  if (!foreground) {
    throw new Error('No visible, non-minimized application window was found.');
  }
  return foreground;
};

const getWindowMonitorGeometry = (handle: number): {
  monitorHandle: number; windowLeft: number; windowTop: number; windowRight: number; windowBottom: number;
  monitorLeft: number; monitorTop: number; monitorRight: number; monitorBottom: number;
} => {
  if (!Number.isSafeInteger(handle) || handle <= 0) {
    throw new Error('The selected application window has an invalid handle.');
  }

  const api = getWin32NativeApi();
  const { user32, dwmapi } = api;
  // Electron normally establishes per-monitor DPI awareness during startup.
  // Ignore ERROR_ACCESS_DENIED if Windows has already fixed the process context.
  user32.SetProcessDpiAwarenessContext(-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2

  const windowRect: Win32Rect = { Left: 0, Top: 0, Right: 0, Bottom: 0 };
  const hasVisibleFrame = dwmapi.DwmGetWindowAttribute(
    handle,
    9, // DWMWA_EXTENDED_FRAME_BOUNDS
    windowRect,
    koffi.sizeof(api.Rect)
  ) === 0;
  if (!hasVisibleFrame && user32.GetWindowRect(handle, windowRect) === 0) {
    throw new Error('Could not read window bounds.');
  }

  const monitorHandle = user32.MonitorFromWindow(handle, 2); // MONITOR_DEFAULTTONEAREST
  if (!monitorHandle) throw new Error('Could not resolve the window monitor.');

  const info: Win32MonitorInfoEx = {
    cbSize: koffi.sizeof(api.MonitorInfoEx),
    rcMonitor: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
    rcWork: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
    dwFlags: 0,
    szDevice: ''
  };
  if (user32.GetMonitorInfoW(monitorHandle, info) === 0) {
    throw new Error('Could not read monitor bounds.');
  }

  const geometry = {
    monitorHandle: Number(monitorHandle),
    windowLeft: windowRect.Left,
    windowTop: windowRect.Top,
    windowRight: windowRect.Right,
    windowBottom: windowRect.Bottom,
    monitorLeft: info.rcMonitor.Left,
    monitorTop: info.rcMonitor.Top,
    monitorRight: info.rcMonitor.Right,
    monitorBottom: info.rcMonitor.Bottom
  };
  if (!Number.isSafeInteger(geometry.monitorHandle)
    || !Object.values(geometry).every(Number.isFinite)
    || geometry.windowRight <= geometry.windowLeft || geometry.windowBottom <= geometry.windowTop
    || geometry.monitorRight <= geometry.monitorLeft || geometry.monitorBottom <= geometry.monitorTop) {
    throw new Error('Windows returned invalid window or monitor geometry.');
  }
  return geometry;
};

const cropWindowFromMonitorFrame = async (handle: number, targetKey: string): Promise<CapturedHdrFrame> => {
  const geometry = getWindowMonitorGeometry(handle);
  const monitors = enumerateMonitors();
  const monitorPosition = monitors.findIndex(item => Number(item.handle) === geometry.monitorHandle);
  if (monitorPosition < 0) throw new Error('The window monitor could not be matched to an HDR capture device.');
  // ScreenCapture.monitorIndex uses the monitor's position in EnumDisplayMonitors order.
  // MonitorInfo.index can instead reflect the Windows DISPLAYn device suffix.
  const source = await captureHdrFrame({ kind:'monitor', index:monitorPosition + 1 });
  const scaleX = source.width / (geometry.monitorRight - geometry.monitorLeft);
  const scaleY = source.height / (geometry.monitorBottom - geometry.monitorTop);
  const left = Math.max(0,Math.round((geometry.windowLeft-geometry.monitorLeft)*scaleX));
  const top = Math.max(0,Math.round((geometry.windowTop-geometry.monitorTop)*scaleY));
  const right = Math.min(source.width,Math.round((geometry.windowRight-geometry.monitorLeft)*scaleX));
  const bottom = Math.min(source.height,Math.round((geometry.windowBottom-geometry.monitorTop)*scaleY));
  const width=right-left, height=bottom-top;
  if(width<8||height<8) throw new Error('The selected window is outside the captured monitor frame.');
  const rowBytes=width*8, buffer=Buffer.allocUnsafe(rowBytes*height);
  for(let row=0;row<height;row++){
    const sourceStart=((top+row)*source.width+left)*8;
    source.buffer.copy(buffer,row*rowBytes,sourceStart,sourceStart+rowBytes);
  }
  const frame:CapturedHdrFrame={targetKey,width,height,buffer};
  cachedHdrFrame=frame;
  return frame;
};

const captureTopWindowFrame = async (includeLightMatterWindows = false, ownerWindow?: Electron.BrowserWindow | null): Promise<CapturedHdrFrame> => {
  if (includeLightMatterWindows) {
    const captureWindow = ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow : App.capturePreviewWindow;
    if (!captureWindow || captureWindow.isDestroyed() || !captureWindow.isVisible() || captureWindow.isMinimized()) {
      throw new Error('The Light Matter Capture window must be visible and restored to capture it as the Top Window.');
    }
    const nativeHandle=captureWindow.getNativeWindowHandle();
    const handle=Number(nativeHandle.readBigUInt64LE(0));
    if(!Number.isSafeInteger(handle)||handle<=0) throw new Error('Could not resolve the Light Matter Capture window handle.');
    const key=captureTargetKey({kind:'top-window',includeLightMatterWindows:true},captureWindow);
    // Use visible monitor pixels for Chromium/Electron windows; native window capture
    // can return only the application icon instead of the rendered window contents.
    return cropWindowFromMonitorFrame(handle,key);
  }

  // Find the topmost visible application window in native Z-order.
  // Light Matter/LumaScope windows are intentionally included.
  const foreground = getForegroundWindowHandle();
  // Electron/Chromium windows may be returned by native window capture as only
  // their application icon. For Light Matter/LumaScope windows, crop the actual
  // visible monitor frame so the rendered application contents are captured.
  if (foreground.processId === process.pid) {
    return cropWindowFromMonitorFrame(foreground.handle, 'top-window');
  }
  const captured = await captureHdrFrame({ kind: 'window', handle: foreground.handle });
  const frame: CapturedHdrFrame = { ...captured, targetKey: 'top-window' };
  cachedHdrFrame = frame;
  return frame;
};

const selectCaptureRectangle = async (): Promise<{
  deviceName: string; monitorHandle: string; screenWidth: number; screenHeight: number; scaleFactor: number;
  x: number; y: number; width: number; height: number;
}> => {
  const displays = screen.getAllDisplays();
  const monitors = enumerateMonitors();
  if (!displays.length || !monitors.length) throw new Error('No displays are available for rectangle capture.');

  const displayMonitors = displays.map((display, position) => {
    const width = Math.round(display.bounds.width * display.scaleFactor);
    const height = Math.round(display.bounds.height * display.scaleFactor);
    const indexed = monitors[position];
    if (indexed && Math.abs(indexed.width - width) <= 2 && Math.abs(indexed.height - height) <= 2) return indexed;
    const matches = monitors.filter(item => Math.abs(item.width - width) <= 2 && Math.abs(item.height - height) <= 2);
    if (matches.length === 1) return matches[0];
    throw new Error('Could not safely map Electron display ' + display.id + ' (' + width + 'x' + height + ') to an HDR capture monitor.');
  });

  const windows: Electron.BrowserWindow[] = [];
  let settled = false;
  return await new Promise<{
    deviceName: string; monitorHandle: string; screenWidth: number; screenHeight: number; scaleFactor: number;
    x: number; y: number; width: number; height: number;
  }>((resolve, reject) => {
    const cleanup = (): void => { for (const window of windows) if (!window.isDestroyed()) window.destroy(); };
    const finish = (value?: {
      deviceName: string; monitorHandle: string; screenWidth: number; screenHeight: number; scaleFactor: number;
      x: number; y: number; width: number; height: number;
    }, error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error('Rectangle selection was cancelled.'));
    };

    for (let position = 0; position < displays.length; position++) {
      const display = displays[position];
      const html = [
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
        '<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;cursor:crosshair;background:transparent;font:600 18px "Segoe UI",sans-serif;color:#fff}',
        '#hint{position:absolute;left:24px;top:20px;padding:10px 14px;background:rgba(0,0,0,.72);border-radius:6px;pointer-events:none}',
        '#shade{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}#selection{position:absolute;border:2px solid #39b9ff;background:transparent;box-shadow:0 0 0 1px rgba(255,255,255,.55);display:none;pointer-events:none}</style></head>',
        '<body><svg id="shade" aria-hidden="true"><path id="shade-path" fill="rgba(0,0,0,.58)" fill-rule="evenodd"/></svg><div id="hint">Drag to select HDR capture area&nbsp;&nbsp;·&nbsp;&nbsp;Esc to cancel</div><div id="selection"></div><script>(()=>{',
        'const box=document.getElementById("selection"),shade=document.getElementById("shade"),shadePath=document.getElementById("shade-path");let start=null;',
        'const point=e=>({x:Math.max(0,Math.min(innerWidth,e.clientX)),y:Math.max(0,Math.min(innerHeight,e.clientY))});const updateShade=(x=0,y=0,w=0,h=0)=>{const W=innerWidth,H=innerHeight;shade.setAttribute("viewBox",`0 0 ${W} ${H}`);shadePath.setAttribute("d",`M0 0H${W}V${H}H0Z ${w>0&&h>0?`M${x} ${y}H${x+w}V${y+h}H${x}Z`:""}`);};updateShade();addEventListener("resize",()=>updateShade());',
        'addEventListener("pointerdown",e=>{if(e.button!==0)return;start=point(e);try{e.target.setPointerCapture(e.pointerId)}catch{}box.style.display="block";box.style.left=start.x+"px";box.style.top=start.y+"px";box.style.width="0";box.style.height="0";updateShade(start.x,start.y,0,0);});',
        'addEventListener("pointermove",e=>{if(!start)return;const p=point(e),x=Math.min(start.x,p.x),y=Math.min(start.y,p.y),w=Math.abs(p.x-start.x),h=Math.abs(p.y-start.y);box.style.left=x+"px";box.style.top=y+"px";box.style.width=w+"px";box.style.height=h+"px";updateShade(x,y,w,h);});',
        'const complete=e=>{if(!start)return;const p=point(e),x=Math.min(start.x,p.x),y=Math.min(start.y,p.y),w=Math.abs(p.x-start.x),h=Math.abs(p.y-start.y);start=null;if(w<8||h<8){box.style.display="none";return;}document.title="LUMASCOPE_RECTANGLE:"+encodeURIComponent(JSON.stringify({x,y,width:w,height:h}));};',
        'addEventListener("pointerup",e=>{if(e.button===0)complete(e)});addEventListener("mouseup",e=>{if(e.button===0)complete(e)});',
        '})();</script></body></html>'
      ].join('');
      const window = new BrowserWindow({
        x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
        frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
        resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
        skipTaskbar: true, alwaysOnTop: true, focusable: true, show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
      });
      windows.push(window);
      window.setAlwaysOnTop(true, 'screen-saver');
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      window.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); finish(); }
      });
      window.webContents.on('page-title-updated', (event, title) => {
        const prefix = 'LUMASCOPE_RECTANGLE:';
        if (!title.startsWith(prefix)) return;
        event.preventDefault();
        try {
          const selected = JSON.parse(decodeURIComponent(title.slice(prefix.length))) as { x: number; y: number; width: number; height: number };
          if (![selected.x, selected.y, selected.width, selected.height].every(Number.isFinite)
            || selected.x < 0 || selected.y < 0 || selected.width < 8 || selected.height < 8) {
            finish(undefined, new Error('The selected rectangle is invalid.'));
            return;
          }
          const scale = display.scaleFactor || 1;
          const monitor = displayMonitors[position];
          finish({
            deviceName: monitor.deviceName || ('Display ' + (position + 1)),
            monitorHandle: String(monitor.handle),
            screenWidth: Math.round(display.bounds.width * scale),
            screenHeight: Math.round(display.bounds.height * scale),
            scaleFactor: scale,
            x: Math.round(selected.x * scale), y: Math.round(selected.y * scale),
            width: Math.round(selected.width * scale), height: Math.round(selected.height * scale)
          });
        } catch (error) {
          finish(undefined, error instanceof Error ? error : new Error(String(error)));
        }
      });
      window.on('closed', () => {
        if (!settled && windows.every(item => item.isDestroyed())) finish();
      });
      void window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
        .then(() => {
          if (settled || window.isDestroyed()) return;
          if (position === 0) { window.show(); window.focus(); }
          else window.showInactive();
        })
        .catch(error => finish(undefined, error instanceof Error ? error : new Error(String(error))));
    }
  });
};

const captureRectangleFrame = async (_ownerWindow?: Electron.BrowserWindow | null): Promise<CapturedHdrFrame> => {
  const selection = await selectCaptureRectangle();
  const monitors = enumerateMonitors();
  const selectedDevice = selection.deviceName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const monitor = monitors.find(item =>
    selectedDevice && (item.deviceName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') === selectedDevice
  ) ?? monitors.find(item => String(item.handle) === selection.monitorHandle);
  if (!monitor) throw new Error('The selected display "' + selection.deviceName + '" could not be matched to an HDR capture monitor.');

  const captureMonitorIndex = monitors.indexOf(monitor) + 1;
  // Resolve the selected display to the matching native HDR capture monitor.
  const source = await captureHdrFrame({ kind: 'monitor', index: captureMonitorIndex });
  const scaleX = source.width / selection.screenWidth;
  const scaleY = source.height / selection.screenHeight;
  // The selection border is 2 CSS pixels wide. Convert that inset with the
  // display's DPI scale factor; source/screen ratios alone lose this offset
  // when both dimensions are already expressed in physical pixels.
  const horizontalInset = Math.max(1, Math.ceil(2 * selection.scaleFactor));
  const bottomInset = Math.max(1, Math.ceil(2 * selection.scaleFactor));
  const left = Math.max(0, Math.round(selection.x * scaleX) + horizontalInset);
  const top = Math.max(0, Math.round(selection.y * scaleY));
  const right = Math.max(0, Math.min(source.width, Math.round((selection.x + selection.width) * scaleX)) - horizontalInset);
  const bottom = Math.max(0, Math.min(source.height, Math.round((selection.y + selection.height) * scaleY)) - bottomInset);
  const width = right - left, height = bottom - top;
  if (width < 8 || height < 8) throw new Error('The selected rectangle is outside the captured display.');
  const rowBytes = width * 8, buffer = Buffer.allocUnsafe(rowBytes * height);
  for (let row = 0; row < height; row++) {
    const sourceStart = ((top + row) * source.width + left) * 8;
    source.buffer.copy(buffer, row * rowBytes, sourceStart, sourceStart + rowBytes);
  }
  const frame: CapturedHdrFrame = { targetKey: 'rectangle', width, height, buffer };
  cachedHdrFrame = frame;
  return frame;
};

const captureTargetFrame = async (target: CaptureTarget, ownerWindow?: Electron.BrowserWindow | null): Promise<CapturedHdrFrame> => {
  if (target.kind === 'monitor') {
    const appWindows=[App.mainWindow,App.capturePreviewWindow,App.mapWindow]
      .filter((window):window is Electron.BrowserWindow=>!!window&&!window.isDestroyed());
    const states=appWindows.map(window=>({window,visible:window.isVisible(),focused:window.isFocused()}));
    const restoreWindow=states.find(item=>item.focused)?.window
      ?? (ownerWindow&&!ownerWindow.isDestroyed()?ownerWindow:states.find(item=>item.visible)?.window);
    try {
      for(const item of states) if(item.visible) item.window.hide();
      await new Promise(resolve=>setTimeout(resolve,180));
      return await captureHdrFrame(target);
    } finally {
      for(const item of states) if(item.visible&&!item.window.isDestroyed()) item.window.showInactive();
      if(restoreWindow&&!restoreWindow.isDestroyed()){
        if(restoreWindow.isMinimized()) restoreWindow.restore();
        restoreWindow.show();
        restoreWindow.focus();
      }
    }
  }
  if (target.kind === 'top-window') return captureTopWindowFrame(target.includeLightMatterWindows === true, ownerWindow);
  if (target.kind === 'rectangle') return captureRectangleFrame(ownerWindow);
  return captureHdrFrame(target);
};

const summarizeVipsImageSamples = (image: Vips.Image) => {
  const pixels = image.writeToMemory();
  const channelCount = image.bands;
  const channels = Array.from({ length: channelCount }, (_, channel) => ({
    channel: [ 'R', 'G', 'B', 'A' ][channel] ?? String(channel),
    min: Infinity,
    max: -Infinity,
    sum: 0,
    samples: 0,
    nonFinite: 0,
    histogram16: new Array<number>(16).fill(0)
  }));

  for (let offset = 0; offset + channelCount <= pixels.length; offset += channelCount) {
    for (let channel = 0; channel < channelCount; channel++) {
      const value = Number(pixels[offset + channel]);
      const stats = channels[channel];
      if (!Number.isFinite(value)) {
        stats.nonFinite++;
        continue;
      }
      stats.min = Math.min(stats.min, value);
      stats.max = Math.max(stats.max, value);
      stats.sum += value;
      stats.samples++;
    }
  }

  for (let offset = 0; offset + channelCount <= pixels.length; offset += channelCount) {
    for (let channel = 0; channel < channelCount; channel++) {
      const value = Number(pixels[offset + channel]);
      const stats = channels[channel];
      if (!Number.isFinite(value) || stats.samples === 0) continue;
      const range = stats.max - stats.min;
      const bin = range === 0 ? 0 : Math.min(15, Math.max(0, Math.floor((value - stats.min) / range * 16)));
      stats.histogram16[bin]++;
    }
  }

  return {
    width: image.width,
    height: image.height,
    bands: image.bands,
    format: image.format,
    interpretation: image.interpretation,
    channels: channels.map(({ sum, ...stats }) => ({
      ...stats,
      min: Number.isFinite(stats.min) ? stats.min : null,
      max: Number.isFinite(stats.max) ? stats.max : null,
      mean: stats.samples > 0 ? sum / stats.samples : null
    }))
  };
};

const readUhdrGainmapMetadata = (image: Vips.Image) => {
  const fields = image.getFields();
  const available = new Set<string>();
  for (let index = 0; index < fields.size(); index++) {
    available.add(fields.get(index));
  }

  const metadata: Record<string, unknown> = {};
  const arrayFields = [
    'gainmap-max-content-boost',
    'gainmap-min-content-boost',
    'gainmap-gamma',
    'gainmap-offset-sdr',
    'gainmap-offset-hdr'
  ];
  const doubleFields = [
    'gainmap-hdr-capacity-min',
    'gainmap-hdr-capacity-max'
  ];
  const intFields = [ 'gainmap-use-base-cg', 'gainmap-scale-factor' ];

  const read = (field: string, method: string) => {
    if (!available.has(field)) {
      metadata[field] = { present: false };
      return;
    }
    try {
      const getter = (image as unknown as Record<string, unknown>)[method];
      if (typeof getter !== 'function') {
        metadata[field] = { present: true, readError: method + ' is not exposed by wasm-vips' };
        return;
      }
      const value = (getter as (name: string) => unknown).call(image, field);
      metadata[field] = {
        present: true,
        value: value && typeof value === 'object'
          && typeof (value as { size?: unknown }).size === 'function'
          && typeof (value as { get?: unknown }).get === 'function'
          ? Array.from(
            { length: (value as { size(): number }).size() },
            (_, index) => (value as { get(index: number): unknown }).get(index)
          )
          : value
      };
    } catch (error) {
      metadata[field] = {
        present: true,
        readError: error instanceof Error ? error.message : String(error)
      };
    }
  };

  for (const field of arrayFields) read(field, 'getArrayDouble');
  for (const field of doubleFields) read(field, 'getDouble');
  for (const field of intFields) read(field, 'getInt');

  return {
    availableGainmapFields: Array.from(available).filter(field => field.startsWith('gainmap-') || field === 'gainmap-data'),
    values: metadata
  };
};

const logUhdrFileDiagnostics = (vips: typeof Vips, outputPath: string): void => {
  try {
    using encoded = vips.Image.newFromFile(outputPath, { access: 'random' });
    using gainmap = encoded.gainmap;

    console.info('[UHDR SDR Base]', summarizeVipsImageSamples(encoded));
    console.info('[UHDR Gainmap Metadata]', readUhdrGainmapMetadata(encoded));

    if (gainmap) {
      console.info('[UHDR Gainmap]', summarizeVipsImageSamples(gainmap));
    } else {
      console.warn('[UHDR Gainmap] libvips did not expose a decoded gainmap image.');
    }
  } catch (error) {
    console.error('[UHDR Diagnostic] Could not inspect the encoded Ultra HDR JPEG:', {
      outputPath,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

const getHdrFrame = async (target: CaptureTarget, ownerWindow?: Electron.BrowserWindow | null): Promise<CapturedHdrFrame> => {
  const key = captureTargetKey(target, ownerWindow);
  if (cachedHdrFrame?.targetKey === key) {
    // console.info('[HDR Capture] reuse cached FP16 HDR frame');
    return cachedHdrFrame;
  }
  return captureTargetFrame(target, ownerWindow);
};
const halfConversionBuffer = new ArrayBuffer(4);
const halfConversionFloat = new Float32Array(halfConversionBuffer);
const halfConversionBits = new Uint32Array(halfConversionBuffer);

const applyGammaCorrection = (value: number, gamma: number): number =>
  value < 0 ? -Math.pow(-value, gamma) : Math.pow(value, gamma);

const floatToHalf = (value: number): number => {
  halfConversionFloat[0] = value;
  const bits = halfConversionBits[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  let mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) {
      return sign;
    }
    mantissa = (mantissa | 0x800000) >> (1 - exponent);
    return sign | ((mantissa + 0x1000) >> 13);
  }
  if (exponent >= 31) {
    return sign | 0x7c00 | (mantissa ? 0x0200 : 0);
  }
  return sign | (exponent << 10) | ((mantissa + 0x1000) >> 13);
};

export default class ElectronEvents {
  static bootstrapElectronEvents(): Electron.IpcMain {
    const injector = Injector.getInstance();

    IpcRegistry
      .getInstance()
      .registerIpcHandlers(
        ipcMain,
        [
          injector.inject('Dialogs'),
          injector.inject('Exif'),
          injector.inject('FileSystem'),
          injector.inject('ProcessManager'),
          injector.inject('CacheManager'),
          injector.inject('Histogram')
        ]
      );

    return ipcMain;
  }
}

ipcMain.handle('openFolder', async (): Promise<FileListing> => {
  const result = await dialog.showOpenDialog({ properties: [ 'openDirectory' ] });

  if (!result.canceled && result.filePaths.length > 0) {
    const folder = result.filePaths[0];

    return {
      success: true,
      data: {
        folder,
        files: await readFolder(folder)
      }
    };
  }

  return { success: false, errorMessage: '' };
});

ipcMain.handle('openFile', async (): Promise<FileListing> => {
  const result = await dialog.showOpenDialog({
    properties: [ 'openFile' ],
    filters: [ { name: 'Images', extensions: supportedFileExtensions } ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const fileName = result.filePaths[0];
    const folder = path.dirname(fileName);

    return {
      success: true,
      data: {
        folder,
        files: await readFolder(folder),
        selected: fileName
      }
    };
  }

  return { success: false, errorMessage: '' };
});

ipcMain.handle('openFileFromArgs', async (_: IpcMainInvokeEvent, fileName: string): Promise<FileListing> => {
  const folder = path.dirname(fileName);

  return {
    success: true,
    data: {
      folder,
      files: await readFolder(folder),
      selected: fileName
    }
  };
});

ipcMain.handle('Loupe.capture', async () => {
  let phase = 'prepare display capture';
  try {
    if (process.platform !== 'win32' || !App.mainWindow || App.mainWindow.isDestroyed()) {
      throw new Error('HDR loupe capture is unavailable: a live Windows application window is required.');
    }

    // Capture the whole monitor containing the application, not the application
    // window. This avoids window-frame/Chromium-area rounding differences.
    const windowBounds = App.mainWindow.getBounds();
    const contentBounds = App.mainWindow.getContentBounds();
    const display = screen.getDisplayMatching(windowBounds);
    const displays = screen.getAllDisplays();
    const displayPosition = displays.findIndex(candidate => candidate.id === display.id);
    const monitors = enumerateMonitors();
    const expectedWidth = Math.round(display.bounds.width * display.scaleFactor);
    const expectedHeight = Math.round(display.bounds.height * display.scaleFactor);

    // Electron and WGC normally enumerate displays in the same order. If the
    // dimensions show they do not, use the closest physical-size match instead.
    let monitorIndex = displayPosition >= 0 ? displayPosition + 1 : 1;
    const indexedMonitor = monitors[monitorIndex - 1];
    if (
      !indexedMonitor
      || Math.abs(indexedMonitor.width - expectedWidth) > 2
      || Math.abs(indexedMonitor.height - expectedHeight) > 2
    ) {
      const closest = monitors
        .map(monitor => ({
          index: monitor.index,
          score: Math.abs(monitor.width - expectedWidth) + Math.abs(monitor.height - expectedHeight)
        }))
        .sort((a, b) => a.score - b.score)[0];
      if (closest) {
        monitorIndex = closest.index;
      }
    }

    phase = 'capture FP16 monitor frame';
    const frame = await captureLoupeFrame(monitorIndex);
    return {
      width: frame.width,
      height: frame.height,
      x: display.bounds.x,
      y: display.bounds.y,
      contentX: contentBounds.x,
      contentY: contentBounds.y,
      windowWidth: display.bounds.width,
      windowHeight: display.bounds.height,
      scaleFactor: display.scaleFactor
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const gpuInfo = await app.getGPUInfo('complete').catch(() => null);
    const devices = (gpuInfo as {
      gpuDevice?: Array<
        { description?: string; driverVersion?: string; driverDate?: string; vendorId?: number; deviceId?: number; }
      >;
    } | null)?.gpuDevice ?? [];
    const gpu = devices.length
      ? devices.map(device =>
        `${device.description ?? 'Unknown GPU'} (vendor ${device.vendorId ?? '?'}, device ${
          device.deviceId ?? '?'
        }, driver ${device.driverVersion ?? 'unknown'}${device.driverDate ? `, ${device.driverDate}` : ''})`
      ).join(' | ')
      : 'GPU/driver information unavailable from Electron';
    throw new Error(
      `${message}\nDiagnostics: phase=${phase}; OS=${os.version()} [${os.release()}]; Electron=${process.versions.electron}; API=@screen-capture/node; requested format=rgba16F (FP16 / R16G16B16A16_FLOAT); GPU=${gpu}`
    );
  }
});

ipcMain.handle('Loupe.sample', (_event, x: number, y: number, radius?: number) => sampleLoupeRegion(x, y, radius));
ipcMain.handle(
  'Loupe.region',
  (_event, x: number, y: number, width: number, height: number) => sampleLoupeRectangle(x, y, width, height)
);
ipcMain.handle('Loupe.release', () => releaseLoupeFrame());

const queryWindowsMonitorHdrModes = (): Record<string, boolean | null> => {
  if (process.platform !== 'win32') return {};

  try {
    const api = getWin32NativeApi();
    const { user32 } = api;
    const modes: Record<string, boolean | null> = {};
    const activePathsOnly = 2; // QDC_ONLY_ACTIVE_PATHS
    let paths: Array<Record<string, unknown>> = [];
    let querySucceeded = false;

    // The display topology can change between sizing and querying. Retry ERROR_INSUFFICIENT_BUFFER.
    for (let attempt = 0; attempt < 3; attempt++) {
      const pathCountOut = [0];
      const modeCountOut = [0];
      const sizeResult = user32.GetDisplayConfigBufferSizes(activePathsOnly, pathCountOut, modeCountOut);
      if (sizeResult !== 0) {
        throw new Error('GetDisplayConfigBufferSizes failed with Win32 error ' + sizeResult + '.');
      }

      const pathCapacity = Number(pathCountOut[0]);
      const modeCapacity = Number(modeCountOut[0]);
      const pathBuffer = Buffer.alloc(Math.max(1, pathCapacity) * koffi.sizeof(api.PathInfo));
      // DISPLAYCONFIG_MODE_INFO is 64 bytes on supported Windows x64 systems.
      const modeBuffer = Buffer.alloc(Math.max(1, modeCapacity) * 64);
      const returnedPathCount = [pathCapacity];
      const returnedModeCount = [modeCapacity];
      const result = user32.QueryDisplayConfig(
        activePathsOnly,
        returnedPathCount,
        pathBuffer,
        returnedModeCount,
        modeBuffer,
        null
      );

      if (result === 122) continue; // ERROR_INSUFFICIENT_BUFFER
      if (result !== 0) throw new Error('QueryDisplayConfig failed with Win32 error ' + result + '.');

      paths = koffi.decode(pathBuffer, api.PathInfo, Number(returnedPathCount[0])) as Array<Record<string, unknown>>;
      querySucceeded = true;
      break;
    }

    if (!querySucceeded) {
      throw new Error('QueryDisplayConfig could not obtain a stable active display topology after three attempts.');
    }

    for (const pathInfo of paths) {
      const sourceInfo = pathInfo.sourceInfo as Record<string, unknown>;
      const targetInfo = pathInfo.targetInfo as Record<string, unknown>;
      const sourceAdapter = sourceInfo.adapterId as Record<string, number>;
      const targetAdapter = targetInfo.adapterId as Record<string, number>;

      const sourceName: Record<string, unknown> = {
        header: {
          type: 1, // DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME
          size: koffi.sizeof(api.SourceName),
          adapterId: sourceAdapter,
          id: Number(sourceInfo.id)
        },
        viewGdiDeviceName: ''
      };
      const sourceResult = user32.GetSourceName(sourceName);
      const deviceName = String(sourceName.viewGdiDeviceName ?? '').trim();
      if (sourceResult !== 0 || !deviceName) {
        console.warn('[Capture HDR modes] DisplayConfigGetDeviceInfo(source) failed:', sourceResult);
        continue;
      }

      const color2: Record<string, unknown> = {
        header: {
          type: 15, // DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO_2 (Windows 11 24H2+)
          size: koffi.sizeof(api.AdvancedColorInfo2),
          adapterId: targetAdapter,
          id: Number(targetInfo.id)
        },
        value: 0,
        colorEncoding: 0,
        bitsPerColorChannel: 0,
        activeColorMode: 0
      };
      const color2Result = user32.GetAdvancedColorInfo2(color2);
      let isHdr: boolean | null = null;
      if (color2Result === 0) {
        isHdr = Number(color2.activeColorMode) === 2; // HDR; SDR=0, WCG=1
      } else {
        // Legacy API does not distinguish HDR from WCG on older Windows versions.
        const color: Record<string, unknown> = {
          header: {
            type: 9, // DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO
            size: koffi.sizeof(api.AdvancedColorInfo),
            adapterId: targetAdapter,
            id: Number(targetInfo.id)
          },
          value: 0,
          colorEncoding: 0,
          bitsPerColorChannel: 0
        };
        const legacyResult = user32.GetAdvancedColorInfo(color);
        if (legacyResult === 0) {
          isHdr = (Number(color.value) & 2) !== 0;
        } else {
          console.warn(
            '[Capture HDR modes] ' + deviceName + ': API v2 failed=' + color2Result + '; legacy failed=' + legacyResult
          );
        }
      }

      modes[deviceName.toLowerCase().replace(/[^a-z0-9]/g, '')] = isHdr;
    }

    return modes;
  } catch (error) {
    console.warn('[Capture] Failed to query Windows HDR monitor modes through Koffi:', error);
    return {};
  }
};

let cachedTopLevelWindowEnumerator: (() => CaptureSources['windows']) | null = null;

const enumerateTopLevelWindows = (): CaptureSources['windows'] => {
  if (cachedTopLevelWindowEnumerator) return cachedTopLevelWindowEnumerator();

  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  const Rect = koffi.struct('LightMatterWindowRect', {
    Left: 'int32_t',
    Top: 'int32_t',
    Right: 'int32_t',
    Bottom: 'int32_t'
  });
  const MonitorInfoEx = koffi.struct('LightMatterMonitorInfoEx', {
    cbSize: 'uint32_t',
    rcMonitor: Rect,
    rcWork: Rect,
    dwFlags: 'uint32_t',
    szDevice: koffi.array('char16_t', 32, 'String')
  });

  const EnumWindowsProc = koffi.proto('int32_t __stdcall LightMatterEnumWindowsProc(uintptr_t hWnd, intptr_t lParam)');
  const EnumWindows = user32.func('int32_t __stdcall EnumWindows(LightMatterEnumWindowsProc *callback, intptr_t lParam)');
  const IsWindowVisible = user32.func('int32_t __stdcall IsWindowVisible(uintptr_t hWnd)');
  const IsIconic = user32.func('int32_t __stdcall IsIconic(uintptr_t hWnd)');
  const GetWindowTextW = user32.func('int32_t __stdcall GetWindowTextW(uintptr_t hWnd, _Out_ char16_t *text, int32_t maxCount)');
  const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32_t *processId)');
  const GetWindowRect = user32.func('int32_t __stdcall GetWindowRect(uintptr_t hWnd, _Out_ LightMatterWindowRect *rect)');
  const MonitorFromRect = user32.func('uintptr_t __stdcall MonitorFromRect(const LightMatterWindowRect *rect, uint32_t flags)');
  const GetMonitorInfoW = user32.func('int32_t __stdcall GetMonitorInfoW(uintptr_t monitor, _Inout_ LightMatterMonitorInfoEx *info)');

  const OpenProcess = kernel32.func('uintptr_t __stdcall OpenProcess(uint32_t access, int32_t inheritHandle, uint32_t processId)');
  const QueryFullProcessImageNameW = kernel32.func('int32_t __stdcall QueryFullProcessImageNameW(uintptr_t process, uint32_t flags, _Out_ char16_t *path, _Inout_ uint32_t *size)');
  const CloseHandle = kernel32.func('int32_t __stdcall CloseHandle(uintptr_t handle)');

  const runEnumeration = (): CaptureSources['windows'] => {
    const rows: CaptureSources['windows'] = [];
    let callbackError: Error | null = null;

    const enumerate = (handle: number, _lParam: number): number => {
      try {
        if (IsWindowVisible(handle) === 0) return 1;

        const titleBuffer = Buffer.alloc(2048);
        const titleLength = GetWindowTextW(handle, titleBuffer, titleBuffer.length / 2);
        const title = titleLength > 0
          ? String(koffi.decode(titleBuffer, 'char16_t', titleLength)).trim()
          : '';
        if (!title) return 1;

        const processIdOut = [0];
        GetWindowThreadProcessId(handle, processIdOut);
        const processId = Number(processIdOut[0]) || 0;

        const rect = { Left: 0, Top: 0, Right: 0, Bottom: 0 };
        const hasRect = GetWindowRect(handle, rect) !== 0;
        const width = hasRect ? Math.max(0, rect.Right - rect.Left) : 0;
        const height = hasRect ? Math.max(0, rect.Bottom - rect.Top) : 0;
        const isMinimized = IsIconic(handle) !== 0;

        let executablePath: string | undefined;
        // Only inspect a process when its window is large enough to be a useful capture source.
        if (processId !== 0 && width > 100 && height > 100) {
          const process = OpenProcess(0x1000, 0, processId);
          if (process !== 0) {
            try {
              const pathBuffer = Buffer.alloc(32768 * 2);
              const pathSize = [32768];
              if (QueryFullProcessImageNameW(process, 0, pathBuffer, pathSize) !== 0 && pathSize[0] > 0) {
                executablePath = String(koffi.decode(pathBuffer, 'char16_t', Number(pathSize[0])));
              }
            } finally {
              CloseHandle(process);
            }
          }
        }

        let monitorDeviceName: string | undefined;
        if (hasRect && width > 100 && height > 100 && !isMinimized) {
          const monitor = MonitorFromRect(rect, 2); // MONITOR_DEFAULTTONEAREST
          if (monitor !== 0) {
            const info = {
              cbSize: koffi.sizeof(MonitorInfoEx),
              rcMonitor: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
              rcWork: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
              dwFlags: 0,
              szDevice: ''
            };
            if (GetMonitorInfoW(monitor, info) !== 0) {
              const device = String(info.szDevice ?? '').trim();
              if (device) monitorDeviceName = device;
            }
          }
        }

        rows.push({
          title,
          processName: executablePath ? path.basename(executablePath) : 'Unknown executable',
          executablePath,
          processId,
          handle,
          width,
          height,
          monitorIndex: -1,
          monitorDeviceName,
          isMinimized
        });
        return 1;
      } catch (error) {
        callbackError = error instanceof Error ? error : new Error(String(error));
        return 0;
      }
    };

    const completed = EnumWindows(enumerate, 0);
    if (callbackError) throw callbackError;
    if (completed === 0) throw new Error('Windows EnumWindows failed while enumerating top-level windows.');

    return rows.sort((a, b) =>
      a.processName.localeCompare(b.processName, undefined, { sensitivity: 'base' })
      || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    );
  };

  cachedTopLevelWindowEnumerator = runEnumeration;
  return runEnumeration();
};

ipcMain.handle('Capture.listSources', async (): Promise<CaptureSources> => {
  if (process.platform !== 'win32') {
    throw new Error('HDR capture of individual windows and monitors is currently supported on Windows only.');
  }

  const hdrModes = queryWindowsMonitorHdrModes();

  /*
  const enumeratedMonitors = enumerateMonitors();
  console.info('[Capture HDR modes] Raw Windows mapping:', JSON.stringify({
    hdrModes,
    monitors: enumeratedMonitors.map(m => ({
      index: m.index,
      name: m.name,
      deviceName: m.deviceName,
      normalizedDeviceName: (m.deviceName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
    }))
  }, null, 2));
  */

  const monitors = enumerateMonitors().map((monitor, position) => {
    const deviceKey = (monitor.deviceName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return {
      // This is the one-based EnumDisplayMonitors position expected by ScreenCapture.
      // Do not use MonitorInfo.index here: it may be the Windows DISPLAYn suffix.
      index: position + 1,
      name: monitor.name || monitor.deviceName || `Monitor ${position + 1}`,
      deviceName: monitor.deviceName,
      width: monitor.width,
      height: monitor.height,
      refreshRate: monitor.refreshRate,
      isHdr: deviceKey in hdrModes ? hdrModes[deviceKey] ?? undefined : undefined
    };
  });

  const sourceErrors: string[] = [];
  let windows: CaptureSources['windows'] = [];

  // Enumerate top-level windows directly through Win32 using Koffi.
  // OpenProcess and QueryFullProcessImageNameW are only called for windows
  // whose width AND height are both greater than 100 physical pixels.
  try {
    windows = enumerateTopLevelWindows();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sourceErrors.push(`Koffi Win32 window enumeration failed: ${message}`);
  }

  return { monitors, windows, sourceErrors };
});

ipcMain.handle('Capture.chooseFolder', async (event, initialPath?: string): Promise<string | null> => {
  const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? App.mainWindow;
  const result = await dialog.showOpenDialog(parentWindow, {
    title: 'Choose HDR capture folder',
    defaultPath: initialPath || undefined,
    properties: [ 'openDirectory', 'createDirectory' ]
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle(
  'Capture.copyPreviewToClipboard',
  async (_event, pngData: Uint8Array, playFeedback = false): Promise<CaptureResult> => {
    if (process.platform !== 'win32') {
      throw new Error('Capture preview clipboard export is currently supported on Windows only.');
    }
    if (!(pngData instanceof Uint8Array) || pngData.byteLength < 8
      || pngData[0] !== 0x89 || pngData[1] !== 0x50 || pngData[2] !== 0x4e || pngData[3] !== 0x47) {
      throw new Error('The WebGPU preview did not provide valid PNG image data.');
    }

    const imageBlob = new Blob([new Uint8Array(pngData)], { type: 'image/png' });
    await clipboard.write([new ClipboardItem({ 'image/png': imageBlob })]);
    const image = nativeImage.createFromBuffer(Buffer.from(pngData));
    if (image.isEmpty()) {
      throw new Error('Electron could not decode the rendered WebGPU preview PNG.');
    }
    const size = image.getSize();
    if (playFeedback) shell.beep();
    return { path: 'Windows Clipboard', width: size.width, height: size.height };
  }
);

ipcMain.handle('CapturePreviewWindow.open', async (): Promise<boolean> => App.openCapturePreviewWindow());
ipcMain.handle('CapturePreviewWindow.close', async (): Promise<void> => App.closeCapturePreviewWindow());
ipcMain.handle('CapturePreviewWindow.isOpen', async (): Promise<boolean> => App.isCapturePreviewWindowOpen());
ipcMain.handle('CapturePreviewWindow.getFrame', async (): Promise<{ width: number; height: number; pixels: Uint16Array } | null> => {
  if (!cachedHdrFrame) return null;
  const pixels = new Uint16Array(cachedHdrFrame.buffer.buffer.slice(cachedHdrFrame.buffer.byteOffset, cachedHdrFrame.buffer.byteOffset + cachedHdrFrame.buffer.byteLength));
  return { width: cachedHdrFrame.width, height: cachedHdrFrame.height, pixels };
});

ipcMain.handle(
  'Capture.preview',
  async (event, target: CaptureTarget): Promise<{ width: number; height: number; pixels: Uint16Array; sdrImage: Uint8Array; }> => {
    // console.info('[HDR Capture] preview requested');
    // Always capture a fresh frame for Preview. The resulting frame remains cached
    // so Save can reuse exactly the image the user just inspected.
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const frame = await captureTargetFrame(target, ownerWindow);
    const pixels = new Uint16Array(
      frame.buffer.buffer.slice(frame.buffer.byteOffset, frame.buffer.byteOffset + frame.buffer.byteLength)
    );
    // SDR preview and clipboard output are tone-mapped directly from this FP16 frame in the renderer.
    // Keep the empty field for compatibility with the existing CapturePreview IPC contract.
    return { width: frame.width, height: frame.height, pixels, sdrImage: new Uint8Array() };
  }
);

ipcMain.handle(
  'Capture.capture',
  async (event, target: CaptureTarget, folder: string, format: CaptureFormat = 'exr', gammaCorrection = 1, encoderQuality = 90, previewFrame?: CapturePreview): Promise<CaptureResult> => {
    if (format !== 'exr' && format !== 'jxr' && format !== 'uhdr') {
      throw new Error('Choose OpenEXR, JPEG XR, or Ultra HDR JPEG as the file capture format.');
    }
    if (!Number.isFinite(gammaCorrection) || gammaCorrection < 0.1 || gammaCorrection > 2.2) {
      throw new Error('Gamma correction must be between 0.1 and 2.2.');
    }
    if (!Number.isInteger(encoderQuality) || encoderQuality < 0 || encoderQuality > 100) {
      throw new Error('Encoder quality must be an integer between 0 and 100.');
    }
    if (process.platform !== 'win32') {
      throw new Error('HDR capture is currently supported on Windows only.');
    }
    if (!folder || !path.isAbsolute(folder)) {
      throw new Error('Choose a valid destination folder before capturing.');
    }
    if (target?.kind !== 'monitor' && target?.kind !== 'window' && target?.kind !== 'top-window' && target?.kind !== 'rectangle') {
      throw new Error('Choose a rectangle, monitor, top window, or application window to capture.');
    }

    let phase = 'get FP16 HDR frame';
    const logPhase = (nextPhase: string): void => {
      phase = nextPhase;
      };
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const frame: CapturedHdrFrame = previewFrame
        ? (() => {
          if (!Number.isSafeInteger(previewFrame.width) || !Number.isSafeInteger(previewFrame.height)
            || previewFrame.width < 1 || previewFrame.height < 1
            || !(previewFrame.pixels instanceof Uint16Array)
            || previewFrame.pixels.length !== previewFrame.width * previewFrame.height * 4) {
            throw new Error('The supplied preview frame is invalid or incomplete. Generate a new preview and try again.');
          }
          const expectedBytes = previewFrame.width * previewFrame.height * 8;
          if (previewFrame.pixels.byteLength !== expectedBytes) {
            throw new Error('The supplied preview frame has an unexpected FP16 buffer size.');
          }
          return {
            targetKey: captureTargetKey(target, ownerWindow),
            width: previewFrame.width,
            height: previewFrame.height,
            buffer: Buffer.from(new Uint8Array(previewFrame.pixels.buffer, previewFrame.pixels.byteOffset, previewFrame.pixels.byteLength))
          };
        })()
        : await getHdrFrame(target, ownerWindow);
      const sourceChannels = new Uint16Array(frame.buffer.buffer, frame.buffer.byteOffset, frame.buffer.byteLength / 2);

      const extension = format === 'uhdr' ? 'jpg' : format;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const baseName = `LightMatter_Capture_${stamp}`;
      let outputPath = path.join(folder, `${baseName}.${extension}`);
      let suffix = 1;
      while (fsSync.existsSync(outputPath)) {
        outputPath = path.join(folder, `${baseName}_${suffix++}.${extension}`);
      }
      if (format === 'uhdr') {
        logPhase('convert FP16 scRGB frame to Float32 RGB without brightness correction');

        const rgb = new Float32Array(frame.width * frame.height * 3);

        for (let pixel = 0; pixel < frame.width * frame.height; pixel++) {
          const source = pixel * 4;
          const destination = pixel * 3;

          for (let channel = 0; channel < 3; channel++) {
            const value = halfToFloat(sourceChannels[source + channel]);
            if (!Number.isFinite(value)) {
              rgb[destination + channel] = 0;
              continue;
            }

            const corrected = gammaCorrection !== 1 ? applyGammaCorrection(value, gammaCorrection) : value;
            rgb[destination + channel] = corrected;
          }
        }


        vipsInitPromise ??= Vips();
        const vips = await vipsInitPromise;
        vips.Cache.max(0);
        vips.Cache.maxMem(0);
        using image = vips.Image.newFromMemory(rgb, frame.width, frame.height, 3, vips.BandFormat.float);
        using scrgb = image.copy({ interpretation: vips.Interpretation.scrgb });
        logPhase('encode Ultra HDR JPEG with embedded gain map');
        scrgb.uhdrsave(outputPath, { Q: encoderQuality });
        logPhase('Ultra HDR JPEG written');
        logPhase('read Ultra HDR SDR base, gainmap and metadata');
        logUhdrFileDiagnostics(vips, outputPath);

      } else {
        let encoded: Buffer | Uint8Array;
        if (format === 'jxr') {
          logPhase('prepare packed RGBA16F input for the WIC JPEG XR encoder');
          const rgba = Buffer.allocUnsafe(frame.width * frame.height * 4 * 2);
          for (let pixel = 0; pixel < frame.width * frame.height; pixel++) {
            const source = pixel * 4;
            const destination = pixel * 8;
            for (let channel = 0; channel < 3; channel++) {
              // Preserve the original FP16 scRGB peak brightness for JPEG XR.
              const sourceValue = halfToFloat(sourceChannels[source + channel]);
              const value = gammaCorrection !== 1 ? applyGammaCorrection(sourceValue, gammaCorrection) : sourceValue;
              rgba.writeUInt16LE(floatToHalf(value), destination + channel * 2);
            }
            // This is an opaque desktop capture. Force alpha to 1.0 so the WIC
            // encoder receives a valid opaque RGBA16F sample without changing RGB.
            rgba.writeUInt16LE(0x3c00, destination + 6);
          }
          const expectedByteLength = frame.width * frame.height * 8;
          if (rgba.byteLength !== expectedByteLength) {
            throw new Error('Packed RGBA16F buffer has an unexpected byte length.');
          }

          const encoderPath = app.isPackaged
            ? path.join(process.resourcesPath, 'jxr-wic-encoder.exe')
            : path.join(process.cwd(), 'tools', 'jxr-wic-prototype', 'build', 'Release', 'jxr-wic-encoder.exe');
          await fs.access(encoderPath).catch(() => {
            throw new Error(
              `The native WIC JPEG XR encoder was not found at "${encoderPath}". Build it with "npm run build:jxr-wic-encoder" and retry.`
            );
          });

          const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'light-matter-jxr-'));
          const inputPath = path.join(temporaryDirectory, 'capture.rgba16f');
          const encodedPath = path.join(temporaryDirectory, 'capture.jxr');
          let retainTemporaryFiles = false;
          try {
            await fs.writeFile(inputPath, rgba);
            logPhase(`encode FP16 JPEG XR with WIC (quality ${encoderQuality}%)`);
            try {
              runExternalProcessSync(
                encoderPath,
                [inputPath, encodedPath, String(frame.width), String(frame.height), String(encoderQuality)],
                { windowsHide: true, timeout: 120000, stdio: 'pipe' }
              );
            } catch (error) {
              retainTemporaryFiles = true;
              const processError = error as NodeJS.ErrnoException & {
                stderr?: Buffer | string;
                stdout?: Buffer | string;
                status?: number | null;
                signal?: string | null;
                code?: number | string;
              };
              const stderr = processError.stderr?.toString().trim() ?? '';
              const stdout = processError.stdout?.toString().trim() ?? '';
              throw new Error([
                'The WIC JPEG XR encoder failed.',
                `Executable: ${encoderPath}`,
                `Exit code: ${processError.status ?? 'unknown'}`,
                `Signal: ${processError.signal ?? 'none'}`,
                `Error code: ${processError.code ?? 'none'}`,
                stderr && `STDERR: ${stderr}`,
                stdout && `STDOUT: ${stdout}`,
                `Temporary files retained at: ${temporaryDirectory}`
              ].filter(Boolean).join('\n'));
            }
            encoded = await fs.readFile(encodedPath);
          } finally {
            if (!retainTemporaryFiles) {
              await fs.rm(temporaryDirectory, { recursive: true, force: true });
            }
          }
        } else {
          logPhase(
            `convert native RGBA16F to Float32 RGBA (${frame.width}x${frame.height}) without brightness correction`
          );
          const rgba = new Float32Array(frame.width * frame.height * 4);
          for (let pixel = 0; pixel < frame.width * frame.height; pixel++) {
            const source = pixel * 4;
            for (let channel = 0; channel < 3; channel++) {
              const value = halfToFloat(sourceChannels[source + channel]);
              rgba[source + channel] = gammaCorrection !== 1 ? applyGammaCorrection(value, gammaCorrection) : value;
            }
            rgba[source + 3] = halfToFloat(sourceChannels[source + 3]);
          }
          logPhase('initialize OpenEXR encoder');
          exrInitPromise ??= initExr();
          await exrInitPromise;
          logPhase('encode OpenEXR');
          encoded = encodeExr({
            width: frame.width,
            height: frame.height,
            layers: [ {
              name: 'rgba',
              channelNames: [ 'R', 'G', 'B', 'A' ],
              interleavedPixels: rgba,
              precision: 'f32',
              compression: 'zip'
            } ]
          });
        }
        logPhase(`write ${format.toUpperCase()} file`);
        await fs.writeFile(outputPath, encoded, { flag: 'wx' });
      }
      if (cachedHdrFrame === frame) {
        cachedHdrFrame = null;
      }
      return { path: outputPath, width: frame.width, height: frame.height };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[HDR Capture] Failed during "${phase}": ${message}`);
    }
  }
);

ipcMain.handle('Profiling.getExternalProcessCalls', (): ExternalProcessCall[] => [...externalProcessCalls]);
ipcMain.on('quit', (_, code) => app.exit(code));

const readFolder = async (folder: string): Promise<string[]> =>
  (await fs.readdir(folder))
    .map(f => path.join(folder, f))
    .filter(f => fsSync.lstatSync(f).isFile())
    .filter(f => supportedFileExtensions.includes(path.extname(f).toLowerCase().replace('.', '')));


ipcMain.handle('MapWindow.open', (_event, latitude: number | null, longitude: number | null, bearing?: number, imagePath?: string | null): boolean =>
  App.openMapWindow(latitude, longitude, bearing, imagePath)
);
ipcMain.handle('MapWindow.getLocation', () => App.mapWindowLocation);
ipcMain.handle('MapWindow.selectImage', (_event, imagePath: string): boolean => {
  if (!imagePath || !App.mainWindow || App.mainWindow.isDestroyed()) return false;
  App.mainWindow.webContents.send('MapWindow.imageSelected', imagePath);
  return true;
});
ipcMain.handle('MapWindow.close', (): void => App.closeMapWindow());
ipcMain.handle('MapWindow.isOpen', (): boolean => App.isMapWindowOpen());
ipcMain.handle('MapWindow.focus', (): boolean => App.focusMapWindow());
ipcMain.handle('MapWindow.setAlwaysOnTop', (_event, enabled: boolean): boolean =>
  App.setMapWindowAlwaysOnTop(enabled)
);
