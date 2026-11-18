// Patterns shared by the in-page preview extractor and the stored-preview cleanup.
// (The extractor runs inside web pages, so it receives these as strings.)

/** Inline stock tickers, e.g. "NVDA -0.44% decrease; down pointing triangle". */
export const TICKER_SOURCE = String.raw`\b[A-Z.]{1,6} [-+]?\d+(\.\d+)?% (increase|decrease); (up|down) pointing triangle\s*`;
/** Paywall and bot-check boilerplate that isn't article text. */
export const BOILERPLATE_SOURCE = String.raw`(subscribe|subscription|per month|per week|digital access|sign in to|create (a free|an) account|already a subscriber|unlock this article|supports javascript|are you a robot|unusual activity|verify you are)`;
