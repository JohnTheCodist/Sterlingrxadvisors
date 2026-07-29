import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const links = [
  { to: '/', label: 'Home' },
  { to: '/features', label: 'Features' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/how-it-works', label: 'How It Works' },
  { to: '/case-studies', label: 'Case Studies' },
  { to: '/contact', label: 'Contact' },
];

export default function Navbar() {
  const [open, setOpen] = useState(false);
  // This bar renders above /upload and /onboarding, which are behind
  // RequireAuth — so it was telling already-signed-in users to "Log in,"
  // and offered them no way to sign out (the only sign-out control lives
  // in the dashboard sidebar, and the dashboard hides this bar entirely).
  const { session, signOut } = useAuth();

  return (
    <header className="navbar">
      <div className="shell">
        <NavLink to="/" className="brand" onClick={() => setOpen(false)}>
          <span className="brand-mark">Rx</span>
          RxNaija Analytics
        </NavLink>

        <nav className="nav-links">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === '/'}
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        <div className="nav-actions">
          {session ? (
            <>
              <NavLink to="/dashboard" className="btn btn-ghost btn-sm">
                Dashboard
              </NavLink>
              <button type="button" onClick={signOut} className="btn btn-primary btn-sm">
                Sign out
              </button>
            </>
          ) : (
            <>
              <NavLink to="/signin" className="btn btn-ghost btn-sm">
                Log in
              </NavLink>
              <NavLink to="/contact" className="btn btn-primary btn-sm">
                Get Started
              </NavLink>
            </>
          )}
          <button
            className="nav-toggle"
            aria-label="Toggle menu"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '✕' : '☰'}
          </button>
        </div>
      </div>

      <div className={`mobile-menu ${open ? 'open' : ''}`}>
        {links.map((link) => (
          <NavLink key={link.to} to={link.to} end={link.to === '/'} onClick={() => setOpen(false)}>
            {link.label}
          </NavLink>
        ))}
        {session ? (
          <>
            <NavLink to="/dashboard" onClick={() => setOpen(false)}>Dashboard</NavLink>
            <button type="button" onClick={() => { setOpen(false); signOut(); }}>
              Sign out
            </button>
          </>
        ) : (
          <NavLink to="/signin" onClick={() => setOpen(false)}>Log in</NavLink>
        )}
      </div>
    </header>
  );
}
