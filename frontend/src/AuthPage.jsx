import { useState } from "react";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithPopup,
} from "firebase/auth";
import { auth, googleProvider } from "./firebase";
import ParticleBackground from "./ParticleBackground";
import "./AuthPage.css";

/* ── Firebase friendly errors ─────────────────────────────────────── */
function friendlyError(code, raw) {
  switch (code) {
    case "auth/invalid-email":            return "Please enter a valid email address.";
    case "auth/missing-email":            return "Please enter your email address.";
    case "auth/missing-password":         return "Please enter your password.";
    case "auth/user-not-found":           return "No account found with this email. Create one below.";
    case "auth/wrong-password":           return "Incorrect password. Try again or reset it.";
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":return "Incorrect email or password. Please try again.";
    case "auth/user-disabled":            return "This account has been disabled. Contact support.";
    case "auth/email-already-in-use":     return "An account already exists with this email. Sign in instead.";
    case "auth/weak-password":            return "Password must be at least 6 characters.";
    case "auth/operation-not-allowed":    return "Email/Password sign-in is not enabled. Check Firebase Console → Authentication → Sign-in method.";
    case "auth/too-many-requests":        return "Too many failed attempts. Wait a moment and try again.";
    case "auth/network-request-failed":   return "Network error. Check your connection and try again.";
    case "auth/popup-blocked":            return "Popup blocked. Allow popups for this site and retry.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":  return "";
    case "auth/account-exists-with-different-credential": return "An account with this email exists via a different sign-in method. Try Google instead.";
    case "auth/unauthorized-domain":      return "This domain is not authorised. Add 'localhost' in Firebase Console → Authentication → Authorised domains.";
    case "auth/api-key-not-valid.-please-pass-a-valid-api-key.": return "Invalid Firebase API key. Copy the correct apiKey from Firebase Console → Project Settings → Your apps.";
    default: {
      console.error("[Firebase Auth] Unhandled code:", code, "|", raw);
      return `Auth error [${code || "unknown"}] — please report this code.`;
    }
  }
}

