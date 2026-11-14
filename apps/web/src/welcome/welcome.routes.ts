import { Route } from '@angular/router';
import { Dashboard } from './pages/dashboard/dashboard';

export const routes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: '/view' },
  { path: 'dashboard', component: Dashboard },
  { path: 'gallery', redirectTo: '/view' }
];
