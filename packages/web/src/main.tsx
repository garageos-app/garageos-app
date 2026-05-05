import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <div>booting…</div>
  </StrictMode>,
);
