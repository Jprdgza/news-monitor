// Built-in sources. If a site redesigns and extraction breaks, its entry here is the only
// thing to fix: usually just articlePattern (which links count as articles).
// Run `npm run check-sources` to see what each front page currently yields.
import type { SourceDef } from './types';

const SIGN_IN = String.raw`^(sign in|log in|login)$`;
const ACCOUNT = String.raw`^(account|my account|customer center|myft|my wsj|profile)( menu)?$`;
const EXCLUDE_COMMON = String.raw`/(video|videos|podcasts?|audio|puzzles|games|crosswords|newsletters?|graphics|market-data|topics?|tags?|authors?|people)/`;

type Preset = Omit<SourceDef, 'maxHeadlines' | 'signInText' | 'accountText' | 'accountSelectors' | 'excludePattern'> &
  Partial<Pick<SourceDef, 'signInText' | 'accountText' | 'accountSelectors' | 'excludePattern'>>;

const preset = (p: Preset): SourceDef => ({
  signInText: SIGN_IN,
  accountText: ACCOUNT,
  accountSelectors: [],
  excludePattern: EXCLUDE_COMMON,
  maxHeadlines: 60,
  ...p,
});

export const PRESETS: SourceDef[] = [
  preset({
    id: 'wsj',
    name: 'The Wall Street Journal',
    short: 'WSJ',
    homeUrl: 'https://www.wsj.com/',
    hosts: ['wsj.com', 'dowjones.com', 'wsj.net'],
    // /articles/slug-1a2b3c4d, /livecoverage/..., /finance/stocks/some-slug-1a2b3c4d
    articlePattern: String.raw`^https://www\.wsj\.com/(articles/|livecoverage/|(?:[a-z0-9-]+/){1,3}[a-z0-9-]+-[0-9a-f]{8}/?$)`,
    livePattern: String.raw`/livecoverage/`,
    excludePattern: String.raw`/(video|podcasts|puzzles|buyside|coupons|story|graphics|market-data)/`,
    opinionPattern: String.raw`/opinion/`,
    accountSelectors: ['[data-testid="customer-nav-menu"]', '[aria-label="Customer Center"]', '[data-testid="user-menu"]'],
    rssFeeds: [
      'https://feeds.content.dowjones.io/public/rss/RSSWorldNews',
      'https://feeds.content.dowjones.io/public/rss/RSSUSnews',
      'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain',
      'https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness',
    ],
    requiresLogin: true,
    color: '#5b8def',
  }),
  preset({
    id: 'nyt',
    name: 'The New York Times',
    short: 'NYT',
    homeUrl: 'https://www.nytimes.com/',
    hosts: ['nytimes.com', 'nyt.com'],
    // /2026/11/14/us/politics/slug.html, /live/2026/11/14/world/slug, /interactive/2026/...
    articlePattern: String.raw`^https://www\.nytimes\.com/(live/|interactive/)?\d{4}/\d{2}/\d{2}/`,
    livePattern: String.raw`/live/`,
    excludePattern: String.raw`/(crosswords|games|puzzles|wirecutter|cooking|athletic|video)/`,
    opinionPattern: String.raw`/opinion/`,
    accountText: String.raw`^(account|my account)$`,
    accountSelectors: ['[data-testid="user-settings-button"]'],
    rssFeeds: ['https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml'],
    requiresLogin: true,
    color: '#a0a4ab',
  }),
  preset({
    id: 'ft',
    name: 'Financial Times',
    short: 'FT',
    homeUrl: 'https://www.ft.com/',
    hosts: ['ft.com'],
    articlePattern: String.raw`^https://www\.ft\.com/content/[0-9a-f-]{36}$`,
    livePattern: String.raw`(?!)`,
    opinionPattern: String.raw`(?!)`, // FT opinion shares /content/ URLs; caught by the "Opinion" label instead
    rssFeeds: ['https://www.ft.com/rss/home/international'],
    requiresLogin: true,
    color: '#f2a07b',
  }),
  preset({
    id: 'bloomberg',
    name: 'Bloomberg',
    short: 'BBG',
    homeUrl: 'https://www.bloomberg.com/',
    hosts: ['bloomberg.com', 'bloomberg.net'],
    articlePattern: String.raw`^https://www\.bloomberg\.com/(news/(articles|features|live-blog)|opinion/articles|features)/\d{4}-\d{2}-\d{2}/`,
    livePattern: String.raw`/live-blog/`,
    opinionPattern: String.raw`/opinion/`,
    rssFeeds: ['https://feeds.bloomberg.com/markets/news.rss'],
    requiresLogin: true,
    color: '#b48cf2',
  }),
  preset({
    id: 'reuters',
    name: 'Reuters',
    short: 'RTRS',
    homeUrl: 'https://www.reuters.com/',
    hosts: ['reuters.com'],
    // /world/europe/some-slug-2026-11-17/
    articlePattern: String.raw`^https://www\.reuters\.com/[a-z-]+/(?:[a-z0-9-]+/)*[a-z0-9-]+-\d{4}-\d{2}-\d{2}/?$`,
    livePattern: String.raw`/live/`,
    opinionPattern: String.raw`/(commentary|breakingviews)/`,
    rssFeeds: [],
    requiresLogin: false,
    color: '#f5a524',
  }),
  preset({
    id: 'economist',
    name: 'The Economist',
    short: 'ECON',
    homeUrl: 'https://www.economist.com/',
    hosts: ['economist.com'],
    articlePattern: String.raw`^https://www\.economist\.com/[a-z-]+/\d{4}/\d{2}/\d{2}/[a-z0-9-]+$`,
    livePattern: String.raw`(?!)`,
    opinionPattern: String.raw`/(leaders|by-invitation|letters)/`,
    rssFeeds: ['https://www.economist.com/latest/rss.xml'],
    requiresLogin: true,
    color: '#ef6b73',
  }),
  preset({
    id: 'barrons',
    name: "Barron's",
    short: 'BAR',
    homeUrl: 'https://www.barrons.com/',
    hosts: ['barrons.com', 'dowjones.com'],
    articlePattern: String.raw`^https://www\.barrons\.com/(articles|livecoverage)/[a-z0-9-]+`,
    livePattern: String.raw`/livecoverage/`,
    opinionPattern: String.raw`/articles/(?:[a-z0-9-]*-)?(commentary|opinion)-`,
    rssFeeds: [],
    requiresLogin: true,
    color: '#7aa2f7',
  }),
  preset({
    id: 'cnbc',
    name: 'CNBC',
    short: 'CNBC',
    homeUrl: 'https://www.cnbc.com/',
    hosts: ['cnbc.com'],
    articlePattern: String.raw`^https://www\.cnbc\.com/\d{4}/\d{2}/\d{2}/[a-z0-9-]+\.html$`,
    livePattern: String.raw`live-updates`,
    opinionPattern: String.raw`-(op-ed|commentary)\b`,
    rssFeeds: ['https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114'],
    requiresLogin: false,
    color: '#60c6e8',
  }),
  preset({
    id: 'ap',
    name: 'Associated Press',
    short: 'AP',
    homeUrl: 'https://apnews.com/',
    hosts: ['apnews.com'],
    articlePattern: String.raw`^https://apnews\.com/(article|live)/[a-z0-9-]+`,
    livePattern: String.raw`/live/`,
    opinionPattern: String.raw`(?!)`,
    rssFeeds: [],
    requiresLogin: false,
    color: '#e5484d',
  }),
  preset({
    id: 'axios',
    name: 'Axios',
    short: 'AXS',
    homeUrl: 'https://www.axios.com/',
    hosts: ['axios.com'],
    articlePattern: String.raw`^https://www\.axios\.com/\d{4}/\d{2}/\d{2}/[a-z0-9-]+$`,
    livePattern: String.raw`(?!)`,
    opinionPattern: String.raw`(?!)`,
    rssFeeds: ['https://api.axios.com/feed/'],
    requiresLogin: false,
    color: '#8bd5ca',
  }),
  preset({
    id: 'marketwatch',
    name: 'MarketWatch',
    short: 'MW',
    homeUrl: 'https://www.marketwatch.com/',
    hosts: ['marketwatch.com', 'dowjones.com'],
    articlePattern: String.raw`^https://www\.marketwatch\.com/(story|livecoverage)/[a-z0-9-]+`,
    livePattern: String.raw`/livecoverage/`,
    opinionPattern: String.raw`(?!)`,
    rssFeeds: ['https://feeds.content.dowjones.io/public/rss/mw_topstories'],
    requiresLogin: false,
    color: '#a6da95',
  }),
  preset({
    id: 'politico',
    name: 'Politico',
    short: 'POL',
    homeUrl: 'https://www.politico.com/',
    hosts: ['politico.com'],
    articlePattern: String.raw`^https://www\.politico\.com/(news|live-updates)/\d{4}/\d{2}/\d{2}/`,
    livePattern: String.raw`/live-updates/`,
    opinionPattern: String.raw`/news/magazine/`,
    rssFeeds: ['https://rss.politico.com/politics-news.xml'],
    requiresLogin: false,
    color: '#f5bde6',
  }),
];

