import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/* Add an absolute timestamp to every Electron main-process console entry.
 * This module is imported first by the desktop entry point, before application
 * services and their startup diagnostics are evaluated. */
const timestampConsoleOutput = (write: (...data: unknown[]) => void) =>
  (...data: unknown[]): void => write(`[${new Date().toISOString()}]`, ...data);

console.log = timestampConsoleOutput(console.log.bind(console));
console.info = timestampConsoleOutput(console.info.bind(console));
console.warn = timestampConsoleOutput(console.warn.bind(console));
console.error = timestampConsoleOutput(console.error.bind(console));
console.debug = timestampConsoleOutput(console.debug.bind(console));

// Set the profile path before any other application modules are evaluated.
// Some imported modules may initialize services that read app.getPath('userData').
app.setName('LumaScope');
const roamingAppData = process.env.APPDATA || app.getPath('appData');
const lumaScopeUserData = join(roamingAppData, 'LumaScope');
mkdirSync(lumaScopeUserData, { recursive: true });
app.setPath('userData', lumaScopeUserData);

console.info(`[Startup] Electron userData path: ${app.getPath('userData')}`);
