import { bootstrapApplication } from '@angular/platform-browser';
import { setPackagedMode } from 'internal-api';
import { App } from './app/app';
import { appConfig } from './app/app.config';

console.warn('[Startup] Renderer entry reached; requesting ProcessManager.isPackaged');

window.desktop
  .ProcessManager
  .isPackaged()
  .then(isPackaged => {
    console.warn('[Startup] ProcessManager.isPackaged resolved', isPackaged);
    setPackagedMode(isPackaged);
    console.warn('[Startup] Starting Angular bootstrap');

    return bootstrapApplication(App, appConfig)
      .then(() => console.warn('[Startup] Angular bootstrap completed'))
      .catch(err => console.error('[Startup] Angular bootstrap failed', err));
  })
  .catch(err => console.error('[Startup] ProcessManager.isPackaged failed', err));
