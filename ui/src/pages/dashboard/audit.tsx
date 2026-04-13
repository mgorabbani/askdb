import { Fragment, useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
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
import { ChevronDown, ChevronRight, ChevronLeft, ScrollText } from "lucide-react";

interface AuditLog {
  id: string;
  action: string;
  query: string | null;
  collection: string | null;
  executionMs: number;
  docCount: number;
  createdAt: string;
  connectionId: string;
  connectionName: string;
}

interface AuditResponse {
  data: AuditLog[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [filterConnection, setFilterConnection] = useState("");
  const [filterAction, setFilterAction] = useState("");
  const [connections, setConnections] = useState<{ id: string; name: string }[]>([]);
  const [actions, setActions] = useState<string[]>([]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "50" });
    if (filterConnection) params.set("connectionId", filterConnection);
    if (filterAction) params.set("action", filterAction);

    const res = await fetch(`/api/audit?${params}`);
    if (res.ok) {
      const data: AuditResponse = await res.json();
      setLogs(data.data);
      setTotalPages(data.totalPages);
      setTotal(data.total);

      if (connections.length === 0 && data.data.length > 0) {
        const uniqueConns = new Map<string, string>();
        const uniqueActions = new Set<string>();
        data.data.forEach((log) => {
          uniqueConns.set(log.connectionId, log.connectionName);
          uniqueActions.add(log.action);
        });
        setConnections(
          Array.from(uniqueConns.entries()).map(([id, name]) => ({ id, name }))
        );
        setActions(Array.from(uniqueActions));
      }
    }
    setLoading(false);
  }, [page, filterConnection, filterAction, connections.length]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  function toggleRow(id: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function truncate(text: string | null, len: number) {
    if (!text) return "---";
    return text.length > len ? text.slice(0, len) + "..." : text;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Audit Log</h1>
        <span className="text-sm text-muted-foreground">{total} total entries</span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          value={filterConnection}
          onChange={(e) => {
            setFilterConnection(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All connections</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <select
          className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          value={filterAction}
          onChange={(e) => {
            setFilterAction(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-muted-foreground">Loading audit logs...</p>
      ) : logs.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <ScrollText className="h-12 w-12 text-muted-foreground/50" />
            <p className="mt-4 text-muted-foreground">No audit logs yet.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Connection</TableHead>
                  <TableHead>Collection</TableHead>
                  <TableHead>Query</TableHead>
                  <TableHead className="text-right">Time (ms)</TableHead>
                  <TableHead className="text-right">Docs</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <Fragment key={log.id}>
                    <TableRow className="cursor-pointer" onClick={() => toggleRow(log.id)}>
                      <TableCell>
                        {expandedRows.has(log.id) ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(log.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{log.action}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">{log.connectionName}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {log.collection || "---"}
                      </TableCell>
                      <TableCell className="max-w-xs text-xs text-muted-foreground">
                        {truncate(log.query, 60)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {log.executionMs}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {log.docCount}
                      </TableCell>
                    </TableRow>
                    {expandedRows.has(log.id) && (
                      <TableRow>
                        <TableCell colSpan={8}>
                          <div className="rounded-md bg-muted p-3">
                            <p className="mb-1 text-xs font-medium text-muted-foreground">
                              Full Query
                            </p>
                            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">
                              {log.query || "No query recorded"}
                            </pre>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft className="mr-1 h-4 w-4" />
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
