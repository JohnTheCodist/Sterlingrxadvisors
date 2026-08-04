import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import './index.css';

/**
 * BrowserRouter routes on location.pathname, which the web deploy serves from
 * a real origin — so it stays the default and nothing about the site changes.
 *
 * The desktop shell loads the same bundle over file://, where pathname is the
 * full path on disk:
 *
 *   /C:/Users/ASUS/.../desktop/renderer/index.html
 *
 * That matches no route, so <Routes> renders nothing while the header and
 * footer -- which sit outside it -- still draw. The result is a window with
 * navigation, a footer, and a blank space where the whole application should
 * be, reporting no error anywhere. HashRouter keeps its route after the '#'
 * and is unaffected by where the file lives.
 */
const Router = window.location.protocol === 'file:' ? HashRouter : BrowserRouter;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Router>
      <AuthProvider>
        <App />
      </AuthProvider>
    </Router>
  </React.StrictMode>
);
