import {
  captureApiSupport,
  enumerateMonitors,
  ScreenCapture
} from '@screen-capture/node';
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, IpcMainInvokeEvent, nativeImage, screen } from 'electron';
import { encodeExr, init as initExr } from 'exrs';
import { CaptureFormat, CaptureResult, CaptureSources, CaptureTarget, FileListing, supportedFileExtensions } from 'internal-api';
import Vips from 'wasm-vips';
import { execFileSync } from 'node:child_process';
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

interface CaptureWindowState {
  exists: boolean;
  minimized: boolean;
}

const queryCaptureWindowState = (handle: number): CaptureWindowState => {
  if (!Number.isSafeInteger(handle) || handle <= 0) {
    throw new Error('The selected application window has an invalid handle.');
  }

  const script = String.raw`
    $ErrorActionPreference = 'Stop'

    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class LightMatterCaptureWindowState {
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
}
'@

    $handle = [long]::Parse(
      $env:LIGHT_MATTER_CAPTURE_HWND,
      [System.Globalization.CultureInfo]::InvariantCulture
    )
    $hwnd = [IntPtr]::new($handle)

    [PSCustomObject]@{
      exists = [LightMatterCaptureWindowState]::IsWindow($hwnd)
      minimized = [LightMatterCaptureWindowState]::IsIconic($hwnd)
    } | ConvertTo-Json -Compress
  `;

  const output = execFileSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      env: {
        ...process.env,
        LIGHT_MATTER_CAPTURE_HWND: String(handle)
      }
    }
  ).trim();

  const state = JSON.parse(output) as CaptureWindowState;

  if (
    typeof state.exists !== 'boolean'
    || typeof state.minimized !== 'boolean'
  ) {
    throw new Error('Windows returned an invalid window-state response.');
  }

  return state;
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
    console.info('[HDR Capture] Border control is unavailable; using the Windows default capture border.');
  }
  let phase = 'initialize capture';
  const logPhase = (nextPhase: string): void => {
    phase = nextPhase;
    console.info(`[HDR Capture] ${phase}`);
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

const getForegroundWindowHandle = (): number => {
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class LightMatterExternalWindow {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  private static IntPtr result;
  private static uint excludedProcessId;

  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint command);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll", SetLastError=true)] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }

  private static bool VisitWindow(IntPtr hWnd, IntPtr lParam) {
    if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;

    uint processId;
    GetWindowThreadProcessId(hWnd, out processId);
    if (processId == 0 || processId == excludedProcessId) return true;

    // Ignore owned/tool windows and tiny helper surfaces. EnumWindows is already
    // in Z-order, so the first remaining entry is the topmost real application window.
    if (GetWindow(hWnd, 4) != IntPtr.Zero) return true; // GW_OWNER
    long extendedStyle = GetWindowLongPtr(hWnd, -20).ToInt64(); // GWL_EXSTYLE
    if ((extendedStyle & 0x00000080L) != 0) return true; // WS_EX_TOOLWINDOW
    RECT rect;
    if (!GetWindowRect(hWnd, out rect) || rect.Right - rect.Left < 160 || rect.Bottom - rect.Top < 120) return true;

    StringBuilder title = new StringBuilder(1024);
    if (GetWindowText(hWnd, title, title.Capacity) <= 0) return true;

    StringBuilder className = new StringBuilder(256);
    GetClassName(hWnd, className, className.Capacity);
    string name = className.ToString();
    if (name == "Progman" || name == "WorkerW" || name == "Shell_TrayWnd" || name == "Shell_SecondaryTrayWnd") return true;

    result = hWnd;
    return false;
  }

  public static IntPtr Find(uint ownProcessId) {
    result = IntPtr.Zero;
    excludedProcessId = ownProcessId;
    EnumWindows(new EnumWindowsProc(VisitWindow), IntPtr.Zero);
    return result;
  }

  public static uint GetProcessId(IntPtr hWnd) {
    uint processId;
    GetWindowThreadProcessId(hWnd, out processId);
    return processId;
  }

  public static string GetTitle(IntPtr hWnd) {
    StringBuilder title = new StringBuilder(1024);
    GetWindowText(hWnd, title, title.Capacity);
    return title.ToString();
  }
}
'@
    $handle = [LightMatterExternalWindow]::Find([uint32]$env:LIGHT_MATTER_PROCESS_ID)
    if ($handle -eq [IntPtr]::Zero) {
      throw 'No visible, non-minimized external application window was found.'
    }
    [PSCustomObject]@{
      handle = $handle.ToInt64()
      processId = [LightMatterExternalWindow]::GetProcessId($handle)
      title = [LightMatterExternalWindow]::GetTitle($handle)
    } | ConvertTo-Json -Compress
  `;
  const output = execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    env: { ...process.env, LIGHT_MATTER_PROCESS_ID: String(process.pid) }
  }).trim();
  const foreground = JSON.parse(output) as { handle: number; processId: number; title: string };
  if (!Number.isSafeInteger(foreground.handle) || foreground.handle <= 0
    || !Number.isSafeInteger(foreground.processId) || foreground.processId <= 0
    || foreground.processId === process.pid) {
    throw new Error('No visible, non-minimized external application window was found.');
  }
  return foreground.handle;
};

const getWindowMonitorGeometry = (handle: number): {
  monitorHandle: number; windowLeft: number; windowTop: number; windowRight: number; windowBottom: number;
  monitorLeft: number; monitorTop: number; monitorRight: number; monitorBottom: number;
} => {
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LightMatterWindowGeometry {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct MONITORINFOEX {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szDevice;
  }
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFOEX info);
}
'@
    $hwnd = [IntPtr]::new([long]::Parse($env:LIGHT_MATTER_WINDOW_HANDLE, [Globalization.CultureInfo]::InvariantCulture))
    $windowRect = [LightMatterWindowGeometry+RECT]::new()
    if (-not [LightMatterWindowGeometry]::GetWindowRect($hwnd, [ref]$windowRect)) { throw 'Could not read window bounds.' }
    $monitor = [LightMatterWindowGeometry]::MonitorFromWindow($hwnd, 2)
    if ($monitor -eq [IntPtr]::Zero) { throw 'Could not resolve the window monitor.' }
    $info = [LightMatterWindowGeometry+MONITORINFOEX]::new()
    $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
    if (-not [LightMatterWindowGeometry]::GetMonitorInfoW($monitor, [ref]$info)) { throw 'Could not read monitor bounds.' }
    [PSCustomObject]@{
      monitorHandle = $monitor.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture)
      windowLeft = $windowRect.Left; windowTop = $windowRect.Top; windowRight = $windowRect.Right; windowBottom = $windowRect.Bottom
      monitorLeft = $info.rcMonitor.Left; monitorTop = $info.rcMonitor.Top; monitorRight = $info.rcMonitor.Right; monitorBottom = $info.rcMonitor.Bottom
    } | ConvertTo-Json -Compress
  `;
  const output = execFileSync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script], {
    encoding:'utf8', windowsHide:true, timeout:5000,
    env:{ ...process.env, LIGHT_MATTER_WINDOW_HANDLE:String(handle) }
  }).trim();
  const value = JSON.parse(output) as Record<string, number | string>;
  const geometry = {
    monitorHandle:Number(value.monitorHandle),
    windowLeft:Number(value.windowLeft), windowTop:Number(value.windowTop), windowRight:Number(value.windowRight), windowBottom:Number(value.windowBottom),
    monitorLeft:Number(value.monitorLeft), monitorTop:Number(value.monitorTop), monitorRight:Number(value.monitorRight), monitorBottom:Number(value.monitorBottom)
  };
  if (!Number.isSafeInteger(geometry.monitorHandle) || geometry.monitorHandle<=0
    || !Object.values(geometry).every(Number.isFinite)
    || geometry.windowRight<=geometry.windowLeft || geometry.windowBottom<=geometry.windowTop
    || geometry.monitorRight<=geometry.monitorLeft || geometry.monitorBottom<=geometry.monitorTop) {
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

  // Find the topmost external application window without hiding Light Matter.
  // The window enumeration explicitly excludes this process, so the capture UI
  // can remain visible while the selected external window is cropped.
  const handle=getForegroundWindowHandle();
  // Use the same native HWND capture path as an explicitly selected application
  // window. Cropping a monitor capture can accidentally retain the full desktop
  // when window and monitor coordinates differ (for example with mixed DPI).
  const captured=await captureHdrFrame({kind:'window',handle});
  const frame:CapturedHdrFrame={...captured,targetKey:'top-window'};
  cachedHdrFrame=frame;
  return frame;
};

