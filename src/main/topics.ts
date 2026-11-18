// Topic tagging for the digest: which part of the world a story tells you about.
// Uses the URL section (very reliable: /economy/, /business/, /tech/) and a keyword lexicon
// on the headline + dek. Pure module, unit-tested.

export type Topic = 'economy' | 'markets' | 'geopolitics' | 'policy' | 'companies' | 'tech' | 'industries' | 'other';
export type Scope = 'macro' | 'micro' | 'other';

export const TOPIC_LABEL: Record<Topic, string> = {
  economy: 'Economy',
  markets: 'Markets',
  geopolitics: 'World',
  policy: 'Policy',
  companies: 'Companies',
  tech: 'Tech',
  industries: 'Industries',
  other: 'Other',
};

export const SCOPE_OF: Record<Topic, Scope> = {
  economy: 'macro',
  markets: 'macro',
  geopolitics: 'macro',
  policy: 'macro',
  companies: 'micro',
  tech: 'micro',
  industries: 'micro',
  other: 'other',
};

const LEXICON: Record<Exclude<Topic, 'other'>, RegExp> = {
  economy:
    /\b(fed|federal reserve|fomc|inflation|cpi|ppi|gdp|recession|jobs report|payrolls|unemployment|jobless|interest rates?|rate (cut|hike)s?|central bank|ecb|bank of (japan|england)|boj|treasur(y|ies)|deficit|debt ceiling|economy|economic|economists?|consumer (spending|confidence|prices)|wages|tariffs?|trade (war|deal|pact|deficit)|housing market|mortgage rates?|imf|world bank|dollar|yuan|yen|euro\b|currenc(y|ies))\b/i,
  markets:
    /\b(stocks?|shares|s&p|nasdaq|dow jones|the dow|wall street|bonds?|yields?|treasury yields|oil prices?|crude|brent|gold|bitcoin|crypto|selloff|sell-off|rally|bear market|bull market|market rout|volatility|vix|futures|commodit(y|ies)|ipo market|investors?|hedge funds?|private credit|private equity)\b/i,
  geopolitics:
    /\b(war|military|troops|missiles?|strikes?|airstrikes?|invasion|ceasefire|cease-fire|nato|sanctions|summit|diplomat(s|ic)?|china|chinese|beijing|xi jinping|xi|russia|russian|putin|kremlin|ukraine|ukrainian|kyiv|israel|israeli|gaza|hamas|hezbollah|iran|iranian|tehran|taiwan|north korea|pyongyang|middle east|eu|european union|europe|european|france|french|germany|german|britain|british|u\.k\.|japan|japanese|india|indian|canada|mexico|brazil|g7|g20|united nations|apec|asean|foreign minister|prime minister|president of)\b/i,
  policy:
    /\b(pentagon|army|navy|defense secretary|hegseth|nominee|nomination|confirmation hearing|speaker|democrats?|republicans?|gop|trump administration|congress|senate|house (republicans|democrats|speaker)|white house|supreme court|justice department|doj|regulators?|regulation|legislation|bill|executive order|administration|election|campaign|governor|lawmakers|shutdown|impeach\w*|indict\w*|ftc|sec\b|antitrust|fda|irs)\b/i,
  companies:
    /\b(earnings|quarterly|revenue|profit|guidance|ceo|chief executive|cfo|board|layoffs?|job cuts|merger|acquisitions?|acquires?|takeover|buyout|deal to buy|ipo|start-?ups?|bankruptcy|chapter 11|shareholders?|activist investor|valuation|lawsuit|settlement|recall|nvidia|apple|microsoft|alphabet|google|amazon|meta|tesla|openai|anthropic|berkshire|jpmorgan|goldman|boeing|walmart|exxon|chevron|pfizer|disney|netflix|intel|amd|tsmc|samsung|spacex)\b/i,
  tech:
    /\b(ai|a\.i\.|artificial intelligence|chips?|semiconductors?|data centers?|software|cloud|cyber\w*|hack(ers?|ed)?|app|smartphones?|iphone|robot\w*|self-driving|autonomous|quantum|tech(nology)?|silicon valley|social media|algorithm)\b/i,
  industries:
    /\b(banks?|banking|insurers?|airlines?|automakers?|car ?makers?|evs?|electric vehicles?|retail(ers)?|real estate|commercial property|oil (companies|producers)|energy|utilit(y|ies)|power grid|pharma\w*|drugmakers?|biotech|hospitals?|health insurers?|media|hollywood|shipping|railroads?|farm(ers|ing)?|agricultur\w*|mining|steel|defense contractors?)\b/i,
};

// URL section → topic. Specific sections are trusted over headline words; a generic
// "business" section only decides when the headline itself doesn't say.
const SECTION_HINTS: [RegExp, Topic][] = [
  [/\/(economy|economics|finance-and-economics|economy-and-policy)\//i, 'economy'],
  [/\/(markets?|finance|investing|personal-finance|stocks|bonds|commodities|currencies)\//i, 'markets'],
  [/\/(world|international|europe|asia|china|middle-east|africa|americas|geopolitics)\//i, 'geopolitics'],
  [/\/(politics|us-news\/law|policy|congress|white-house|elections?)\//i, 'policy'],
  [/\/(technology|tech|science\/ai|artificial-intelligence)\//i, 'tech'],
  [/\/(real-estate|energy|autos|media|retail|industrials)\//i, 'industries'],
];
const WEAK_HINTS: [RegExp, Topic][] = [[/\/(business|companies|deals|earnings|dealbook)\//i, 'companies']];

const HEALTH = /\b(measles|vaccin\w*|virus|disease|outbreak|cancer|flu|covid|booster|patients?)\b/i;
const OFF_TOPIC = /\/(arts?|arts-culture|style|lifestyle|sports?|athletic|travel|food|books|movies|theater|fashion|weddings|obituaries|well|crosswords|puzzles)\//i;

export interface TopicResult {
  topic: Topic;
  scope: Scope;
  /** All topics the text touches (for personalization). */
  tags: Topic[];
}

export function classify(headline: string, dek: string, url: string): TopicResult {
  const text = `${headline} ${dek}`;
  const tags = (Object.keys(LEXICON) as Exclude<Topic, 'other'>[]).filter((t) => LEXICON[t].test(text));
  let topic: Topic | undefined;
  for (const [re, t] of SECTION_HINTS) if (re.test(url)) {
    topic = t;
    break;
  }
  if (!topic && OFF_TOPIC.test(url)) topic = 'other';
  // Headline words beat dek words: check the lexicon on the headline alone first.
  topic ??= (Object.keys(LEXICON) as Exclude<Topic, 'other'>[]).find((t) => LEXICON[t].test(headline));
  if (!topic && HEALTH.test(headline)) topic = 'other';
  if (!topic) for (const [re, t] of WEAK_HINTS) if (re.test(url)) topic = t;
  topic ??= tags[0] ?? 'other';
  if (topic !== 'other' && !tags.includes(topic)) tags.unshift(topic);
  return { topic, scope: SCOPE_OF[topic], tags };
}
