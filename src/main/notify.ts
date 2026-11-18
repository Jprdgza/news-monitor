// macOS notifications. Clicking one opens the article inside the app.
import { Notification } from 'electron';
import { log } from './log';

type OpenHandler = (sourceId: string, url: string, storyId?: string) => void;
let onOpen: OpenHandler = () => {};
// Keep references so notifications aren't garbage-collected before they're clicked.
const live = new Set<Notification>();

export function setNotificationClickHandler(fn: OpenHandler) {
  onOpen = fn;
}

export function notify(opts: { title: string; subtitle?: string; body: string; sourceId?: string; url?: string; storyId?: string }) {
  if (!Notification.isSupported()) {
    log.warn('Notifications are not supported on this system');
    return;
  }
  const n = new Notification({ title: opts.title, subtitle: opts.subtitle, body: opts.body, silent: false });
  live.add(n);
  n.on('click', () => {
    onOpen(opts.sourceId ?? '', opts.url ?? '', opts.storyId);
    live.delete(n);
  });
  n.on('close', () => live.delete(n));
  n.on('failed', (_e, err) => log.error(`Notification failed: ${err}`));
  n.show();
  setTimeout(() => live.delete(n), 6 * 3_600_000);
}
