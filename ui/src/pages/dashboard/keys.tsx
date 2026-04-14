import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Key,
  Plus,
  Copy,
  Check,
  Trash2,
  ShieldCheck,
  ArrowUpRight,
  TriangleAlert,
} from "lucide-react";

interface ApiKey {
  id: string;
  prefix: string;
  label: string | null;
  createdAt: string;
}

export default function KeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    fetchKeys();
  }, []);

  async function fetchKeys() {
    const res = await fetch("/api/keys");
    if (res.ok) setKeys(await res.json());
  }

  async function createKey() {
    setCreating(true);
    const res = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: label || undefined }),
    });

    if (res.ok) {
      const data = await res.json();
      setNewKey(data.key);
      setLabel("");
      fetchKeys();
    }
    setCreating(false);
  }

  async function revokeKey(id: string) {
    await fetch(`/api/keys/${id}`, { method: "DELETE" });
    setRevokingId(null);
    fetchKeys();
  }

  function copyKey() {
    if (newKey) {
      navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">API Keys</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create and manage keys used to authenticate the MCP server.
          </p>
        </div>
        <Dialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) setNewKey(null);
          }}
        >
          <DialogTrigger render={<Button className="w-full sm:w-auto" />}>
            <Plus className="mr-2 h-4 w-4" />
            Create Key
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{newKey ? "Key Created" : "Create API Key"}</DialogTitle>
              <DialogDescription>
                {newKey
                  ? "Copy this key now. It won't be shown again."
                  : "Create a new API key for MCP access."}
              </DialogDescription>
            </DialogHeader>

            {newKey ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
                  <code className="flex-1 break-all text-sm">{newKey}</code>
                  <Button variant="ghost" size="sm" onClick={copyKey}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Store this key somewhere safe. askdb only stores a hash —
                    you won't be able to see it again.
                  </span>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Label (optional)</label>
                  <Input
                    placeholder="e.g. Claude Desktop"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    A short name so you can tell keys apart later.
                  </p>
                </div>
                <Button onClick={createKey} disabled={creating} className="w-full">
                  {creating ? "Creating..." : "Create Key"}
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <Card className="gap-0 border-primary/20 bg-primary/5 py-0">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">How keys work</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Each key authenticates requests to the askdb MCP server. Keep them
              secret — anyone with a key can read any database connected here.
            </p>
          </div>
          <Link
            to="/dashboard/setup"
            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            MCP Setup
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        </CardContent>
      </Card>

      {keys.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Key className="h-6 w-6" />
            </div>
            <div className="space-y-1">
              <p className="text-base font-semibold">No API keys yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Create your first key to start using the askdb MCP server from
                Claude, Cursor, or any MCP-compatible client.
              </p>
            </div>
            <Button className="mt-2" onClick={() => setDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create your first key
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div>
          <div className="mb-3 flex items-end justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground">
              Active keys
            </h2>
            <span className="text-xs text-muted-foreground">
              {keys.length} {keys.length === 1 ? "key" : "keys"}
            </span>
          </div>
          <Card className="overflow-hidden p-0">
            <ul className="divide-y">
              {keys.map((key) => (
                <li
                  key={key.id}
                  className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/40"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Key className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="truncate font-mono text-sm font-medium">
                        {key.prefix}…
                      </code>
                      {key.label ? (
                        <span className="rounded-md border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {key.label}
                        </span>
                      ) : (
                        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                          Unlabeled
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Created {timeAgo(key.createdAt)} ·{" "}
                      {new Date(key.createdAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRevokingId(key.id)}
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Revoke ${key.prefix}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      <Dialog
        open={revokingId !== null}
        onOpenChange={(open) => !open && setRevokingId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke this key?</DialogTitle>
            <DialogDescription>
              Any client using this key will immediately lose access to the MCP
              server. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokingId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => revokingId && revokeKey(revokingId)}
            >
              Revoke key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
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
