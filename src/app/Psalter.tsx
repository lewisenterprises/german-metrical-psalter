"use client";

import { useEffect, useRef, useState } from "react";
import { STRINGS, type Lang } from "@/lib/i18n";
import { buildSystemPrompt } from "@/lib/prompt";
import { METERS, findMeter } from "@/lib/meters";
import {
  DEFAULT_PREFS,
  PREFS_STORAGE_KEY,
  PROMPT_STORAGE_KEY,
  parsePrefs,
} from "@/lib/prefs";

// Parse a psalm reference into a psalm and optional verse range. Accepts
// "119:1-6", "119,1-6", "103:5", "103", or a bare "1-6" (applied to the current
// psalm). Returns null if it can't be read. Verse bounds are validated against
// the loaded psalm elsewhere.
function parseReference(
  input: string,
  currentPsalm: number
): { psalm: number; start?: number; end?: number } | null {
  const s = input.trim();
  if (!s) return { psalm: currentPsalm };
  const inRange = (p: number) => p >= 1 && p <= 150;
  let m = s.match(/^(\d{1,3})\s*[:.,]\s*(\d{1,3})\s*[-–]\s*(\d{1,3})$/);
  if (m && inRange(+m[1]) && +m[2] <= +m[3])
    return { psalm: +m[1], start: +m[2], end: +m[3] };
  m = s.match(/^(\d{1,3})\s*[:.,]\s*(\d{1,3})$/);
  if (m && inRange(+m[1])) return { psalm: +m[1], start: +m[2], end: +m[2] };
  m = s.match(/^(\d{1,3})$/);
  if (m && inRange(+m[1])) return { psalm: +m[1] };
  m = s.match(/^(\d{1,3})\s*[-–]\s*(\d{1,3})$/);
  if (m && +m[1] <= +m[2])
    return { psalm: currentPsalm, start: +m[1], end: +m[2] };
  return null;
}

type Stanza = { lines: string[] };
type Variant = { notes?: string; stanzas: Stanza[] };
type GenerateResponse = {
  variants: Variant[];
  meta?: { stop_reason?: string; usage?: Record<string, number> };
  error?: string;
};

type Provider =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "deepseek"
  | "openrouter"
  | "lmstudio";
type ModelInfo = {
  id: string;
  label: string;
  provider: Provider;
  available: boolean;
};

const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  deepseek: "DeepSeek",
  openrouter: "Open Source (via OpenRouter)",
  lmstudio: "Local (LM Studio)",
};
const PROVIDER_ORDER: Provider[] = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "openrouter",
  "lmstudio",
];

const JOB_STORAGE_KEY = "psalter.activeJob";

// What a job was launched with — shown above the output and persisted with the
// job id so a reload restores the correct labels.
type JobRef = {
  psalm: number;
  range: { start: number; end: number } | null;
  meterId: string;
  model: string;
  // Captured at submit so the output label is self-contained on reload (no
  // dependency on the model list having loaded).
  modelLabel: string;
  provider?: Provider;
  variants: number;
};

