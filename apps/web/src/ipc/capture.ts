import { Injectable } from '@angular/core';
import { CaptureFormat, CapturePreview, CaptureResult, CaptureSources, CaptureTarget, DesktopCapture, GlobalShortcutStatus } from 'internal-api';

@Injectable({ providedIn: 'root' })
export class CaptureService implements DesktopCapture {
  readonly listSources = (): Promise<CaptureSources> => window.desktop.Capture.listSources();

  readonly chooseFolder = (initialPath?: string): Promise<string | null> =>
    window.desktop.Capture.chooseFolder(initialPath);

  readonly preview = (target: CaptureTarget): Promise<CapturePreview> =>
    window.desktop.Capture.preview(target);

  readonly capture = (target: CaptureTarget, folder: string, format?: CaptureFormat, gammaCorrection?: number, encoderQuality?: number, previewFrame?: CapturePreview): Promise<CaptureResult> =>
    window.desktop.Capture.capture(target, folder, format, gammaCorrection, encoderQuality, previewFrame);

  readonly copyPreviewToClipboard = (pngData: Uint8Array): Promise<CaptureResult> =>
    window.desktop.Capture.copyPreviewToClipboard(pngData);

  readonly getGlobalShortcutStatus = (): Promise<GlobalShortcutStatus[]> =>
    window.desktop.Capture.getGlobalShortcutStatus();

  readonly onGlobalShortcutStatusChanged = (callback: (statuses: GlobalShortcutStatus[]) => void): (() => void) =>
    window.desktop.Capture.onGlobalShortcutStatusChanged(callback);

  readonly onTopWindowClipboardHotkey = (callback: () => void): (() => void) =>
    window.desktop.Capture.onTopWindowClipboardHotkey(callback);

  readonly onRectangleClipboardHotkey = (callback: () => void): (() => void) =>
    window.desktop.Capture.onRectangleClipboardHotkey(callback);
}
