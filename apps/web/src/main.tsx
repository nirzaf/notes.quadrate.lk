import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles.css';

const rootElement = document.getElementById('root');
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1 } } });

function showFatal(error: unknown): void {
  if (!rootElement) return;
  rootElement.innerHTML = `<main class="q-auth-page"><section class="q-card q-auth-card"><p class="q-eyebrow">Configuration required</p><h1 class="q-display" style="font-size:3rem">Quadrate Notes cannot start.</h1><p class="q-subtitle">${error instanceof Error ? error.message : 'The web environment is incomplete.'}</p></section></main>`;
}

async function boot(): Promise<void> {
  try {
    await import('./env');
    const [{ AuthProvider }, { router }, { ToastProvider }] = await Promise.all([import('./auth-context'), import('./router'), import('./components/ui/toast')]);
    if (!rootElement) throw new Error('The application root element is missing.');
    createRoot(rootElement).render(<QueryClientProvider client={queryClient}><AuthProvider><ToastProvider><RouterProvider router={router} /></ToastProvider></AuthProvider></QueryClientProvider>);
    if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  } catch (error: unknown) {
    showFatal(error);
  }
}

const { RouterProvider } = await import('@tanstack/react-router');
void boot();