export function Psalter() {
  // All settings are session-scoped. The server can't read sessionStorage, so
  // state initializes from defaults (matching the SSR HTML — no hydration
  // mismatch) and a mount effect re-applies any stored values.
  const [psalm, setPsalm] = useState(DEFAULT_PREFS.psalm);
  const [variantCount, setVariantCount] = useState(DEFAULT_PREFS.variants);
  const [style, setStyle] = useState(DEFAULT_PREFS.style);
  const [model, setModel] = useState<string>(DEFAULT_PREFS.model);
  const [lang, setLang] = useState<Lang>(DEFAULT_PREFS.lang);
  const [meterId, setMeterId] = useState(DEFAULT_PREFS.meter);
  // Optional verse range within the selected psalm (null = whole psalm).
  const [range, setRange] = useState<{ start: number; end: number } | null>(
    DEFAULT_PREFS.range
  );
  const [refInput, setRefInput] = useState("");
  const [refError, setRefError] = useState(false);
  const [meterOpen, setMeterOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [promptCustomized, setPromptCustomized] = useState(false);
  // Becomes true once stored settings have been read; gates the persist effect
  // so it doesn't clobber sessionStorage with defaults before the load runs.
  const [hydrated, setHydrated] = useState(false);
  // Whether localStorage holds saved defaults (controls the "Clear" link), and a
  // transient flag for the "Saved ✓" confirmation after pressing save.
  const [hasDefaults, setHasDefaults] = useState(false);
  const [defaultsSaved, setDefaultsSaved] = useState(false);
  const meter = findMeter(meterId);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [collapsedProviders, setCollapsedProviders] = useState<Set<Provider>>(
    () => new Set(PROVIDER_ORDER)
  );
  const [hebrew, setHebrew] = useState<string[]>([]);
  const [hebrewLoading, setHebrewLoading] = useState(false);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [generating, setGenerating] = useState(false);
  // True from when Cancel is pressed until the job actually reaches a terminal
  // state — the worker may take a tick to see the flag.
  const [cancelling, setCancelling] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [streamingText, setStreamingText] = useState("");
  const [reasoningCount, setReasoningCount] = useState(0);
  // True from the start of a resumed job until its first snapshot lands, so the
  // status reads "Reconnecting…" rather than the misleading "waiting for first
  // token" (the job is already underway; we just don't have its text yet).
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the in-flight (or last) job was started with, so the output header
  // reflects what's actually being generated, not later edits to the controls.
  const [submitted, setSubmitted] = useState<JobRef | null>(null);
  // The prompt text lives in its own sessionStorage key (too big to bundle with
  // the other prefs comfortably). It isn't rendered on first paint (only inside
  // the closed settings modal), so loading it after mount can't cause a flash.
  // Default is meter-specific; a saved custom prompt overrides it.
  const [systemPrompt, setSystemPrompt] = useState(() =>
    buildSystemPrompt(findMeter(DEFAULT_PREFS.meter), DEFAULT_PREFS.style)
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const elapsedTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeJobRef = useRef<string | null>(null);
  const startRef = useRef<number>(0);
  const t = STRINGS[lang];

  // Load stored settings once after mount, then mark hydrated so the persist
  // effect can start writing. Within a tab the session copy governs; on a fresh
  // session (no session copy yet) we seed from the saved defaults in
  // localStorage, if any. A saved custom prompt (presence of the prompt key)
  // overrides the meter default, so presence ⇒ customized.
  useEffect(() => {
    const sessionPrefs = window.sessionStorage.getItem(PREFS_STORAGE_KEY);
    const usingDefaults = sessionPrefs == null;
    const store = usingDefaults ? window.localStorage : window.sessionStorage;
    const prefsRaw = sessionPrefs ?? window.localStorage.getItem(PREFS_STORAGE_KEY);
    const prefs = parsePrefs(prefsRaw);
    setPsalm(prefs.psalm);
    setVariantCount(prefs.variants);
    setStyle(prefs.style);
    setModel(prefs.model);
    setLang(prefs.lang);
    setMeterId(prefs.meter);
    setRange(prefs.range);
    const storedPrompt = store.getItem(PROMPT_STORAGE_KEY);
    if (storedPrompt) {
      setSystemPrompt(storedPrompt);
      setPromptCustomized(true);
      // Mirror the seeded prompt into the session so it survives reloads within
      // this tab (later reads are session-only once prefs are written below).
      if (usingDefaults)
        window.sessionStorage.setItem(PROMPT_STORAGE_KEY, storedPrompt);
    } else {
      setSystemPrompt(buildSystemPrompt(findMeter(prefs.meter), prefs.style));
    }
    setHasDefaults(window.localStorage.getItem(PREFS_STORAGE_KEY) != null);
    setHydrated(true);
  }, []);

  // Persist prefs to sessionStorage whenever they change, but only after the
  // initial load (gated by `hydrated`) so we never overwrite stored values with
  // the defaults rendered on first paint.
  useEffect(() => {
    if (!hydrated) return;
    window.sessionStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        lang,
        model,
        psalm,
        variants: variantCount,
        meter: meterId,
        style,
        range,
      })
    );
  }, [hydrated, lang, model, psalm, variantCount, meterId, style, range]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // Choosing a metre updates the default prompt (unless the user has customized
  // it — then their text is left alone and the metre still rides in the user
  // prompt at generation time).
  function selectMeter(id: string) {
    setMeterId(id);
    if (!promptCustomized)
      setSystemPrompt(buildSystemPrompt(findMeter(id), style));
  }

  // The literal↔poetic dial rebuilds the default prompt (the fidelity rules are
  // style-dependent). A customized prompt is left alone, so the slider has no
  // effect until the prompt is reset to default.
  function selectStyle(level: number) {
    setStyle(level);
    if (!promptCustomized) setSystemPrompt(buildSystemPrompt(meter, level));
  }

  function applyReference(value: string) {
    const parsed = parseReference(value, psalm);
    if (!parsed) {
      setRefError(true);
      return;
    }
    setRefError(false);
    setPsalm(parsed.psalm);
    setRange(
      parsed.start && parsed.end
        ? { start: parsed.start, end: parsed.end }
        : null
    );
  }

  function selectPsalmFromGrid(n: number) {
    setPsalm(n);
    setRange(null);
    setRefInput("");
    setRefError(false);
  }

  // Clear the reference field and any verse range, falling back to the whole
  // psalm. Leaves the selected psalm itself untouched.
  function clearReference() {
    setRefInput("");
    setRange(null);
    setRefError(false);
  }

  // Copy the current (session) settings into localStorage so new tabs/sessions
  // start from them. The live session copy still governs edits in this tab.
  function saveAsDefaults() {
    window.localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        lang,
        model,
        psalm,
        variants: variantCount,
        meter: meterId,
        style,
        range,
      })
    );
    if (promptCustomized) {
      window.localStorage.setItem(PROMPT_STORAGE_KEY, systemPrompt);
    } else {
      window.localStorage.removeItem(PROMPT_STORAGE_KEY);
    }
    setHasDefaults(true);
    setDefaultsSaved(true);
    window.setTimeout(() => setDefaultsSaved(false), 1800);
  }

  function clearDefaults() {
    window.localStorage.removeItem(PREFS_STORAGE_KEY);
    window.localStorage.removeItem(PROMPT_STORAGE_KEY);
    setHasDefaults(false);
  }

  function openSettings() {
    setPromptDraft(systemPrompt);
    setSettingsOpen(true);
  }
  function savePrompt() {
    const isCustom = promptDraft !== buildSystemPrompt(meter, style);
    setSystemPrompt(promptDraft);
    setPromptCustomized(isCustom);
    if (isCustom) {
      window.sessionStorage.setItem(PROMPT_STORAGE_KEY, promptDraft);
    } else {
      window.sessionStorage.removeItem(PROMPT_STORAGE_KEY);
    }
    setSettingsOpen(false);
  }
  function resetPrompt() {
    const fresh = buildSystemPrompt(meter, style);
    setSystemPrompt(fresh);
    setPromptDraft(fresh);
    window.sessionStorage.removeItem(PROMPT_STORAGE_KEY);
    setPromptCustomized(false);
  }

  // Close the settings dialog on Escape.
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((d) => setModels((d.models as ModelInfo[]) ?? []));
  }, []);

  // Expand the provider group holding the selected model so it's visible. Runs
  // once models have loaded and whenever the selected model changes (e.g. after
  // session settings are restored on mount).
  useEffect(() => {
    const selected = models.find((m) => m.id === model);
    if (!selected) return;
    setCollapsedProviders((prev) => {
      if (!prev.has(selected.provider)) return prev;
      const next = new Set(prev);
      next.delete(selected.provider);
      return next;
    });
  }, [models, model]);

  useEffect(() => {
    let cancelled = false;
    setHebrewLoading(true);
    fetch(`/api/psalm/${psalm}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setHebrew(d.verses ?? []);
      })
      .finally(() => {
        if (!cancelled) setHebrewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [psalm]);

  type Snapshot = {
    status?: string;
    text?: string;
    reasoning?: number;
    createdAt?: number;
    result?: unknown;
    error?: string;
  };

  // Follow a job to completion: live SSE tail first, falling back to polling if
  // the stream drops. The job itself runs server-side regardless, so neither
  // channel dropping loses work — and we can resume from the id at any time.
  async function consumeJob(
    jobId: string,
    ref?: JobRef,
    opts?: { resume?: boolean }
  ) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    activeJobRef.current = jobId;
    // Persist (per-tab via sessionStorage) the id AND the reference so a reload
    // restores this tab's job — without other tabs picking it up.
    window.sessionStorage.setItem(
      JOB_STORAGE_KEY,
      JSON.stringify({ id: jobId, ref: ref ?? null })
    );
    if (ref) setSubmitted(ref);

    setGenerating(true);
    setCancelling(false);
    setError(null);
    setResult(null);
    setStreamingText("");
    setReasoningCount(0);
    setResuming(opts?.resume ?? false);
    startRef.current = Date.now();
    setElapsed(0);
    if (elapsedTimer.current) clearInterval(elapsedTimer.current);
    elapsedTimer.current = setInterval(
      () => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)),
      250
    );

    const stop = () => {
      if (activeJobRef.current === jobId) {
        activeJobRef.current = null;
        window.sessionStorage.removeItem(JOB_STORAGE_KEY);
        setGenerating(false);
        setCancelling(false);
        setResuming(false);
        if (elapsedTimer.current) {
          clearInterval(elapsedTimer.current);
          elapsedTimer.current = null;
        }
      }
    };
    const apply = (s: Snapshot) => {
      // The first snapshot means we're reconnected and have the true state.
      setResuming(false);
      if (typeof s.createdAt === "number") startRef.current = s.createdAt;
      if (typeof s.text === "string") setStreamingText(s.text);
      if (typeof s.reasoning === "number") setReasoningCount(s.reasoning);
    };
    // Returns true once the job reached a terminal state (caller should stop).
    const handleTerminal = (s: Snapshot): boolean => {
      if (!s.status || s.status === "running") return false;
      if (s.status === "done") {
        setResult((s.result ?? null) as GenerateResponse | null);
      } else if (s.status === "error") {
        setError(s.error || "unknown error");
      }
      // "cancelled" / "missing" → silent stop, no error.
      stop();
      return true;
    };

    // 1) Live SSE tail.
    try {
      const r = await fetch(`/api/job/${jobId}/stream`, {
        signal: controller.signal,
      });
      if (r.ok && r.body) {
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const raw of events) {
            if (!raw.startsWith("data:")) continue; // skip ": ping" heartbeats
            const payload = raw.slice(raw.indexOf("data:") + 5).trim();
            if (!payload) continue;
            let snap: Snapshot;
            try {
              snap = JSON.parse(payload);
            } catch {
              continue;
            }
            apply(snap);
            if (handleTerminal(snap)) return;
          }
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      // otherwise fall through to polling
    }

    // 2) Poll fallback (stream dropped before a terminal state).
    while (!controller.signal.aborted) {
      try {
        const res = await fetch(`/api/job/${jobId}`, {
          signal: controller.signal,
        });
        if (res.status === 404) {
          stop();
          return;
        }
        const job: Snapshot = await res.json();
        apply(job);
        if (handleTerminal(job)) return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        // transient network error — keep polling
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async function cancel() {
    const id = activeJobRef.current;
    if (!id || cancelling) return;
    setCancelling(true);
    try {
      await fetch(`/api/job/${id}/cancel`, { method: "POST" });
    } catch {
      // The worker may still see the flag on its next tick; ignore network blips.
    }
    // Stay in the cancelling state until the stream/poll observes the terminal
    // status and stop() clears it.
  }

  async function generate() {
    const selected = models.find((m) => m.id === model);
    const ref: JobRef = {
      psalm,
      range,
      meterId,
      model,
      modelLabel: selected?.label ?? model,
      provider: selected?.provider,
      variants: variantCount,
    };
    setGenerating(true);
    setError(null);
    setSubmitted(ref);
    // Clear the previous output immediately so it doesn't linger during the
    // POST round-trip (consumeJob also clears these, but only once the job id
    // comes back).
    setResult(null);
    setStreamingText("");
    setReasoningCount(0);
    try {
      const r = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          psalm,
          variants: variantCount,
          model,
          systemPrompt,
          meter: meterId,
          style,
          verseStart: range?.start,
          verseEnd: range?.end,
        }),
      });
      const data = await r.json();
      if (!r.ok || !data.jobId) {
        setError(data.error ?? `HTTP ${r.status}`);
        setGenerating(false);
        return;
      }
      void consumeJob(data.jobId, ref);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setGenerating(false);
    }
  }

  // Resume an in-flight job after a reload / returning to the tab.
  useEffect(() => {
    const raw = window.sessionStorage.getItem(JOB_STORAGE_KEY);
    if (!raw) return;
    try {
      const { id, ref } = JSON.parse(raw) as {
        id: string;
        ref: JobRef | null;
      };
      if (id) void consumeJob(id, ref ?? undefined, { resume: true });
    } catch {
      // Malformed entry — drop it.
      window.sessionStorage.removeItem(JOB_STORAGE_KEY);
    }
    // consumeJob is stable for this purpose; run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <header className="border-b border-stone-200 dark:border-stone-800 px-6 py-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-serif">{t.appTitle}</h1>
          <p className="text-sm text-stone-500">{t.appSubtitle}</p>
        </div>
        <div className="shrink-0 flex items-center gap-3">
          <div className="inline-flex border border-stone-300 dark:border-stone-700 rounded overflow-hidden text-xs tabular-nums">
            {(["en", "de"] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                className={`px-2.5 py-1.5 sm:px-2 sm:py-1 transition-colors ${
                  lang === l
                    ? "bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900"
                    : "text-stone-600 hover:bg-stone-200 dark:text-stone-400 dark:hover:bg-stone-800"
                }`}
                aria-pressed={lang === l}
                aria-label={l === "en" ? "English" : "Deutsch"}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <button
            onClick={openSettings}
            title={t.settings}
            aria-label={t.settings}
            className="relative p-2 sm:p-1.5 rounded text-stone-500 hover:bg-stone-200 hover:text-stone-900 dark:hover:bg-stone-800 dark:hover:text-stone-100 transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-5 h-5"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            {promptCustomized && (
              <span className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-stone-50 dark:ring-stone-950" />
            )}
          </button>
        </div>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-[1fr_320px_2fr] gap-6 p-6">
        <section className="min-w-0">
          <h2 className="text-sm uppercase tracking-wider text-stone-500 mb-3">
            {t.hebrewHeader(psalm)}
          </h2>
          <div
            dir="rtl"
            lang="he"
            className="font-serif text-4xl leading-relaxed text-stone-800 dark:text-stone-200 whitespace-pre-wrap"
            style={{ fontFamily: '"SBL Hebrew", "Ezra SIL", "Times New Roman", serif' }}
          >
            {hebrewLoading ? (
              <span className="text-stone-400 text-base">{t.hebrewLoading}</span>
            ) : (
              (range ? hebrew.slice(range.start - 1, range.end) : hebrew).map(
                (v, i) => {
                  const num = (range ? range.start : 1) + i;
                  return (
                    <p key={num} className="mb-2">
                      <span className="text-xs text-stone-400 align-top mx-1">
                        {num}
                      </span>
                      {v}
                    </p>
                  );
                }
              )
            )}
          </div>
        </section>

        <aside className="lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden space-y-4 border border-stone-200 dark:border-stone-800 rounded-lg p-4 bg-white dark:bg-stone-900">
          <div>
            <label className="block text-sm mb-2">
              {t.psalmLabel}{" "}
              <span className="text-stone-400">— {psalm}</span>
            </label>
            <div className="grid grid-cols-10 gap-1 sm:gap-0.5">
              {Array.from({ length: 150 }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  onClick={() => selectPsalmFromGrid(n)}
                  className={`text-xs py-2 sm:text-[10px] sm:py-1 rounded tabular-nums transition-colors ${
                    n === psalm
                      ? "bg-stone-800 text-stone-50 dark:bg-stone-200 dark:text-stone-900"
                      : "text-stone-600 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="mt-2">
              <label className="block text-xs text-stone-500 mb-1">
                {t.referenceLabel}
              </label>
              <div className="relative">
                <input
                  type="text"
                  inputMode="text"
                  value={refInput}
                  onChange={(e) => {
                    setRefInput(e.target.value);
                    if (refError) setRefError(false);
                  }}
                  onBlur={(e) => applyReference(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyReference((e.target as HTMLInputElement).value);
                    }
                  }}
                  placeholder={t.referencePlaceholder}
                  aria-invalid={refError}
                  className={`w-full rounded border py-1.5 pl-2.5 text-sm tabular-nums bg-stone-50 dark:bg-stone-950 outline-none focus:ring-2 focus:ring-stone-400 dark:focus:ring-stone-500 focus:border-stone-400 dark:focus:border-stone-500 ${
                    refInput || range ? "pr-8" : "pr-2.5"
                  } ${
                    refError
                      ? "border-red-400 dark:border-red-700"
                      : "border-stone-300 dark:border-stone-700"
                  }`}
                />
                {(refInput || range) && (
                  <button
                    type="button"
                    onClick={clearReference}
                    title={t.referenceClear}
                    aria-label={t.referenceClear}
                    className="absolute inset-y-0 right-0 flex items-center pr-2.5 pl-1 text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="w-3.5 h-3.5"
                      aria-hidden="true"
                    >
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
              {refError && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {t.referenceInvalid}
                </p>
              )}
            </div>
          </div>
          {generating ? (
            <button
              onClick={cancel}
              disabled={cancelling}
              className="w-full py-2.5 sm:py-2 rounded border border-stone-300 text-stone-700 hover:bg-stone-900 hover:text-stone-50 hover:border-stone-900 disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-stone-700 disabled:hover:border-stone-300 disabled:cursor-default dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-300 dark:hover:text-stone-900 dark:hover:border-stone-300 dark:disabled:hover:bg-transparent dark:disabled:hover:text-stone-300 dark:disabled:hover:border-stone-700 transition-colors"
            >
              {cancelling ? t.cancelling : t.cancel} · {elapsed}s
            </button>
          ) : (
            <button
              onClick={generate}
              className="w-full py-2.5 sm:py-2 rounded bg-stone-200 text-stone-900 hover:bg-stone-900 hover:text-stone-50 dark:bg-stone-700 dark:text-stone-50 dark:hover:bg-stone-300 dark:hover:text-stone-900 transition-colors"
            >
              {t.generate}
            </button>
          )}
          {generating && (
            <div className="h-1 w-full overflow-hidden rounded bg-stone-200 dark:bg-stone-800">
              <div className="h-full w-1/3 bg-stone-800 dark:bg-stone-200 animate-indeterminate" />
            </div>
          )}
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          {result?.meta?.usage && (
            <p className="text-xs text-stone-400">
              {t.usage(
                result.meta.usage.input_tokens,
                result.meta.usage.output_tokens,
                result.meta.usage.cache_read_input_tokens
              )}
            </p>
          )}
          <div>
            <label className="block text-sm mb-1">
              {t.variantsLabel(variantCount)}
            </label>
            <input
              type="range"
              min={1}
              max={5}
              value={variantCount}
              onChange={(e) => setVariantCount(Number(e.target.value))}
              className="variants-slider w-full"
              style={
                {
                  "--p": `${((variantCount - 1) / 4) * 100}%`,
                } as React.CSSProperties
              }
            />
          </div>
          <div>
            <label className="block text-sm mb-1">
              {t.styleLabel}{" "}
              <span className="text-stone-400">— {t.styleNames[style - 1]}</span>
            </label>
            <input
              type="range"
              min={1}
              max={5}
              value={style}
              onChange={(e) => selectStyle(Number(e.target.value))}
              className="variants-slider w-full"
              style={
                {
                  "--p": `${((style - 1) / 4) * 100}%`,
                } as React.CSSProperties
              }
            />
            <div className="mt-1 flex justify-between text-[10px] uppercase tracking-wider text-stone-400">
              <span>{t.styleLiteral}</span>
              <span>{t.stylePoetic}</span>
            </div>
          </div>
          <div>
            <button
              onClick={() => setMeterOpen((o) => !o)}
              className="flex w-full items-center gap-1.5 text-sm py-1"
              aria-expanded={meterOpen}
            >
              <span
                className={`inline-block text-stone-400 transition-transform ${
                  meterOpen ? "rotate-90" : ""
                }`}
              >
                ▸
              </span>
              <span>{t.meterLabel}</span>
              {!meterOpen && (
                <span className="ml-auto tabular-nums text-xs text-stone-500 dark:text-stone-300">
                  {meter.short}
                </span>
              )}
            </button>
            {meterOpen && (
              <div className="flex flex-wrap gap-1 mt-2">
                {METERS.map((m) => {
                  const selected = m.id === meterId;
                  return (
                    <button
                      key={m.id}
                      onClick={() => selectMeter(m.id)}
                      title={m.label}
                      className={`text-sm px-3 py-1.5 sm:text-xs sm:px-2.5 sm:py-1 rounded-full border tabular-nums transition-colors ${
                        selected
                          ? "bg-stone-900 text-stone-50 border-stone-900 dark:bg-stone-100 dark:text-stone-900 dark:border-stone-100"
                          : "border-stone-300 text-stone-700 hover:border-stone-900 hover:text-stone-900 dark:border-stone-700 dark:text-stone-300 dark:hover:border-stone-100 dark:hover:text-stone-100"
                      }`}
                    >
                      {m.short}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <button
              onClick={() => setModelOpen((o) => !o)}
              className="flex w-full items-center gap-1.5 text-sm py-1"
              aria-expanded={modelOpen}
            >
              <span
                className={`inline-block text-stone-400 transition-transform ${
                  modelOpen ? "rotate-90" : ""
                }`}
              >
                ▸
              </span>
              <span>{t.modelLabel}</span>
              {!modelOpen && (
                <span className="ml-auto max-w-[60%] truncate text-right text-xs text-stone-500 dark:text-stone-300">
                  {(() => {
                    const sel = models.find((m) => m.id === model);
                    return sel
                      ? `${PROVIDER_LABEL[sel.provider]} · ${sel.label}`
                      : model;
                  })()}
                </span>
              )}
            </button>
            {modelOpen && (
            <div className="space-y-1 mt-2">
              {PROVIDER_ORDER.map((p) => {
                const group = models.filter((m) => m.provider === p);
                if (group.length === 0) return null;
                const collapsed = collapsedProviders.has(p);
                const containsSelected = group.some((m) => m.id === model);
                return (
                  <div key={p}>
                    <button
                      onClick={() =>
                        setCollapsedProviders((prev) => {
                          const next = new Set(prev);
                          if (next.has(p)) next.delete(p);
                          else next.add(p);
                          return next;
                        })
                      }
                      className="flex w-full items-center gap-1.5 text-left text-[11px] sm:text-[10px] uppercase tracking-wider text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 py-1.5 sm:py-1"
                      aria-expanded={!collapsed}
                    >
                      <span
                        className={`inline-block transition-transform ${
                          collapsed ? "" : "rotate-90"
                        }`}
                      >
                        ▸
                      </span>
                      <span>{PROVIDER_LABEL[p]}</span>
                      <span className="text-stone-300 dark:text-stone-600">
                        ({group.length})
                      </span>
                      {collapsed && containsSelected && (
                        <span className="ml-auto normal-case tracking-normal text-[11px] text-stone-600 dark:text-stone-300">
                          {group.find((m) => m.id === model)?.label}
                        </span>
                      )}
                    </button>
                    {!collapsed && (
                      <div className="flex flex-wrap gap-1 mt-1 mb-2">
                        {group.map((m) => {
                          const selected = m.id === model;
                          const disabled = !m.available;
                          return (
                            <button
                              key={m.id}
                              onClick={() => !disabled && setModel(m.id)}
                              disabled={disabled}
                              title={
                                disabled
                                  ? t.missingKey(PROVIDER_LABEL[p])
                                  : m.id
                              }
                              className={`text-left text-sm px-3 py-1.5 sm:text-xs sm:px-2.5 sm:py-1 rounded-full border transition-colors ${
                                selected
                                  ? "bg-stone-900 text-stone-50 border-stone-900 dark:bg-stone-100 dark:text-stone-900 dark:border-stone-100"
                                  : disabled
                                  ? "border-stone-200 text-stone-300 line-through cursor-not-allowed dark:border-stone-800 dark:text-stone-600"
                                  : "border-stone-300 text-stone-700 hover:border-stone-900 hover:text-stone-900 dark:border-stone-700 dark:text-stone-300 dark:hover:border-stone-100 dark:hover:text-stone-100"
                              }`}
                            >
                              {m.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            )}
          </div>
          <div className="pt-3 border-t border-stone-200 dark:border-stone-800 flex items-center justify-between gap-2">
            <button
              onClick={saveAsDefaults}
              title={t.saveDefaultsHint}
              className="text-xs text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"
            >
              {defaultsSaved ? t.saveDefaultsDone : t.saveDefaults}
            </button>
            {hasDefaults && (
              <button
                onClick={clearDefaults}
                className="text-xs text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
              >
                {t.clearDefaults}
              </button>
            )}
          </div>
        </aside>

        <section className="min-w-0 space-y-6">
          <div className="space-y-1">
            <h2 className="text-sm uppercase tracking-wider text-stone-500">
              {t.outputHeader}
            </h2>
            {(generating || result) &&
              (() => {
                const live = models.find((x) => x.id === model);
                const ref: JobRef = submitted ?? {
                  psalm,
                  range,
                  meterId,
                  model,
                  modelLabel: live?.label ?? model,
                  provider: live?.provider,
                  variants: variantCount,
                };
                return (
                  <div className="space-y-0.5">
                    <p className="font-serif text-lg tabular-nums text-stone-700 dark:text-stone-300">
                      Psalm {ref.psalm}
                      {ref.range ? `:${ref.range.start}–${ref.range.end}` : ""}
                    </p>
                    <p className="text-xs text-stone-400">
                      {findMeter(ref.meterId).short} · {t.variantsCount(ref.variants)} ·{" "}
                      {ref.provider ? `${PROVIDER_LABEL[ref.provider]} · ` : ""}
                      {ref.modelLabel}
                    </p>
                  </div>
                );
              })()}
          </div>
          {!result && !generating && (
            <p className="text-stone-400 italic">
              {t.pressGenerate(psalm, variantCount)}
            </p>
          )}
          {generating && (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600 dark:border-stone-700 dark:border-t-stone-300" />
                <p className="text-stone-400 italic">
                  {streamingText.length > 0
                    ? t.streamingChars(streamingText.length, elapsed)
                    : reasoningCount > 0
                    ? t.streamingThinking(reasoningCount, elapsed)
                    : resuming
                    ? t.streamingResuming(elapsed)
                    : t.streamingWaiting(elapsed)}
                </p>
                <button
                  onClick={cancel}
                  disabled={cancelling}
                  className="ml-auto shrink-0 text-xs text-stone-500 underline hover:text-stone-800 disabled:no-underline disabled:opacity-70 disabled:hover:text-stone-500 dark:hover:text-stone-200 dark:disabled:hover:text-stone-500"
                >
                  {cancelling ? t.cancelling : t.cancel}
                </button>
              </div>
              {streamingText.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-stone-500 hover:text-stone-800 dark:hover:text-stone-200">
                    {t.showRaw}
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded bg-stone-100 dark:bg-stone-900 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-stone-700 dark:text-stone-300">
                    {streamingText}
                  </pre>
                </details>
              )}
            </div>
          )}
          {result?.variants?.map((variant, vi) => (
            <article
              key={vi}
              className="border border-stone-200 dark:border-stone-800 rounded-lg p-4 bg-white dark:bg-stone-900"
            >
              <header className="flex items-baseline justify-between mb-3">
                <h3 className="font-serif text-lg">{t.versionHeader(vi + 1)}</h3>
                <button
                  onClick={() =>
                    navigator.clipboard.writeText(stanzasToText(variant.stanzas))
                  }
                  className="text-xs text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"
                >
                  {t.copy}
                </button>
              </header>
              {variant.notes && (
                <p className="text-xs text-stone-500 italic mb-3">
                  {variant.notes}
                </p>
              )}
              <div className="font-serif text-base leading-relaxed space-y-3">
                {variant.stanzas.map((s, si) => (
                  <div key={si}>
                    {s.lines.map((line, li) => (
                      <p key={li} className={li % 2 === 1 ? "pl-6" : ""}>
                        {line}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            </article>
          ))}
        </section>
      </main>

      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
          onClick={() => setSettingsOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={t.settings}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="my-auto w-full max-w-2xl rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-xl"
          >
            <header className="flex items-center justify-between border-b border-stone-200 dark:border-stone-800 px-4 py-3">
              <h2 className="text-sm font-medium">{t.settings}</h2>
              <button
                onClick={() => setSettingsOpen(false)}
                aria-label={t.promptCancel}
                className="text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 text-lg leading-none"
              >
                ✕
              </button>
            </header>
            <div className="p-4 space-y-3">
              <label className="block text-sm font-medium">
                {t.promptHeader}
              </label>
              <textarea
                value={promptDraft}
                onChange={(e) => setPromptDraft(e.target.value)}
                rows={18}
                spellCheck={false}
                className="w-full rounded border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 p-3 font-mono text-[11px] leading-relaxed text-stone-700 dark:text-stone-300"
              />
              <p className="text-xs text-stone-400">{t.promptHint}</p>
            </div>
            <footer className="flex items-center justify-between gap-3 border-t border-stone-200 dark:border-stone-800 px-4 py-3">
              <button
                onClick={resetPrompt}
                disabled={!promptCustomized}
                className="text-xs text-stone-500 hover:text-stone-800 disabled:opacity-40 disabled:hover:text-stone-500 dark:hover:text-stone-200"
              >
                {t.promptReset}
              </button>
              <div className="flex items-center gap-3 text-xs">
                <button
                  onClick={() => setSettingsOpen(false)}
                  className="text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"
                >
                  {t.promptCancel}
                </button>
                <button
                  onClick={savePrompt}
                  disabled={!promptDraft.trim()}
                  className="px-3 py-1.5 rounded bg-stone-900 text-stone-50 hover:bg-stone-700 disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300"
                >
                  {t.promptSave}
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

function stanzasToText(stanzas: Stanza[]): string {
  return stanzas
    .map((s) => s.lines.join("\n"))
    .join("\n\n");
}
