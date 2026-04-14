import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Database,
  Plus,
  Clock,
  ArrowUpRight,
  Activity,
  CircleCheck,
  CircleAlert,
  Loader2,
} from "lucide-react";
interface Connection {
  id: string;
  name: string;
  dbType: string;
  syncStatus: string;
  lastSyncAt: string | null;
  sandboxPort: number | null;
  createdAt: string;
}

export default function DashboardPage() {
  const [conns, setConns] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchConnections = useCallback(async () => {
    const res = await fetch("/api/connections");
    if (res.ok) {
      setConns(await res.json());
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading connections…
      </div>
    );
  }

  const healthy = conns.filter((c) => c.syncStatus === "COMPLETED").length;
  const syncing = conns.filter((c) => c.syncStatus === "SYNCING").length;
  const failed = conns.filter((c) => c.syncStatus === "FAILED").length;
  const lastSyncedAt = conns
    .map((c) => c.lastSyncAt)
    .filter((x): x is string => Boolean(x))
    .sort()
    .pop();

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Databases connected to askdb. Tap a card to browse its schema.
          </p>
        </div>
        <Link to="/dashboard/connect" className="shrink-0">
          <Button className="w-full sm:w-auto">
            <Plus className="mr-2 h-4 w-4" />
            Connect Database
          </Button>
        </Link>
      </div>

      {conns.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Database className="h-6 w-6" />
            </div>
            <h2 className="mt-5 text-base font-semibold">No databases connected</h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Connect your first database to let AI agents query it through the
              askdb MCP server.
            </p>
            <Link to="/dashboard/connect" className="mt-5">
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Connect Database
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              icon={<Database className="h-4 w-4" />}
              label="Connections"
              value={conns.length.toString()}
              hint={conns.length === 1 ? "1 database" : `${conns.length} databases`}
            />
            <StatCard
              icon={<CircleCheck className="h-4 w-4 text-emerald-500" />}
              label="Healthy"
              value={healthy.toString()}
              hint={healthy === conns.length ? "All systems normal" : "Some need attention"}
            />
            <StatCard
              icon={<Activity className="h-4 w-4 text-blue-500" />}
              label="Syncing"
              value={syncing.toString()}
              hint={syncing > 0 ? "In progress" : "Idle"}
            />
            <StatCard
              icon={<Clock className="h-4 w-4 text-muted-foreground" />}
              label="Last sync"
              value={lastSyncedAt ? timeAgo(lastSyncedAt) : "—"}
              hint={lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : "Never synced"}
            />
          </div>

          <div>
            <div className="mb-3 flex items-end justify-between">
              <h2 className="text-sm font-semibold text-muted-foreground">
                Your databases
              </h2>
              {failed > 0 && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
                  <CircleAlert className="h-3.5 w-3.5" />
                  {failed} sync {failed === 1 ? "error" : "errors"}
                </span>
              )}
            </div>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {conns.map((conn) => (
                <ConnectionCard key={conn.id} conn={conn} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card className="gap-0 py-4">
      <CardContent className="px-4">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</div>
      </CardContent>
    </Card>
  );
}

function ConnectionCard({ conn }: { conn: Connection }) {
  const theme = dbTheme(conn.dbType);
  return (
    <Card className="group gap-0 overflow-hidden py-0 transition-all hover:border-primary/40 hover:shadow-sm">
      <Link
        to={`/dashboard/connections/${conn.id}/schema`}
        className="block p-5"
      >
        <div className="flex items-start gap-3">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${theme.bg} ${theme.fg}`}
          >
            <Database className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold">{conn.name}</h3>
            <p className="mt-0.5 text-xs uppercase tracking-wide text-muted-foreground">
              {conn.dbType}
            </p>
          </div>
          <SyncPill status={conn.syncStatus} />
        </div>

        <div className="mt-5 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Clock className="h-3 w-3" />
            {conn.lastSyncAt
              ? `Synced ${timeAgo(conn.lastSyncAt)}`
              : "Never synced"}
          </span>
          <span className="inline-flex items-center gap-1 font-medium text-foreground/70 transition-colors group-hover:text-primary">
            Browse schema
            <ArrowUpRight className="h-3 w-3" />
          </span>
        </div>
      </Link>
    </Card>
  );
}

function SyncPill({ status }: { status: string }) {
  const s = status.toUpperCase();
  const config = {
    COMPLETED: {
      label: "Healthy",
      dot: "bg-emerald-500",
      text: "text-emerald-600 dark:text-emerald-400",
      bg: "bg-emerald-500/10",
    },
    SYNCING: {
      label: "Syncing",
      dot: "bg-blue-500 animate-pulse",
      text: "text-blue-600 dark:text-blue-400",
      bg: "bg-blue-500/10",
    },
    IDLE: {
      label: "Idle",
      dot: "bg-muted-foreground/60",
      text: "text-muted-foreground",
      bg: "bg-muted",
    },
    FAILED: {
      label: "Failed",
      dot: "bg-destructive",
      text: "text-destructive",
      bg: "bg-destructive/10",
    },
  }[s] ?? {
    label: status.toLowerCase(),
    dot: "bg-muted-foreground/60",
    text: "text-muted-foreground",
    bg: "bg-muted",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${config.bg} ${config.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${config.dot}`} />
      {config.label}
    </span>
  );
}

function dbTheme(dbType: string) {
  const t = dbType.toLowerCase();
  if (t.includes("mongo")) return { bg: "bg-emerald-500/10", fg: "text-emerald-600 dark:text-emerald-400" };
  if (t.includes("postgres")) return { bg: "bg-blue-500/10", fg: "text-blue-600 dark:text-blue-400" };
  if (t.includes("mysql") || t.includes("maria")) return { bg: "bg-amber-500/10", fg: "text-amber-600 dark:text-amber-400" };
  if (t.includes("sqlite")) return { bg: "bg-violet-500/10", fg: "text-violet-600 dark:text-violet-400" };
  return { bg: "bg-primary/10", fg: "text-primary" };
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
