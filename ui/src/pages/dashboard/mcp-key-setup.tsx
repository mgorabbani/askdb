import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CopyButton } from "@/components/copy-button";
import { Key } from "lucide-react";

interface ApiKeyInfo {
  id: string;
  prefix: string;
  label: string | null;
  createdAt: string;
}

export default function McpKeySetupPage() {
  const { keyId } = useParams<{ keyId: string }>();
  const [keyInfo, setKeyInfo] = useState<ApiKeyInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [mcpUrl, setMcpUrl] = useState("http://localhost:3001/mcp");

  useEffect(() => {
    async function fetchKey() {
      const [keysRes, configRes] = await Promise.all([
        fetch("/api/keys"),
        fetch("/api/mcp/config"),
      ]);

      if (keysRes.ok) {
        const keys: ApiKeyInfo[] = await keysRes.json();
        const found = keys.find((k) => k.id === keyId);
        setKeyInfo(found ?? null);
      }

      if (configRes.ok) {
        const config = await configRes.json() as { mcpUrl?: string };
        if (typeof config.mcpUrl === "string" && config.mcpUrl) {
          setMcpUrl(config.mcpUrl);
        }
      }

      setLoading(false);
    }
    fetchKey();
  }, [keyId]);

  if (loading) return <p className="text-muted-foreground">Loading...</p>;
  if (!keyInfo) return <p className="text-muted-foreground">API key not found.</p>;

  const claudeDesktopConfig = JSON.stringify(
    {
      mcpServers: {
        askdb: {
          url: mcpUrl,
          headers: { Authorization: "Bearer <YOUR_API_KEY>" },
        },
      },
    },
    null,
    2
  );

  const chatgptConfig = JSON.stringify(
    {
      type: "mcp",
      server_label: "askdb",
      server_url: mcpUrl,
      headers: { Authorization: "Bearer <YOUR_API_KEY>" },
    },
    null,
    2
  );

  const cursorConfig = JSON.stringify(
    {
      mcpServers: {
        askdb: {
          url: mcpUrl,
          headers: { Authorization: "Bearer <YOUR_API_KEY>" },
        },
      },
    },
    null,
    2
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">MCP Setup</h1>
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-muted-foreground" />
          <Badge variant="outline" className="font-mono">
            {keyInfo.prefix}
          </Badge>
          {keyInfo.label && (
            <span className="text-sm text-muted-foreground">{keyInfo.label}</span>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connection Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md bg-muted p-3">
            <div>
              <p className="text-xs font-medium text-muted-foreground">MCP Endpoint</p>
              <code className="text-sm">{mcpUrl}</code>
            </div>
            <CopyButton text={mcpUrl} />
          </div>
          <div className="flex items-center justify-between rounded-md bg-muted p-3">
            <div>
              <p className="text-xs font-medium text-muted-foreground">API Key Prefix</p>
              <code className="text-sm">{keyInfo.prefix}</code>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Replace <code>&lt;YOUR_API_KEY&gt;</code> in the configs below with your full API key (shown once at creation).
          </p>
        </CardContent>
      </Card>

      <Tabs defaultValue={0}>
        <TabsList>
          <TabsTrigger value={0}>Claude Desktop</TabsTrigger>
          <TabsTrigger value={1}>ChatGPT</TabsTrigger>
          <TabsTrigger value={2}>Cursor</TabsTrigger>
        </TabsList>

        <TabsContent value={0}>
          <ConfigSnippet
            title="Claude Desktop"
            description="Add this to your Claude Desktop config file (claude_desktop_config.json):"
            config={claudeDesktopConfig}
          />
        </TabsContent>
        <TabsContent value={1}>
          <ConfigSnippet
            title="ChatGPT"
            description="Add this MCP server configuration in ChatGPT settings:"
            config={chatgptConfig}
          />
        </TabsContent>
        <TabsContent value={2}>
          <ConfigSnippet
            title="Cursor"
            description="Add this to your Cursor MCP settings (.cursor/mcp.json):"
            config={cursorConfig}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ConfigSnippet({
  title,
  description,
  config,
}: {
  title: string;
  description: string;
  config: string;
}) {
  return (
    <Card className="mt-3">
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent>
        <div className="relative">
          <pre className="overflow-x-auto rounded-md bg-muted p-4 font-mono text-xs">
            {config}
          </pre>
          <div className="absolute right-2 top-2">
            <CopyButton text={config} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
