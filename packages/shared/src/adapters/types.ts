export interface DatabaseAdapter {
  /** Test connection is valid and read-only accessible */
  validateConnection(connString: string): Promise<{
    valid: boolean;
    error?: string;
  }>;

  /** Get database size in bytes and collection count */
  getDatabaseSize(connString: string): Promise<{
    sizeBytes: number;
    collections: number;
  }>;

  /** Dump database to a temp directory */
  dump(connString: string, outputDir: string): Promise<void>;

  /** Restore dump into sandbox container */
  restore(sandboxConnString: string, inputDir: string): Promise<void>;

  /** Introspect schema: collections, fields, types, sample data */
  introspect(sandboxConnString: string): Promise<IntrospectionResult>;

  /** Execute a read-only query against sandbox */
  executeQuery(
    sandboxConnString: string,
    query: string,
    visibleCollections: string[],
    hiddenFields: Map<string, string[]>
  ): Promise<QueryResult>;

  /** Validate that a query is read-only */
  validateQuery(query: string): { valid: boolean; error?: string };
}

export interface IntrospectionResult {
  collections: CollectionSchema[];
}

export interface CollectionSchema {
  name: string;
  docCount: number;
  fields: FieldSchema[];
  sampleDoc: Record<string, unknown> | null;
}

export interface FieldSchema {
  name: string; // dot notation for nested: "address.zip"
  fieldType: string; // BSON type
  sampleValue: string | null;
}

export interface QueryResult {
  documents: Record<string, unknown>[];
  totalCount: number;
  truncated: boolean;
}
