export type Lang = "en" | "de";

export const STRINGS = {
  en: {
    appTitle: "German Metrical Psalter",
    appSubtitle:
      "Renders the Hebrew Psalms into singable modern German verse — in the metre of your choice.",
    hebrewHeader: (n: number) => `Hebrew — Psalm ${n}`,
    hebrewLoading: "Loading…",
    psalmLabel: "Psalm",
    referenceLabel: "Reference (optional)",
    referencePlaceholder: "e.g. 119:1-6",
    referenceInvalid: "Couldn’t read that reference",
    referenceClear: "Clear reference",
    variantsLabel: (n: number) => `Variants: ${n}`,
    variantsCount: (n: number) => `${n} variant${n === 1 ? "" : "s"}`,
    styleLabel: "Rendering",
    styleLiteral: "literal",
    stylePoetic: "poetic",
    styleNames: ["Strictly literal", "Faithful", "Balanced", "Poetic", "Free paraphrase"],
    meterLabel: "Metre",
    trialLabel: "Metre trial — two stanzas only",
    trialHint:
      "Renders exactly two complete stanzas instead of a verse range, so a metre is never judged on a half-finished stanza. How far it gets is up to the psalm.",
    trialBadge: "trial · 2 stanzas",
    sweepLabel: "…in every metre at once",
    sweepHint:
      "Runs the trial once per metre, one version each, so you can compare them without generating them one at a time.",
    sweepGenerate: (n: number) => `Trial all ${n} metres`,
    sweepAllMetres: (n: number) => `all ${n} metres`,
    sweepProgress: (done: number, total: number, s: number) =>
      `${done} of ${total} metres done · ${s}s`,
    sweepQueued: "queued",
    sweepRunning: "generating…",
    sweepCancelled: "cancelled",
    modelLabel: "Model",
    missingKey: (provider: string) => `Missing API key for ${provider}`,
    generate: "Generate",
    generating: (s: number) => `Generating… ${s}s`,
    cancel: "Cancel",
    cancelling: "Cancelling…",
    outputHeader: "German rendering",
    pressGenerate: (psalm: number, n: number) =>
      `Press Generate to render Psalm ${psalm} into ${n} version${n === 1 ? "" : "s"}.`,
    composing: (s: number) =>
      `Composing… ${s}s elapsed. Long psalms may take a minute or two.`,
    streamingWaiting: (s: number) =>
      `Waiting for first token… ${s}s (reasoning models often pause 30–120s before writing).`,
    streamingResuming: (s: number) =>
      `Reconnecting to job… ${s}s`,
    streamingThinking: (count: number, s: number) =>
      `Thinking… ${count.toLocaleString()} reasoning chunks in ${s}s`,
    streamingChars: (chars: number, s: number) =>
      `Receiving… ${chars.toLocaleString()} chars in ${s}s`,
    showRaw: "Show raw stream",
    versionHeader: (n: number) => `Version ${n}`,
    copy: "Copy",
    usage: (input: number, output: number, cached?: number) =>
      `${input} in / ${output} out${cached ? ` · ${cached} cached` : ""}`,
    promptHeader: "System prompt",
    promptCustomized: "customized",
    promptEdit: "Edit",
    promptSave: "Save",
    promptCancel: "Cancel",
    promptReset: "Reset to default",
    promptHint:
      "Sent to the model on every generation. Saved in your browser.",
    displayHeader: "Display",
    fontSizeLabel: "Font size",
    typefaceLabel: "Typeface",
    typefaceSerif: "Serif",
    typefaceSans: "Sans",
    settings: "Settings",
    saveDefaults: "Save as defaults",
    saveDefaultsDone: "Saved ✓",
    saveDefaultsHint:
      "Remember the current settings so new tabs and sessions start with them.",
    clearDefaults: "Clear saved defaults",
  },
  de: {
    appTitle: "Deutscher metrischer Psalter",
    appSubtitle:
      "Vertont die hebräischen Psalmen als singbares modernes Deutsch — im Versmaß deiner Wahl.",
    hebrewHeader: (n: number) => `Hebräisch — Psalm ${n}`,
    hebrewLoading: "Laden…",
    psalmLabel: "Psalm",
    referenceLabel: "Stelle (optional)",
    referencePlaceholder: "z. B. 119:1-6",
    referenceInvalid: "Stelle nicht erkannt",
    referenceClear: "Stelle löschen",
    variantsLabel: (n: number) => `Fassungen: ${n}`,
    variantsCount: (n: number) => `${n} Fassung${n === 1 ? "" : "en"}`,
    styleLabel: "Übertragung",
    styleLiteral: "wörtlich",
    stylePoetic: "poetisch",
    styleNames: ["Streng wörtlich", "Texttreu", "Ausgewogen", "Poetisch", "Freie Nachdichtung"],
    meterLabel: "Versmaß",
    trialLabel: "Versmaß-Probe — nur zwei Strophen",
    trialHint:
      "Setzt genau zwei vollständige Strophen statt eines Versbereichs, damit ein Versmaß nie an einer halben Strophe gemessen wird. Wie weit der Text dabei kommt, bestimmt der Psalm.",
    trialBadge: "Probe · 2 Strophen",
    sweepLabel: "…in jedem Versmaß zugleich",
    sweepHint:
      "Führt die Probe einmal pro Versmaß aus, je eine Fassung, damit du sie vergleichen kannst, ohne sie einzeln zu erzeugen.",
    sweepGenerate: (n: number) => `Alle ${n} Versmaße proben`,
    sweepAllMetres: (n: number) => `alle ${n} Versmaße`,
    sweepProgress: (done: number, total: number, s: number) =>
      `${done} von ${total} Versmaßen fertig · ${s}s`,
    sweepQueued: "in Warteschlange",
    sweepRunning: "wird erzeugt…",
    sweepCancelled: "abgebrochen",
    modelLabel: "Modell",
    missingKey: (provider: string) => `Kein API-Schlüssel für ${provider}`,
    generate: "Erzeugen",
    generating: (s: number) => `Erzeuge… ${s}s`,
    cancel: "Abbrechen",
    cancelling: "Breche ab…",
    outputHeader: "Deutsche Fassung",
    pressGenerate: (psalm: number, n: number) =>
      `Drücke „Erzeugen", um Psalm ${psalm} in ${n} Fassung${n === 1 ? "" : "en"} zu setzen.`,
    composing: (s: number) =>
      `Komponiere… ${s}s vergangen. Lange Psalmen brauchen ein paar Minuten.`,
    streamingWaiting: (s: number) =>
      `Warte auf erstes Token… ${s}s (Reasoning-Modelle denken oft 30–120s, bevor sie schreiben).`,
    streamingResuming: (s: number) =>
      `Verbinde erneut mit Auftrag… ${s}s`,
    streamingThinking: (count: number, s: number) =>
      `Denke nach… ${count.toLocaleString()} Reasoning-Chunks in ${s}s`,
    streamingChars: (chars: number, s: number) =>
      `Empfange… ${chars.toLocaleString()} Zeichen in ${s}s`,
    showRaw: "Rohdaten anzeigen",
    versionHeader: (n: number) => `Fassung ${n}`,
    copy: "Kopieren",
    usage: (input: number, output: number, cached?: number) =>
      `${input} ein / ${output} aus${cached ? ` · ${cached} aus Cache` : ""}`,
    promptHeader: "System-Prompt",
    promptCustomized: "angepasst",
    promptEdit: "Bearbeiten",
    promptSave: "Speichern",
    promptCancel: "Abbrechen",
    promptReset: "Auf Standard zurücksetzen",
    promptHint:
      "Wird bei jeder Erzeugung an das Modell gesendet. Im Browser gespeichert.",
    displayHeader: "Darstellung",
    fontSizeLabel: "Schriftgröße",
    typefaceLabel: "Schriftart",
    typefaceSerif: "Serif",
    typefaceSans: "Sans",
    settings: "Einstellungen",
    saveDefaults: "Als Standard speichern",
    saveDefaultsDone: "Gespeichert ✓",
    saveDefaultsHint:
      "Aktuelle Einstellungen merken, damit neue Tabs und Sitzungen damit starten.",
    clearDefaults: "Standard löschen",
  },
} as const satisfies Record<Lang, unknown>;
