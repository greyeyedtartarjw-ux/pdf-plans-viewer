import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ViewerProvider } from './store/ViewerContext';
import Shell from './components/Shell';
import { Toaster } from '@/components/ui/toaster';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
    mutations: { retry: 0 },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ViewerProvider>
        <Shell />
        <Toaster />
      </ViewerProvider>
    </QueryClientProvider>
  );
}
