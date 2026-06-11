import { useEffect } from "react";
import { useGetStats, getGetStatsQueryKey, useGetTokenPoolStatus, getGetTokenPoolStatusQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Activity, Server, Key, Zap, CheckCircle2, XCircle, Clock } from "lucide-react";
import { Link } from "wouter";

export default function Dashboard() {
  const queryClient = useQueryClient();

  const { data: stats, isLoading: isStatsLoading } = useGetStats({
    query: {
      queryKey: getGetStatsQueryKey()
    }
  });

  const { data: tokenPool, isLoading: isPoolLoading } = useGetTokenPoolStatus({
    query: {
      queryKey: getGetTokenPoolStatusQueryKey()
    }
  });

  useEffect(() => {
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetTokenPoolStatusQueryKey() });
    }, 30000);
    return () => clearInterval(interval);
  }, [queryClient]);

  return (
    <div className="flex-1 overflow-auto p-8 space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold tracking-tight">System Overview</h1>
        <div className="flex gap-4">
          <Link href="/playground" className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2 font-mono uppercase tracking-wider">
            &gt; Test_Connection
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-widest font-mono">Success Rate</CardTitle>
            <Activity className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            {isStatsLoading ? (
              <div className="h-8 w-24 bg-muted animate-pulse rounded" />
            ) : (
              <>
                <div className="text-4xl font-bold font-mono text-primary">
                  {stats?.successRate.toFixed(1)}%
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {stats?.successRequests} successful / {stats?.totalRequests} total
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-widest font-mono">Reqs Today</CardTitle>
            <Zap className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            {isStatsLoading ? (
              <div className="h-8 w-24 bg-muted animate-pulse rounded" />
            ) : (
              <>
                <div className="text-4xl font-bold font-mono">
                  {stats?.requestsToday.toLocaleString()}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {stats?.requestsThisHour.toLocaleString()} this hour
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-widest font-mono">Avg Latency</CardTitle>
            <Clock className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            {isStatsLoading ? (
              <div className="h-8 w-24 bg-muted animate-pulse rounded" />
            ) : (
              <>
                <div className="text-4xl font-bold font-mono">
                  {stats?.averageResponseTime}ms
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Across all models
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-widest font-mono">Active Keys</CardTitle>
            <Key className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            {isStatsLoading ? (
              <div className="h-8 w-24 bg-muted animate-pulse rounded" />
            ) : (
              <>
                <div className="text-4xl font-bold font-mono">
                  {stats?.activeApiKeys}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Currently provisioned
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-mono uppercase tracking-widest text-sm">
              <Server className="w-4 h-4" />
              Token Pool Health
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isPoolLoading ? (
              <div className="space-y-2">
                <div className="h-4 w-full bg-muted animate-pulse rounded" />
                <div className="h-4 w-2/3 bg-muted animate-pulse rounded" />
              </div>
            ) : (
              <>
                <div className="flex justify-between text-sm font-mono mb-2">
                  <span className="text-primary">{tokenPool?.healthy} Healthy</span>
                  <span className="text-muted-foreground">{tokenPool?.total} Total Tokens</span>
                </div>
                <Progress value={tokenPool ? (tokenPool.healthy / tokenPool.total) * 100 : 0} className="h-2" />
                
                <div className="grid grid-cols-2 gap-4 mt-6">
                  <div className="flex flex-col gap-1 p-3 bg-muted/50 rounded border border-border">
                    <span className="text-xs text-muted-foreground font-mono">Exhausted</span>
                    <span className="text-lg font-bold font-mono text-destructive flex items-center gap-2">
                      {tokenPool?.exhausted}
                      {tokenPool?.exhausted && tokenPool.exhausted > 0 ? <XCircle className="w-4 h-4" /> : null}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 p-3 bg-muted/50 rounded border border-border">
                    <span className="text-xs text-muted-foreground font-mono">Rotations</span>
                    <span className="text-lg font-bold font-mono flex items-center gap-2">
                      {tokenPool?.rotationCount}
                    </span>
                  </div>
                </div>
                
                <div className="text-xs text-muted-foreground mt-4 font-mono">
                  <div>Last refresh: {tokenPool?.lastRefreshed ? new Date(tokenPool.lastRefreshed).toLocaleString() : 'N/A'}</div>
                  {tokenPool?.nextRefresh && (
                    <div>Next scheduled: {new Date(tokenPool.nextRefresh).toLocaleString()}</div>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