/* ── Icons ────────────────────────────────────────────────────────── */
function IconEmail() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
      <polyline points="22,6 12,13 2,6"/>
    </svg>
  );
}
function IconLock() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}
function IconEyeOn() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}
function IconEyeOff() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  );
}
function GoogleIcon() {
  return (
    <svg className="google-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

/* ── Reusable sub-components ───────────────────────────────────────── */
function ErrorBanner({ msg, id }) {
  if (!msg) return null;
  return <div className="auth-error" id={id} role="alert"><span>⚠️</span>{msg}</div>;
}

function EmailField({ id, value, onChange, autoFocus }) {
  return (
    <div className="auth-field">
      <label className="auth-label" htmlFor={id}>Email address</label>
      <div className="auth-input-wrap">
        <span className="auth-field-icon"><IconEmail /></span>
        <input
          id={id} type="email" className="auth-input"
          placeholder="you@company.com"
          value={value} onChange={onChange}
          autoComplete="email" autoFocus={autoFocus} required
        />
      </div>
    </div>
  );
}

function PasswordField({ id, label, value, onChange, placeholder = "••••••••", autoComplete = "current-password" }) {
  const [show, setShow] = useState(false);
  return (
    <div className="auth-field">
      <label className="auth-label" htmlFor={id}>{label}</label>
      <div className="auth-input-wrap">
        <span className="auth-field-icon"><IconLock /></span>
        <input
          id={id} type={show ? "text" : "password"} className="auth-input"
          placeholder={placeholder} value={value} onChange={onChange}
          autoComplete={autoComplete} required
        />
        <button type="button" className="auth-eye" tabIndex={-1}
          onClick={() => setShow(s => !s)}
          aria-label={show ? "Hide password" : "Show password"}>
          {show ? <IconEyeOff /> : <IconEyeOn />}
        </button>
      </div>
    </div>
  );
}

function GoogleBtn({ onClick, loading, disabled }) {
  return (
    <button type="button" className="auth-btn-google" onClick={onClick}
      disabled={disabled} id="google-btn">
      {loading ? <span className="auth-spinner-dark" /> : <GoogleIcon />}
      {loading ? "Connecting…" : "Continue with Google"}
    </button>
  );
}

/* ── Animated background elements ─────────────────────────────────── */
function AuthBackground() {
  return (
    <>
      <div className="auth-orb auth-orb-1" />
      <div className="auth-orb auth-orb-2" />
      <div className="auth-orb auth-orb-3" />
      <div className="auth-lines" aria-hidden="true">
        {Array.from({length: 9}).map((_, i) => (
          <div key={i} className="auth-line" />
        ))}
      </div>
    </>
  );
}

/* ── Brand header ──────────────────────────────────────────────────── */
function BrandHeader({ panelTitle, panelSub }) {
  return (
    <div className="auth-card-header">
      <div className="auth-logo">🎯</div>
      <div className="auth-brand">
        Scribe <span className="auth-brand-accent">GoogleAI</span>
      </div>
      <p className="auth-tagline">Turn meetings into AI-powered notes instantly.</p>
      <div className="auth-header-sep" />
      <div className="auth-panel-title">{panelTitle}</div>
      {panelSub && <div className="auth-panel-sub">{panelSub}</div>}
    </div>
  );
}

/* ── Footer ────────────────────────────────────────────────────────── */
function CardFooter() {
  return (
    <div className="auth-footer">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
      Secured by Firebase Authentication
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   SIGN IN PANEL
═══════════════════════════════════════════════════════ */
function SignInPanel({ onSwitch, onForgot }) {
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [gLoading, setGLoading] = useState(false);
  const [error,    setError]    = useState("");

  async function handleSignIn(e) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setError(""); setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      console.error("[Firebase SignIn]", err.code, err.message);
      setError(friendlyError(err.code, err.message));
    } finally { setLoading(false); }
  }

  async function handleGoogle() {
    setError(""); setGLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error("[Firebase Google]", err.code, err.message);
      const m = friendlyError(err.code, err.message);
      if (m) setError(m);
    } finally { setGLoading(false); }
  }

  return (
    <>
      <BrandHeader panelTitle="Sign in to your account" />
      <form className="auth-card-body" onSubmit={handleSignIn} id="signin-form" noValidate>
        <ErrorBanner msg={error} id="signin-error" />

        <EmailField id="signin-email" value={email} onChange={e => setEmail(e.target.value)} autoFocus />

        <PasswordField id="signin-password" label="Password" value={password}
          onChange={e => setPassword(e.target.value)} autoComplete="current-password" />

        <div className="auth-forgot">
          <button type="button" className="auth-link" onClick={onForgot} id="forgot-link">
            Forgot password?
          </button>
        </div>

        <button type="submit" className="auth-btn-primary" disabled={loading || gLoading} id="signin-btn">
          {loading && <span className="auth-spinner" />}
          {loading ? "Signing in…" : "Sign In"}
        </button>

        <div className="auth-divider">or continue with</div>
        <GoogleBtn onClick={handleGoogle} loading={gLoading} disabled={loading || gLoading} />

        <div className="auth-switch">
          New here?{" "}
          <button type="button" onClick={onSwitch} id="goto-register-btn">Create an account</button>
        </div>
      </form>
      <CardFooter />
    </>
  );
}

/* ═══════════════════════════════════════════════════════
   REGISTER PANEL
═══════════════════════════════════════════════════════ */
function RegisterPanel({ onSwitch }) {
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [confirm,  setConfirm]  = useState("");
  const [loading,  setLoading]  = useState(false);
  const [gLoading, setGLoading] = useState(false);
  const [error,    setError]    = useState("");

  async function handleRegister(e) {
    e.preventDefault();
    setError("");
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== confirm)  { setError("Passwords do not match."); return; }
    setLoading(true);
    try {
      await createUserWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      console.error("[Firebase Register]", err.code, err.message);
      setError(friendlyError(err.code, err.message));
    } finally { setLoading(false); }
  }

  async function handleGoogle() {
    setError(""); setGLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error("[Firebase Google]", err.code, err.message);
      const m = friendlyError(err.code, err.message);
      if (m) setError(m);
    } finally { setGLoading(false); }
  }

  return (
    <>
      <BrandHeader panelTitle="Create your account" panelSub="Start your first AI-powered meeting" />
      <form className="auth-card-body" onSubmit={handleRegister} id="register-form" noValidate>
        <ErrorBanner msg={error} id="register-error" />

        <EmailField id="reg-email" value={email} onChange={e => setEmail(e.target.value)} autoFocus />

        <PasswordField id="reg-password" label="Password" value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Min. 6 characters" autoComplete="new-password" />

        <PasswordField id="reg-confirm" label="Confirm password" value={confirm}
          onChange={e => setConfirm(e.target.value)}
          placeholder="Repeat your password" autoComplete="new-password" />

        <button type="submit" className="auth-btn-primary" disabled={loading || gLoading} id="register-btn">
          {loading && <span className="auth-spinner" />}
          {loading ? "Creating account…" : "Create Account"}
        </button>

        <div className="auth-divider">or continue with</div>
        <GoogleBtn onClick={handleGoogle} loading={gLoading} disabled={loading || gLoading} />

        <div className="auth-switch">
          Already have an account?{" "}
          <button type="button" onClick={onSwitch} id="goto-signin-btn">Sign in</button>
        </div>
      </form>
      <CardFooter />
    </>
  );
}

