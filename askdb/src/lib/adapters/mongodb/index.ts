import { MongoClient } from "mongodb";
import type { DatabaseAdapter, IntrospectionResult, QueryResult } from "../types";

export class MongoDBAdapter implements DatabaseAdapter {
  async validateConnection(connString: string) {
    const client = new MongoClient(connString, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });

    try {
      await client.connect();
      // Test that we can actually list databases
      await client.db().admin().listDatabases();
      return { valid: true };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown connection error";
      return { valid: false, error: message };
    } finally {
      await client.close().catch(() => {});
    }
  }

  async getDatabaseSize(connString: string) {
    const client = new MongoClient(connString, {
      serverSelectionTimeoutMS: 10000,
    });

    try {
      await client.connect();
      const db = client.db();
      const stats = await db.stats();
      const collections = await db.listCollections().toArray();

      return {
        sizeBytes: stats.dataSize ?? 0,
        collections: collections.length,
      };
    } finally {
      await client.close().catch(() => {});
    }
  }

  async dump(_connString: string, _outputDir: string): Promise<void> {
    // Implemented in T8 (sync)
    throw new Error("Not implemented — see T8");
  }

  async restore(_sandboxConnString: string, _inputDir: string): Promise<void> {
    // Implemented in T8 (sync)
    throw new Error("Not implemented — see T8");
  }

  async introspect(_sandboxConnString: string): Promise<IntrospectionResult> {
    // Implemented in T9 (schema introspection)
    throw new Error("Not implemented — see T9");
  }

  async executeQuery(
    _sandboxConnString: string,
    _query: string,
    _visibleCollections: string[],
    _hiddenFields: Map<string, string[]>
  ): Promise<QueryResult> {
    // Implemented in T12/T14
    throw new Error("Not implemented — see T12/T14");
  }

  validateQuery(_query: string) {
    // Implemented in T14
    return { valid: true };
  }
}
