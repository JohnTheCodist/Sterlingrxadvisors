import { useState } from 'react';
import { NavLink } from 'react-router-dom';

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
          <a href="#login" className="btn btn-ghost btn-sm">
            Log in
          </a>
          <NavLink to="/contact" className="btn btn-primary btn-sm">
            Get Started
          </NavLink>
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
        <a href="#login" onClick={() => setOpen(false)}>Log in</a>
      </div>
    </header>
  );
}
