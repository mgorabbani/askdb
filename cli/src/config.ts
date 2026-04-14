import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".askdb");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface AskdbConfig {
  serverUrl: string;
  apiKey: string;
  connectionId?: string;
}

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): AskdbConfig | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export function saveConfig(config: AskdbConfig) {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getConfigDir() {
  ensureDir();
  return CONFIG_DIR;
}

export function requireConfig(): AskdbConfig {
  const config = loadConfig();
  if (!config) {
    console.error("Not logged in. Run `askdb auth` first.");
    process.exit(1);
  }
  return config;
}
