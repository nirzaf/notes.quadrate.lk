import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuth } from './auth-context';
import { LoginPage } from './pages/login-page';
import { HomePage } from './pages/home-page';
import { SearchPage } from './pages/search-page';
import { TokensPage } from './pages/tokens-page';
import { TrashPage } from './pages/trash-page';
import { currentAppPath, safeInternalPath, validateAppSearch } from './navigation-context';

function RecoveryState({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }): JSX.Element {
  return <main className="q-auth-page"><section className="q-card q-auth-card" role="alert"><p className="q-eyebrow">Quadrate Notes</p><h1 className="q-display" style={{ fontSize: '2.8rem' }}>{title}</h1><p className="q-subtitle">{message}</p><div className="q-dialog-actions">{onRetry && <button className="q-button q-button-primary" type="button" onClick={onRetry}>Try again</button>}<Link className="q-button q-button-outline" to="/">Go to Notes</Link></div></section></main>;
}

function routeErrorComponent({ reset }: { reset: () => void }): JSX.Element {
  return <RecoveryState title="This view needs another try." message="The page or one of its modules could not be opened. Your local drafts are left untouched." onRetry={reset} />;
}

function routeNotFoundComponent(): JSX.Element {
  return <RecoveryState title="That page is not here." message="The link may be stale or the note may no longer be available." />;
}

function RootLayout(): JSX.Element {
  const { session, loading, authError, retryInitialization } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (loading || authError) return;
    if (!session && location.pathname !== '/login') {
      const returnTo = safeInternalPath(currentAppPath());
      void navigate({ to: '/login', replace: true, search: returnTo ? { returnTo } : {} });
    }
    if (session && location.pathname === '/login') {
      const returnTo = safeInternalPath(new URLSearchParams(window.location.search).get('returnTo'));
      void navigate((returnTo ? { href: returnTo, replace: true } : { to: '/', replace: true }) as never);
    }
  }, [authError, loading, location.pathname, location.search, navigate, session]);
  if (loading) return <div className="q-auth-page"><div className="q-empty">Opening your private workspace…</div></div>;
  if (authError && location.pathname !== '/login') return <RecoveryState title="Sign-in could not be restored." message="Authentication initialization failed. Retry, or continue to the sign-in screen." onRetry={retryInitialization} />;
  if (!session && location.pathname !== '/login') return <div className="q-auth-page"><div className="q-empty">Redirecting to sign in…</div></div>;
  if (session && location.pathname === '/login') return <div className="q-auth-page"><div className="q-empty">Returning to your workspace…</div></div>;
  return <Outlet />;
}

export const rootRoute = createRootRoute({ component: RootLayout, validateSearch: validateAppSearch, errorComponent: routeErrorComponent, notFoundComponent: routeNotFoundComponent });
export const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginPage });
export const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage });
export const searchRoute = createRoute({ getParentRoute: () => rootRoute, path: '/search', component: SearchPage });
export const noteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notes/$noteId', component: lazyRouteComponent(() => import('./pages/note-page'), 'NotePage') });
export const integrationsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings/integrations', component: TokensPage });
export const tokensRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings/tokens', component: TokensPage });
export const trashRoute = createRoute({ getParentRoute: () => rootRoute, path: '/trash', component: TrashPage });
export const routeTree = rootRoute.addChildren([loginRoute, homeRoute, searchRoute, noteRoute, integrationsRoute, tokensRoute, trashRoute]);
export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router; }
}