const selectCaptureRectangle = (): { deviceName: string; monitorHandle: string; screenWidth: number; screenHeight: number; x: number; y: number; width: number; height: number } => {
  const csharp = [
    "using System;", "using System.Collections.Generic;", "using System.Drawing;", "using System.Windows.Forms;",
    "public static class LightMatterRectangleSelection {",
    " public static string DeviceName = null; public static long MonitorHandle; public static int ScreenWidth, ScreenHeight, X, Y, Width, Height; public static bool Cancelled = false;",
    " public static readonly List<RectangleSelectionForm> Forms = new List<RectangleSelectionForm>();",
    " public static void Finish(bool cancel) { if (cancel) Cancelled = true; foreach (var form in Forms.ToArray()) if (!form.IsDisposed) form.Close(); }",
    " public static void SetResult(string device, long monitor, int screenWidth, int screenHeight, int x, int y, int width, int height) { DeviceName=device; MonitorHandle=monitor; ScreenWidth=screenWidth; ScreenHeight=screenHeight; X=x; Y=y; Width=width; Height=height; Finish(false); }",
    "}",
    "public sealed class RectangleSelectionForm : Form {",
    " private readonly Screen targetScreen; private Point start, current; private bool dragging;",
    " [System.Runtime.InteropServices.DllImport(\"user32.dll\")] private static extern IntPtr MonitorFromPoint(Point point, uint flags);",
    " public RectangleSelectionForm(Screen screen) { targetScreen=screen; FormBorderStyle=FormBorderStyle.None; StartPosition=FormStartPosition.Manual; Bounds=screen.Bounds; ShowInTaskbar=false; TopMost=true; BackColor=Color.Black; Opacity=0.32; Cursor=Cursors.Cross; KeyPreview=true; DoubleBuffered=true; MouseDown+=OnMouseDown; MouseMove+=OnMouseMove; MouseUp+=OnMouseUp; KeyDown+=OnKeyDown; Paint+=OnPaintOverlay; FormClosed+=(_,__)=>{ if(LightMatterRectangleSelection.Forms.TrueForAll(f=>f.IsDisposed || f==this)) Application.ExitThread(); }; }",
    " private void OnMouseDown(object s, MouseEventArgs e) { if(e.Button!=MouseButtons.Left)return; start=e.Location; current=e.Location; dragging=true; Invalidate(); }",
    " private void OnMouseMove(object s, MouseEventArgs e) { if(!dragging)return; current=new Point(Math.Max(0,Math.Min(ClientSize.Width-1,e.X)),Math.Max(0,Math.Min(ClientSize.Height-1,e.Y))); Invalidate(); }",
    " private void OnMouseUp(object s, MouseEventArgs e) { if(!dragging || e.Button!=MouseButtons.Left)return; dragging=false; current=new Point(Math.Max(0,Math.Min(ClientSize.Width-1,e.X)),Math.Max(0,Math.Min(ClientSize.Height-1,e.Y))); int l=Math.Min(start.X,current.X), t=Math.Min(start.Y,current.Y), w=Math.Abs(current.X-start.X), h=Math.Abs(current.Y-start.Y); if(w<8 || h<8){Invalidate();return;} var selectionCenter=new Point(targetScreen.Bounds.Left+l+w/2,targetScreen.Bounds.Top+t+h/2); var monitor=MonitorFromPoint(selectionCenter,2); LightMatterRectangleSelection.SetResult(targetScreen.DeviceName,monitor.ToInt64(),targetScreen.Bounds.Width,targetScreen.Bounds.Height,l,t,w,h); }",
    " private void OnKeyDown(object s, KeyEventArgs e) { if(e.KeyCode==Keys.Escape){LightMatterRectangleSelection.Finish(true);e.Handled=true;} }",
    " private void OnPaintOverlay(object s, PaintEventArgs e) { using(var b=new SolidBrush(Color.White)) using(var f=new Font(\"Segoe UI\",16,FontStyle.Bold)) e.Graphics.DrawString(\"Drag to select HDR capture area  ·  Esc to cancel\",f,b,24,24); if(dragging){var r=new Rectangle(Math.Min(start.X,current.X),Math.Min(start.Y,current.Y),Math.Abs(current.X-start.X),Math.Abs(current.Y-start.Y)); using(var p=new Pen(Color.DeepSkyBlue,3))e.Graphics.DrawRectangle(p,r); using(var b=new SolidBrush(Color.FromArgb(45,Color.DeepSkyBlue)))e.Graphics.FillRectangle(b,r);} }",
    "}"
  ].join("\n");
  const dpi = "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DpiAwareness { [DllImport(\"user32.dll\")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); }'; [void][DpiAwareness]::SetProcessDpiAwarenessContext([IntPtr](-4));";
  const script = "$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.Windows.Forms\nAdd-Type -AssemblyName System.Drawing\nAdd-Type -ReferencedAssemblies @('System.Windows.Forms','System.Drawing') -TypeDefinition @'\n" + csharp + "\n'@\n" +
    "$screens=[System.Windows.Forms.Screen]::AllScreens\nforeach($display in $screens){$form=[RectangleSelectionForm]::new($display);[LightMatterRectangleSelection]::Forms.Add($form);$form.Show()}\n" +
    "[System.Windows.Forms.Application]::Run()\n" +
    "if([LightMatterRectangleSelection]::Cancelled -or -not [LightMatterRectangleSelection]::DeviceName){throw 'Rectangle selection was cancelled.'}\n" +
    "[PSCustomObject]@{deviceName=[LightMatterRectangleSelection]::DeviceName;monitorHandle=[LightMatterRectangleSelection]::MonitorHandle.ToString();screenWidth=[LightMatterRectangleSelection]::ScreenWidth;screenHeight=[LightMatterRectangleSelection]::ScreenHeight;x=[LightMatterRectangleSelection]::X;y=[LightMatterRectangleSelection]::Y;width=[LightMatterRectangleSelection]::Width;height=[LightMatterRectangleSelection]::Height}|ConvertTo-Json -Compress";
  const output = execFileSync('powershell.exe', ['-STA','-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',dpi + '\n' + script],
    { encoding:'utf8', windowsHide:true, timeout:120000 }).trim();
  const selection = JSON.parse(output) as { deviceName:string; monitorHandle:string; screenWidth:number; screenHeight:number; x:number; y:number; width:number; height:number };
  if (!selection.deviceName || ![selection.x,selection.y,selection.width,selection.height].every(Number.isFinite)
    || selection.x<0 || selection.y<0 || selection.width<8 || selection.height<8) throw new Error('Windows returned an invalid rectangle selection.');
  return selection;
};

