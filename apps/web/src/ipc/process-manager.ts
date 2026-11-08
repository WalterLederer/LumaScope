import { Injectable } from '@angular/core';
import { DesktopProcessManager, SystemPathMapping } from 'internal-api';
import { Arguments } from 'yargs';

@Injectable({ providedIn: 'root' })
export class ProcessManager implements DesktopProcessManager {
  readonly getAppVersion = (): Promise<string> => window.desktop.ProcessManager.getAppVersion();

  readonly getAppSettings = (): Promise<Record<string, unknown>> => window.desktop.ProcessManager.getAppSettings();

  readonly setAppSettingsSection = (section: string, values: Record<string, unknown>): Promise<void> =>
    window.desktop.ProcessManager.setAppSettingsSection(section, values);

  readonly isPackaged = (): Promise<boolean> => window.desktop.ProcessManager.isPackaged();

  readonly getDevToolsOpen = (): Promise<boolean> => window.desktop.ProcessManager.getDevToolsOpen();

  readonly setDevToolsOpen = (open: boolean): Promise<void> => window.desktop.ProcessManager.setDevToolsOpen(open);

  readonly getPlatform = (): Promise<string> => window.desktop.ProcessManager.getPlatform();

  readonly argv = (): Promise<Arguments> => window.desktop.ProcessManager.argv();

  readonly getSystemPaths = (): Promise<SystemPathMapping> => window.desktop.ProcessManager.getSystemPaths();

  readonly openConfigFile = (): Promise<string> => window.desktop.ProcessManager.openConfigFile();
  readonly openExternal = (url: string): Promise<void> => window.desktop.ProcessManager.openExternal(url);

  readonly quit = (code: number): Promise<void> => window.desktop.ProcessManager.quit(code);

  readonly setWindowTitle = (title: string): Promise<void> => window.desktop.ProcessManager.setWindowTitle(title);
}
