import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadStore } from './lib/store';
import App from './App';
import './styles.css';

// everything kept on the phone is read once, before the first screen
loadStore().finally(() => {
  createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
});
