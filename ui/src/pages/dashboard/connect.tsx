import { useState, useCallback } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Database } from "lucide-react";

interface ParsedConnection {
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  options: string;
}

function parseMongoUri(uri: string): ParsedConnection {
  const result: ParsedConnection = {
    host: "",
    port: "27017",
    username: "",
    password: "",
    database: "",
    options: "",
  };

  try {
    const match = uri.match(
      /^mongodb(?:\+srv)?:\/\/(?:([^:]+):([^@]+)@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/
    );
    if (!match) return result;

    const [, user, pass, hostPort, db, opts] = match;
    if (user) result.username = decodeURIComponent(user);
    if (pass) result.password = decodeURIComponent(pass);
    if (db) result.database = db;
    if (opts) result.options = opts;

    if (hostPort) {
      const hostParts = hostPort.split(":");
      result.host = hostParts[0] ?? "";
      if (hostParts[1]) result.port = hostParts[1];
    }
  } catch {
    // noop
  }

  return result;
}

function buildMongoUri(parsed: ParsedConnection): string {
  let uri = "mongodb://";
  if (parsed.username && parsed.password) {
    uri += `${encodeURIComponent(parsed.username)}:${encodeURIComponent(parsed.password)}@`;
  }
  uri += parsed.host;
  if (parsed.port && parsed.port !== "27017") {
    uri += `:${parsed.port}`;
  }
  uri += "/";
  if (parsed.database) {
    uri += parsed.database;
  }

  let opts = parsed.options || "";
  if (parsed.username && !opts.includes("authSource")) {
    opts = opts ? `${opts}&authSource=admin` : "authSource=admin";
  }
  if (opts) {
    uri += `?${opts}`;
  }
  return uri;
}

export default function ConnectPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rawUri, setRawUri] = useState("");
  const [parsed, setParsed] = useState<ParsedConnection>({
    host: "",
    port: "27017",
    username: "",
    password: "",
    database: "",
    options: "",
  });
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [loading, setLoading] = useState(false);

  const handleUriChange = useCallback((value: string) => {
    setRawUri(value);
    if (value.startsWith("mongodb")) {
      setParsed(parseMongoUri(value));
    }
  }, []);

  const updateField = useCallback((field: keyof ParsedConnection, value: string) => {
    setParsed((prev) => {
      const next = { ...prev, [field]: value };
      setRawUri(buildMongoUri(next));
      return next;
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setWarning("");

    if (!parsed.database) {
      setError("Database name is required");
      return;
    }

    setLoading(true);

    const connectionString = buildMongoUri(parsed);

    const res = await fetch("/api/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description: description.trim() || null,
        connectionString,
        databaseName: parsed.database,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      setError(data.error || "Failed to connect");
      setLoading(false);
      return;
    }

    if (data.warning) {
      setWarning(data.warning);
    }

    navigate(`/dashboard/connections/${data.id}/schema`);
  }

  return (
    <div className="mx-auto max-w-lg">
      <Card>
        <CardHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Database className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-center text-xl">Connect MongoDB</CardTitle>
          <CardDescription className="text-center">
            Paste a connection string to auto-fill, or enter details manually.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="name" className="text-sm font-medium">Connection Name</label>
              <Input
                id="name"
                placeholder="e.g. Production DB"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div>
              <label htmlFor="description" className="text-sm font-medium">
                What's in this database?
              </label>
              <Input
                id="description"
                placeholder="e.g. Customer orders and subscriptions"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                One plain-language sentence. Agents read this to pick the right database when you have more than one connected.
              </p>
            </div>

            <div>
              <label htmlFor="connString" className="text-sm font-medium">Connection String</label>
              <Input
                id="connString"
                type="password"
                placeholder="mongodb://user:pass@host:port/dbname"
                value={rawUri}
                onChange={(e) => handleUriChange(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Paste your full URI — fields below auto-fill. Or fill them manually.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label htmlFor="host" className="text-sm font-medium">Host</label>
                <Input id="host" placeholder="localhost" value={parsed.host} onChange={(e) => updateField("host", e.target.value)} required />
              </div>
              <div>
                <label htmlFor="port" className="text-sm font-medium">Port</label>
                <Input id="port" placeholder="27017" value={parsed.port} onChange={(e) => updateField("port", e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="username" className="text-sm font-medium">Username</label>
                <Input id="username" placeholder="root" value={parsed.username} onChange={(e) => updateField("username", e.target.value)} />
              </div>
              <div>
                <label htmlFor="password" className="text-sm font-medium">Password</label>
                <Input id="password" type="password" placeholder="••••••••" value={parsed.password} onChange={(e) => updateField("password", e.target.value)} />
              </div>
            </div>

            <div>
              <label htmlFor="database" className="text-sm font-medium">
                Database Name <span className="text-destructive">*</span>
              </label>
              <Input id="database" placeholder="myapp" value={parsed.database} onChange={(e) => updateField("database", e.target.value)} required />
              <p className="mt-1 text-xs text-muted-foreground">
                The database to sync into the sandbox.
              </p>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            {warning && <p className="text-sm text-yellow-600">{warning}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Validating connection..." : "Connect & Create Sandbox"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
