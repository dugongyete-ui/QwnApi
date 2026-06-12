import { useEffect } from "react";
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

const queryClient = new QueryClient();

// Auto-inject ADMIN_API_KEY (embedded at dev/build time from env).
// No setup screen, no manual entry — dashboard auto-authenticates on every device.
const ADMIN_KEY = import.meta.env.VITE_ADMIN_API_KEY as string | undefined;
if (ADMIN_KEY) {
  setAuthTokenGetter(() => ADMIN_KEY);
}

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

function App() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

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
