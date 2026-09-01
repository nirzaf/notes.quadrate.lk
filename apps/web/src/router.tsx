import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuth } from './auth-context';
import { LoginPage } from './pages/login-page';
import { HomePage } from './pages/home-page';
import { TokensPage } from './pages/tokens-page';

function RootLayout(): JSX.Element {
  const { session, loading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session && location.pathname !== '/login') void navigate({ to: '/login', replace: true });
    if (session && location.pathname === '/login') void navigate({ to: '/', replace: true });
  }, [loading, location.pathname, navigate, session]);
  if (loading) return <div className="q-auth-page"><div className="q-empty">Opening your private workspace…</div></div>;
  return <Outlet />;
}

export const rootRoute = createRootRoute({ component: RootLayout });
export const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginPage });
export const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage });
export const noteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notes/$noteId', component: lazyRouteComponent(() => import('./pages/note-page'), 'NotePage') });
export const tokensRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings/tokens', component: TokensPage });
export const routeTree = rootRoute.addChildren([loginRoute, homeRoute, noteRoute, tokensRoute]);
export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router; }
}
