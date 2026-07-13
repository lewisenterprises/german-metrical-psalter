import type { Lang } from "./i18n";
import { DEFAULT_METER_ID } from "./meters";
import { DEFAULT_STYLE, STYLE_MIN, STYLE_MAX } from "./prompt";

// Session-scoped UI settings. Stored in sessionStorage (per-tab, cleared when
// the tab closes) rather than a cookie or localStorage, so each browser session
// starts fresh from the defaults below. Nothing is read on the server, so the
// first paint always shows defaults and the client re-applies stored settings
// after mount. The system prompt text rides in a separate sessionStorage key
// (PROMPT_STORAGE_KEY) because it can be large.

export const PREFS_STORAGE_KEY = "psalter.prefs";
export const PROMPT_STORAGE_KEY = "psalter.systemPrompt";
export const DEFAULT_MODEL = "claude-sonnet-4-6";

// Reading-display options (settings modal). Size applies to both the Hebrew
// source and the German output; typeface applies to the German output only.
export type FontSize = "S" | "M" | "L";
export type Typeface = "serif" | "sans";

export interface Prefs {
  lang: Lang;
  model: string;
  psalm: number;
  variants: number;
  meter: string;
  // Literal↔poetic dial, 1 (literal) … 5 (poetic). See src/lib/prompt.ts.
  style: number;
  // Optional verse range within the selected psalm (null = whole psalm).
  range: { start: number; end: number } | null;
  fontSize: FontSize;
  typeface: Typeface;
}

export const DEFAULT_PREFS: Prefs = {
  lang: "en",
  model: DEFAULT_MODEL,
  psalm: 23,
  variants: 3,
  meter: DEFAULT_METER_ID,
  style: DEFAULT_STYLE,
  range: null,
  fontSize: "M",
  typeface: "serif",
};

function parseRange(r: unknown): Prefs["range"] {
  if (!r || typeof r !== "object") return null;
  const o = r as { start?: unknown; end?: unknown };
  if (
    typeof o.start === "number" &&
    typeof o.end === "number" &&
    Number.isInteger(o.start) &&
    Number.isInteger(o.end) &&
    o.start >= 1 &&
    o.start <= o.end
  ) {
    return { start: o.start, end: o.end };
  }
  return null;
}

export function parsePrefs(raw: string | null | undefined): Prefs {
  if (!raw) return DEFAULT_PREFS;
  let o: Partial<Prefs>;
  try {
    o = JSON.parse(raw) as Partial<Prefs>;
  } catch {
    return DEFAULT_PREFS;
  }
  return {
    lang: o.lang === "de" || o.lang === "en" ? o.lang : DEFAULT_PREFS.lang,
    model:
      typeof o.model === "string" && o.model ? o.model : DEFAULT_PREFS.model,
    psalm:
      typeof o.psalm === "number" &&
      Number.isInteger(o.psalm) &&
      o.psalm >= 1 &&
      o.psalm <= 150
        ? o.psalm
        : DEFAULT_PREFS.psalm,
    variants:
      typeof o.variants === "number" &&
      Number.isInteger(o.variants) &&
      o.variants >= 1 &&
      o.variants <= 5
        ? o.variants
        : DEFAULT_PREFS.variants,
    meter:
      typeof o.meter === "string" && o.meter ? o.meter : DEFAULT_PREFS.meter,
    style:
      typeof o.style === "number" &&
      Number.isInteger(o.style) &&
      o.style >= STYLE_MIN &&
      o.style <= STYLE_MAX
        ? o.style
        : DEFAULT_PREFS.style,
    range: parseRange(o.range),
    fontSize:
      o.fontSize === "S" || o.fontSize === "M" || o.fontSize === "L"
        ? o.fontSize
        : DEFAULT_PREFS.fontSize,
    typeface:
      o.typeface === "serif" || o.typeface === "sans"
        ? o.typeface
        : DEFAULT_PREFS.typeface,
  };
}
