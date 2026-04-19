import { db } from "../../db/index.js";
import { connections } from "../../db/schema.js";
import { syncConnection } from "../sync.js";

const SYNC_HOUR_LOCAL = 5;
const DAILY_MS = 24 * 60 * 60 * 1000;
const BOOT_CATCHUP_DELAY_MS = 15_000;

let timer: NodeJS.Timeout | null = null;
let catchupTimer: NodeJS.Timeout | null = null;
let running = false;

export function startSyncScheduler(): void {
  if (timer) {
    console.log("[sync-scheduler] already running, ignoring start");
    return;
  }
  scheduleNext();
  scheduleBootCatchup();
}

export function stopSyncScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (catchupTimer) {
    clearTimeout(catchupTimer);
    catchupTimer = null;
  }
}

function scheduleBootCatchup(): void {
  catchupTimer = setTimeout(() => {
    catchupTimer = null;
    runCatchupIfStale().catch((err) =>
      console.error("[sync-scheduler] boot catch-up failed:", err),
    );
  }, BOOT_CATCHUP_DELAY_MS);
}

async function runCatchupIfStale(): Promise<void> {
  const rows = await db.select().from(connections);
  const cutoff = new Date(Date.now() - DAILY_MS);
  const stale = rows.filter((c) => {
    if (c.syncStatus === "SYNCING") return false;
    if (!c.lastSyncAt) return true;
    return c.lastSyncAt < cutoff;
  });

  if (stale.length === 0) {
    console.log("[sync-scheduler] boot check — no stale connections");
    return;
  }

  console.log(
    `[sync-scheduler] boot catch-up — ${stale.length} connection(s) missed their daily sync`,
  );
  await runSyncBatch(stale, "boot-catchup");
}

function scheduleNext(): void {
  const next = nextRunAt(new Date());
  const delay = next.getTime() - Date.now();
  console.log(
    `[sync-scheduler] next run at ${next.toString()} (in ${formatDelay(delay)})`,
  );
  timer = setTimeout(() => {
    runTick()
      .catch((err) => console.error("[sync-scheduler] tick failed:", err))
      .finally(scheduleNext);
  }, delay);
}

function nextRunAt(now: Date): Date {
  const next = new Date(now);
  next.setHours(SYNC_HOUR_LOCAL, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

async function runTick(): Promise<void> {
  const rows = await db.select().from(connections);
  const due = rows.filter((c) => c.syncStatus !== "SYNCING");

  if (due.length === 0) {
    console.log("[sync-scheduler] daily run — no connections to sync");
    return;
  }

  console.log(`[sync-scheduler] daily run — syncing ${due.length} connection(s)`);
  await runSyncBatch(due, "daily");
}

type ConnectionRow = typeof connections.$inferSelect;

async function runSyncBatch(rows: ConnectionRow[], label: string): Promise<void> {
  if (running) {
    console.log(`[sync-scheduler] ${label} skipped — another batch is running`);
    return;
  }
  running = true;
  const startedAt = Date.now();

  try {
    for (const conn of rows) {
      try {
        console.log(`[sync-scheduler] → ${conn.id} (${conn.name})`);
        await syncConnection(conn.id);
        console.log(`[sync-scheduler] ✓ ${conn.id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sync-scheduler] ✗ ${conn.id}: ${msg}`);
      }
    }
  } finally {
    running = false;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[sync-scheduler] ${label} finished in ${elapsed}s`);
  }
}

function formatDelay(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}
