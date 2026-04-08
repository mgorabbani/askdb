"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CopyButton } from "@/components/copy-button";
import { Key, Plus, ExternalLink } from "lucide-react";

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

  const mcpUrl =
    typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.hostname}:3001/mcp`
      : "http://localhost:3001/mcp";

  useEffect(() => {
    async function fetchKeys() {
      const res = await fetch("/api/keys");
      if (res.ok) {
        const data: ApiKey[] = await res.json();
        setKeys(data);
        if (data.length > 0) setSelectedKey(data[0].prefix);
      }
      setLoading(false);
    }
    fetchKeys();
  }, []);

  if (loading) {
    return <p className="text-muted-foreground">Loading...</p>;
  }

  if (keys.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">MCP Setup</h1>
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-4 py-12">
            <Key className="h-12 w-12 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              Create an API key first to get your MCP configuration.
            </p>
            <Link href="/dashboard/keys">
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Create API Key
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const keyPlaceholder = selectedKey ? `${selectedKey}...` : "<YOUR_API_KEY>";

  const configs = {
    "Claude Desktop": {
      description: "Add to ~/.claude/claude_desktop_config.json",
      config: JSON.stringify(
        {
          mcpServers: {
            askdb: {
              type: "http",
              url: mcpUrl,
              headers: {
                Authorization: `Bearer ${keyPlaceholder}`,
              },
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
            headers: {
              Authorization: `Bearer ${keyPlaceholder}`,
            },
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
              headers: {
                Authorization: `Bearer ${keyPlaceholder}`,
              },
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
          headers: {
            Authorization: `Bearer ${keyPlaceholder}`,
          },
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
              headers: {
                Authorization: `Bearer ${keyPlaceholder}`,
              },
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
      <h1 className="text-2xl font-semibold">MCP Setup</h1>

      {/* Individual fields for copy-paste */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connection Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <CopyField label="MCP Endpoint" value={mcpUrl} />
          <CopyField label="Transport" value="streamable-http" />
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              API Key
            </p>
            {keys.length > 1 ? (
              <div className="space-y-2">
                {keys.map((k) => (
                  <div
                    key={k.id}
                    className="flex items-center justify-between rounded-md bg-muted p-3"
                  >
                    <div>
                      <code className="text-sm">{k.prefix}...</code>
                      {k.label && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {k.label}
                        </span>
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
            ) : (
              <div className="flex items-center justify-between rounded-md bg-muted p-3">
                <code className="text-sm">{keys[0].prefix}...</code>
                {keys[0].label && (
                  <span className="text-xs text-muted-foreground">
                    {keys[0].label}
                  </span>
                )}
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Replace <code>{keyPlaceholder}</code> with your full API key
              (shown once at creation).{" "}
              <Link
                href="/dashboard/keys"
                className="inline-flex items-center gap-1 underline"
              >
                Manage keys
                <ExternalLink className="h-3 w-3" />
              </Link>
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Full configs per client */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Copy-Paste Configuration
          </CardTitle>
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
                    <pre className="overflow-x-auto rounded-md bg-muted p-4 font-mono text-xs leading-relaxed">
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
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-muted p-3">
      <div>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <code className="text-sm">{value}</code>
      </div>
      <CopyButton text={value} />
    </div>
  );
}
