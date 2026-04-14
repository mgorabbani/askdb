import type { AskdbConfig } from "./config.js";

export class AskdbClient {
  private baseUrl: string;
  private apiKey: string;
  private connectionId: string | undefined;

  constructor(config: AskdbConfig) {
    this.baseUrl = config.serverUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.connectionId = config.connectionId;
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...init?.headers,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`${res.status}: ${text}`);
    }

    return res;
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetch(path, init);
    return (await res.json()) as T;
  }

  private requireConnectionId(): string {
    if (!this.connectionId) {
      console.error("No connection selected. Run `askdb connections` first.");
      process.exit(1);
    }
    return this.connectionId as string;
  }

  // ── Connections ─────────────────────────────────────────────────

  async listConnections(): Promise<Connection[]> {
    return this.fetchJson<Connection[]>("/api/connections");
  }

  // ── Schema ──────────────────────────────────────────────────────

  async getSchema(): Promise<SchemaTable[]> {
    const id = this.requireConnectionId();
    return this.fetchJson<SchemaTable[]>(`/api/connections/${id}/schema`);
  }

  async getSchemaSummary(): Promise<string> {
    const id = this.requireConnectionId();
    const res = await this.fetch(`/api/connections/${id}/schema/summary`);
    return res.text();
  }

  async updateTableDescription(
    tableId: string,
    description: string
  ): Promise<void> {
    const id = this.requireConnectionId();
    await this.fetch(`/api/connections/${id}/schema/tables/${tableId}`, {
      method: "PATCH",
      body: JSON.stringify({ description }),
    });
  }

  // ── MCP tools (via direct API, same logic) ──────────────────────

  async listTables(): Promise<TableInfo[]> {
    const id = this.requireConnectionId();
    const tables = await this.fetchJson<SchemaTable[]>(`/api/connections/${id}/schema`);
    return tables
      .filter((t) => t.isVisible)
      .filter((t) => t.columns?.some((c) => c.isVisible))
      .map((t) => ({ name: t.name, docCount: t.docCount }));
  }

  async describeTable(tableName: string): Promise<FieldInfo[]> {
    const id = this.requireConnectionId();
    const tables = await this.fetchJson<SchemaTable[]>(`/api/connections/${id}/schema`);
    const table = tables.find(
      (t) => t.name === tableName && t.isVisible
    );
    if (!table) throw new Error(`Collection "${tableName}" not found or hidden`);

    return (table.columns ?? [])
      .filter((c) => c.isVisible)
      .map((c) => ({
        name: c.name,
        type: c.fieldType,
        sampleValue: c.sampleValue,
      }));
  }

  // ── Memories ────────────────────────────────────────────────────

  async getMemories(): Promise<Memory[]> {
    const id = this.requireConnectionId();
    return this.fetchJson<Memory[]>(`/api/connections/${id}/memories`);
  }

  async addMemory(memory: {
    pattern: string;
    description: string;
    exampleQuery?: string;
    collection?: string;
  }): Promise<void> {
    const id = this.requireConnectionId();
    await this.fetch(`/api/connections/${id}/memories`, {
      method: "POST",
      body: JSON.stringify(memory),
    });
  }

  async deleteMemory(memoryId: string): Promise<void> {
    const id = this.requireConnectionId();
    await this.fetch(`/api/connections/${id}/memories?memoryId=${memoryId}`, {
      method: "DELETE",
    });
  }
}

// ── Types ───────────────────────────────────────────────────────────

export interface Connection {
  id: string;
  name: string;
  dbType: string;
  syncStatus: string;
  lastSyncAt: string | null;
}

export interface SchemaTable {
  id: string;
  name: string;
  description: string | null;
  docCount: number;
  isVisible: boolean;
  columns?: SchemaColumn[];
  relationships?: SchemaRelationship[];
}

export interface SchemaColumn {
  id: string;
  name: string;
  fieldType: string;
  sampleValue: string | null;
  isVisible: boolean;
  piiConfidence: string;
}

export interface SchemaRelationship {
  sourceField: string;
  targetTableId: string;
  targetField: string;
  relationType: string;
}

export interface TableInfo {
  name: string;
  docCount: number;
}

export interface FieldInfo {
  name: string;
  type: string;
  sampleValue: string | null;
}

export interface Memory {
  id: string;
  pattern: string;
  description: string;
  exampleQuery: string | null;
  collection: string | null;
  frequency: number;
  lastUsedAt: string;
}