const captureRectangleFrame = async (_ownerWindow?: Electron.BrowserWindow | null): Promise<CapturedHdrFrame> => {
    const selection=selectCaptureRectangle();
    const enumeratedMonitors=enumerateMonitors();
    const normalizeDeviceName=(value:string|undefined):string=>(value??'').toLowerCase().replace(/[^a-z0-9]/g,'');
    const selectedDevice=normalizeDeviceName(selection.deviceName);
    // Match the selected Windows display by its stable device name first. HMONITOR
    // values can be represented differently by the PowerShell and Node processes.
    const monitor=enumeratedMonitors.find(item=>
      selectedDevice && normalizeDeviceName(item.deviceName)===selectedDevice
    ) ?? enumeratedMonitors.find(item=>String(item.handle)===String(selection.monitorHandle));
    if(!monitor) {
      throw new Error(`The selected display "${selection.deviceName}" (HMONITOR ${selection.monitorHandle}) could not be matched to an HDR capture monitor. Available: ${enumeratedMonitors.map(item=>`${item.deviceName} [${item.handle}]`).join(', ')}`);
    }
    // Use the capture backend's enumeration position, not MonitorInfo.index (DISPLAYn).
    const captureMonitorIndex=enumeratedMonitors.indexOf(monitor)+1;
    console.info('[HDR Capture] Rectangle source mapping', {
      selectedDeviceName:selection.deviceName,
      selectedMonitorHandle:selection.monitorHandle,
      captureMonitorDeviceName:monitor.deviceName,
      captureMonitorHandle:String(monitor.handle),
      captureMonitorIndex
    });
    const source=await captureHdrFrame({kind:'monitor',index:captureMonitorIndex});
    const scaleX=source.width/selection.screenWidth, scaleY=source.height/selection.screenHeight;
    const left=Math.max(0,Math.round(selection.x*scaleX)), top=Math.max(0,Math.round(selection.y*scaleY));
    const right=Math.min(source.width,Math.round((selection.x+selection.width)*scaleX));
    const bottom=Math.min(source.height,Math.round((selection.y+selection.height)*scaleY));
    const width=right-left,height=bottom-top;
    if(width<8||height<8) throw new Error('The selected rectangle is outside the captured display.');
    const rowBytes=width*8,buffer=Buffer.allocUnsafe(rowBytes*height);
    for(let row=0;row<height;row++){
      const sourceStart=((top+row)*source.width+left)*8;
      source.buffer.copy(buffer,row*rowBytes,sourceStart,sourceStart+rowBytes);
    }
    const frame:CapturedHdrFrame={targetKey:'rectangle',width,height,buffer};
    cachedHdrFrame=frame;
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

const summarizeFp16Frame = (frame: CapturedHdrFrame) => {
  const channels = [ 'R', 'G', 'B' ].map(name => ({
    name,
    min: Infinity,
    max: -Infinity,
    minPositive: Infinity,
    negativeSamples: 0,
    zeroSamples: 0,
    aboveReferenceWhiteSamples: 0,
    nonFiniteSamples: 0
  }));
  const values = new Uint16Array(
    frame.buffer.buffer,
    frame.buffer.byteOffset,
    frame.buffer.byteLength / 2
  );

  for (let pixel = 0; pixel < frame.width * frame.height; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const value = halfToFloat(values[pixel * 4 + channel]);
      const stats = channels[channel];
      if (!Number.isFinite(value)) {
        stats.nonFiniteSamples++;
        continue;
      }
      stats.min = Math.min(stats.min, value);
      stats.max = Math.max(stats.max, value);
      if (value < 0) stats.negativeSamples++;
      else if (value === 0) stats.zeroSamples++;
      else stats.minPositive = Math.min(stats.minPositive, value);
      if (value > 1) stats.aboveReferenceWhiteSamples++;
    }
  }

  return {
    width: frame.width,
    height: frame.height,
    pixelFormat: 'RGBA16F linear scRGB',
    referenceWhiteNits: 80,
    channels: channels.map(({ min, max, minPositive, ...stats }) => ({
      ...stats,
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
      minPositive: Number.isFinite(minPositive) ? minPositive : null
    }))
  };
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
  if (process.platform !== 'win32') {
    return {};
  }
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public sealed class LightMatterDisplayMode {
  public string deviceName { get; set; }
  public bool? isHdr { get; set; }
}
public static class LightMatterDisplayConfig {
  [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)] public struct HEADER { public int type; public uint size; public LUID adapterId; public uint id; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH_SOURCE { public uint adapterIdLow; public int adapterIdHigh; public uint id; public uint modeInfoIdx; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH_TARGET { public uint adapterIdLow; public int adapterIdHigh; public uint id; public uint modeInfoIdx; public uint outputTechnology; public uint rotation; public uint scaling; public uint refreshNumerator; public uint refreshDenominator; public uint scanLineOrdering; public int targetAvailable; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH_INFO { public PATH_SOURCE sourceInfo; public PATH_TARGET targetInfo; public uint flags; }

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct SOURCE_NAME {
    public HEADER header;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)]
    public string viewGdiDeviceName;
  }

  [StructLayout(LayoutKind.Sequential)] public struct ADVANCED_COLOR_INFO { public HEADER header; public uint value; public uint colorEncoding; public uint bitsPerColorChannel; }
  [StructLayout(LayoutKind.Sequential)] public struct ADVANCED_COLOR_INFO_2 { public HEADER header; public uint value; public uint colorEncoding; public uint bitsPerColorChannel; public uint activeColorMode; }
  [DllImport("user32.dll")] public static extern int GetDisplayConfigBufferSizes(uint flags, out uint pathCount, out uint modeCount);

  [DllImport("user32.dll")]
  public static extern int QueryDisplayConfig(
    uint flags,
    ref uint pathCount,
    [Out] PATH_INFO[] paths,
    ref uint modeCount,
    IntPtr modes,
    IntPtr currentTopologyId);

  [DllImport("user32.dll")] public static extern int DisplayConfigGetDeviceInfo(ref SOURCE_NAME requestPacket);
  [DllImport("user32.dll")] public static extern int DisplayConfigGetDeviceInfo(ref ADVANCED_COLOR_INFO requestPacket);
  [DllImport("user32.dll")] public static extern int DisplayConfigGetDeviceInfo(ref ADVANCED_COLOR_INFO_2 requestPacket);
  public static LightMatterDisplayMode[] GetModes() {
    uint pathCount, modeCount;
    int sizeResult = GetDisplayConfigBufferSizes(2, out pathCount, out modeCount);
    if (sizeResult != 0) {
      Console.Error.WriteLine("[Capture HDR modes] GetDisplayConfigBufferSizes failed: " + sizeResult);
      return new LightMatterDisplayMode[0];
    }
    var paths = new PATH_INFO[pathCount];
    uint pc = pathCount, mc = modeCount;
    // QueryDisplayConfig requires storage for the returned DISPLAYCONFIG_MODE_INFO entries.
    // The native structure is 64 bytes on supported Windows x64 systems; we only inspect paths.
    IntPtr modeBuffer = Marshal.AllocHGlobal(checked((int)Math.Max(1u, modeCount) * 64));
    int result;
    try { result = QueryDisplayConfig(2, ref pc, paths, ref mc, modeBuffer, IntPtr.Zero); }
    finally { Marshal.FreeHGlobal(modeBuffer); }
    if (result != 0) {
      Console.Error.WriteLine("[Capture HDR modes] QueryDisplayConfig failed: " + result + "; paths=" + pc + "; modes=" + mc);
      return new LightMatterDisplayMode[0];
    }
    var rows = new List<LightMatterDisplayMode>();

/*
    Console.Error.WriteLine(
      "[Capture HDR modes] HEADER size=" + Marshal.SizeOf(typeof(HEADER)) +
      "; SOURCE_NAME size=" + Marshal.SizeOf(typeof(SOURCE_NAME)) +
      "; paths=" + pc);
*/

    for (int i = 0; i < pc; i++) {
      var source = new SOURCE_NAME();
      source.header.type = 1;
      source.header.size = (uint)Marshal.SizeOf(typeof(SOURCE_NAME));
      source.header.adapterId = new LUID { LowPart = paths[i].sourceInfo.adapterIdLow, HighPart = paths[i].sourceInfo.adapterIdHigh };
      source.header.id = paths[i].sourceInfo.id;
      int sourceResult = DisplayConfigGetDeviceInfo(ref source);
      if (sourceResult != 0 || String.IsNullOrEmpty(source.viewGdiDeviceName)) {
        Console.Error.WriteLine("[Capture HDR modes] DisplayConfigGetDeviceInfo(source) failed: " + sourceResult);
        continue;
      }
      var targetAdapter = new LUID { LowPart = paths[i].targetInfo.adapterIdLow, HighPart = paths[i].targetInfo.adapterIdHigh };
      bool? hdr = null;
      // Windows 11 24H2+ distinguishes HDR from wide-color-gamut (WCG).
      // DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO_2 = 15 (Windows 11 24H2+).
      var color2 = new ADVANCED_COLOR_INFO_2();
      color2.header.type = 15;
      color2.header.size = (uint)Marshal.SizeOf(typeof(ADVANCED_COLOR_INFO_2));
      color2.header.adapterId = targetAdapter;
      color2.header.id = paths[i].targetInfo.id;
      int color2Result = DisplayConfigGetDeviceInfo(ref color2);
      if (color2Result == 0) {
        hdr = color2.activeColorMode == 2u; // DISPLAYCONFIG_ADVANCED_COLOR_MODE_HDR; SDR=0, WCG=1
        // Console.Error.WriteLine("[Capture HDR modes] " + source.viewGdiDeviceName + ": API v2 activeColorMode=" + color2.activeColorMode);
      } else {
        // Legacy API for earlier Windows versions: bit 1 is advancedColorEnabled.
        // On those versions Windows does not expose a distinct HDR/WCG active mode.
        var color = new ADVANCED_COLOR_INFO();
        color.header.type = 9;
        color.header.size = (uint)Marshal.SizeOf(typeof(ADVANCED_COLOR_INFO));
        color.header.adapterId = targetAdapter;
        color.header.id = paths[i].targetInfo.id;
        int legacyResult = DisplayConfigGetDeviceInfo(ref color);
        if (legacyResult == 0) {
          hdr = (color.value & 2u) != 0;
          // Console.Error.WriteLine("[Capture HDR modes] " + source.viewGdiDeviceName + ": legacy advancedColorEnabled=" + ((color.value & 2u) != 0));
        } else {
          Console.Error.WriteLine("[Capture HDR modes] " + source.viewGdiDeviceName + ": API v2 failed=" + color2Result + "; legacy failed=" + legacyResult);
        }
      }
      rows.Add(new LightMatterDisplayMode { deviceName = source.viewGdiDeviceName, isHdr = hdr });
    }
    return rows.ToArray();
  }
}
'@
    [LightMatterDisplayConfig]::GetModes() | ConvertTo-Json -Compress -Depth 4
  `;
  try {
    const raw = execFileSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
    const parsed = JSON.parse(raw || '[]') as
      | { deviceName: string; isHdr: boolean | null; }
      | Array<{ deviceName: string; isHdr: boolean | null; }>;
    const rows = Array.isArray(parsed) ? parsed : [ parsed ];
    const modes: Record<string, boolean | null> = {};
    for (const row of rows) {
      modes[row.deviceName.toLowerCase().replace(/[^a-z0-9]/g, '')] = row.isHdr;
    }
    // console.info('[Capture HDR modes] Windows API rows:', rows, 'normalized keys:', Object.keys(modes));
    return modes;
  } catch (error) {
    const e = error as NodeJS.ErrnoException & {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };

    console.warn('[Capture] Failed to query Windows HDR monitor modes:', {
      message: e.message,
      status: e.status,
      stdout: e.stdout?.toString(),
      stderr: e.stderr?.toString()
    });

    return {};
  }
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

  // @screen-capture/node's enumerateWindows() throws ACCESS_DENIED on some
  // systems. Enumerate top-level windows through Win32 instead, and tolerate
  // protected processes for which Windows will not provide an executable path.
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    # Windows PowerShell 5.1 otherwise may emit redirected native output using the active OEM code page.
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

public sealed class LightMatterWindowRow {
  public string handle { get; set; }
  public string title { get; set; }
  public uint processId { get; set; }
  public string executablePath { get; set; }
  public int width { get; set; }
  public int height { get; set; }
  public int monitorIndex { get; set; }
  public string monitorDeviceName { get; set; }
  public bool isMinimized { get; set; }
}

public static class LightMatterWindowEnumerator {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)]
  private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct MONITORINFOEX {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szDevice;
  }
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", SetLastError=true)] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] private static extern IntPtr MonitorFromRect(ref RECT rect, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFOEX info);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);

  public static LightMatterWindowRow[] GetWindows() {
    var rows = new List<LightMatterWindowRow>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      var titleBuffer = new StringBuilder(1024);
      GetWindowText(hWnd, titleBuffer, titleBuffer.Capacity);
      var title = titleBuffer.ToString().Trim();
      if (title.Length == 0) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      string exePath = null;
      if (pid != 0) {
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process != IntPtr.Zero) {
          try {
            var pathBuffer = new StringBuilder(32768);
            uint size = (uint)pathBuffer.Capacity;
            if (QueryFullProcessImageNameW(process, 0, pathBuffer, ref size)) exePath = pathBuffer.ToString();
          } finally { CloseHandle(process); }
        }
      }
      RECT rect;
      int width = 0, height = 0;
      string monitorDeviceName = null;
      if (GetWindowRect(hWnd, out rect)) {
        width = Math.Max(0, rect.Right - rect.Left);
        height = Math.Max(0, rect.Bottom - rect.Top);
        if (width >= 100 && height >= 100 && !IsIconic(hWnd)) {
          IntPtr monitor = MonitorFromRect(ref rect, 2); // MONITOR_DEFAULTTONEAREST
          if (monitor != IntPtr.Zero) {
            var monitorInfo = new MONITORINFOEX();
            monitorInfo.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (GetMonitorInfoW(monitor, ref monitorInfo)) monitorDeviceName = monitorInfo.szDevice;
          }
        }
      }
      rows.Add(new LightMatterWindowRow { handle = hWnd.ToInt64().ToString(), title = title, processId = pid, executablePath = exePath, width = width, height = height, monitorIndex = -1, monitorDeviceName = monitorDeviceName, isMinimized = IsIconic(hWnd) });
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }
}
'@
    [LightMatterWindowEnumerator]::GetWindows() | ConvertTo-Json -Compress -Depth 4
  `;

  try {
    const nativeJson = execFileSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
    const nativeRows = JSON.parse(nativeJson || '[]') as Array<{
      handle: string;
      title: string;
      processId: number;
      executablePath?: string | null;
      width: number;
      height: number;
      monitorIndex: number;
      monitorDeviceName?: string | null;
      isMinimized: boolean;
    }>;
    windows = nativeRows
      .map(window => {
        const executablePath = window.executablePath || undefined;
        return {
          title: window.title.trim(),
          processName: executablePath ? path.basename(executablePath) : 'Unknown executable',
          executablePath,
          processId: Number(window.processId) || 0,
          handle: Number(window.handle),
          width: Number(window.width) || 0,
          height: Number(window.height) || 0,
          monitorIndex: Number(window.monitorIndex) || -1,
          monitorDeviceName: window.monitorDeviceName || undefined,
          isMinimized: Boolean(window.isMinimized)
        };
      })
      .sort((a, b) =>
        a.processName.localeCompare(b.processName, undefined, { sensitivity: 'base' })
        || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sourceErrors.push(`PowerShell Win32 window enumeration failed: ${message}`);
  }

  return { monitors, windows, sourceErrors };
});

