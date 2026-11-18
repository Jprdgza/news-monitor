// Loads the editable config file from the app's userData folder.
// On first run it copies default-config.json there. Missing or invalid values fall back to defaults.
import { app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log';
import { sanitizeConfig, type Config } from './configCore';

export type { Config, CustomSourceInput } from './configCore';

const defaultsPath = path.join(app.getAppPath(), 'default-config.json');
export const configPath = () => path.join(app.getPath('userData'), 'config.json');

let defaults: Config | null = null;
export function getDefaults(): Config {
  return (defaults ??= JSON.parse(fs.readFileSync(defaultsPath, 'utf8')));
}

let current: Config | null = null;
let lastWritten = '';
const listeners = new Set<(c: Config) => void>();

export function onConfigChange(fn: (c: Config) => void) {
  listeners.add(fn);
}

export function loadConfig(): Config {
  const file = configPath();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(defaultsPath, file);
    log.info(`Created config file at ${file}`);
  }
  let raw: unknown = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log.error(`Config file is not valid JSON, using defaults: ${err}`);
  }
  const before = (raw as any)?.version;
  current = sanitizeConfig(getDefaults(), raw);
  if (!(Number(before) >= current.version)) {
    log.info(`Upgraded config to version ${current.version} (scoring weights reset to the new defaults)`);
    write(current);
  }
  return current;
}

export function getConfig(): Config {
  return current ?? loadConfig();
}

function write(cfg: Config) {
  lastWritten = JSON.stringify(cfg, null, 2);
  fs.writeFileSync(configPath(), lastWritten, { mode: 0o600 });
}

/** Save a config from the settings panel (untrusted shape: it is sanitized first). */
export function saveConfig(next: unknown): Config {
  current = sanitizeConfig(getDefaults(), { ...(next as object), version: getDefaults().version });
  write(current);
  log.info('Config saved from settings panel');
  for (const fn of listeners) fn(current);
  return current;
}

export function openConfigFile() {
  shell.openPath(configPath());
}

// Re-read the config whenever the file is edited by hand.
export function watchConfig() {
  let timer: NodeJS.Timeout | null = null;
  // Watch the folder, not the file: editors that save by replacing the file would break a file watch.
  fs.watch(path.dirname(configPath()), (_event, name) => {
    if (name !== path.basename(configPath())) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      let text = '';
      try {
        text = fs.readFileSync(configPath(), 'utf8');
      } catch {
        return;
      }
      if (text === lastWritten) return; // our own save
      log.info('Config file changed on disk, reloading');
      const cfg = loadConfig();
      for (const fn of listeners) fn(cfg);
    }, 300);
  });
}
