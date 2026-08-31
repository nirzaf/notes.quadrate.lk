import { createContext, useCallback, useContext, useMemo, useState, type PropsWithChildren } from 'react';

interface ToastItem { id: number; message: string; tone: 'success' | 'error' | 'info'; }
interface ToastContextValue { toast: (message: string, tone?: ToastItem['tone']) => void; }
const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: PropsWithChildren): JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([]);
  const toast = useCallback((message: string, tone: ToastItem['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setItems((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), 3500);
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);
  return <ToastContext.Provider value={value}>{children}<div className="q-toast-viewport" aria-live="polite">{items.map((item) => <div className={`q-toast q-toast-${item.tone}`} key={item.id}>{item.message}</div>)}</div></ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used within ToastProvider.');
  return value;
}
