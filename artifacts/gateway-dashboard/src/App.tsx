import { useState, useEffect, useCallback } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setAuthTokenGetter } from "@workspace/api-client-react";

import { Layout } from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import Playground from "@/pages/playground";
import History from "@/pages/history";
import Keys from "@/pages/keys";
import ApiReference from "@/pages/api-reference";
import NotFound from "@/pages/not-found";

const STORAGE_KEY = "gateway_admin_key";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/playground" component={Playground} />
        <Route path="/history" component={History} />
        <Route path="/keys" component={Keys} />
        <Route path="/api-reference" component={ApiReference} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function SetupScreen({ onSave }: { onSave: (key: string) => void }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) { setError("Admin key cannot be empty."); return; }
    onSave(trimmed);
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md border border-border rounded-lg p-6 bg-card space-y-5">
        <div className="space-y-1">
          <h1 className="text-lg font-bold font-mono tracking-tight text-primary">GATEWAY_AUTH</h1>
          <p className="text-xs text-muted-foreground font-mono">
            Enter your <span className="text-foreground">ADMIN_API_KEY</span> to access the dashboard.
            This is stored locally on this device — no login required on subsequent visits.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="password"
            value={input}
            onChange={(e) => { setInput(e.target.value); setError(""); }}
            placeholder="sk-..."
            autoFocus
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground"
          />
          {error && <p className="text-xs text-destructive font-mono">{error}</p>}
          <button
            type="submit"
            className="w-full bg-primary text-primary-foreground rounded px-3 py-2 text-sm font-mono font-semibold hover:bg-primary/90 transition-colors"
          >
            CONNECT
          </button>
        </form>
        <p className="text-xs text-muted-foreground font-mono opacity-60">
          Find your key in <span className="text-foreground">.replit</span> under{" "}
          <span className="text-foreground">ADMIN_API_KEY</span>.
        </p>
      </div>
    </div>
  );
}

function App() {
  const [adminKey, setAdminKey] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEY)
  );

  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  const applyKey = useCallback((key: string) => {
    localStorage.setItem(STORAGE_KEY, key);
    setAdminKey(key);
    setAuthTokenGetter(() => key);
    queryClient.clear();
  }, []);

  useEffect(() => {
    if (adminKey) {
      setAuthTokenGetter(() => adminKey);
    }
  }, [adminKey]);

  if (!adminKey) {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <SetupScreen onSave={applyKey} />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
