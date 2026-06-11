import { useEffect } from "react";
import {
  useGetStats,
  getGetStatsQueryKey,
  useGetTokenPoolStatus,
  getGetTokenPoolStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Activity, Server, Key, Zap, XCircle, Clock } from "lucide-react";
import { Link } from "wouter";

export default function Dashboard() {
  const queryClient = useQueryClient();

  const { data: stats, isLoading: isStatsLoading } = useGetStats({
    query: { queryKey: getGetStatsQueryKey() },
  });

  const { data: tokenPool, isLoading: isPoolLoading } = useGetTokenPoolStatus({
    query: { queryKey: getGetTokenPoolStatusQueryKey() },
  });

  useEffect(() => {
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetTokenPoolStatusQueryKey() });
    }, 30000);
    return () => clearInterval(interval);
  }, [queryClient]);

  const poolPercent =
    tokenPool && tokenPool.total > 0
      ? (tokenPool.healthy / tokenPool.total) * 100
      : 0;

  return (
    <div className="flex-1 overflow-auto p-4 md:p-8 space-y-6 md:space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">System Overview</h1>
        <Link
          href="/playground"
          data-testid="link-test-connection"
          className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2 font-mono uppercase tracking-wider self-start sm:self-auto"
        >
          &gt; Test_Connection
        </Link>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <Card className="bg-card border-border" data-testid="card-success-rate">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0 p-3 md:p-6">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-widest font-mono">
              Success Rate
            </CardTitle>
            <Activity className="w-4 h-4 text-primary shrink-0" />
          </CardHeader>
          <CardContent className="p-3 pt-0 md:p-6 md:pt-0">
            {isStatsLoading ? (
              <div className="h-8 w-20 bg-muted animate-pulse rounded" />
            ) : (
              <>
                <div className="text-3xl md:text-4xl font-bold font-mono text-primary">
                  {(stats?.successRate ?? 0).toFixed(1)}%
                </div>
                <p className="text-xs text-muted-foreground mt-1 hidden sm:block">
                  {stats?.successRequests} successful / {stats?.totalRequests} total
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border" data-testid="card-reqs-today">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0 p-3 md:p-6">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-widest font-mono">
              Reqs Today
            </CardTitle>
            <Zap className="w-4 h-4 text-primary shrink-0" />
          </CardHeader>
          <CardContent className="p-3 pt-0 md:p-6 md:pt-0">
            {isStatsLoading ? (
              <div className="h-8 w-16 bg-muted animate-pulse rounded" />
            ) : (
              <>
                <div className="text-3xl md:text-4xl font-bold font-mono">
                  {stats?.requestsToday.toLocaleString()}
                </div>
                <p className="text-xs text-muted-foreground mt-1 hidden sm:block">
                  {stats?.requestsThisHour.toLocaleString()} this hour
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border" data-testid="card-avg-latency">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0 p-3 md:p-6">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-widest font-mono">
              Avg Latency
            </CardTitle>
            <Clock className="w-4 h-4 text-primary shrink-0" />
          </CardHeader>
          <CardContent className="p-3 pt-0 md:p-6 md:pt-0">
            {isStatsLoading ? (
              <div className="h-8 w-16 bg-muted animate-pulse rounded" />
            ) : (
              <>
                <div className="text-3xl md:text-4xl font-bold font-mono">
                  {stats?.averageResponseTime}ms
                </div>
                <p className="text-xs text-muted-foreground mt-1 hidden sm:block">
                  Across all models
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border" data-testid="card-active-keys">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0 p-3 md:p-6">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-widest font-mono">
              Active Keys
            </CardTitle>
            <Key className="w-4 h-4 text-primary shrink-0" />
          </CardHeader>
          <CardContent className="p-3 pt-0 md:p-6 md:pt-0">
            {isStatsLoading ? (
              <div className="h-8 w-10 bg-muted animate-pulse rounded" />
            ) : (
              <>
                <div className="text-3xl md:text-4xl font-bold font-mono">
                  {stats?.activeApiKeys}
                </div>
                <p className="text-xs text-muted-foreground mt-1 hidden sm:block">
                  Currently provisioned
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Token Pool */}
      <Card className="border-border" data-testid="card-token-pool">
        <CardHeader className="p-4 md:p-6">
          <CardTitle className="flex items-center gap-2 font-mono uppercase tracking-widest text-sm">
            <Server className="w-4 h-4" />
            Token Pool Health
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 md:px-6 md:pb-6 space-y-4">
          {isPoolLoading ? (
            <div className="space-y-2">
              <div className="h-4 w-full bg-muted animate-pulse rounded" />
              <div className="h-4 w-2/3 bg-muted animate-pulse rounded" />
            </div>
          ) : (
            <>
              <div className="flex justify-between text-sm font-mono mb-2">
                <span className="text-primary">{tokenPool?.healthy} Healthy</span>
                <span className="text-muted-foreground">{tokenPool?.total} Total</span>
              </div>
              <Progress value={poolPercent} className="h-2" />

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4">
                <div className="flex flex-col gap-1 p-3 bg-muted/50 rounded border border-border">
                  <span className="text-xs text-muted-foreground font-mono">Exhausted</span>
                  <span className="text-lg font-bold font-mono text-destructive flex items-center gap-2">
                    {tokenPool?.exhausted}
                    {tokenPool?.exhausted && tokenPool.exhausted > 0 ? (
                      <XCircle className="w-4 h-4" />
                    ) : null}
                  </span>
                </div>
                <div className="flex flex-col gap-1 p-3 bg-muted/50 rounded border border-border">
                  <span className="text-xs text-muted-foreground font-mono">Rotations</span>
                  <span className="text-lg font-bold font-mono">{tokenPool?.rotationCount}</span>
                </div>
                <div className="flex flex-col gap-1 p-3 bg-muted/50 rounded border border-border col-span-2 sm:col-span-1">
                  <span className="text-xs text-muted-foreground font-mono">Last Refresh</span>
                  <span className="text-sm font-mono truncate">
                    {tokenPool?.lastRefreshed
                      ? new Date(tokenPool.lastRefreshed).toLocaleTimeString()
                      : "N/A"}
                  </span>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
