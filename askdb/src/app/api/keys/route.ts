import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiKeys } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { generateApiKey } from "@/lib/auth/api-keys";
import { and, eq, isNull } from "drizzle-orm";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { label } = body as { label?: string };

  const { fullKey, prefix, hash } = generateApiKey();

  await db.insert(apiKeys).values({
    prefix,
    keyHash: hash,
    label: label || null,
    userId: session.user.id,
  });

  return NextResponse.json({ key: fullKey, prefix });
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const keys = await db
    .select({
      id: apiKeys.id,
      prefix: apiKeys.prefix,
      label: apiKeys.label,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, session.user.id), isNull(apiKeys.revokedAt)));

  return NextResponse.json(keys);
}
