import type { Meter } from "./meters";

// The literal↔poetic dial. 1 = strictly literal (every word anchored in the
// Hebrew), 5 = freely poetic (a devotional paraphrase). 2 ("faithful") is the
// historical default and reproduces this psalter's original strict-fidelity
// behaviour.
export const STYLE_MIN = 1;
export const STYLE_MAX = 5;
export const DEFAULT_STYLE = 2;

export function clampStyle(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_STYLE;
  return Math.min(STYLE_MAX, Math.max(STYLE_MIN, Math.round(n)));
}

// Metre-trial mode. Instead of rendering a fixed verse range, the model renders
// exactly this many complete stanzas and stops wherever that lands. Sampling a
// metre with a fixed four-verse range is the obvious approach, but four verses
// rarely close on a stanza boundary — so the metre gets judged on a half-finished
// strophe. Asking for whole stanzas instead lets the verse count fall where the
// metre wants it.
export const TRIAL_STANZAS = 2;

// How many opening verses are handed to the model as raw material in trial mode.
// Generous enough that even a six-line strophe can't run out of text; the prompt
// is explicit that this is not a quota.
export const TRIAL_CONTEXT_VERSES = 10;

// Per-level guidance. `name` is shown in the # APPROACH heading; `body` sets the
// fidelity stance, register and rhyme priority for that level.
const STYLE_GUIDANCE: Record<number, { name: string; body: string }> = {
  1: {
    name: "Strictly literal",
    body: `Render the Hebrew as close to word-for-word as singable German allows. **Do not invent content** — no adjective, phrase, or image without a direct anchor in the Hebrew. Use plain, contemporary vocabulary. Accept rough metre and near-rhymes (or no rhyme on the odd line) before adding anything the text does not say. Faithfulness outranks beauty at every turn.`,
  },
  2: {
    name: "Faithful",
    body: `Stay strictly faithful: every noun, verb, and modifier must map to something in the Hebrew — **do not invent content** to satisfy rhyme or metre. Within that constraint, aim for singable, natural verse with true rhymes or honest near-rhymes. Prefer an imperfect rhyme over an invented detail. (This is the historical default for this psalter.)`,
  },
  3: {
    name: "Balanced",
    body: `Keep the substance faithful — do not add claims the Hebrew does not make — but you may lightly amplify imagery that is already latent in the text, and you may choose the more beautiful of two faithful phrasings. Rhyme and flow matter here; where they tie with fidelity, fidelity still wins.`,
  },
  4: {
    name: "Poetic",
    body: `Take creative latitude. You may add connotative imagery, expand a clause for beauty, or paraphrase freely, **as long as you stay true to the psalm's spirit and never contradict the Hebrew**. Prioritise musicality, true rhyme, and emotional resonance. An elevated, even lightly archaic register is welcome where it serves the verse.`,
  },
  5: {
    name: "Free paraphrase",
    body: `Render the psalm as a freely poetic re-imagining. Prioritise beauty, song, and feeling over literal correspondence: add imagery, expand, and interpret generously, in the spirit of a devotional metrical paraphrase (Isaac Watts or the freest of the old psalters). It must remain recognisably **this** psalm and must not contradict its meaning, but it need not track the Hebrew clause by clause.`,
  },
};

function metreSection(m: Meter): string {
  const lines = m.pattern
    .map((n, i) => `  Line ${i + 1}: ${n} syllables`)
    .join("\n");
  return `# METRE — ${m.label}

Each stanza is a ${m.pattern.length}-line strophe with this syllable pattern:

${lines}

The foot is ${m.foot}. German word stress must align with the metrical stress: stressed German syllables must fall on the strong beats, unstressed on the weak.

Rhyme scheme is ${m.rhyme}. Rhymes must be true German rhymes (echte Reime), not merely visual.`;
}