/* ═══════════════════════════════════════════════════════
   FORGOT PASSWORD PANEL
═══════════════════════════════════════════════════════ */
function ForgotPanel({ onBack }) {
  const [email,   setEmail]   = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [sent,    setSent]    = useState(false);

  async function handleReset(e) {
    e.preventDefault();
    if (!email.trim()) return;
    setError(""); setLoading(true);
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setSent(true);
    } catch (err) {
      console.error("[Firebase Reset]", err.code, err.message);
      setError(friendlyError(err.code, err.message));
    } finally { setLoading(false); }
  }

  return (
    <>
      <BrandHeader
        panelTitle="Reset your password"
        panelSub={sent ? "Reset link sent — check your inbox." : "Enter your email to receive a reset link."}
      />
      <form className="auth-card-body" onSubmit={handleReset} id="forgot-form" noValidate>
        <ErrorBanner msg={error} id="forgot-error" />

        {sent ? (
          <div className="auth-success" id="forgot-success">
            <span>✅</span>
            <span>Password reset link sent to <strong>{email}</strong>. Check your inbox and spam folder.</span>
          </div>
        ) : (
          <EmailField id="forgot-email" value={email} onChange={e => setEmail(e.target.value)} autoFocus />
        )}

        {!sent && (
          <button type="submit" className="auth-btn-primary" disabled={loading} id="reset-btn">
            {loading && <span className="auth-spinner" />}
            {loading ? "Sending link…" : "Send Reset Link"}
          </button>
        )}

        <button type="button" className="auth-back" onClick={onBack} id="back-to-signin-btn">
          ← Back to sign in
        </button>
      </form>
      <CardFooter />
    </>
  );
}

/* ═══════════════════════════════════════════════════════
   MAIN
═══════════════════════════════════════════════════════ */
export default function AuthPage() {
  const [panel, setPanel] = useState("signin");
  return (
    <div className="auth-root" id="auth-page">
      {/* CSS ambient orbs */}
      <div className="auth-orb auth-orb-1" />
      <div className="auth-orb auth-orb-2" />
      <div className="auth-orb auth-orb-3" />
      {/* Three.js cursor-reactive particles (z-index 1, pointer-events none) */}
      <ParticleBackground />
      <div className="auth-card" id="auth-card">
        {panel === "signin"   && <SignInPanel   onSwitch={() => setPanel("register")} onForgot={() => setPanel("forgot")} />}
        {panel === "register" && <RegisterPanel onSwitch={() => setPanel("signin")} />}
        {panel === "forgot"   && <ForgotPanel   onBack={() => setPanel("signin")} />}
      </div>
    </div>
  );
}
