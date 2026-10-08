import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { SharedInstructions } from './SharedInstructions.js';
import './styles.css';
import './workspace.css';
import './editor-ux.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SharedInstructions />
    <App />
  </React.StrictMode>,
);
