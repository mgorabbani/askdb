"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Database } from "lucide-react";

export default function ConnectPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [connectionString, setConnectionString] = useState("");
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setWarning("");
    setLoading(true);

    const res = await fetch("/api/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, connectionString }),
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

    // Navigate to schema browser for the new connection
    router.push(`/dashboard/connections/${data.id}/schema`);
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
            Paste your MongoDB connection string. We&apos;ll validate it and create a
            sandbox copy.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="name" className="text-sm font-medium">
                Connection Name
              </label>
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
              <label htmlFor="connString" className="text-sm font-medium">
                Connection String
              </label>
              <Input
                id="connString"
                type="password"
                placeholder="mongodb://..."
                value={connectionString}
                onChange={(e) => setConnectionString(e.target.value)}
                required
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Read-only access is sufficient. We never write to your production
                database.
              </p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {warning && (
              <p className="text-sm text-yellow-600">{warning}</p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Validating connection..." : "Connect & Create Sandbox"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
