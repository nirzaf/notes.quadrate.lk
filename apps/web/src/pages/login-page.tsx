import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useAuth } from '../auth-context';

export function LoginPage(): JSX.Element {
  const { session, signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (session) void navigate({ to: '/' }); }, [navigate, session]);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try { if (register) await signUp(email, password); else await signIn(email, password); void navigate({ to: '/' }); } catch (caught: unknown) { setError(caught instanceof Error ? caught.message : 'Unable to authenticate.'); } finally { setBusy(false); }
  };
  return <main className="q-auth-page"><section className="q-card q-auth-card"><div className="q-brand"><span className="q-brand-mark">qn</span><span className="q-brand-word">Quadrate Notes</span></div><p className="q-eyebrow" style={{ marginTop: 28 }}>{register ? 'Create your private workspace' : 'Welcome back'}</p><h1 className="q-display" style={{ fontSize: 'clamp(2.2rem, 8vw, 3.8rem)' }}>{register ? 'Make space for good ideas.' : 'Your notes, in flow.'}</h1><form className="q-auth-form" onSubmit={submit}><label className="q-field"><span className="q-label">Email</span><Input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label className="q-field"><span className="q-label">Password</span><Input type="password" autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={6} required /></label>{error && <div className="q-error" role="alert">{error}</div>}<Button type="submit" size="lg" disabled={busy}>{busy ? 'Working…' : register ? 'Create account' : 'Sign in'}</Button></form><p className="q-auth-switch">{register ? 'Already have an account?' : 'New to Quadrate Notes?'} <button className="q-button q-button-ghost q-button-sm" type="button" onClick={() => { setRegister((current) => !current); setError(''); }}>{register ? 'Sign in' : 'Create one'}</button></p></section></main>;
}
