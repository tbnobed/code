import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { ThemeProvider } from './components/theme-provider';
import ForgeLayout from './pages/ForgeLayout';
import NotFound from './pages/not-found';
import Auth from './pages/Auth';
import { useGetCurrentUser } from '@workspace/api-client-react';
import { Terminal } from 'lucide-react';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error: any) => {
        if (error?.status === 401 || error?.response?.status === 401) return false;
        return failureCount < 3;
      },
    },
  },
});

function AuthGate({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading, isError } = useGetCurrentUser();

  if (isLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background text-primary">
        <div className="flex flex-col items-center gap-4 animate-pulse">
          <div className="w-16 h-16 bg-sidebar-accent text-sidebar-primary rounded-sm flex items-center justify-center border border-sidebar-border shadow-[0_0_20px_rgba(255,87,34,0.15)]">
            <Terminal className="w-8 h-8" />
          </div>
          <div className="font-mono text-xs font-bold tracking-widest text-muted-foreground uppercase">INITIALIZING_CORE...</div>
        </div>
      </div>
    );
  }

  if (isError || !user) {
    return <Auth />;
  }

  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={ForgeLayout} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="forge-ui-theme">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={0}>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <AuthGate>
              <Router />
            </AuthGate>
          </WouterRouter>
          <Toaster theme="dark" position="bottom-right" className="font-sans" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;