// A news source: a front page the watcher reads, plus the rules for reading it.
// Built-in sources live in presets.ts; custom sources are created from the settings panel.

export type SourceId = string;

/** Options passed into the in-page extractor (see extract.ts). Must be plain JSON. */
export interface ExtractOptions {
  /** Regex source: URLs that are articles. */
  articlePattern: string;
  /** Regex source: URLs that are live blogs. */
  livePattern: string;
  /** Regex source: article-looking URLs to ignore (puzzles, video hubs, section fronts). */
  excludePattern: string;
  /** Regex source: URLs that are opinion / commentary. */
  opinionPattern: string;
  /** Regex source: visible text of a sign-in control (means signed OUT). */
  signInText: string;
  /** Regex source: visible text / aria-label of an account control (means signed IN). */
  accountText: string;
  /** CSS selectors that mean signed IN if present and visible. */
  accountSelectors: string[];
  maxHeadlines: number;
}

export interface SourceDef extends ExtractOptions {
  id: SourceId;
  /** Full name, e.g. "Financial Times". */
  name: string;
  /** Short label for tabs and badges, e.g. "FT". */
  short: string;
  homeUrl: string;
  /** Hostnames that belong to this source (links to them stay inside its tab). */
  hosts: string[];
  /** Public feeds used only when reading the front page fails. */
  rssFeeds: string[];
  /** Paywalled: the app tracks whether you're signed in and warns when the session expires. */
  requiresLogin: boolean;
  /** Brand-ish color for the source chip. */
  color: string;
  custom?: boolean;
}

/** One headline as it appears on a front page. */
export interface RawHeadline {
  headline: string;
  dek: string;
  url: string;
  /** 1-based order on the page (DOM order of unique article links). */
  position: number;
  /** Computed font size of the headline text, in px. Bigger usually = more prominent. */
  fontSize: number;
  /** The page marks it Live / Breaking (label, banner or live-blog URL). */
  live: boolean;
  /** The page explicitly says "Breaking". */
  breaking?: boolean;
  /** Opinion / commentary (URL section, label, or "Columnist | Headline" format). */
  opinion?: boolean;
}

export interface LoginStatus {
  /** true = signed in, false = signed out, null = couldn't tell */
  loggedIn: boolean | null;
  reason: string;
}

export interface ExtractionResult {
  headlines: RawHeadline[];
  login: LoginStatus;
}