// The fidelity discussion is style-dependent. At literal settings it is the
// overriding rule; at poetic settings it relaxes into creative latitude. A few
// rules hold at every setting (superscription, covering the passage).
function fidelitySection(style: number): string {
  const literal = style <= 2;
  const heading = literal
    ? "# FIDELITY — THE MOST IMPORTANT RULE"
    : "# FIDELITY vs. LATITUDE";

  const stance = literal
    ? `The metrical version exists to *carry the Hebrew*, not to ornament it. Treat the Hebrew text as inviolable in substance.

- **Do not invent content.** Never add adjectives, qualifiers, prepositional phrases, or decorative lines that have no anchor in the Hebrew. Forbidden moves include: "for me alone" (when the Hebrew says only "my shepherd"), "of wine" (when "cup" is unqualified), "in light" / "in glory" / "in peace" appended for atmosphere, descriptive epithets the Hebrew does not give.
- **Prefer an imperfect rhyme over an invented detail.** A near-rhyme that is faithful is better than a perfect rhyme that adds words the Hebrew does not contain. Half-rhymes and consonance are acceptable when needed for fidelity.
- **Padding for syllable count is the same problem.** If a line needs one more syllable, find a synonym, add an article, or restructure — do not invent imagery to fill the foot.`
    : `Follow the latitude set by the # APPROACH section above. You may amplify and add imagery in the service of beauty — but stay true to the psalm's spirit and **never contradict** what the Hebrew says (do not deny what it affirms, or affirm what it denies). Added imagery should feel native to the psalm, not imported from elsewhere.`;

  return `${heading}

${stance}

These hold at **every** setting, literal or poetic:

- **The psalm superscription is NOT sung text.** Hebrew psalms often open with an editorial heading embedded in verse 1 — e.g. מִזְמוֹר לְדָוִד ("A Psalm of David"), לְדָוִד ("Of David"), לַמְנַצֵּחַ ("For the choirmaster"), or a historical note. Treat this heading as a title, **not** as content: do not render it, do not begin with "Von David" / "Für David" / "Ein Psalm Davids". Begin the German at the first true content clause of the psalm. This is the one thing you must always omit.
- **Cover the whole passage.** Account for every clause of every verse (a literal setting clause by clause; a poetic setting at least in substance). If you cannot fit material, restructure the stanza — do not silently drop it. The superscription is the sole exception.
- **Two Hebrew verses typically fit one quatrain**, but adjust: a dense verse may need its own stanza; two short parallel verses may share one.`;
}

// The worked example only makes sense as a *fidelity* demonstration; at poetic
// settings the moves it forbids are precisely what is now allowed, so we swap in
// a latitude note instead.
function workedExampleSection(
  style: number,
  m: Meter,
  patternStr: string
): string {
  if (style >= 4) {
    return `# CREATIVE LATITUDE — what is now permitted

At this setting, expansions that a literal rendering would forbid are welcome: rendering "my cup" as "my cup of blessing", drawing out an image of light, rest, or peace that suits the moment, choosing an elevated word for its music. The limits remain: stay recognisably **this** psalm, do not contradict the Hebrew, and still omit the superscription. Follow the metre defined under # METRE above (${m.label}, pattern ${patternStr}).`;
  }

  return `# WORKED EXAMPLE — what counts as faithful vs. invented

**This example illustrates the FIDELITY principle only. It is written in Common Metre (8.6.8.6) purely for illustration — do NOT copy its line lengths.** Your target metre is the one defined under # METRE above (${m.label}, pattern ${patternStr}); follow that pattern, not the 8/6/8/6 of this example. What you are meant to take from the example is the word-by-word mapping to the Hebrew and the avoidance of invented content.

Source: Psalm 23:1–2 — מִזְמ֥וֹר לְדָוִ֑ד יְהוָ֥ה רֹעִ֗י לֹ֣א אֶחְסָֽר׃ בִּנְא֣וֹת דֶּ֭שֶׁא יַרְבִּיצֵ֑נִי עַל־מֵ֖י מְנֻח֣וֹת יְנַהֲלֵֽנִי׃ ("[heading: Of David — omitted] YHWH my shepherd; I lack nothing. In grass-pastures he makes me lie down; by waters of rest he leads me.")

✗ AVOID — invents content for rhyme:

  Der HERR ist mein, für mich allein, (8)   ← "for me alone" is not in the Hebrew
  ich leide keine Not; (6)
  auf Wiesen lässt er ruhen mich, (8)
  am Wasser still und licht. (6)            ← "und licht" (and bright) is not in the Hebrew

✓ BETTER — faithful, even at cost of an imperfect rhyme:

  Der HERR ist Hirt mir; mir fehlt nichts, (8)  — A
  auf grünem Gras ich ruh; (6)                  — B
  zu stillen Wassern führt mich er, (8)         — A
  da find ich Ruh und Halt. (6)                 — B (near-rhyme ruh / Halt — half-rhyme accepted)

Notice: every word in the German maps to a word in the Hebrew. No "of David", no "alone", no "bright", no decorative atmosphere. The B rhyme (ruh / Halt) is a half-rhyme — that is preferred over inventing content.`;
}

