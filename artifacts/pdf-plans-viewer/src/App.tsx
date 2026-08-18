import React from 'react';
import { ViewerProvider } from './store/ViewerContext';
import Shell from './components/Shell';

export default function App() {
  return (
    <ViewerProvider>
      <Shell />
    </ViewerProvider>
  );
}
