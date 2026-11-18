// Loads/saves the personalization model (data/prefs.json) and applies feedback events.
import { getConfig } from './config';
import { emptyPrefs, featuresOf, prune, record, boostFor, type Feedback, type Prefs } from './prefsCore';
import { readData, store, writeJson, type Story } from './store';

let prefs: Prefs | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function get(): Prefs {
  if (!prefs) {
    const raw = readData<Prefs>('prefs.json', emptyPrefs());
    prefs = { features: raw.features ?? {}, shown: raw.shown ?? {} };
  }
  return prefs;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const p = get();
    prune(p, Date.now());
    writeJson('prefs.json', p);
  }, 2000);
}

export function giveFeedback(story: Story, kind: Feedback) {
  const now = Date.now();
  if (kind === 'up' || kind === 'down') {
    if (story.feedback === kind) return; // already counted
    // Switching 👍 → 👎 undoes the earlier vote first.
    if (story.feedback) record(get(), featuresOf(story), story.feedback === 'up' ? 'down' : 'up', now);
    story.feedback = kind;
  }
  if (kind === 'open') {
    if (story.openedAt) return; // count each story once
    story.openedAt = now;
  }
  record(get(), featuresOf(story), kind, now);
  scheduleSave();
}

/** Stories shown in a digest: anything not opened later counts as a gentle "skip". */
export function noteShown(stories: Story[]) {
  const p = get();
  const now = Date.now();
  let changed = false;
  for (const s of stories) {
    if (p.shown[s.id] || s.openedAt) continue;
    p.shown[s.id] = now;
    record(p, featuresOf(s), 'skip', now);
    changed = true;
  }
  if (changed) scheduleSave();
}

export function preferenceBoost(story: Story): { boost: number; reason?: string } {
  if (!getConfig().personalization.enabled) return { boost: 0 };
  return boostFor(get(), story, Date.now());
}

export function resetPrefs() {
  prefs = emptyPrefs();
  for (const s of store.stories) {
    delete s.feedback;
  }
  writeJson('prefs.json', prefs);
}