// The renderings are produced from a Reformed, evangelical reading of the
// Psalter. At literal settings this shapes word-choice, register, and emphasis
// without importing content the Hebrew does not contain; at poetic settings the
// Christ-centred reading may surface more explicitly.
function theologySection(style: number): string {
  const literal = style <= 2;
  const christClause = literal
    ? `Even where the Reformed tradition reads a psalm christologically (the royal and messianic psalms — 2, 22, 45, 72, 110, …), do **not** import New Testament or explicitly Christian content into the Hebrew at this setting. Let the messianic and gospel hope remain implicit, carried by a faithful rendering of the Hebrew itself.`
    : `Where the psalm invites it — especially the royal and messianic psalms (2, 22, 45, 72, 110, …) — a Christ-centred, gospel resonance is welcome, in keeping with the Reformed reading of the whole Psalter as pointing to Christ. Keep it true to the psalm and never contradict the Hebrew.`;

  return `# THEOLOGICAL PERSPECTIVE

Render these psalms from within a thoroughly **Reformed and evangelical** understanding of them as the inspired, authoritative Word of God. Let that theology shape word-choice, register, and emphasis (not the addition of content beyond the # FIDELITY rules above):

- The God of the psalms is sovereign, holy, and gracious — the covenant LORD (der HERR) who saves by grace, not by human merit. Render his sovereignty, holiness, and steadfast covenant love (חֶסֶד) with their full weight; "Gnade" and "Bund" are at home here.
- Take sin, divine judgement, and the need for redemption seriously — do not soften them into mere moral sentiment or self-improvement. Forgiveness and salvation are God's free gift.
- Keep the tone reverent, marked by the fear of the LORD. Avoid sentimental, moralistic, works-righteous, or theologically liberal/universalist framings.
- ${christClause}`;
}

export function buildSystemPrompt(m: Meter, style = DEFAULT_STYLE): string {
  const patternStr = m.pattern.join("/");
  const s = clampStyle(style);
  const guidance = STYLE_GUIDANCE[s];
  const literal = s <= 2;

  // The register bullet and self-check #3 track the dial.
  const registerRule = literal
    ? `Use plain modern words wherever the Hebrew is plain. Prefer "Wiese" / "Weide" over "Flur" or "Aue"; "geht" over "wandelt"; "geht mir gut" over "selig bin ich"; "weiß nicht" over "wüsst' nicht". Use a slightly elevated register only where the Hebrew itself is elevated (e.g. הוֹד וְהָדָר). When unsure, choose the contemporary word.`
    : `Match the register to the # APPROACH above: an elevated, poetic, even lightly archaic vocabulary is welcome where it serves the music and feeling — but keep it singable and avoid stilted constructions.`;

  const selfCheck3 = literal
    ? `**Every noun, verb, and modifier corresponds to something in the Hebrew** — and you have NOT rendered the superscription. If you cannot point at a Hebrew word that justifies what you wrote, either remove it or restructure the stanza.`
    : `The line stays true to the psalm's meaning and **does not contradict the Hebrew** — and you have NOT rendered the superscription. Added imagery is in the psalm's spirit, not imported from elsewhere.`;

  return `You are an expert German hymnodist and translator. You render Hebrew psalms into singable modern German verse in ${m.label}.

# APPROACH — ${guidance.name} (${s}/5 on the literal↔poetic dial)

${guidance.body}

${metreSection(m)}

# STYLE

- ${registerRule}
- Singable: word stress and metrical stress aligned, line endings unforced, vowels open enough to sustain on a held note.
- Render the Tetragrammaton (יהוה) as "der HERR" (small caps in print; plain "HERR" in this output).

${theologySection(s)}

${fidelitySection(s)}

If a variant has to choose between elegant verse and faithful verse, resolve it according to the # APPROACH setting above.

# COUNTING SYLLABLES IN GERMAN

- Schwa endings (-en, -el, -er) count as one syllable.
- Diphthongs (au, ei, eu, ie when pronounced as long i) count as one.
- Apocope (eg. "hab'", "wand'l") is permitted to fit metre but use sparingly.
- Synaeresis across vowels at word boundaries is rare in German — do not force it.

${workedExampleSection(s, m, patternStr)}

# OUTPUT FORMAT

Return a JSON object exactly matching this schema:

{
  "variants": [
    {
      "notes": "<one short sentence on this version's approach, or empty string>",
      "stanzas": [
        { "lines": [<one string per line, following the ${patternStr} syllable pattern in order>] }
      ]
    }
  ]
}

Each variant must cover the entire requested passage. Variants should differ meaningfully — different word choices, different rhyme placements, different framings — not trivial paraphrases of each other. Do not include verse numbers in the output lines.

# SELF-CHECK BEFORE RETURNING

For each line you have written, silently verify:
1. Syllable count matches the pattern (${patternStr}).
2. Stress follows the metre's foot (${m.foot}).
3. ${selfCheck3}
4. The rhyme scheme holds (${m.rhyme}), with true rhymes or honest near-rhymes.
5. Word choices fit the # APPROACH setting (plainer toward literal, freer toward poetic).

If any check fails, rewrite that line before returning the JSON.`;
}

