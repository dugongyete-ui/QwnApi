import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Terminal,
  Activity,
  MessageSquare,
  History,
  Key,
  Cpu,
  Menu,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = [
    { href: "/", label: "Dashboard", icon: Activity },
    { href: "/playground", label: "Playground", icon: MessageSquare },
    { href: "/history", label: "History", icon: History },
    { href: "/keys", label: "API Keys", icon: Key },
  ];

  const SidebarContent = () => (
    <>
      <div className="h-14 md:h-16 flex items-center px-5 border-b border-sidebar-border gap-3">
        <Terminal className="h-5 w-5 text-primary shrink-0" />
        <span className="font-mono font-bold tracking-tight text-sidebar-foreground">GW_CTRL</span>
      </div>

      <div className="flex-1 overflow-y-auto py-4 px-3">
        <div className="space-y-1">
          {navItems.map((item) => {
            const isActive =
              location === item.href ||
              (item.href !== "/" && location.startsWith(item.href));
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="block"
                onClick={() => setMobileOpen(false)}
              >
                <div
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      <div className="p-4 border-t border-sidebar-border">
        <div className="flex items-center gap-2 text-xs text-sidebar-foreground opacity-50 font-mono">
          <Cpu className="h-4 w-4" />
          <span>SYS_ONLINE v1.0.4</span>
        </div>
      </div>
    </>
  );

  return (
    <div className="flex h-screen bg-background overflow-hidden text-foreground">
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 flex items-center h-14 px-4 border-b border-border bg-sidebar gap-3">
        <button
          data-testid="button-mobile-menu"
          onClick={() => setMobileOpen(true)}
          className="p-1 rounded text-sidebar-foreground hover:text-primary transition-colors"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Terminal className="h-4 w-4 text-primary" />
        <span className="font-mono font-bold text-sm text-sidebar-foreground tracking-tight">GW_CTRL</span>
      </div>

      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative w-64 bg-sidebar flex flex-col h-full shadow-2xl border-r border-sidebar-border">
            <button
              data-testid="button-close-menu"
              onClick={() => setMobileOpen(false)}
              className="absolute top-3 right-3 p-1 rounded text-sidebar-foreground hover:text-primary"
              aria-label="Close menu"
            >
              <X className="h-4 w-4" />
            </button>
            <SidebarContent />
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <div className="hidden md:flex w-64 border-r border-border bg-sidebar flex-col shrink-0">
        <SidebarContent />
      </div>

      {/* Main content — offset by mobile top bar */}
      <div className="flex-1 overflow-hidden flex flex-col mt-14 md:mt-0">
        {children}
      </div>
    </div>
  );
}