/** Sources turned on for a fresh install. */
export const DEFAULT_ENABLED = ['wsj', 'nyt', 'ft', 'bloomberg', 'reuters'];

/** Rules for a source added by the user: just a name and a front-page URL. */
export function customSource(input: { id: string; name: string; homeUrl: string; rssUrl?: string; articlePattern?: string; requiresLogin?: boolean }): SourceDef {
  const u = new URL(input.homeUrl);
  const host = u.hostname.replace(/^www\./, '');
  const hostRe = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // An article URL on this site: a dated path, a long hyphenated slug, or an id-like segment.
  const generic = String.raw`^https?://(?:[a-z0-9-]+\.)?${hostRe}/(?:.*/\d{4}/\d{1,2}/\d{1,2}/|(?:[^?#]*/)?[a-z0-9]+(?:-[a-z0-9]+){3,}|(?:[^?#]*/)?(?:content|article|story|news)/[a-z0-9-]{8,})`;
  return preset({
    id: input.id,
    name: input.name,
    short: input.name.replace(/^the\s+/i, '').replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 4) || 'SRC',
    homeUrl: u.toString(),
    hosts: [host],
    articlePattern: input.articlePattern || generic,
    livePattern: String.raw`/live(-updates|-blog|coverage)?/`,
    opinionPattern: String.raw`/(opinion|commentary|op-ed|editorials?)/`,
    rssFeeds: input.rssUrl ? [input.rssUrl] : [],
    requiresLogin: !!input.requiresLogin,
    color: '#94e2d5',
    custom: true,
  });
}
