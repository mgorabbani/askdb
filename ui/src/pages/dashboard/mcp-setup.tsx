import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CopyButton } from "@/components/copy-button";
import { Plus, ExternalLink } from "lucide-react";

interface ApiKey {
  id: string;
  prefix: string;
  label: string | null;
  createdAt: string;
}

export default function McpSetupPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mcpUrl, setMcpUrl] = useState("http://localhost:3001/mcp");

  useEffect(() => {
    async function fetchSetupData() {
      const [keysRes, configRes] = await Promise.all([
        fetch("/api/keys"),
        fetch("/api/mcp/config"),
      ]);

      if (keysRes.ok) {
        const data: ApiKey[] = await keysRes.json();
        setKeys(data);
        if (data.length > 0 && data[0]) setSelectedKey(data[0].prefix);
      }

      if (configRes.ok) {
        const data = await configRes.json() as { mcpUrl?: string };
        if (typeof data.mcpUrl === "string" && data.mcpUrl) {
          setMcpUrl(data.mcpUrl);
        }
      }

      setLoading(false);
    }
    fetchSetupData();
  }, []);

  if (loading) {
    return <p className="text-muted-foreground">Loading...</p>;
  }

  const keyPlaceholder = selectedKey ? `${selectedKey}...` : "<YOUR_API_KEY>";

  const configs: Record<string, { description: string; config: string }> = {
    "Claude Desktop": {
      description: "Add to ~/.claude/claude_desktop_config.json",
      config: JSON.stringify(
        {
          mcpServers: {
            askdb: {
              type: "http",
              url: mcpUrl,
              headers: { Authorization: `Bearer ${keyPlaceholder}` },
            },
          },
        },
        null,
        2
      ),
    },
    "Claude Code": {
      description: "Add to ~/.claude/mcp_servers.json",
      config: JSON.stringify(
        {
          askdb: {
            type: "http",
            url: mcpUrl,
            headers: { Authorization: `Bearer ${keyPlaceholder}` },
          },
        },
        null,
        2
      ),
    },
    Cursor: {
      description: "Add to .cursor/mcp.json in your project",
      config: JSON.stringify(
        {
          mcpServers: {
            askdb: {
              url: mcpUrl,
              headers: { Authorization: `Bearer ${keyPlaceholder}` },
            },
          },
        },
        null,
        2
      ),
    },
    ChatGPT: {
      description: "Add as MCP server in ChatGPT settings",
      config: JSON.stringify(
        {
          type: "mcp",
          server_label: "askdb",
          server_url: mcpUrl,
          headers: { Authorization: `Bearer ${keyPlaceholder}` },
        },
        null,
        2
      ),
    },
    Windsurf: {
      description: "Add to ~/.codeium/windsurf/mcp_config.json",
      config: JSON.stringify(
        {
          mcpServers: {
            askdb: {
              serverUrl: mcpUrl,
              headers: { Authorization: `Bearer ${keyPlaceholder}` },
            },
          },
        },
        null,
        2
      ),
    },
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">MCP Setup</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect askdb to Claude via OAuth or use an API key for clients that require fixed
          headers.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Connection Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <CopyField label="MCP Endpoint" value={mcpUrl} />
            <CopyField label="Transport" value="streamable-http" />
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Claude Web</p>
              <p className="text-sm text-foreground">
                In Claude, add a custom connector, paste the MCP endpoint, and finish the OAuth
                approval flow in your browser. No API key header is needed.
              </p>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">API Key</p>
              {keys.length > 1 ? (
                <div className="space-y-2">
                  {keys.map((k) => (
                    <div
                      key={k.id}
                      className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 p-3"
                    >
                      <div className="min-w-0">
                        <code className="truncate text-sm">{k.prefix}…</code>
                        {k.label && (
                          <span className="ml-2 text-xs text-muted-foreground">{k.label}</span>
                        )}
                      </div>
                      <Button
                        variant={selectedKey === k.prefix ? "default" : "outline"}
                        size="sm"
                        onClick={() => setSelectedKey(k.prefix)}
                      >
                        {selectedKey === k.prefix ? "Selected" : "Use this"}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : keys[0] ? (
                <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 p-3">
                  <code className="truncate text-sm">{keys[0].prefix}…</code>
                  {keys[0].label && (
                    <span className="shrink-0 text-xs text-muted-foreground">{keys[0].label}</span>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed bg-muted/30 p-3 text-sm text-muted-foreground">
                  Claude web works over OAuth without an API key. Create a key only for local MCP
                  clients such as Claude Code, Cursor, or ChatGPT.
                </div>
              )}
              {keys.length > 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Replace <code className="rounded bg-muted px-1 py-0.5">{keyPlaceholder}</code>{" "}
                  with your full key (shown once at creation).{" "}
                  <Link
                    to="/dashboard/keys"
                    className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    Manage keys <ExternalLink className="h-3 w-3" />
                  </Link>
                </p>
              ) : (
                <Link
                  to="/dashboard/keys"
                  className="inline-flex items-center gap-2 text-sm font-medium underline-offset-4 hover:underline"
                >
                  <Plus className="h-4 w-4" />
                  Create an API key for local clients
                </Link>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Copy-Paste Configuration</CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue={0}>
              <TabsList className="flex-wrap">
                {Object.keys(configs).map((name, i) => (
                  <TabsTrigger key={name} value={i}>
                    {name}
                  </TabsTrigger>
                ))}
              </TabsList>
              {Object.entries(configs).map(([name, { description, config }], i) => (
                <TabsContent key={name} value={i}>
                  <div className="mt-3 space-y-2">
                    <p className="text-xs text-muted-foreground">{description}</p>
                    <div className="relative">
                      <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
                        {config}
                      </pre>
                      <div className="absolute right-2 top-2">
                        <CopyButton text={config} />
                      </div>
                    </div>
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 p-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <code className="truncate text-sm">{value}</code>
      </div>
      <CopyButton text={value} />
    </div>
  );
}
