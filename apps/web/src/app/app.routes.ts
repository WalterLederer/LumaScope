import { Route } from '@angular/router';
import { startupGuard } from '../system/guards/startup/startup.guard';
import { Root } from '../system/pages/root/root';

export const appRoutes: Route[] = [
  { path: '', component: Root, canActivate: [ startupGuard ] },
  { path: 'map', loadComponent: () => import('../system/pages/map-window/map-window').then(m => m.MapWindow) },
  { path: 'capture-preview', loadComponent: () => import('../capture/pages/capture-preview-window/capture-preview-window').then(m => m.CapturePreviewWindow) },
  { path: 'view', loadChildren: () => import('../viewer/viewer.routes').then(m => m.routes) },
  { path: 'welcome', loadChildren: () => import('../welcome/welcome.routes').then(m => m.routes) }
];
