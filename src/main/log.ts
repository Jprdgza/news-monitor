// Tiny logger: writes to stdout and to <userData>/logs/news-monitor.log (rotated at ~5 MB).
import { app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export const logPath = () => path.join(app.getPath('userData'), 'logs', 'news-monitor.log');

function write(level: string, msg: string) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  console.log(line);
  try {
    const file = logPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 5_000_000) fs.renameSync(file, file + '.old');
    fs.appendFileSync(file, line + '\n');
  } catch {
    /* logging must never crash the app */
  }
}

export const log = {
  info: (m: string) => write('INFO', m),
  warn: (m: string) => write('WARN', m),
  error: (m: string) => write('ERROR', m),
};

export function openLogFile() {
  shell.openPath(logPath());
}
