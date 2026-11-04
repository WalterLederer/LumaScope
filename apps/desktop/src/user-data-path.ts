import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Set the profile path before any other application modules are evaluated.
// Some imported modules may initialize services that read app.getPath('userData').
app.setName('LumaScope');
const roamingAppData = process.env.APPDATA || app.getPath('appData');
const lumaScopeUserData = join(roamingAppData, 'LumaScope');
mkdirSync(lumaScopeUserData, { recursive: true });
app.setPath('userData', lumaScopeUserData);

console.info(`[Startup] Electron userData path: ${app.getPath('userData')}`);
