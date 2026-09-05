import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/tokens.css';
import './styles/global.css';

/**
 * Dark by default. A viewer who has picked a side keeps it; the stamp in
 * index.html covers the first paint so the page never flashes light.
 */
try {
  const saved = localStorage.getItem('jkj:theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
} catch {
  // Private windows and blocked site data both throw. Dark stays.
}

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
