import { Injectable } from '@angular/core';
import { DesktopProcessManager, SystemPathMapping } from 'internal-api';
import { Arguments } from 'yargs';

@Injectable({ providedIn: 'root' })
export class ProcessManager implements DesktopProcessManager {
  readonly getProcessMemoryUsage = () => window.desktop.ProcessManager.getProcessMemoryUsage();

  readonly getAppVersion = (): Promise<string> => window.desktop.ProcessManager.getAppVersion();

  readonly getFileTypeIcon = (filePath: string): Promise<string | null> => window.desktop.ProcessManager.getFileTypeIcon(filePath);

  readonly getAppSettings = (): Promise<Record<string, unknown>> => window.desktop.ProcessManager.getAppSettings();

  readonly setAppSettingsSection = (section: string, values: Record<string, unknown>): Promise<void> =>
    window.desktop.ProcessManager.setAppSettingsSection(section, values);

  readonly onAppSettingsChanged = (callback: (section: string, values: Record<string, unknown>) => void): (() => void) =>
    window.desktop.ProcessManager.onAppSettingsChanged(callback);

  readonly isPackaged = (): Promise<boolean> => window.desktop.ProcessManager.isPackaged();

  readonly getDevToolsOpen = (): Promise<boolean> => window.desktop.ProcessManager.getDevToolsOpen();

  readonly setDevToolsOpen = (open: boolean): Promise<void> => window.desktop.ProcessManager.setDevToolsOpen(open);

  readonly getPlatform = (): Promise<string> => window.desktop.ProcessManager.getPlatform();

  readonly argv = (): Promise<Arguments> => window.desktop.ProcessManager.argv();

  readonly getSystemPaths = (): Promise<SystemPathMapping> => window.desktop.ProcessManager.getSystemPaths();

  readonly openConfigFile = (): Promise<string> => window.desktop.ProcessManager.openConfigFile();
  readonly openConfigFolder = (): Promise<string> => window.desktop.ProcessManager.openConfigFolder();
  readonly openPath = (filePath: string): Promise<string> => window.desktop.ProcessManager.openPath(filePath);
  readonly openWith = (filePath: string): Promise<void> => window.desktop.ProcessManager.openWith(filePath);
  readonly showWindowsContextMenu = (filePath: string, screenX: number, screenY: number): Promise<void> =>
    window.desktop.ProcessManager.showWindowsContextMenu(filePath, screenX, screenY);
  readonly openExternal = (url: string): Promise<void> => window.desktop.ProcessManager.openExternal(url);

  readonly quit = (code: number): Promise<void> => window.desktop.ProcessManager.quit(code);

  readonly setWindowTitle = (title: string): Promise<void> => window.desktop.ProcessManager.setWindowTitle(title);
}