ipcMain.handle('Capture.chooseFolder', async (_event, initialPath?: string): Promise<string | null> => {
  const result = await dialog.showOpenDialog(App.mainWindow, {
    title: 'Choose HDR capture folder',
    defaultPath: initialPath || undefined,
    properties: [ 'openDirectory', 'createDirectory' ]
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle(
  'Capture.copyPreviewToClipboard',
  async (_event, pngData: Uint8Array): Promise<CaptureResult> => {
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
    console.info('[HDR Capture] Copied native-resolution WebGPU preview to Windows Clipboard', size);
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
  async (event, target: CaptureTarget): Promise<{ width: number; height: number; pixels: Uint16Array; }> => {
    // console.info('[HDR Capture] preview requested');
    // Always capture a fresh frame for Preview. The resulting frame remains cached
    // so Save can reuse exactly the image the user just inspected.
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const frame = await captureTargetFrame(target, ownerWindow);
    console.info('[HDR Capture] preview source FP16/scRGB statistics', summarizeFp16Frame(frame));
    const pixels = new Uint16Array(
      frame.buffer.buffer.slice(frame.buffer.byteOffset, frame.buffer.byteOffset + frame.buffer.byteLength)
    );
    console.info(`[HDR Capture] send FP16 frame to WebGPU preview (${frame.width}x${frame.height})`);
    return { width: frame.width, height: frame.height, pixels };
  }
);

ipcMain.handle(
  'Capture.capture',
  async (event, target: CaptureTarget, folder: string, format: CaptureFormat = 'exr', gammaCorrection = 1, encoderQuality = 90): Promise<CaptureResult> => {
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
      console.info(`[HDR Capture] ${phase}`);
    };
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const reusedPreviewFrame = cachedHdrFrame?.targetKey === captureTargetKey(target, ownerWindow);
      const frame = await getHdrFrame(target, ownerWindow);
      console.info('[HDR Capture] save source FP16/scRGB statistics', {
        reusedPreviewFrame,
        gammaCorrection,
        ...summarizeFp16Frame(frame)
      });
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
        let sourcePeakScRgb = 0;
        let outputMin = Infinity;
        let outputMax = -Infinity;
        let negativeChannelSamples = 0;
        let nonFiniteChannelSamples = 0;

        for (let pixel = 0; pixel < frame.width * frame.height; pixel++) {
          const source = pixel * 4;
          const destination = pixel * 3;

          for (let channel = 0; channel < 3; channel++) {
            const value = halfToFloat(sourceChannels[source + channel]);
            if (!Number.isFinite(value)) {
              rgb[destination + channel] = 0;
              nonFiniteChannelSamples++;
              continue;
            }

            if (value < 0) negativeChannelSamples++;
            sourcePeakScRgb = Math.max(sourcePeakScRgb, value);
            const corrected = gammaCorrection !== 1 ? applyGammaCorrection(value, gammaCorrection) : value;
            rgb[destination + channel] = corrected;
            outputMin = Math.min(outputMin, corrected);
            outputMax = Math.max(outputMax, corrected);
          }
        }

        console.info('[HDR Capture] scRGB input summary', {
          width: frame.width,
          height: frame.height,
          sourcePeakScRgb,
          sourcePeakNitsAt80NitsPerScRgb: sourcePeakScRgb * 80,
          brightnessCorrection: 1,
          negativeChannelSamples,
          nonFiniteChannelSamples,
          outputMin,
          outputMax
        });

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
              execFileSync(
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

ipcMain.on('quit', (_, code) => app.exit(code));

const readFolder = async (folder: string): Promise<string[]> =>
  (await fs.readdir(folder))
    .map(f => path.join(folder, f))
    .filter(f => fsSync.lstatSync(f).isFile())
    .filter(f => supportedFileExtensions.includes(path.extname(f).toLowerCase().replace('.', '')));


ipcMain.handle('MapWindow.open', (_event, latitude: number, longitude: number, bearing?: number): boolean =>
  App.openMapWindow(latitude, longitude, bearing)
);
ipcMain.handle('MapWindow.close', (): void => App.closeMapWindow());
ipcMain.handle('MapWindow.isOpen', (): boolean => App.isMapWindowOpen());
ipcMain.handle('MapWindow.focus', (): boolean => App.focusMapWindow());
ipcMain.handle('MapWindow.setAlwaysOnTop', (_event, enabled: boolean): boolean =>
  App.setMapWindowAlwaysOnTop(enabled)
);
