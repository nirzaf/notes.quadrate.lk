import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useAuth } from '../auth-context';

export function LoginPage(): JSX.Element {
  const { signIn, signUp, authError, retryInitialization } = useAuth();
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setConfirmation('');
    try {
      if (register) {
        await signUp(email, password);
        setConfirmation('Check your email to confirm the account before signing in.');
      } else {
        await signIn(email, password);
      }
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Unable to authenticate.');
    } finally { setBusy(false); }
  };
  return <main className="q-auth-page"><section className="q-card q-auth-card"><div className="q-brand"><span className="q-brand-mark">qn</span><span className="q-brand-word">QNotes</span></div><p className="q-eyebrow" style={{ marginTop: 28 }}>{register ? 'Create your private workspace' : 'Welcome back'}</p><h1 className="q-display" style={{ fontSize: 'clamp(2.2rem, 8vw, 3.8rem)' }}>{register ? 'Make space for good ideas.' : 'Your notes, in flow.'}</h1>{authError && <div className="q-error" role="alert">Authentication could not be restored. <button className="q-button q-button-ghost q-button-sm" type="button" onClick={retryInitialization}>Try again</button></div>}<form className="q-auth-form" onSubmit={submit}><label className="q-field"><span className="q-label">Email</span><Input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label className="q-field"><span className="q-label">Password</span><Input type="password" autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={6} required /></label>{error && <div className="q-error" role="alert">{error}</div>}{confirmation && <div className="q-success" role="status">{confirmation}</div>}<Button type="submit" size="lg" disabled={busy}>{busy ? 'Working…' : register ? 'Create account' : 'Sign in'}</Button></form><p className="q-auth-switch">{register ? 'Already have an account?' : 'New to QNotes?'} <button className="q-button q-button-ghost q-button-sm" type="button" onClick={() => { setRegister((current) => !current); setError(''); setConfirmation(''); }}>{register ? 'Sign in' : 'Create one'}</button></p></section></main>;
}
