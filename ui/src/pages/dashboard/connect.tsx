import { useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Database } from "lucide-react";

type DbType = "mongodb" | "postgresql";

interface ParsedConnection {
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  options: string;
}

interface DbProfile {
  label: string;
  defaultPort: string;
  scheme: string;
  placeholder: string;
  parse: (uri: string) => ParsedConnection;
  build: (parsed: ParsedConnection) => string;
}

const EMPTY: ParsedConnection = {
  host: "",
  port: "",
  username: "",
  password: "",
  database: "",
  options: "",
};

const PROFILES: Record<DbType, DbProfile> = {
  mongodb: {
    label: "MongoDB",
    defaultPort: "27017",
    scheme: "mongodb",
    placeholder: "mongodb://user:pass@host:port/dbname",
    parse(uri) {
      const result: ParsedConnection = { ...EMPTY, port: "27017" };
      const match = uri.match(
        /^mongodb(?:\+srv)?:\/\/(?:([^:]+):([^@]+)@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/,
      );
      if (!match) return result;
      const [, user, pass, hostPort, db, opts] = match;
      if (user) result.username = decodeURIComponent(user);
      if (pass) result.password = decodeURIComponent(pass);
      if (db) result.database = db;
      if (opts) result.options = opts;
      if (hostPort) {
        const parts = hostPort.split(":");
        result.host = parts[0] ?? "";
        if (parts[1]) result.port = parts[1];
      }
      return result;
    },
    build(parsed) {
      let uri = "mongodb://";
      if (parsed.username && parsed.password) {
        uri += `${encodeURIComponent(parsed.username)}:${encodeURIComponent(parsed.password)}@`;
      }
      uri += parsed.host;
      if (parsed.port && parsed.port !== "27017") uri += `:${parsed.port}`;
      uri += "/";
      if (parsed.database) uri += parsed.database;

      let opts = parsed.options || "";
      if (parsed.username && !opts.includes("authSource")) {
        opts = opts ? `${opts}&authSource=admin` : "authSource=admin";
      }
      if (opts) uri += `?${opts}`;
      return uri;
    },
  },
  postgresql: {
    label: "PostgreSQL",
    defaultPort: "5432",
    scheme: "postgresql",
    placeholder: "postgresql://user:pass@host:5432/dbname",
    parse(uri) {
      const result: ParsedConnection = { ...EMPTY, port: "5432" };
      const match = uri.match(
        /^postgres(?:ql)?:\/\/(?:([^:]+):([^@]+)@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/,
      );
      if (!match) return result;
      const [, user, pass, hostPort, db, opts] = match;
      if (user) result.username = decodeURIComponent(user);
      if (pass) result.password = decodeURIComponent(pass);
      if (db) result.database = db;
      if (opts) result.options = opts;
      if (hostPort) {
        const parts = hostPort.split(":");
        result.host = parts[0] ?? "";
        if (parts[1]) result.port = parts[1];
      }
      return result;
    },
    build(parsed) {
      let uri = "postgresql://";
      if (parsed.username) {
        uri += encodeURIComponent(parsed.username);
        if (parsed.password) uri += `:${encodeURIComponent(parsed.password)}`;
        uri += "@";
      }
      uri += parsed.host || "";
      if (parsed.port && parsed.port !== "5432") uri += `:${parsed.port}`;
      else if (parsed.port) uri += `:${parsed.port}`;
      uri += "/";
      if (parsed.database) uri += parsed.database;
      if (parsed.options) uri += `?${parsed.options}`;
      return uri;
    },
  },
};

export default function ConnectPage() {
  const navigate = useNavigate();
  const [dbType, setDbType] = useState<DbType>("mongodb");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rawUri, setRawUri] = useState("");
  const [parsed, setParsed] = useState<ParsedConnection>({ ...EMPTY, port: "27017" });
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [loading, setLoading] = useState(false);

  const profile = useMemo(() => PROFILES[dbType], [dbType]);

  const handleDbTypeChange = useCallback((next: DbType) => {
    setDbType(next);
    setRawUri("");
    setParsed({ ...EMPTY, port: PROFILES[next].defaultPort });
    setError("");
  }, []);

  const handleUriChange = useCallback(
    (value: string) => {
      setRawUri(value);
      if (value.startsWith(profile.scheme)) {
        setParsed(profile.parse(value));
      }
    },
    [profile],
  );

  const updateField = useCallback(
    (field: keyof ParsedConnection, value: string) => {
      setParsed((prev) => {
        const next = { ...prev, [field]: value };
        setRawUri(profile.build(next));
        return next;
      });
    },
    [profile],
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setWarning("");

    if (!parsed.database) {
      setError("Database name is required");
      return;
    }

    setLoading(true);

    const connectionString = profile.build(parsed);

    const res = await fetch("/api/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        dbType,
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
          <CardTitle className="text-center text-xl">Connect {profile.label}</CardTitle>
          <CardDescription className="text-center">
            Paste a connection string to auto-fill, or enter details manually.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium">Database Type</label>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {(Object.keys(PROFILES) as DbType[]).map((key) => {
                  const selected = dbType === key;
                  return (
                    <button
                      type="button"
                      key={key}
                      onClick={() => handleDbTypeChange(key)}
                      className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                        selected
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-input bg-background text-muted-foreground hover:bg-accent"
                      }`}
                    >
                      {PROFILES[key].label}
                    </button>
                  );
                })}
              </div>
            </div>

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
                placeholder={profile.placeholder}
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
                <Input id="port" placeholder={profile.defaultPort} value={parsed.port} onChange={(e) => updateField("port", e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="username" className="text-sm font-medium">Username</label>
                <Input id="username" placeholder={dbType === "postgresql" ? "postgres" : "root"} value={parsed.username} onChange={(e) => updateField("username", e.target.value)} />
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
              <Input id="database" placeholder={dbType === "postgresql" ? "postgres" : "myapp"} value={parsed.database} onChange={(e) => updateField("database", e.target.value)} required />
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
