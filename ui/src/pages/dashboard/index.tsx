import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Database, Plus, Clock } from "lucide-react";
import { DeleteConnectionButton } from "@/components/delete-connection-button";

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
    return <p className="text-muted-foreground">Loading connections…</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <Link to="/dashboard/connect">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Connect Database
          </Button>
        </Link>
      </div>

      {conns.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Database className="h-12 w-12 text-muted-foreground/50" />
            <h2 className="mt-4 text-lg font-medium">No databases connected</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect your MongoDB to start querying with AI agents.
            </p>
            <Link to="/dashboard/connect" className="mt-4">
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Connect Database
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {conns.map((conn) => (
            <Link key={conn.id} to={`/dashboard/connections/${conn.id}/schema`}>
              <Card className="transition-colors hover:border-primary/50">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{conn.name}</CardTitle>
                  <div className="flex items-center gap-2">
                    <SyncBadge status={conn.syncStatus} />
                    <DeleteConnectionButton
                      connectionId={conn.id}
                      connectionName={conn.name}
                      onDeleted={fetchConnections}
                    />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {conn.lastSyncAt
                      ? `Last sync: ${new Date(conn.lastSyncAt).toLocaleString()}`
                      : "Never synced"}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function SyncBadge({ status }: { status: string }) {
  const variant = {
    IDLE: "secondary",
    SYNCING: "default",
    COMPLETED: "default",
    FAILED: "destructive",
  }[status] as "secondary" | "default" | "destructive";

  return <Badge variant={variant}>{status.toLowerCase()}</Badge>;
}
