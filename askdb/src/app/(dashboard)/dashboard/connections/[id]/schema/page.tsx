"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronDown, ChevronRight, Eye, EyeOff, ShieldAlert, RefreshCw, Loader2 } from "lucide-react";

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

export default function SchemaBrowserPage() {
  const { id } = useParams<{ id: string }>();
  const [tables, setTables] = useState<SchemaTable[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSchema = useCallback(async () => {
    const res = await fetch(`/api/connections/${id}/schema`);
    if (res.ok) {
      setTables(await res.json());
    }
    setLoading(false);
  }, [id]);

  const fetchStatus = useCallback(async () => {
    const res = await fetch(`/api/connections/${id}/status`);
    if (res.ok) {
      const data: SyncStatus = await res.json();
      setSyncStatus(data);
      if (data.syncStatus === "SYNCING") {
        setSyncing(true);
      } else if (syncing && (data.syncStatus === "COMPLETED" || data.syncStatus === "FAILED")) {
        setSyncing(false);
        // Stop polling and refresh schema
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
  }, [fetchSchema, fetchStatus]);

  // Poll while syncing
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
    setSyncing(true);
    const res = await fetch(`/api/connections/${id}/sync`, { method: "POST" });
    if (res.ok) {
      // Start polling
      fetchStatus();
    } else {
      setSyncing(false);
    }
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
    // Optimistic update
    setTables((prev) =>
      prev.map((t) => (t.id === tableId ? { ...t, isVisible: !current } : t))
    );

    const res = await fetch(`/api/connections/${id}/schema/tables/${tableId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isVisible: !current }),
    });

    if (!res.ok) {
      // Revert on failure
      setTables((prev) =>
        prev.map((t) => (t.id === tableId ? { ...t, isVisible: current } : t))
      );
    }
  }

  async function toggleColumnVisibility(
    columnId: string,
    tableId: string,
    current: boolean
  ) {
    // Optimistic update
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

    const res = await fetch(
      `/api/connections/${id}/schema/columns/${columnId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isVisible: !current }),
      }
    );

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

  if (loading) {
    return <p className="text-muted-foreground">Loading schema...</p>;
  }

  if (tables.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
          <p className="text-muted-foreground">
            No collections found. Sync your database first.
          </p>
          <Button onClick={triggerSync} disabled={syncing}>
            {syncing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {syncing ? "Syncing..." : "Sync Now"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Sort: visible first, then hidden
  const sorted = [...tables].sort((a, b) => {
    if (a.isVisible === b.isVisible) return a.name.localeCompare(b.name);
    return a.isVisible ? -1 : 1;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Schema Browser</h1>
        <div className="flex items-center gap-3">
          {/* Container health indicator */}
          {syncStatus?.sandbox && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  syncStatus.sandbox.running ? "bg-green-500" : "bg-red-500"
                }`}
              />
              {syncStatus.sandbox.running ? "Container healthy" : "Container down"}
            </div>
          )}

          {/* Sync status badge */}
          {syncStatus && (
            <SyncStatusBadge status={syncStatus.syncStatus} />
          )}

          {/* Last sync time */}
          {syncStatus?.lastSyncAt && (
            <span className="text-xs text-muted-foreground">
              Last sync: {new Date(syncStatus.lastSyncAt).toLocaleString()}
            </span>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={triggerSync}
            disabled={syncing}
          >
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
            onClick={() => {
              // Hide all PII
              tables.forEach((t) => {
                t.columns.forEach((c) => {
                  if (
                    (c.piiConfidence === "HIGH" || c.piiConfidence === "MEDIUM") &&
                    c.isVisible
                  ) {
                    toggleColumnVisibility(c.id, t.id, true);
                  }
                });
              });
            }}
          >
            <ShieldAlert className="mr-2 h-4 w-4" />
            Hide All PII
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {sorted.map((table) => (
          <Card
            key={table.id}
            className={table.isVisible ? "" : "opacity-60"}
          >
            <CardHeader
              className="cursor-pointer py-3"
              onClick={() => toggleExpand(table.id)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {expanded.has(table.id) ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  <CardTitle className="text-sm font-medium">
                    {table.name}
                  </CardTitle>
                  <Badge variant="secondary" className="text-xs">
                    {table.docCount.toLocaleString()} docs
                  </Badge>
                </div>
                <div
                  className="flex items-center gap-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  {table.isVisible ? (
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                  )}
                  <Switch
                    checked={table.isVisible}
                    onCheckedChange={() =>
                      toggleTableVisibility(table.id, table.isVisible)
                    }
                  />
                </div>
              </div>
            </CardHeader>

            {expanded.has(table.id) && (
              <CardContent className="pt-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Field</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Sample</TableHead>
                      <TableHead>PII</TableHead>
                      <TableHead className="text-right">Visible</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {table.columns.map((col) => (
                      <TableRow
                        key={col.id}
                        className={col.isVisible ? "" : "opacity-50"}
                      >
                        <TableCell className="font-mono text-sm">
                          {col.name}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {col.fieldType}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                          {col.sampleValue || "—"}
                        </TableCell>
                        <TableCell>
                          <PiiBadge confidence={col.piiConfidence} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Switch
                            checked={col.isVisible}
                            onCheckedChange={() =>
                              toggleColumnVisibility(
                                col.id,
                                table.id,
                                col.isVisible
                              )
                            }
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            )}
          </Card>
        ))}
      </div>
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

  const colors = {
    HIGH: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    MEDIUM: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
    LOW: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  }[confidence];

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors}`}>
      {confidence}
    </span>
  );
}
