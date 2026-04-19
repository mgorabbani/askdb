import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronDown, ChevronRight, ShieldAlert, RefreshCw, Loader2, AlertTriangle, Pencil, Check, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { DeleteConnectionButton } from "@/components/delete-connection-button";

interface SchemaColumn {
  id: string;
  name: string;
  fieldType: string;
  sampleValue: string | null;
  isVisible: boolean;
  piiConfidence: string;
}

interface SchemaTable {
  id: string;
  name: string;
  docCount: number;
  isVisible: boolean;
  columns: SchemaColumn[];
}

interface SyncStatus {
  syncStatus: string;
  syncError: string | null;
  lastSyncAt: string | null;
  sandbox: { running: boolean; port: number } | null;
}

interface ConnectionMeta {
  id: string;
  name: string;
  description: string | null;
  dbType: string;
}

export default function SchemaBrowserPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [tables, setTables] = useState<SchemaTable[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [meta, setMeta] = useState<ConnectionMeta | null>(null);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [savingDescription, setSavingDescription] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSchema = useCallback(async () => {
    if (!id) return;
    const res = await fetch(`/api/connections/${id}/schema`);
    if (res.ok) setTables(await res.json());
    setLoading(false);
  }, [id]);

  const fetchMeta = useCallback(async () => {
    if (!id) return;
    const res = await fetch(`/api/connections/${id}`);
    if (res.ok) {
      const data = await res.json();
      setMeta({
        id: data.id,
        name: data.name,
        description: data.description ?? null,
        dbType: data.dbType,
      });
    }
  }, [id]);

  async function saveDescription() {
    if (!id) return;
    setSavingDescription(true);
    const res = await fetch(`/api/connections/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: descriptionDraft.trim() || null }),
    });
    setSavingDescription(false);
    if (res.ok) {
      const data = await res.json();
      setMeta((prev) =>
        prev ? { ...prev, description: data.description ?? null } : prev
      );
      setEditingDescription(false);
    }
  }

  const fetchStatus = useCallback(async () => {
    if (!id) return;
    const res = await fetch(`/api/connections/${id}/status`);
    if (res.ok) {
      const data: SyncStatus = await res.json();
      setSyncStatus(data);
      if (data.syncStatus === "SYNCING") {
        setSyncing(true);
      } else if (syncing && (data.syncStatus === "COMPLETED" || data.syncStatus === "FAILED")) {
        setSyncing(false);
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        fetchSchema();
      }
    }
  }, [id, syncing, fetchSchema]);

  useEffect(() => {
    fetchSchema();
    fetchStatus();
    fetchMeta();
  }, [fetchSchema, fetchStatus, fetchMeta]);

  useEffect(() => {
    if (syncing && !pollRef.current) {
      pollRef.current = setInterval(fetchStatus, 2000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [syncing, fetchStatus]);

  async function triggerSync() {
    if (!id) return;
    setSyncing(true);
    const res = await fetch(`/api/connections/${id}/sync`, { method: "POST" });
    if (res.ok) fetchStatus();
    else setSyncing(false);
  }

  function toggleExpand(tableId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tableId)) next.delete(tableId);
      else next.add(tableId);
      return next;
    });
  }

  async function toggleTableVisibility(tableId: string, current: boolean) {
    if (!id) return;
    setTables((prev) =>
      prev.map((t) => (t.id === tableId ? { ...t, isVisible: !current } : t))
    );

    const res = await fetch(`/api/connections/${id}/schema/tables/${tableId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isVisible: !current }),
    });

    if (!res.ok) {
      setTables((prev) =>
        prev.map((t) => (t.id === tableId ? { ...t, isVisible: current } : t))
      );
    }
  }

  async function toggleColumnVisibility(columnId: string, tableId: string, current: boolean) {
    if (!id) return;
    setTables((prev) =>
      prev.map((t) =>
        t.id === tableId
          ? {
              ...t,
              columns: t.columns.map((c) =>
                c.id === columnId ? { ...c, isVisible: !current } : c
              ),
            }
          : t
      )
    );

    const res = await fetch(`/api/connections/${id}/schema/columns/${columnId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isVisible: !current }),
    });

    if (!res.ok) {
      setTables((prev) =>
        prev.map((t) =>
          t.id === tableId
            ? {
                ...t,
                columns: t.columns.map((c) =>
                  c.id === columnId ? { ...c, isVisible: current } : c
                ),
              }
            : t
        )
      );
    }
  }

  if (loading) return <p className="text-muted-foreground">Loading schema...</p>;

  if (tables.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
          <p className="text-muted-foreground">No collections found. Sync your database first.</p>
          <Button onClick={triggerSync} disabled={syncing}>
            {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {syncing ? "Syncing..." : "Sync Now"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const sorted = [...tables].sort((a, b) => {
    if (a.isVisible === b.isVisible) return a.name.localeCompare(b.name);
    return a.isVisible ? -1 : 1;
  });

  const visibleCount = tables.filter((t) => t.isVisible).length;
  const piiCandidates = tables.reduce(
    (n, t) =>
      n +
      t.columns.filter(
        (c) => (c.piiConfidence === "HIGH" || c.piiConfidence === "MEDIUM") && c.isVisible
      ).length,
    0
  );

  function hideAllPii() {
    tables.forEach((t) => {
      t.columns.forEach((c) => {
        if ((c.piiConfidence === "HIGH" || c.piiConfidence === "MEDIUM") && c.isVisible) {
          toggleColumnVisibility(c.id, t.id, true);
        }
      });
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {meta?.dbType ?? "Schema"}
          </p>
          <h1 className="mt-0.5 truncate text-2xl font-semibold tracking-tight">
            {meta?.name ?? "Schema Browser"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tables.length} collections · {visibleCount} visible to the agent
          </p>
          {meta && (
            <div className="mt-3 max-w-2xl">
              {editingDescription ? (
                <div className="flex items-start gap-2">
                  <Input
                    autoFocus
                    value={descriptionDraft}
                    onChange={(e) => setDescriptionDraft(e.target.value)}
                    placeholder="e.g. Customer orders and subscriptions"
                    disabled={savingDescription}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        saveDescription();
                      } else if (e.key === "Escape") {
                        setEditingDescription(false);
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={saveDescription}
                    disabled={savingDescription}
                  >
                    {savingDescription ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditingDescription(false)}
                    disabled={savingDescription}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  className="group flex items-start gap-2 rounded-md text-left text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setDescriptionDraft(meta.description ?? "");
                    setEditingDescription(true);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    {meta.description || (
                      <span className="italic">
                        Add a one-line description so agents know what this database is for…
                      </span>
                    )}
                  </span>
                  <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={triggerSync} disabled={syncing}>
            {syncing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {syncing ? "Syncing..." : "Sync Now"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={hideAllPii}
            disabled={piiCandidates === 0}
          >
            <ShieldAlert className="mr-2 h-4 w-4" />
            Hide PII
            {piiCandidates > 0 && (
              <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-[10px]">
                {piiCandidates}
              </Badge>
            )}
          </Button>
        </div>
      </div>

      {(syncStatus?.sandbox || syncStatus) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/30 px-4 py-2.5 text-xs">
          {syncStatus?.sandbox && (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  syncStatus.sandbox.running ? "bg-emerald-500" : "bg-red-500"
                }`}
              />
              {syncStatus.sandbox.running ? "Container healthy" : "Container down"}
            </div>
          )}
          {syncStatus && <SyncStatusBadge status={syncStatus.syncStatus} />}
          {syncStatus?.lastSyncAt && (
            <span className="text-muted-foreground">
              Last sync {new Date(syncStatus.lastSyncAt).toLocaleString()}
            </span>
          )}
        </div>
      )}

      <Card className="overflow-hidden p-0">
        <ul className="divide-y">
          {sorted.map((table) => {
            const isOpen = expanded.has(table.id);
            return (
              <li key={table.id} className={table.isVisible ? "" : "opacity-60"}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-muted/40"
                  onClick={() => toggleExpand(table.id)}
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className="truncate text-sm font-medium">{table.name}</span>
                  <Badge variant="secondary" className="font-normal">
                    {table.docCount.toLocaleString()} docs
                  </Badge>
                  <div
                    className="ml-auto flex items-center"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                    }}
                  >
                    <Switch
                      checked={table.isVisible}
                      onCheckedChange={() => toggleTableVisibility(table.id, table.isVisible)}
                    />
                  </div>
                </button>

                {isOpen && (
                  <div className="overflow-x-auto border-t bg-muted/20 px-5 py-3">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="h-8">Field</TableHead>
                          <TableHead className="h-8">Type</TableHead>
                          <TableHead className="h-8">Sample</TableHead>
                          <TableHead className="h-8">PII</TableHead>
                          <TableHead className="h-8 text-right">Visible</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {table.columns.map((col) => (
                          <TableRow
                            key={col.id}
                            className={col.isVisible ? "" : "opacity-50"}
                          >
                            <TableCell className="font-mono text-xs">{col.name}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="font-mono text-[10px]">
                                {col.fieldType}
                              </Badge>
                            </TableCell>
                            <TableCell className="max-w-[240px] truncate text-xs text-muted-foreground">
                              {col.sampleValue || "—"}
                            </TableCell>
                            <TableCell>
                              <PiiBadge confidence={col.piiConfidence} />
                            </TableCell>
                            <TableCell className="text-right">
                              <Switch
                                checked={col.isVisible}
                                onCheckedChange={() =>
                                  toggleColumnVisibility(col.id, table.id, col.isVisible)
                                }
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {meta && (
        <Card className="gap-0 border-destructive/30 bg-destructive/5 py-0">
          <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">Danger zone</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Delete this connection, its sandbox container, schema cache,
                and all related data. This action cannot be undone.
              </p>
            </div>
            <DeleteConnectionButton
              connectionId={meta.id}
              connectionName={meta.name}
              onDeleted={() => navigate("/dashboard")}
              render={
                <Button
                  variant="destructive"
                  size="sm"
                  className="w-full sm:w-auto"
                  onClick={(e: React.MouseEvent) => e.preventDefault()}
                />
              }
            >
              Delete connection
            </DeleteConnectionButton>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SyncStatusBadge({ status }: { status: string }) {
  const variant = {
    IDLE: "secondary",
    SYNCING: "default",
    COMPLETED: "default",
    FAILED: "destructive",
  }[status] as "secondary" | "default" | "destructive";

  return <Badge variant={variant}>{status.toLowerCase()}</Badge>;
}

function PiiBadge({ confidence }: { confidence: string }) {
  if (confidence === "NONE") return null;

  const colors: Record<string, string> = {
    HIGH: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    MEDIUM: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
    LOW: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  };
  const color = colors[confidence] ?? "";

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {confidence}
    </span>
  );
}
