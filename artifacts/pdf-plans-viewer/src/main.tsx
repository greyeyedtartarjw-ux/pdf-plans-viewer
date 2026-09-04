import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';
import { setBaseUrl } from '@workspace/api-client-react';

import './index.css';

// file:// pages have no web origin, so desktop releases use an explicit API
// origin embedded by the release builder. Without one, the app remains fully
// usable offline and keeps edits pending.
if (window.electronAPI && import.meta.env.VITE_DESKTOP_API_URL) {
  setBaseUrl(import.meta.env.VITE_DESKTOP_API_URL);
}

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