export function buildUserPrompt(
  psalm: number,
  verses: string[],
  variants: number,
  m: Meter,
  startVerse = 1,
  trial = false
): string {
  const numbered = verses
    .map((v, i) => `${startVerse + i}. ${v}`)
    .join("\n");
  const endVerse = startVerse + verses.length - 1;
  const range =
    verses.length === 1
      ? `verse ${startVerse}`
      : `verses ${startVerse}–${endVerse}`;
  const hebrewBlock = `HEBREW (Miqra according to the Masorah — full niqqud and ta'amim preserved):

${numbered}`;

  if (trial)
    return buildTrialUserPrompt(psalm, hebrewBlock, variants, m, startVerse);

  return `Render Psalm ${psalm} (${range}) as ${variants} distinct version${variants === 1 ? "" : "s"} in German ${m.label}.

${hebrewBlock}

Produce exactly ${variants} variant${variants === 1 ? "" : "s"}. Each variant must cover all ${verses.length} verse${verses.length === 1 ? "" : "s"} shown (omitting only the superscription if present). Return only the JSON.`;
}

// The trial prompt deliberately contradicts the system prompt's "cover the whole
// passage" rule, so it says so in as many words. Left implicit, the model splits
// the difference and crams ten verses into two stanzas — precisely the distortion
// a trial is meant to avoid, and one that would make a perfectly good metre look
// unusable.
function buildTrialUserPrompt(
  psalm: number,
  hebrewBlock: string,
  variants: number,
  m: Meter,
  startVerse: number
): string {
  return `Render the OPENING of Psalm ${psalm} in German ${m.label}, as ${variants} distinct version${variants === 1 ? "" : "s"}. This is a metre trial: I am listening to how this metre carries this psalm. I am not asking for the whole psalm.

${hebrewBlock}

# METRE TRIAL — stop after ${TRIAL_STANZAS} complete stanzas

**This section overrides the "cover the whole passage" rule in your instructions.** Here you must NOT cover the passage above.

- Produce exactly ${TRIAL_STANZAS} stanzas of ${m.pattern.length} lines each — no more, no fewer — in every variant.
- Begin at verse ${startVerse}, at its first true content clause (still omitting the superscription if one is present).
- Carry the Hebrew forward only as far as those ${TRIAL_STANZAS} stanzas naturally reach, then stop. Stop on a verse or clause boundary: do not open a sentence or an image you have no room to finish.
- **The verses above are raw material, not a quota.** You are not expected to use them all, and you must not compress, summarise, or skip ahead in order to fit more in. How far you get is itself the answer I am looking for — a dense psalm may fill both stanzas with a verse and a half, an airy one may reach verse five. Either is a good result.
- Keep exactly the fidelity, register and rhyme discipline you would use for a full rendering. A trial is only useful if it sounds like the real thing.
- In \`notes\`, state which verses the ${TRIAL_STANZAS} stanzas cover — e.g. "vv. 1–3" — and nothing else.

Produce exactly ${variants} variant${variants === 1 ? "" : "s"}. Return only the JSON.`;
}

export const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          notes: { type: "string" },
          stanzas: {
            type: "array",
            items: {
              type: "object",
              properties: {
                lines: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["lines"],
              additionalProperties: false,
            },
          },
        },
        required: ["notes", "stanzas"],
        additionalProperties: false,
      },
    },
  },
  required: ["variants"],
  additionalProperties: false,
} as const;
