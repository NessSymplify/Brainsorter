import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Plus, X, Check, Search, Camera, Image as ImageIcon, Mic, Sparkles, Clock,
  RotateCcw, ChevronDown, ChevronRight, Link2, Lightbulb, Compass, ShoppingCart,
  Brain, Layers, CheckCircle2, ArrowLeft, RefreshCw, Zap, BookOpen, Trash2, Circle,
  PenLine, ImagePlus, Star, Repeat, Bell, Filter, Armchair, Footprints, GripVertical,
  Download, Upload, MoreVertical
} from "lucide-react";

// Bump this on every edit so freshness is visible at a glance (shown in the
// header and on the welcome screen) — no need to dig into a specific flow
// to confirm you're looking at the latest build.
const BUILD_STAMP = "build 68";

// Host apps (the Claude mobile preview, PWAs, notched phones) overlay their
// own chrome — a back button, status bar — across the top of the viewport.
// Reserve space so the header controls are never underneath it.
const TOP_INSET = 52;

// This build has no server-side proxy for the Anthropic API, so calling it
// directly from the browser would either fail (no key) or expose a key to
// anyone who opens dev tools. Splitting falls back to the local word/
// punctuation splitter (see localSplit below), and photo reading is
// disabled until a real backend exists. Flip this on once you've added one,
// and point extractItemsFromText / extractItemsFromImage at it instead of
// api.anthropic.com directly.
const AI_ENABLED = false;

/* ---------------------------------------------------------------------- */
/* Storage helpers                                                        */
/* ---------------------------------------------------------------------- */

// This build runs as a normal deployed website rather than inside a Claude
// artifact, so persistence is real localStorage instead of the sandbox-only
// window.storage API. A "bs:" prefix keeps it from colliding with anything
// else on the domain.
const STORAGE_PREFIX = "bs:";

async function storeGet(key) {
  try {
    return localStorage.getItem(STORAGE_PREFIX + key);
  } catch (e) {
    console.error("Brainsorter: storage read failed", e);
    return null;
  }
}
async function storeSet(key, value) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, value);
  } catch (e) {
    // Most likely quota exceeded — this build stores photo images as base64
    // in localStorage, which is a real limit (~5-10MB depending on browser).
    console.error("Brainsorter: storage write failed (quota?)", e);
  }
}

// Used by backup/export, to find every stored photo without needing to
// already know its id. localStorage has no native prefix-scan, so this
// walks its keys directly.
async function storeListKeys(prefix) {
  try {
    const full = STORAGE_PREFIX + prefix;
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(full)) out.push(k.slice(STORAGE_PREFIX.length));
    }
    return out;
  } catch (e) {
    console.error("Brainsorter: storage list failed", e);
    return [];
  }
}

function uid() {
  return "id_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
const DAY = 86400000;

/* ---------------------------------------------------------------------- */
/* Type system                                                            */
/* ---------------------------------------------------------------------- */

const TYPE_CONFIG = {
  task: { label: "Task", icon: CheckCircle2, color: "#F5A153", soft: "rgba(245,161,83,0.16)" },
  buy: { label: "Buy", icon: ShoppingCart, color: "#FFD166", soft: "rgba(255,209,102,0.16)" },
  note: { label: "Note", icon: Brain, color: "#8FC6FF", soft: "rgba(143,198,255,0.16)" },
  project: { label: "Project", icon: Layers, color: "#9FD68C", soft: "rgba(159,214,140,0.16)" },
};
const STAR_CLIP = "polygon(50% 0%,60% 17%,77% 8%,76% 28%,95% 29%,84% 45%,99% 57%,81% 64%,88% 83%,68% 79%,64% 98%,50% 84%,36% 98%,32% 79%,12% 83%,19% 64%,1% 57%,16% 45%,5% 29%,24% 28%,23% 8%,40% 17%)";

const TYPE_ORDER = ["task", "note", "buy", "project"];

function inferType(text) {
  const t = text.toLowerCase();
  if (/\b(buy|purchase|order|pick up|get a |get some)\b/.test(t)) return "buy";
  if (/\b(research|look into|find out|how does|how do|how to)\b/.test(t)) return "note";
  if (/\b(idea|what if|could make|concept for|maybe i could|maybe build)\b/.test(t)) return "note";
  if (/\b(remember|don't forget|ask |tell |remind|note)\b/.test(t)) return "note";
  if (/\b(project|renovation|extension|build a|garden office)\b/.test(t)) return "project";
  return "task";
}
function inferMinutes(text) {
  const t = text.toLowerCase();
  if (/\b(call|ring|text|message|email|put away|throw out|add to|order|reply)\b/.test(t)) return 5;
  return null;
}

// "Can I do this sitting down?" — a physical-energy filter, the counterpart to
// 5-minute mode's time filter. Inferred from wording so nothing has to be
// tagged by hand, but overridable per item in the detail view.
const SIT_WORDS = /\b(call|ring|phone|text|message|email|reply|ask|write|draft|read|research|look (up|into)|find|find out|google|search|browse|book|order|plan|think|decide|watch|listen|budget|compare|design|sketch|list)\b/;
const MOVE_WORDS = /\b(tidy|clean|wipe|hoover|vacuum|dust|wash|water|weed|mow|garden|sort out|organise|organize|declutter|fix|mend|measure|install|assemble|paint|build|hang|carry|drop off|collect|pick up|deliver|visit|walk|drive|swim|cook|bake|recipe|sew|iron|fold|put away|unpack|pack)\b/;

function inferPosture(text, type) {
  const t = (text || "").toLowerCase();
  if (MOVE_WORDS.test(t)) return "move";
  if (SIT_WORDS.test(t)) return "sit";
  // Research and idea work is desk-shaped by default; projects tend not to be.
  if (type === "note") return "sit";
  if (type === "project") return "move";
  return null;
}

// Stored value wins; otherwise work it out from the item's own words, so
// items saved before this filter existed still get sorted sensibly.
function postureOf(item) {
  if (item.posture) return item.posture;
  return inferPosture(`${item.title} ${item.notes || ""}`, item.type);
}


// The second axis: what kind of thing it is (type) vs which part of life it
// belongs to (area). Kept separate because they're independent — a Task can
// be house, family, work or personal. Inferred like everything else, so it
// never has to be chosen at capture time.
const AREA_CONFIG = {
  house: { label: "House", emoji: "\u{1F3E1}" },
  family: { label: "Family", emoji: "\u{1F46A}" },
  work: { label: "Work", emoji: "\u{1F4BC}" },
  me: { label: "Me", emoji: "\u{2728}" },
};
const AREA_ORDER = ["house", "family", "work", "me"];

const AREA_WORDS = {
  house: /\b(?:house|home|garden|greenhouse|lawn|shed|garage|loft|attic|kitchen|bathroom|bedroom|living room|door|window|roof|boiler|plumber|electrician|lightbulb|paint|decorat|diy|furniture|mirror|hoover|tidy|declutter|bin|recycl|lego|toy|storage|airbnb|tenant|lease|landlord|mortgage|rent)s?\b/,
  family: /\b(?:kid|children|son|daughter|mum|mom|dad|nan|grandma|grandad|family|birthday|christmas|party|school|nursery|homework|swimming|playdate|husband|wife|partner|dave|timmy|meetup)s?\b/,
  work: /\b(?:work|client|customer|invoice|meeting|deadline|report|marketing|campaign|launch|website|admin|contract|proposal|pitch|colleague|symplify|therapist|slt|teemill|shop listing|pricing|freelance|tax return)s?\b/,
  me: /\b(?:crochet|knit|reading|novel|hobby|craft|music|guitar|running|gym|yoga|hike|recipe|museum|exhibition|holiday|weekend away|journal|course|podcast)s?\b/,
};

function inferArea(text) {
  const t = (text || "").toLowerCase();
  // Check in a deliberate order: work and family cues are more specific than
  // house ones, which are the broadest.
  for (const key of ["work", "family", "me", "house"]) {
    if (AREA_WORDS[key].test(t)) return key;
  }
  return null;
}

function areaOf(item) {
  if (item.area) return item.area;
  return inferArea(`${item.title} ${item.notes || ""}`);
}

function inferRecurrenceDays(text) {
  const t = text.toLowerCase();
  const m = t.match(/every\s+(\d+)\s*(day|week|month)s?/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (m[2] === "day") return n;
    if (m[2] === "week") return n * 7;
    if (m[2] === "month") return n * 30;
  }
  if (/\bdaily\b/.test(t)) return 1;
  if (/\bfortnightly\b|\bevery other week\b/.test(t)) return 14;
  if (/\bweekly\b/.test(t)) return 7;
  if (/\bmonthly\b/.test(t)) return 30;
  return null;
}

/* ---------------------------------------------------------------------- */
/* Seed content                                                           */
/* ---------------------------------------------------------------------- */

function daysAgo(n) {
  return Date.now() - n * DAY;
}

function seedItems() {
  const mk = (o) => ({
    id: uid(),
    status: "active",
    notes: "",
    subtasks: [],
    thoughts: [],
    relatedItemIds: [],
    tags: [],
    sourceImageId: null,
    snoozedUntil: null,
    completedAt: null,
    estimatedMinutes: null,
    recurrenceDays: null,
    lastCompletedAt: null,
    posture: null,
    area: null,
    sortIndex: null,
    ...o,
    createdAt: o.createdAt ?? Date.now(),
    updatedAt: o.updatedAt ?? o.createdAt ?? Date.now(),
  });

  // A repeating chore that was last done `doneAgo` days back, so its next
  // appearance is worked out from when it was actually ticked off.
  const chore = (title, weeks, doneAgo, extra = {}) =>
    mk({
      title,
      type: "task",
      recurrenceDays: weeks * 7,
      lastCompletedAt: daysAgo(doneAgo),
      completedAt: daysAgo(doneAgo),
      snoozedUntil: daysAgo(doneAgo) + weeks * 7 * DAY,
      createdAt: daysAgo(doneAgo + 60),
      updatedAt: daysAgo(doneAgo),
      ...extra,
    });

  return [
    // ---- Tasks ----
    chore("Wipe mirrors", 8, 60),
    chore("Change bedding", 4, 26),
    chore("Hoover stairs", 16, 40),
    chore("Empty upstairs bins", 2, 15),
    mk({ title: "Laundry", type: "task", createdAt: daysAgo(2) }),
    mk({ title: "Invoices", type: "task", createdAt: daysAgo(5) }),
    mk({ title: "Work emails", type: "task", estimatedMinutes: 5, createdAt: daysAgo(1) }),

    // ---- Notes ----
    mk({ title: "Garden storage", type: "note", createdAt: daysAgo(12) }),
    mk({ title: "Office blinds", type: "note", createdAt: daysAgo(9) }),
    mk({ title: "Scooters", type: "note", createdAt: daysAgo(18) }),
    mk({ title: "Think about Christmas", type: "note", createdAt: daysAgo(6) }),

    // ---- Projects ----
    mk({ title: "Symplify", type: "project", createdAt: daysAgo(30), updatedAt: daysAgo(1) }),
    mk({ title: "Min (app)", type: "project", createdAt: daysAgo(24), updatedAt: daysAgo(4) }),
    mk({ title: "Min (gadget)", type: "project", createdAt: daysAgo(24), updatedAt: daysAgo(11) }),
    mk({ title: "ITOAW", type: "project", createdAt: daysAgo(20), updatedAt: daysAgo(7) }),
    mk({ title: "Anagram game", type: "project", createdAt: daysAgo(16), updatedAt: daysAgo(16) }),
    mk({ title: "Therapy bag", type: "project", createdAt: daysAgo(28), updatedAt: daysAgo(22) }),
    mk({ title: "Hyper-Kinetic artwork", type: "project", createdAt: daysAgo(14), updatedAt: daysAgo(3) }),
    mk({ title: "Hyper-Kinetic clothing", type: "project", createdAt: daysAgo(14), updatedAt: daysAgo(9) }),

    // ---- Buy ----
    mk({ title: "Grandma birthday present", type: "buy", createdAt: daysAgo(4) }),
    mk({ title: "Melon", type: "buy", estimatedMinutes: 5, createdAt: daysAgo(1) }),
    mk({ title: "Dog poo bags", type: "buy", estimatedMinutes: 5, createdAt: daysAgo(3) }),
  ];
}

/* ---------------------------------------------------------------------- */
/* Vision extraction (Anthropic API)                                      */
/* ---------------------------------------------------------------------- */

const EXTRACTION_PROMPT = `You are looking at a photo of handwritten or printed notes — a notebook page, scrap of paper, whiteboard, or list.

Identify the separate, distinct thoughts, tasks, ideas, or reminders in the image. When lines are clearly related to each other (for example a heading with related notes underneath it, like "GARDEN OFFICE" followed by "door stop - find something that works" and "maybe floor mounted?"), group them into ONE item: use the heading as the title and fold the related lines into that item's notes, rather than creating several meaningless fragments. If a line stands alone, make it its own item.

Default to splitting a plain list into separate items — a shopping list like "milk, eggs, bread" or "cake / lemon / potato" is three separate "buy" items, one per entry, NOT one combined item, even though they share a category. Only merge lines together when one is clearly a detail or sub-point explaining another (like the garden office example above), not merely because they're thematically related. When unsure, prefer splitting — it's easier for the person to merge or delete an over-split item in review than to notice one hidden inside another.

Keep titles as close to the written words as possible. Do NOT prepend a verb that just restates the type — the type is already shown next to the item, so a list entry reading "cake" becomes the title "Cake", not "Buy cake". Only keep a verb if it's actually written there ("ring plumber" stays "Ring plumber") or if the title would be meaningless without it.

If something is genuinely ambiguous or illegible, preserve it as-is rather than guessing or inventing information.

Types: "task" (something to do), "buy" (something to get), "project" (a bigger multi-step undertaking, usually with a name), "note" (anything else worth keeping — an idea, a question to look into, a thought, or information with no action attached).

Respond with ONLY a raw JSON array, no markdown code fences, no explanation before or after. Each element must look like:
{"title": "short title, 3-8 words", "type": "task|buy|note|project", "notes": "related detail, or empty string"}`;

async function extractItemsFromImage(dataUrl, mimeType) {
  const base64 = dataUrl.split(",")[1];
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      },
    ],
  };
  return parseExtractionResponse(body);
}

const SPLIT_PROMPT = `You are looking at a chunk of typed or dictated text — someone speaking or typing out a stream-of-consciousness brain dump, often with run-on sentences, "and also", "oh and", filler words, or no punctuation at all (common with voice dictation).

Default to splitting aggressively. Any comma-separated, "and"-separated, or newline-separated list of short items is almost always meant as SEPARATE items, even when they're thematically related (a shopping list, several chores, a few ideas in a row) — each one should become its own item so it can be individually checked off later. For example, "cake, lemon, potato" is three separate items typed "buy" — titled simply "Cake", "Lemon", "Potato" — NOT one combined item, and never merge a plain list into a single item just because the entries are short or share a category.

Keep titles as close to the person's own words as possible. Do NOT prepend a verb that just restates the type — the type is already shown next to the item, so "Buy cake" is redundant where "Cake" is correct. Same for other types: a research item they wrote as "children's book subscriptions" stays that, not "Research children's book subscriptions". Only keep a verb if they actually said it ("ring plumber" stays "Ring plumber") or if the title would be meaningless without it.

Only keep two things together as ONE item when one part is clearly a detail, reason, or sub-point ABOUT the other — not merely related to it. For example "garden office door, needs a stop because it swings in the wind" is one item (title: "Garden office door", notes: "Needs a stop — swings in the wind"), because the second clause is explaining the first, not naming something new.

When genuinely unsure whether two things are separate or one, prefer splitting them — a spurious split is easy to undo (the user can just delete or merge in review), but a wrongful merge hides an item inside another one where it's easy to miss.

Dictated text often has NO punctuation at all. "papers eggs lemons sausages walk the dog" is five separate items (papers / eggs / lemons / sausages / walk the dog) — a run of unrelated nouns with no linking words is a list, even without a single comma. Use the words themselves to find the boundaries, and keep short verb phrases like "walk the dog" or "ring the vet" intact.

Where punctuation IS present, split on SEPARATORS, not on words. Commas, "and", newlines, bullets, and semicolons are separators. A phrase with no separator in it is ONE thought, however many nouns it contains — "Minecraft potions idea" is a single idea (title: "Minecraft potions"), NOT "Minecraft" plus "Potions idea". Never break a single phrase into fragments that lose their meaning apart.

Clean up dictation artifacts (stray "um", repeated words, missing punctuation) when forming each title, but don't invent information that wasn't said.

Types: "task" (something to do), "buy" (something to get), "project" (a bigger multi-step undertaking, usually with a name), "note" (anything else worth keeping — an idea, a question to look into, a thought, or information with no action attached).

Respond with ONLY a raw JSON array, no markdown code fences, no explanation before or after. Each element must look like:
{"title": "short title, 3-8 words", "type": "task|buy|note|project", "notes": "related detail, or empty string"}`;

async function extractItemsFromText(rawText) {
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `${SPLIT_PROMPT}\n\nHere's the text:\n"""\n${rawText}\n"""` }],
      },
    ],
  };
  return parseExtractionResponse(body);
}

// The model is instructed to reply with only a JSON array, but real-world
// replies sometimes wrap it in prose, use a single object instead of an
// array, or (rarely) get cut off. Try progressively looser strategies
// before giving up, so a slightly-off reply still produces usable items
// instead of a dead end.
function salvageJsonArray(rawText) {
  const cleaned = rawText.replace(/```json|```/g, "").trim();

  const bracketStart = cleaned.indexOf("[");
  const bracketEnd = cleaned.lastIndexOf("]");
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    try {
      const parsed = JSON.parse(cleaned.slice(bracketStart, bracketEnd + 1));
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (e) {
      /* fall through */
    }
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length) return parsed;
    if (parsed && Array.isArray(parsed.items) && parsed.items.length) return parsed.items;
  } catch (e) {
    /* fall through */
  }

  // Last resort: pull out individual {...} objects one at a time, even if
  // the surrounding array syntax is malformed or truncated.
  const objectMatches = cleaned.match(/\{[^{}]*\}/g);
  if (objectMatches && objectMatches.length) {
    const salvaged = [];
    for (const m of objectMatches) {
      try {
        salvaged.push(JSON.parse(m));
      } catch (e) {
        /* skip this fragment */
      }
    }
    if (salvaged.length) return salvaged;
  }

  return null;
}

// The response envelope sometimes arrives truncated or corrupted in this
// environment (e.g. missing its opening bytes) even on a status 200 with a
// perfectly good model reply inside. So rather than depending on the envelope
// parsing cleanly, pull the assistant's text out of whatever we actually got.


// Dictation and quick typing often arrive with no punctuation at all
// ("papers eggs lemons sausages walk the dog"), so separators alone aren't
// enough to spot a list. These function words are the giveaway: a real
// sentence is full of them, a rattled-off list has almost none.
const STOP_WORDS = new Set([
  "the", "a", "an", "my", "your", "our", "some", "of", "to", "for", "with", "and", "or",
  "in", "on", "at", "out", "up", "off", "from", "about", "into", "over", "back", "that",
  "this", "it", "its", "his", "her", "their", "new", "more", "few", "then", "also",
]);

const wordsOf = (t) => String(t || "").trim().split(/\s+/).filter(Boolean);
const normalise = (w) => w.toLowerCase().replace(/[^a-z']/g, "");

function stopWordRatio(text) {
  const w = wordsOf(text).map(normalise);
  if (!w.length) return 1;
  return w.filter((x) => STOP_WORDS.has(x)).length / w.length;
}

// A run-on spoken list: several words, but hardly any function words.
function looksLikeWordList(text) {
  if (/[,;•·]|\r?\n/.test(text)) return false;
  if (wordsOf(text).length < 5) return false;
  return stopWordRatio(text) <= 0.2;
}

// Break on word boundaries, keeping function words (and whatever follows
// them) attached — so "walk the dog" survives as one item.
function wordSplit(text) {
  const chunks = [];
  let cur = [];
  for (const word of wordsOf(text)) {
    const isStop = STOP_WORDS.has(normalise(word));
    const prevWasStop = cur.length ? STOP_WORDS.has(normalise(cur[cur.length - 1])) : false;
    if (cur.length === 0 || isStop || prevWasStop) {
      cur.push(word);
    } else {
      chunks.push(cur.join(" "));
      cur = [word];
    }
  }
  if (cur.length) chunks.push(cur.join(" "));
  return chunks;
}

// If the model can't be reached (in some environments the request returns an
// empty body), fall back to splitting locally. Crude next to the model — it
// can only go on separators and keywords — but it means a brain dump is never
// lost or dumped in as one blob.
function localSplit(text) {
  if (looksLikeWordList(text)) {
    return wordSplit(text).map((t) => ({
      tempId: uid(),
      title: t.charAt(0).toUpperCase() + t.slice(1, 140),
      type: inferType(t),
      notes: "",
      selected: true,
    }));
  }
  const pieces = String(text || "")
    .split(/\r?\n|[;•·]|,(?![^()]*\))| and (?=[a-z])| then | also /i)
    .map((t) => t.replace(/^[\s\-–—*+.\d)]+/, "").trim())
    .filter((t) => t.length > 1);

  const seen = new Set();
  return pieces
    .filter((t) => {
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 30)
    .map((t) => ({
      tempId: uid(),
      title: t.charAt(0).toUpperCase() + t.slice(1, 140),
      type: inferType(t),
      notes: "",
      selected: true,
    }));
}


// Decide whether a captured chunk is one thought or several, so the person
// only ever has to press "Add" and gets asked about splitting when it's
// actually ambiguous. Deliberately conservative: a single short phrase with
// one "and" in it stays one thing.
function looksSplittable(text) {
  const t = String(text || "").trim();
  if (t.length < 12) return false;
  if (/\r?\n/.test(t)) return true; // more than one line is a list
  const separators = (t.match(/[,;•·]/g) || []).length;
  if (separators >= 2) return true;
  if (separators === 1 && t.length > 28) return true;
  const joiners = (t.match(/\b(and|then|also|plus)\b/gi) || []).length;
  if (joiners >= 2) return true;
  if (joiners >= 1 && separators >= 1) return true;
  if (joiners >= 1 && t.length > 45) return true;
  if (looksLikeWordList(t)) return true;
  return localSplit(t).length >= 3;
}

function extractModelText(rawBody) {
  // Happy path: the envelope is intact. Join every text block (there can be
  // more than one) and ignore empty ones, so an empty leading block doesn't
  // make us give up on a reply that's actually there.
  try {
    const data = JSON.parse(rawBody);
    const joined = (data.content || [])
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (joined) return joined;
  } catch (e) {
    /* fall through to salvage */
  }

  // Salvage path: find the "text":"..." field(s) directly in the raw bytes and
  // unescape them, so a damaged envelope still yields the model's reply.
  const matches = rawBody.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
  if (matches && matches.length) {
    const pieces = [];
    for (const m of matches) {
      const inner = m.replace(/^"text"\s*:\s*/, "");
      try {
        const v = JSON.parse(inner);
        if (v && String(v).trim()) pieces.push(v);
      } catch (e) {
        /* skip unparseable fragment */
      }
    }
    if (pieces.length) return pieces.join("\n");
  }

  // Last resort: hand back the raw body and let salvageJsonArray try on it.
  return rawBody;
}

// Reading the response body has proven flaky in this environment: the same
// request can return good content, a body truncated at the front, or nothing
// at all. So read it at the byte level (more reliable than res.text() here)
// and retry a few times before giving up, since the failures are intermittent
// rather than deterministic.
async function readBodyText(res) {
  try {
    const buf = await res.arrayBuffer();
    if (buf && buf.byteLength) {
      return new TextDecoder("utf-8").decode(buf);
    }
  } catch (e) {
    /* fall through */
  }
  return "";
}

async function parseExtractionResponse(body, attempts = 3) {
  const problems = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const rawBody = await readBodyText(res);

      if (!res.ok) {
        problems.push(`attempt ${attempt}: HTTP ${res.status} — ${rawBody.slice(0, 400) || "(empty body)"}`);
        // Auth/permission failures won't fix themselves on a retry.
        if (res.status === 401 || res.status === 403) break;
      } else {
        const raw = extractModelText(rawBody);
        const parsed = salvageJsonArray(raw);
        if (parsed) {
          return parsed.map((p) => ({
            tempId: uid(),
            title: String((p && p.title) || "Untitled thought").slice(0, 140),
            type: p && TYPE_ORDER.includes(p.type) ? p.type : "task",
            notes: String((p && p.notes) || ""),
            selected: true,
          }));
        }
        problems.push(
          `attempt ${attempt}: HTTP 200, body ${rawBody.length} chars, usable text ${
            raw && raw.trim() ? `"${raw.slice(0, 120)}"` : "(none)"
          }`
        );
      }
    } catch (e) {
      problems.push(`attempt ${attempt}: ${e.message || String(e)}`);
    }

    if (attempt < attempts) await new Promise((r) => setTimeout(r, 500 * attempt));
  }

  console.error("Brainsorter: all extraction attempts failed", problems);
  throw new Error(`Couldn't get a usable reply after ${problems.length} tr${problems.length === 1 ? "y" : "ies"}:\n${problems.join("\n")}`);
}

/* ---------------------------------------------------------------------- */
/* Small UI atoms                                                         */
/* ---------------------------------------------------------------------- */

function TypeIcon({ type, size = 16, style, color }) {
  const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.task;
  const Icon = cfg.icon;
  return <Icon size={size} color={color || cfg.color} strokeWidth={2.25} style={style} />;
}

function TypeBadge({ type }) {
  const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.task;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium tracking-wide"
      style={{ background: cfg.soft, color: cfg.color }}
    >
      <TypeIcon type={type} size={12} />
      {cfg.label}
    </span>
  );
}

function Toast({ text }) {
  if (!text) return null;
  return (
    <div
      className="fixed left-1/2 top-6 -translate-x-1/2 px-4 py-2 rounded-2xl text-sm font-medium shadow-lg"
      style={{ background: "#EDEBFB", color: "#1B1A24", zIndex: 120, maxWidth: "85vw", whiteSpace: "normal", textAlign: "center" }}
    >
      {text}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Onboarding                                                             */
/* ---------------------------------------------------------------------- */

function WelcomeScreen({ onBegin, onSeeExample }) {
  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center px-8 text-center"
      style={{ background: "radial-gradient(120% 90% at 50% 0%, #24213A 0%, #14121F 60%, #0E0C17 100%)", zIndex: 100 }}
    >
      <span
        className="absolute right-4 text-[10px]"
        style={{ top: `calc(env(safe-area-inset-top, 0px) + ${TOP_INSET}px)`, color: "#4A4658" }}
      >
        {BUILD_STAMP}
      </span>
      <div
        className="mb-7 flex h-16 w-16 items-center justify-center rounded-2xl"
        style={{ background: "linear-gradient(135deg,#F5A153,#FF8B7B)" }}
      >
        <Filter size={28} color="#14121F" strokeWidth={2.4} />
      </div>
      <h1 className="mb-3 text-3xl leading-tight text-white" style={{ fontFamily: "Fraunces, serif" }}>
        Welcome to Brainsorter.
      </h1>
      <p className="mb-1 max-w-xs text-[15px] leading-relaxed" style={{ color: "#B3AFC4" }}>
        Your brain has better things to do than organise itself.
      </p>
      <p className="mb-10 max-w-xs text-[15px] leading-relaxed" style={{ color: "#B3AFC4" }}>
        Let's get what's in your head into here — a few quick prompts, then just scroll.
      </p>
      <p className="mb-10 text-sm font-medium tracking-wide" style={{ color: "#F5A153" }}>
        Doomscroll your own brain.
      </p>
      <button
        onClick={onBegin}
        className="rounded-full px-8 py-3.5 text-[15px] font-semibold shadow-lg active:scale-95 transition-transform"
        style={{ background: "#F2F0F5", color: "#14121F" }}
      >
        Let's get it out of my head
      </button>
      <button onClick={onSeeExample} className="mt-4 text-sm font-medium" style={{ color: "#736E88" }}>
        Or just show me an example first
      </button>
    </div>
  );
}

const DUMP_SUGGESTIONS = [
  "Ring plumber…",
  "Buy new lightbulbs…",
  "Wipe mirrors every 10 weeks…",
  "Idea: Minecraft phonics books…",
  "Somewhere fun to take the kids…",
  "Look into swimming lessons…",
  "Ask Mum about the greenhouse…",
  "Garden office door needs sorting…",
  "Try that new recipe…",
  "Find a weird museum nearby…",
];

function BrainDump({ items, onAdd, onPhoto, toast, onDone }) {
  const [textValue, setTextValue] = useState("");
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const camInput = useRef(null);
  const libInput = useRef(null);

  useEffect(() => {
    const t = setInterval(() => setPlaceholderIdx((i) => (i + 1) % DUMP_SUGGESTIONS.length), 2600);
    return () => clearInterval(t);
  }, []);

  const commit = () => {
    const v = textValue.trim();
    if (!v) return;
    onAdd(v);
    setTextValue("");
  };

  const recent = items.slice().sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="fixed inset-0 flex flex-col" style={{ background: "radial-gradient(120% 90% at 50% 0%, #24213A 0%, #14121F 60%, #0E0C17 100%)", zIndex: 100 }}>
      <div className="flex items-center justify-between px-5" style={{ paddingTop: `calc(env(safe-area-inset-top, 0px) + ${TOP_INSET}px)` }}>
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#8FC6FF" }}>
          Brain dump · {BUILD_STAMP}
        </span>
        <button onClick={onDone} className="text-xs font-medium" style={{ color: "#736E88" }}>
          Skip
        </button>
      </div>

      <div className="px-6 pb-2 pt-6 text-center">
        <h2 className="mb-2 text-2xl leading-snug text-white" style={{ fontFamily: "Fraunces, serif" }}>
          Just throw it all in.
        </h2>
        <p className="mx-auto max-w-xs text-[13.5px] leading-relaxed" style={{ color: "#8B87A0" }}>
          Tasks, ideas, things to buy, things to look into, things to keep hold of, repeating chores — whatever's rattling around. We'll sort it after.
        </p>
      </div>

      <div className="mx-auto w-full max-w-sm px-6 pt-4">
        <textarea
          autoFocus
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={DUMP_SUGGESTIONS[placeholderIdx]}
          rows={2}
          className="w-full resize-none rounded-2xl px-4 py-3 text-sm outline-none"
          style={{ background: "rgba(255,255,255,0.06)", color: "#EDEBFB" }}
        />
        <button
          onClick={commit}
          className="mt-2 w-full rounded-full py-3 text-sm active:scale-95 transition-transform"
          style={{ fontFamily: "'Fredoka',sans-serif", fontWeight: 700, background: "#F5A153", color: "#14121F" }}
        >
          Add
        </button>
        <p className="mt-2 text-center text-[11px]" style={{ color: "#736E88" }}>
          One thought or a whole splurge — I'll ask if it looks like several things.
        </p>

        <div className="mt-4 flex justify-center gap-4">
          <button onClick={() => camInput.current?.click()} className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform">
            <div className="flex h-11 w-11 items-center justify-center rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
              <Camera size={18} color="#EDEBFB" />
            </div>
            <span className="text-[11px]" style={{ color: "#8B87A0" }}>
              Photo of notes
            </span>
          </button>
          <button onClick={() => libInput.current?.click()} className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform">
            <div className="flex h-11 w-11 items-center justify-center rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
              <ImagePlus size={18} color="#EDEBFB" />
            </div>
            <span className="text-[11px]" style={{ color: "#8B87A0" }}>
              Choose photo
            </span>
          </button>
          <button onClick={() => toast("Voice capture coming soon 🎙️")} className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform">
            <div className="flex h-11 w-11 items-center justify-center rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
              <Mic size={18} color="#EDEBFB" />
            </div>
            <span className="text-[11px]" style={{ color: "#8B87A0" }}>
              Voice
            </span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-3 pt-5">
        {recent.length > 0 && (
          <div className="mx-auto flex max-w-sm flex-col gap-1.5">
            {recent.map((it) => (
              <div key={it.id} className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
                <TypeIcon type={it.type} size={13} />
                <span className="flex-1 truncate text-[13px]" style={{ color: "#C7C3D6" }}>
                  {it.title}
                </span>
                {it.recurrenceDays && <Repeat size={12} color="#8FC6FF" />}
                {it.sourceImageId && <ImageIcon size={11} color="#7B7690" />}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="px-6 pb-8">
        <button
          onClick={onDone}
          disabled={items.length === 0}
          className="w-full rounded-full py-3.5 text-sm font-semibold active:scale-95 transition-transform disabled:opacity-40"
          style={{ background: "#F2F0F5", color: "#14121F" }}
        >
          {items.length > 0 ? `Organise ${items.length} thing${items.length === 1 ? "" : "s"}` : "Add something first"}
        </button>
      </div>

      <input
        ref={camInput}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPhoto(f);
          e.target.value = "";
        }}
      />
      <input
        ref={libInput}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPhoto(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

// Tapping a type icon opens this instead of cycling through types one at a
// time — with seven types, cycling means up to six taps to reach the one you
// want, and you can't see where you're heading. Rendered as a fixed centered
// sheet rather than an anchored popover so it can't be clipped by the
// scrolling containers it opens from.
// Backup, restore, and reset live in one place — Export/Import move real data
// in and out as a JSON file (including photos, base64-encoded), so someone
// relying on this via "Add to Home Screen" has a way to recover from Safari
// clearing localStorage, switching phones, or anything else wiping it.
function DataMenu({ items, imageCache, onClose, onExport, onImportFile, onReset, toast }) {
  const fileRef = useRef(null);
  return (
    <div
      className="fixed inset-0 flex items-center justify-center px-8"
      style={{ background: "rgba(10,9,15,0.75)", zIndex: 200 }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full overflow-hidden rounded-3xl shadow-2xl"
        style={{ maxWidth: 300, background: "#242233", border: "1px solid rgba(255,255,255,0.1)" }}
      >
        <p className="px-4 pt-4 pb-1 text-xs font-semibold uppercase tracking-wider" style={{ color: "#736E88" }}>
          Your data
        </p>
        <p className="px-4 pb-3 text-xs leading-relaxed" style={{ color: "#8B87A0" }}>
          {items.length} thing{items.length === 1 ? "" : "s"} stored on this device only — nothing is backed up
          anywhere unless you export it.
        </p>

        <button
          onClick={() => {
            onExport();
            onClose();
          }}
          className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-white/5"
        >
          <Download size={16} color="#8FC6FF" />
          <span className="flex-1 text-sm font-medium" style={{ color: "#DAD7E5" }}>
            Back up to a file
          </span>
        </button>

        <button
          onClick={() => fileRef.current?.click()}
          className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-white/5"
        >
          <Upload size={16} color="#9FD68C" />
          <span className="flex-1 text-sm font-medium" style={{ color: "#DAD7E5" }}>
            Restore from a file
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImportFile(f);
            e.target.value = "";
            onClose();
          }}
        />

        <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "4px 0" }} />

        <button
          onClick={() => {
            onReset();
            onClose();
          }}
          className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-white/5"
        >
          <Trash2 size={16} color="#FF6B60" />
          <span className="flex-1 text-sm font-medium" style={{ color: "#FF8C82" }}>
            Reset everything
          </span>
        </button>

        <p className="px-4 pb-4 pt-1 text-center text-[10px]" style={{ color: "#4A4658" }}>
          {BUILD_STAMP}
        </p>
      </div>
    </div>
  );
}

// Shown when a chosen backup file is about to replace everything currently
// on the device, and separately for the reset action — a plain confirm()
// dialog isn't reliable in every environment this runs in, so this is a
// real in-app modal instead.
function ConfirmDialog({ title, body, confirmLabel, danger, onConfirm, onCancel }) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center px-8"
      style={{ background: "rgba(10,9,15,0.8)", zIndex: 210 }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full rounded-3xl p-5 shadow-2xl"
        style={{ maxWidth: 300, background: "#242233", border: "1px solid rgba(255,255,255,0.1)" }}
      >
        <p className="mb-1.5 text-[15px] font-semibold text-white" style={{ fontFamily: "'Fredoka',sans-serif" }}>
          {title}
        </p>
        <p className="mb-5 text-[13px] leading-relaxed" style={{ color: "#B3AFC4" }}>
          {body}
        </p>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 rounded-full py-2.5 text-sm font-medium"
            style={{ background: "rgba(255,255,255,0.08)", color: "#C7C3D6" }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-full py-2.5 text-sm font-semibold"
            style={{ background: danger ? "#FF6B60" : "#9FD68C", color: "#14121F" }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function TypePicker({ currentType, onPick, onClose }) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center px-8"
      style={{ background: "rgba(10,9,15,0.75)", zIndex: 200 }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[260px] overflow-hidden rounded-3xl shadow-2xl"
        style={{ background: "#242233", border: "1px solid rgba(255,255,255,0.1)" }}
      >
        <p className="px-4 pt-4 pb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "#736E88" }}>
          Change type
        </p>
        {TYPE_ORDER.map((t) => {
          const cfg = TYPE_CONFIG[t];
          const isCurrent = t === currentType;
          return (
            <button
              key={t}
              onClick={() => {
                onPick(t);
                onClose();
              }}
              className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-white/5"
              style={{ background: isCurrent ? cfg.soft : "transparent" }}
            >
              <TypeIcon type={t} size={16} />
              <span className="flex-1 text-sm font-medium" style={{ color: isCurrent ? cfg.color : "#DAD7E5" }}>
                {cfg.label}
              </span>
              {isCurrent && <Check size={14} color={cfg.color} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OrganizedSummary({ items, onFinish, onBack, updateItem, deleteItem }) {
  const [expanded, setExpanded] = useState(null);
  const [pickerFor, setPickerFor] = useState(null);
  const pickerTarget = items.find((i) => i.id === pickerFor);
  const groups = TYPE_ORDER.map((t) => ({ type: t, items: items.filter((i) => i.type === t) })).filter((g) => g.items.length > 0);
  const recurringCount = items.filter((i) => i.recurrenceDays).length;
  const total = items.length;

  return (
    <div
      className="fixed inset-0 flex flex-col px-6 pb-10"
      style={{
        paddingTop: `calc(env(safe-area-inset-top, 0px) + ${TOP_INSET}px)`,
        background: "radial-gradient(120% 90% at 50% 0%, #24213A 0%, #14121F 60%, #0E0C17 100%)",
        zIndex: 100,
      }}
    >
      <div className="flex-1 overflow-y-auto">
        <p className="mb-1 text-center text-xs font-semibold uppercase tracking-wider" style={{ color: "#8FC6FF" }}>
          All sorted · {BUILD_STAMP}
        </p>
        <h2 className="mb-2 text-center text-2xl leading-snug text-white" style={{ fontFamily: "Fraunces, serif" }}>
          {total === 0 ? "Nothing captured yet — that's OK too." : `Got ${total} thing${total === 1 ? "" : "s"} sorted for you.`}
        </h2>
        {total > 0 && (
          <p className="mb-6 text-center text-xs leading-relaxed" style={{ color: "#736E88" }}>
            Tap a group to open it. Edit any title, tap its icon to pick a different type, or ✕ to remove it.
            {recurringCount > 0 ? ` ${recurringCount} repeating.` : ""}
          </p>
        )}
        {groups.length > 0 && (
          <div className="mx-auto mt-4 w-full max-w-sm space-y-2">
            {groups.map((g) => {
              const cfg = TYPE_CONFIG[g.type];
              const isOpen = expanded === g.type;
              return (
                <div key={g.type} className="rounded-2xl" style={{ background: "rgba(255,255,255,0.04)" }}>
                  <button onClick={() => setExpanded(isOpen ? null : g.type)} className="flex w-full items-center justify-between px-4 py-3">
                    <span className="flex items-center gap-2 text-sm font-medium" style={{ color: "#EDEBFB" }}>
                      <TypeIcon type={g.type} size={15} /> {cfg.label}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs font-semibold" style={{ color: cfg.color }}>
                        {g.items.length}
                      </span>
                      <ChevronDown
                        size={14}
                        color="#736E88"
                        style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}
                      />
                    </span>
                  </button>
                  {isOpen && (
                    <div className="space-y-1.5 px-3 pb-3">
                      {g.items.map((it) => (
                        <div key={it.id} className="flex items-center gap-2 rounded-xl px-2 py-1.5" style={{ background: "rgba(255,255,255,0.04)" }}>
                          <button
                            onClick={() => setPickerFor(it.id)}
                            className="shrink-0 rounded-full p-1.5"
                            style={{ background: TYPE_CONFIG[it.type].soft }}
                            title="Change type"
                          >
                            <TypeIcon type={it.type} size={12} />
                          </button>
                          <input
                            value={it.title}
                            onChange={(e) => updateItem(it.id, { title: e.target.value })}
                            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                            style={{ color: "#EDEBFB" }}
                          />
                          {it.recurrenceDays && <Repeat size={11} color="#8FC6FF" className="shrink-0" />}
                          <button onClick={() => deleteItem(it.id)} className="shrink-0 p-1" title="Remove">
                            <X size={13} color="#736E88" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="mt-6 flex gap-2">
        <button
          onClick={onBack}
          className="rounded-full px-5 py-3.5 text-sm font-medium active:scale-95 transition-transform"
          style={{ background: "rgba(255,255,255,0.08)", color: "#C7C3D6" }}
        >
          Add more
        </button>
        <button
          onClick={onFinish}
          className="flex-1 rounded-full py-3.5 text-sm font-semibold active:scale-95 transition-transform"
          style={{ background: "#F2F0F5", color: "#14121F" }}
        >
          Start scrolling
        </button>
      </div>

      {pickerTarget && (
        <TypePicker
          currentType={pickerTarget.type}
          onPick={(t) => updateItem(pickerTarget.id, { type: t })}
          onClose={() => setPickerFor(null)}
        />
      )}
    </div>
  );
}

function OnboardingFlow({ items, onAdd, addTextItem, onPhoto, extraction, setExtraction, confirmExtraction, updateItem, deleteItem, toast, onFinish }) {
  const [stage, setStage] = useState("welcome");
  if (stage === "welcome") {
    return <WelcomeScreen onBegin={() => setStage("dump")} onSeeExample={() => onFinish(true)} />;
  }
  if (stage === "summary") {
    return (
      <OrganizedSummary
        items={items}
        onFinish={() => onFinish(false)}
        onBack={() => setStage("dump")}
        updateItem={updateItem}
        deleteItem={deleteItem}
      />
    );
  }
  return (
    <>
      <BrainDump items={items} onAdd={onAdd} onPhoto={onPhoto} toast={toast} onDone={() => setStage("summary")} />
      {extraction && (
        <ExtractionConfirm
          status={extraction.status}
          previewUrl={extraction.previewUrl}
          extracted={extraction.list}
          origin={extraction.origin}
          errorDetail={extraction.errorDetail}
          offline={extraction.offline}
          sourceText={extraction.sourceText}
          onAddAsOne={(t) => {
            addTextItem(t);
            setExtraction(null);
          }}
          setExtracted={(fn) => setExtraction((ex) => ({ ...ex, list: typeof fn === "function" ? fn(ex.list) : fn }))}
          onClose={() => setExtraction(null)}
          onConfirm={confirmExtraction}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------------------- */
/* Feed Card                                                              */
/* ---------------------------------------------------------------------- */

function relativeDays(ts, now) {
  const days = Math.round(Math.abs(now - ts) / DAY);
  if (days === 0) return "today";
  return `${days} day${days === 1 ? "" : "s"}`;
}

function snoozeLabel(ts, now) {
  const ms = ts - now;
  if (ms <= 0) return "due now";
  const hours = ms / 3600000;
  if (hours < 12) return "back later today";
  const days = Math.round(hours / 24);
  if (days <= 1) return "back tomorrow";
  if (days < 14) return `back in ${days} days`;
  return `back in ${Math.round(days / 7)} weeks`;
}

function neglectMessage(item, now) {
  if (item.recurrenceDays && item.resurfaced) {
    const weeks = Math.round(item.recurrenceDays / 7);
    return item.lastCompletedAt
      ? `Due again — last done ${relativeDays(item.lastCompletedAt, now)} ago. Every ~${weeks}w.`
      : `Due — repeats every ~${weeks} weeks.`;
  }
  if (item.resurfaced) return "This one's back — you snoozed it a while ago.";
  if (item.estimatedMinutes && item.estimatedMinutes <= 5) return "Tiny thing. Probably five minutes.";
  if (now - item.createdAt < DAY) return "Fresh thought.";
  return null;
}

function SnoozeMenu({ onPick, onClose }) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center px-8"
      style={{ background: "rgba(10,9,15,0.75)", zIndex: 200 }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full overflow-hidden rounded-3xl shadow-2xl"
        style={{ maxWidth: 260, background: "#242233", border: "1px solid rgba(255,255,255,0.1)" }}
      >
        <p className="px-4 pt-4 pb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "#736E88" }}>
          Come back to this…
        </p>
        {[
          ["Later today", 4 / 24],
          ["Tomorrow", 1],
          ["This week", 3],
          ["Next week", 7],
          ["Surprise me", 2 + Math.random() * 8],
        ].map(([label, d]) => (
          <button
            key={label}
            onClick={() => {
              onPick(d);
              onClose();
            }}
            className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-white/5"
          >
            <Clock size={15} color="#8FC6FF" />
            <span className="text-sm font-medium" style={{ color: "#DAD7E5" }}>
              {label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// Quick actions shared by the card and list views: done, prioritise, snooze.
function ItemActions({ item, onComplete, onShortlist, onUnshortlist, onSnooze, compact = false, skin = null }) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const cfg = TYPE_CONFIG[item.type] || TYPE_CONFIG.task;
  const size = compact ? 15 : 16;
  const pad = compact ? "p-2" : "p-2.5";
  // On a decorated card, buttons pick up that card's chrome/ink so they stay
  // legible against loud backgrounds instead of assuming a dark surface.
  const btnBg = skin ? skin.chrome : "rgba(255,255,255,0.06)";
  const btnInk = skin ? (skin.ink === "transparent" ? cfg.color : skin.ink) : "#8B87A0";

  return (
    <>
      <div className="flex items-center gap-1.5">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onComplete(item.id);
          }}
          className={`flex items-center justify-center rounded-full ${pad} active:scale-90 transition-transform`}
          style={{ background: skin ? skin.chrome : cfg.soft }}
          title="Done"
        >
          <Check size={size} color={skin ? btnInk : cfg.color} strokeWidth={2.6} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            item.shortlisted ? onUnshortlist(item.id) : onShortlist(item.id);
          }}
          className={`flex items-center justify-center rounded-full ${pad} active:scale-90 transition-transform`}
          style={{ background: item.shortlisted ? "rgba(255,209,102,0.25)" : btnBg }}
          title={item.shortlisted ? "Remove from today" : "Prioritise for today"}
        >
          <Star size={size} color={item.shortlisted ? "#FFD166" : btnInk} fill={item.shortlisted ? "#FFD166" : "none"} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setSnoozeOpen(true);
          }}
          className={`flex items-center justify-center rounded-full ${pad} active:scale-90 transition-transform`}
          style={{ background: btnBg }}
          title="Snooze"
        >
          <Clock size={size} color={btnInk} />
        </button>
      </div>
      {snoozeOpen && <SnoozeMenu onPick={(d) => onSnooze(item.id, d)} onClose={() => setSnoozeOpen(false)} />}
    </>
  );
}

// Each card gets a look of its own, chosen deterministically from its id so
// it stays the same every time you see it. The type badge and action buttons
// keep their normal styling throughout — only the "poster" area changes, so
// the cards can be loud without becoming unusable.
function hashId(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0x7fffffff;
  return h;
}

// Skins are grouped into a family per category, so the palette signals the
// type (amber = task, violet = idea, teal = research, gold = buy,
// blue = note, green = project) while the treatment still
// varies wildly within it. Each item keeps one skin permanently, picked from
// Each category is its own visual world — one theme, several variations —
// so the look tells you the type before you read the badge, and the feed
// feels composed rather than random. A skin is picked from the item's own
// family by a hash of its id, so it never changes once assigned.
//
// One look per category, built from the real content only — no fake handles,
// like counts or invented metadata:
//   Task    · inspirational meme posters (the one place the joke lives)
//   Buy     · fluoro die-cut price stickers, all on one shared card
//   Note    · paper — torn pages, spiral pads, plain colour cards
//   Project · ring binder pages and bold colour blocks
const SKIN_FAMILIES = {
  // ---- TASK · corny inspirational memes ----
  task: [
    () => ({ bg: "linear-gradient(180deg,#FFC97A,#E2703A 55%,#5E2A12)", ink: "#FFF8EE", sub: "rgba(255,248,238,0.9)", chrome: "rgba(0,0,0,0.3)",
      titleStyle: { fontFamily: "Fraunces,serif", fontStyle: "italic", fontWeight: 500, fontSize: 30, lineHeight: 1.32, textShadow: "0 2px 18px rgba(0,0,0,0.78), 0 1px 3px rgba(0,0,0,0.9)" }, meme: true, center: true, pad: "24px 32px", attribution: "— every to-do list, ever", deco: "dunes" }),
    () => ({ bg: "linear-gradient(180deg,#A8D8B0,#3E7A52 50%,#0B2616)", ink: "#F4FFF0", sub: "rgba(244,255,240,0.9)", chrome: "rgba(0,0,0,0.3)",
      titleStyle: { fontFamily: "'Playfair Display',serif", fontWeight: 700, fontSize: 29, lineHeight: 1.36, textShadow: "0 2px 18px rgba(0,0,0,0.78), 0 1px 3px rgba(0,0,0,0.9)" }, meme: true, center: true, pad: "24px 32px", attribution: "— one day at a time", deco: "forest" }),
    () => ({ bg: "linear-gradient(180deg,#BFF5EA,#3E9AA8 45%,#0E4A50)", ink: "#F2FFFC", sub: "rgba(242,255,252,0.9)", chrome: "rgba(0,0,0,0.3)",
      titleStyle: { fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 23, lineHeight: 1.55, letterSpacing: "0.15em", textTransform: "uppercase", textShadow: "0 2px 16px rgba(0,0,0,0.8)" }, meme: true, center: true, pad: "24px 32px", attribution: "— go with the flow", deco: "ocean" }),
    () => ({ bg: "linear-gradient(180deg,#D6E8F7,#7FA4C8 50%,#2A3E58)", ink: "#F8FCFF", sub: "rgba(248,252,255,0.9)", chrome: "rgba(0,0,0,0.3)",
      titleStyle: { fontFamily: "Fraunces,serif", fontStyle: "italic", fontWeight: 500, fontSize: 30, lineHeight: 1.32, textShadow: "0 2px 18px rgba(0,0,0,0.78), 0 1px 3px rgba(0,0,0,0.9)" }, meme: true, center: true, pad: "24px 32px", attribution: "— the summit is optional", deco: "snowpeaks" }),
    () => ({ bg: "linear-gradient(180deg,#1B1040,#2A1B5E 50%,#0A1420)", ink: "#F2EEFF", sub: "rgba(242,238,255,0.9)", chrome: "rgba(0,0,0,0.32)",
      titleStyle: { fontFamily: "'Playfair Display',serif", fontWeight: 700, fontSize: 29, lineHeight: 1.36, textShadow: "0 2px 18px rgba(0,0,0,0.8), 0 1px 3px rgba(0,0,0,0.9)" }, meme: true, center: true, pad: "24px 32px", attribution: "— the universe is telling you something", deco: "aurora" }),
    () => ({ bg: "linear-gradient(180deg,#FFD9E8,#E88AAE 50%,#5A2438)", ink: "#FFF8FB", sub: "rgba(255,248,251,0.9)", chrome: "rgba(0,0,0,0.28)",
      titleStyle: { fontFamily: "Fraunces,serif", fontStyle: "italic", fontWeight: 500, fontSize: 30, lineHeight: 1.32, textShadow: "0 2px 18px rgba(0,0,0,0.72), 0 1px 3px rgba(0,0,0,0.85)" }, meme: true, center: true, pad: "24px 32px", attribution: "— bloom where you are planted", deco: "blossom" }),
    () => ({ bg: "linear-gradient(180deg,#0E1030,#241640 55%,#120A22)", ink: "#F6F0FF", sub: "rgba(246,240,255,0.9)", chrome: "rgba(0,0,0,0.32)",
      titleStyle: { fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 23, lineHeight: 1.55, letterSpacing: "0.15em", textTransform: "uppercase", textShadow: "0 2px 16px rgba(0,0,0,0.8)" }, meme: true, center: true, pad: "24px 32px", attribution: "— shoot for the moon", deco: "starfield" }),
    () => ({ bg: "linear-gradient(180deg,#E8F4C8,#8AB84A 50%,#2E4A16)", ink: "#FAFFF0", sub: "rgba(250,255,240,0.9)", chrome: "rgba(0,0,0,0.3)",
      titleStyle: { fontFamily: "Fraunces,serif", fontStyle: "italic", fontWeight: 500, fontSize: 30, lineHeight: 1.32, textShadow: "0 2px 18px rgba(0,0,0,0.75), 0 1px 3px rgba(0,0,0,0.9)" }, meme: true, center: true, pad: "24px 32px", attribution: "— future you says thanks", deco: "meadow" }),
  ],

  // ---- NOTE · torn notebook pages, ink, doodles ----
  note: [
    () => ({ bg: "#FFF25C", ink: "#2A2600", sub: "rgba(42,38,0,0.62)", chrome: "rgba(42,38,0,0.1)", pad: "58px 26px 30px",
      titleStyle: { fontFamily: "'Kalam',cursive", fontWeight: 700, fontSize: 42, lineHeight: 1.18, letterSpacing: "0.2px" }, center: true, deco: "postit", clip: "polygon(0% 0%, 100% 0%, 100% 86%, 86% 100%, 0% 100%)", tilt: -1.2 }),
    () => ({ bg: "#FF7BC8", ink: "#3A0A26", sub: "rgba(58,10,38,0.62)", chrome: "rgba(58,10,38,0.1)", pad: "58px 26px 30px",
      titleStyle: { fontFamily: "'Kalam',cursive", fontWeight: 700, fontSize: 40, lineHeight: 1.2, letterSpacing: "0.2px" }, center: true, deco: "postit", clip: "polygon(0% 0%, 100% 0%, 100% 86%, 86% 100%, 0% 100%)", tilt: 1.4 }),
    () => ({ bg: "#9BFF6B", ink: "#0E2A06", sub: "rgba(14,42,6,0.62)", chrome: "rgba(14,42,6,0.1)", pad: "52px 26px 30px",
      titleStyle: { fontFamily: "'Kalam',cursive", fontWeight: 700, fontSize: 43, lineHeight: 1.16, letterSpacing: "0.2px" }, center: true, deco: "postitPlain", clip: "polygon(0% 0%, 100% 0%, 100% 86%, 86% 100%, 0% 100%)", tilt: -0.8 }),
    () => ({ bg: "#6BE3FF", ink: "#052A36", sub: "rgba(5,42,54,0.62)", chrome: "rgba(5,42,54,0.1)", pad: "58px 26px 30px",
      titleStyle: { fontFamily: "'Kalam',cursive", fontWeight: 700, fontSize: 41, lineHeight: 1.19, letterSpacing: "0.2px" }, center: true, deco: "postit", clip: "polygon(0% 0%, 100% 0%, 100% 86%, 86% 100%, 0% 100%)", tilt: 1 }),
    () => ({ bg: "#FFA94D", ink: "#3A1A00", sub: "rgba(58,26,0,0.62)", chrome: "rgba(58,26,0,0.1)", pad: "52px 26px 30px",
      titleStyle: { fontFamily: "'Kalam',cursive", fontWeight: 700, fontSize: 40, lineHeight: 1.2, letterSpacing: "0.2px" }, center: true, deco: "postitPlain", clip: "polygon(0% 0%, 100% 0%, 100% 86%, 86% 100%, 0% 100%)", tilt: -1.6 }),
    () => ({ bg: "#C9A7FF", ink: "#22093A", sub: "rgba(34,9,58,0.62)", chrome: "rgba(34,9,58,0.1)", pad: "58px 26px 30px",
      titleStyle: { fontFamily: "'Kalam',cursive", fontWeight: 700, fontSize: 42, lineHeight: 1.18, letterSpacing: "0.2px" }, center: true, deco: "postit", clip: "polygon(0% 0%, 100% 0%, 100% 86%, 86% 100%, 0% 100%)", tilt: 0.7 }),
  ],

  // ---- PROJECT · 90s neon zigzag Filofax ----
  project: [
    () => ({ bg: "#E8195B", ink: "#14121F", sub: "#5B5568", chrome: "rgba(20,18,31,0.1)", pad: "34px 30px 34px 56px",
      titleStyle: { fontFamily: "'Bungee',sans-serif", fontSize: 28, lineHeight: 1.25 }, deco: "funfaxDots" }),
    () => ({ bg: "#00A8E8", ink: "#14121F", sub: "#5B5568", chrome: "rgba(20,18,31,0.1)", pad: "34px 30px 34px 56px",
      titleStyle: { fontFamily: "'Fredoka',sans-serif", fontWeight: 700, fontSize: 32, lineHeight: 1.24 }, deco: "funfaxTabs" }),
    () => ({ bg: "#FFC400", ink: "#14121F", sub: "#5B5568", chrome: "rgba(20,18,31,0.1)", pad: "48px 30px 34px 56px",
      titleStyle: { fontFamily: "'Bungee',sans-serif", fontSize: 30, lineHeight: 1.22 }, deco: "funfaxZig" }),
    () => ({ bg: "#7B2FF7", ink: "#14121F", sub: "#5B5568", chrome: "rgba(20,18,31,0.1)", pad: "34px 30px 34px 56px",
      titleStyle: { fontFamily: "'Righteous',cursive", fontSize: 32, lineHeight: 1.26 }, deco: "funfaxDots" }),
    () => ({ bg: "#00C46A", ink: "#14121F", sub: "#5B5568", chrome: "rgba(20,18,31,0.1)", pad: "48px 30px 34px 56px",
      titleStyle: { fontFamily: "'Fredoka',sans-serif", fontWeight: 700, fontSize: 31, lineHeight: 1.26 }, deco: "funfaxZig" }),
    () => ({ bg: "#FF6B00", ink: "#14121F", sub: "#5B5568", chrome: "rgba(20,18,31,0.1)", pad: "34px 30px 34px 56px",
      titleStyle: { fontFamily: "'Bungee',sans-serif", fontSize: 26, lineHeight: 1.3 }, deco: "funfaxTabs" }),
  ],
};

function skinFor(item, accent) {
  const family = SKIN_FAMILIES[item.type] || SKIN_FAMILIES.task;
  return family[hashId(item.id) % family.length](accent);
}


// Index tabs for the Funfax pages: same five every time, tapering in size
// top to bottom like a fat binder. right = (page inset) - (tab width), which
// is what makes the tab's inner edge land exactly on the page edge instead
// of overlapping it — the previous version had the tab starting inside the
// page and only partly poking out.
const FUNFAX_PAGE_INSET = 26;
const PROJECT_TABS = [
  { color: "#E8195B", top: 34, h: 46, w: 24 },
  { color: "#FFC400", top: 82, h: 42, w: 22 },
  { color: "#00C46A", top: 126, h: 38, w: 20 },
  { color: "#00A8E8", top: 166, h: 34, w: 18 },
  { color: "#7B2FF7", top: 202, h: 30, w: 16 },
].map((t) => ({ ...t, right: FUNFAX_PAGE_INSET - t.w }));

function ProjectTabs() {
  return (
    <>
      {PROJECT_TABS.map((t, i) => (
        <span
          key={i}
          className="pointer-events-none absolute"
          style={{
            right: t.right,
            top: t.top,
            width: t.w,
            height: t.h,
            background: t.color,
            borderRadius: "0 6px 6px 0",
            boxShadow: "2px 2px 4px rgba(0,0,0,0.35)",
          }}
        />
      ))}
    </>
  );
}

function CardDeco({ kind, accent, item }) {
  const abs = "pointer-events-none absolute";
  switch (kind) {
    case "forest":
      return (<>
        <span className={abs} style={{ inset: 0, background: "linear-gradient(180deg,rgba(255,255,255,0.16),transparent 42%)" }} />
        {[...Array(7)].map((_, i) => (
          <span key={i} className={abs} style={{ left: `${i * 15 - 4}%`, bottom: 0, width: 0, height: 0, borderLeft: `${28 + (i % 3) * 8}px solid transparent`, borderRight: `${28 + (i % 3) * 8}px solid transparent`, borderBottom: `${120 + (i % 4) * 38}px solid ${i % 2 ? "#123B22" : "#0B2616"}` }} />
        ))}
      </>);
    case "snowpeaks":
      return (<>
        <span className={abs} style={{ inset: 0, background: "linear-gradient(180deg,rgba(255,255,255,0.18),transparent 40%)" }} />
        <span className={abs} style={{ left: -20, right: "30%", bottom: 0, height: "48%", background: "#4A6280", clipPath: "polygon(0% 100%,34% 8%,66% 66%,86% 32%,100% 100%)" }} />
        <span className={abs} style={{ left: "28%", right: -20, bottom: 0, height: "38%", background: "#33465F", clipPath: "polygon(0% 100%,28% 14%,58% 70%,80% 28%,100% 100%)" }} />
        {[...Array(10)].map((_, i) => (
          <span key={i} className={abs} style={{ left: `${(i * 31 + 4) % 96}%`, top: `${(i * 23 + 6) % 56}%`, width: 3, height: 3, borderRadius: 3, background: "#fff", opacity: 0.8 }} />
        ))}
      </>);
    case "ocean":
      return (<>
        <span className={abs} style={{ right: 44, top: "14%", width: 62, height: 62, borderRadius: "50%", background: "radial-gradient(circle,#EAFFFB,#8FE8D8)", boxShadow: "0 0 44px 16px rgba(143,232,216,0.32)" }} />
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={abs} style={{ left: 0, right: 0, bottom: `${i * 9}%`, height: "17%", background: ["#0E4A50", "#12626B", "#177C86", "#1E97A3"][i], clipPath: "polygon(0% 100%,0% 42%,22% 18%,48% 48%,72% 20%,100% 44%,100% 100%)", opacity: 0.92 }} />
        ))}
      </>);
    case "aurora":
      return (<>
        {[0, 1, 2].map((i) => (
          <span key={i} className={`bs-blob ${abs}`} style={{ left: `${-10 + i * 26}%`, top: `${4 + i * 7}%`, width: "70%", height: 160, background: `linear-gradient(180deg,${["#6BFFB8", "#7FD8FF", "#C3B2FF"][i]},transparent)`, filter: "blur(28px)", opacity: 0.5, animationDelay: `${i * 2}s` }} />
        ))}
        {[...Array(14)].map((_, i) => (
          <span key={`s${i}`} className={abs} style={{ left: `${(i * 41 + 5) % 95}%`, top: `${(i * 29 + 4) % 48}%`, width: 2, height: 2, background: "#fff", borderRadius: 2, opacity: 0.8 }} />
        ))}
        <span className={abs} style={{ left: 0, right: 0, bottom: 0, height: "26%", background: "#0A1420", clipPath: "polygon(0% 100%,0% 46%,22% 20%,50% 54%,78% 24%,100% 50%,100% 100%)" }} />
      </>);
    case "blossom":
      return (<>
        {[...Array(9)].map((_, i) => (
          <span key={i} className={abs} style={{ left: `${(i * 23 + 6) % 94}%`, top: `${(i * 31 + 8) % 66}%`, fontSize: 12 + (i % 3) * 4, opacity: 0.85 }}>🌸</span>
        ))}
        <span className={abs} style={{ left: -10, top: -10, width: "60%", height: 74, background: "#5A2438", borderRadius: "0 0 70% 0", opacity: 0.5 }} />
        <span className={abs} style={{ left: 0, right: 0, bottom: 0, height: "22%", background: "rgba(0,0,0,0.28)", clipPath: "polygon(0% 100%,0% 56%,34% 30%,70% 60%,100% 36%,100% 100%)" }} />
      </>);
    case "starfield":
      return (<>
        {[...Array(20)].map((_, i) => (
          <span key={i} className={abs} style={{ left: `${(i * 37 + 7) % 96}%`, top: `${(i * 53 + 5) % 60}%`, width: i % 4 ? 2 : 3, height: i % 4 ? 2 : 3, background: "#fff", borderRadius: 3, opacity: 0.85 }} />
        ))}
        <span className={abs} style={{ right: 36, top: 42, width: 50, height: 50, borderRadius: "50%", background: "radial-gradient(circle at 35% 35%,#FFF8E7,#D9CFF0)", boxShadow: "0 0 36px 10px rgba(217,207,240,0.35)" }} />
        <span className={abs} style={{ left: 0, right: 0, bottom: 0, height: "28%", background: "#120A22", clipPath: "polygon(0% 100%,0% 42%,24% 18%,52% 52%,74% 26%,100% 56%,100% 100%)" }} />
      </>);
    case "dunes":
      return (<>
        <span className={`${abs} rounded-full`} style={{ left: "50%", top: "22%", width: 100, height: 100, marginLeft: -50, background: "radial-gradient(circle,#FFF1C9,#FF9A3C)", boxShadow: "0 0 70px 26px rgba(255,154,60,0.42)" }} />
        <span className={abs} style={{ left: 0, right: 0, bottom: 0, height: "38%", background: "#7A431C", clipPath: "polygon(0% 100%,0% 44%,34% 20%,68% 50%,100% 26%,100% 100%)" }} />
        <span className={abs} style={{ left: 0, right: 0, bottom: 0, height: "24%", background: "#4E2810", clipPath: "polygon(0% 100%,0% 58%,42% 30%,76% 60%,100% 40%,100% 100%)" }} />
      </>);
    case "meadow":
      return (<>
        <span className={`${abs} rounded-full`} style={{ left: "50%", top: "14%", width: 84, height: 84, marginLeft: -42, background: "radial-gradient(circle,#FFFBE8,#FFE066)", boxShadow: "0 0 60px 24px rgba(255,224,102,0.4)" }} />
        <span className={abs} style={{ left: 0, right: 0, bottom: 0, height: "36%", background: "#4C7A2A", borderRadius: "50% 50% 0 0 / 26% 26% 0 0" }} />
        <span className={abs} style={{ left: "-14%", right: "40%", bottom: 0, height: "26%", background: "#3C6320", borderRadius: "50% 50% 0 0 / 32% 32% 0 0" }} />
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className={`bs-float ${abs}`} style={{ left: `${12 + i * 18}%`, bottom: `${8 + (i % 3) * 7}%`, fontSize: 13, animationDelay: `${i * 0.7}s` }}>🌼</span>
        ))}
      </>);
    // ================= BUY · shopping content =================
    case "labelPink":
    case "labelGreen":
    case "labelOrange": {
      const star = "polygon(50% 0%,56% 9%,65% 3%,67% 14%,78% 10%,76% 21%,87% 20%,81% 30%,93% 32%,84% 40%,96% 45%,86% 50%,96% 55%,84% 60%,93% 68%,81% 70%,87% 80%,76% 79%,78% 90%,67% 86%,65% 97%,56% 91%,50% 100%,44% 91%,35% 97%,33% 86%,22% 90%,24% 79%,13% 80%,19% 70%,7% 68%,16% 60%,4% 55%,14% 50%,4% 45%,16% 40%,7% 32%,19% 30%,13% 20%,24% 21%,22% 10%,33% 14%,35% 3%,44% 9%)";
      return (<>
        <span className={abs} style={{ inset: 0, background: "#F2EFE8", backgroundImage: "repeating-linear-gradient(93deg,rgba(0,0,0,0.035) 0 3px,transparent 3px 26px)" }} />
        <span className={abs} style={{ left: "50%", top: "19%", width: "96%", height: "56%", marginLeft: "-48%", background: kind === "labelPink" ? "#FF3BA7" : kind === "labelGreen" ? "#39FF14" : kind === "labelOrange" ? "#FF5C1A" : "#FFE800", clipPath: star, filter: "drop-shadow(0 6px 10px rgba(0,0,0,0.22))" }} />
      </>);
    }
    // PROJECT · 90s Funfax — a bright ring binder, white page, and the chunky
    // primary-coloured patterns those organisers were covered in.
    case "funfaxDots":
      return (<>
        <span className={abs} style={{ inset: 0, backgroundImage: "radial-gradient(circle at 20% 24%,rgba(255,255,255,0.35) 0 7px,transparent 8px),radial-gradient(circle at 76% 62%,rgba(255,255,255,0.28) 0 5px,transparent 6px),radial-gradient(circle at 44% 86%,rgba(255,255,255,0.22) 0 6px,transparent 7px)", backgroundSize: "120px 120px" }} />
        <span className={abs} style={{ left: 34, right: FUNFAX_PAGE_INSET, top: 12, bottom: 12, background: "#FFFFFF", borderRadius: "3px 8px 8px 3px", boxShadow: "0 10px 22px rgba(0,0,0,0.4)" }} />
        <span className={abs} style={{ left: 50, top: 12, bottom: 12, width: 1.5, background: "rgba(232,25,91,0.35)" }} />
        {[...Array(6)].map((_, i) => (
          <span key={i} className={abs} style={{ left: 12, top: 46 + i * 46, width: 15, height: 15, borderRadius: "50%", background: "rgba(0,0,0,0.5)", border: "2px solid #FFFFFF", boxShadow: "inset 0 2px 3px rgba(0,0,0,0.5)" }} />
        ))}
        <ProjectTabs />
      </>);
    case "funfaxZig":
      return (<>
        <span className={abs} style={{ left: 34, right: FUNFAX_PAGE_INSET, top: 12, bottom: 12, background: "#FFFFFF", borderRadius: "3px 8px 8px 3px", boxShadow: "0 10px 22px rgba(0,0,0,0.4)" }} />
        <span className={abs} style={{ left: 50, right: FUNFAX_PAGE_INSET + 14, top: 24, height: 20, backgroundImage: "linear-gradient(135deg,#E8195B 25%,transparent 25%),linear-gradient(225deg,#00A8E8 25%,transparent 25%),linear-gradient(45deg,#FFC400 25%,transparent 25%)", backgroundSize: "16px 16px" }} />
        <span className={abs} style={{ left: 50, right: FUNFAX_PAGE_INSET + 14, bottom: 26, height: 14, backgroundImage: "linear-gradient(135deg,#00C46A 25%,transparent 25%),linear-gradient(225deg,#7B2FF7 25%,transparent 25%)", backgroundSize: "14px 14px" }} />
        <span className={abs} style={{ left: 50, top: 12, bottom: 12, width: 1.5, background: "rgba(232,25,91,0.3)" }} />
        {[...Array(6)].map((_, i) => (
          <span key={i} className={abs} style={{ left: 12, top: 46 + i * 46, width: 15, height: 15, borderRadius: "50%", background: "rgba(0,0,0,0.5)", border: "2px solid #FFFFFF", boxShadow: "inset 0 2px 3px rgba(0,0,0,0.5)" }} />
        ))}
        <ProjectTabs />
      </>);
    case "funfaxTabs":
      return (<>
        <span className={abs} style={{ inset: 0, backgroundImage: "repeating-linear-gradient(45deg,rgba(255,255,255,0.16) 0 10px,transparent 10px 20px)" }} />
        <span className={abs} style={{ left: 34, right: FUNFAX_PAGE_INSET, top: 12, bottom: 12, background: "#FFFFFF", borderRadius: "3px 6px 6px 3px", boxShadow: "0 10px 22px rgba(0,0,0,0.4)" }} />
        {[...Array(6)].map((_, i) => (
          <span key={`h${i}`} className={abs} style={{ left: 12, top: 46 + i * 46, width: 15, height: 15, borderRadius: "50%", background: "rgba(0,0,0,0.5)", border: "2px solid #FFFFFF", boxShadow: "inset 0 2px 3px rgba(0,0,0,0.5)" }} />
        ))}
        <ProjectTabs />
      </>);
    case "postit":
      return (<>
        <span className={`${abs} inset-x-0`} style={{ top: 0, height: "17%", background: "rgba(0,0,0,0.07)" }} />
        <span className={`${abs} inset-x-0`} style={{ top: "17%", height: 1, background: "rgba(0,0,0,0.06)" }} />
        {/* shading into the cut corner, so the fold reads as depth */}
        <span className={abs} style={{ right: 0, bottom: 0, width: 78, height: 78, background: "linear-gradient(315deg,rgba(0,0,0,0.13),transparent 62%)" }} />
      </>);
    case "postitPlain":
      return (<>
        <span className={`${abs} inset-x-0`} style={{ top: 0, height: "14%", background: "rgba(0,0,0,0.06)" }} />
        <span className={abs} style={{ right: 0, bottom: 0, width: 70, height: 70, background: "linear-gradient(315deg,rgba(0,0,0,0.12),transparent 60%)" }} />
      </>);
    default:
      return null;
  }
}

// Up to 5 fluoro die-cut price stickers on one card. They're landscape —
// like the real shelf tags — stacked down the card with slight random tilts
// and a soft drop shadow so they read as physical bits of card.
const LABEL_COLORS = ["#FF3BA7", "#39FF14", "#FFE800", "#FF5C1A", "#00E5FF"];
const LABEL_TILTS = [-2.5, 1.8, -1.2, 2.4, -1.8];

function ShoppingListCard({ items, onOpen }) {
  return (
    <div
      className="relative flex flex-col overflow-hidden rounded-[26px]"
      style={{
        minHeight: "76vh",
        padding: "62px 18px 26px",
        background: "#F2EFE8",
        backgroundImage: "repeating-linear-gradient(93deg,rgba(0,0,0,0.035) 0 3px,transparent 3px 26px)",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 18px 50px -20px rgba(0,0,0,0.65)",
      }}
    >
      <span
        className="absolute left-5 top-5 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold"
        style={{ background: "rgba(20,18,31,0.08)", color: "#8A6A00" }}
      >
        <ShoppingCart size={12} /> Shopping list
      </span>

      <div className="flex flex-1 flex-col justify-center" style={{ gap: 2 }}>
        {items.map((item, i) => {
          const color = LABEL_COLORS[i % LABEL_COLORS.length];
          const tilt = LABEL_TILTS[i % LABEL_TILTS.length];
          const h = items.length <= 2 ? 150 : items.length === 3 ? 124 : items.length === 4 ? 108 : 96;
          // Fit to whichever runs out first: the height available for two
          // lines, or the width of the star's inner disc for this many
          // characters. Without this a long title runs out through the spikes.
          const chars = Math.max(item.title.length, 5);
          const fontSize = Math.max(12, Math.min(38, Math.round(h * 0.26), Math.round(600 / chars)));
          return (
            <button
              key={item.id}
              onClick={() => onOpen(item.id)}
              className="relative flex w-full items-center justify-center active:scale-95 transition-transform"
              style={{
                height: h,
                transform: `rotate(${tilt}deg)`,
                background: color,
                clipPath: STAR_CLIP,
                filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.28))",
              }}
            >
              <span
                className="text-center"
                style={{
                  // width + minWidth are what force wrapping: a flex child
                  // defaults to min-content and will happily overflow instead.
                  width: "70%",
                  minWidth: 0,
                  maxWidth: "70%",
                  fontFamily: "'Permanent Marker',cursive",
                  fontSize,
                  lineHeight: 1.06,
                  color: "#111",
                  overflowWrap: "anywhere",
                  wordBreak: "break-word",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {item.title}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Card({ item, now, onOpen, onComplete, onSnooze, onShortlist, onUnshortlist }) {
  const cfg = TYPE_CONFIG[item.type] || TYPE_CONFIG.task;
  const msg = neglectMessage(item, now);
  const doneCount = item.subtasks.filter((s) => s.done).length;
  const skin = useMemo(() => skinFor(item, cfg.color), [item.id, item.type, cfg.color]); // eslint-disable-line

  // Cards earn their height. A bare two-word note shouldn't leave three
  // quarters of a screen empty — it gets a shorter card and much bigger type,
  // the way a short social post does.
  const len = item.title.length;
  const extras =
    (item.notes ? 1 : 0) + (item.subtasks.length ? 1 : 0) + (msg ? 1 : 0);
  const cardHeight =
    len <= 30 && extras === 0
      ? "44vh"
      : len <= 60 && extras <= 1
      ? "58vh"
      : "72vh";
  // Posters need room for their scenery, so they never go fully compact.
  const minHeight = skin.meme && cardHeight === "44vh" ? "56vh" : cardHeight;
  const titleScale = len <= 12 ? 1.55 : len <= 20 ? 1.34 : len <= 30 ? 1.16 : len <= 48 ? 1.02 : 0.94;
  const scaledTitle = {
    ...skin.titleStyle,
    fontSize: skin.titleStyle && skin.titleStyle.fontSize
      ? Math.round(skin.titleStyle.fontSize * titleScale)
      : undefined,
  };

  return (
    <div
      className="relative flex flex-col overflow-hidden rounded-[26px]"
      style={{
        padding: skin.pad || 24,
        minHeight,
        clipPath: skin.clip,
        background: skin.bg,
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 18px 50px -20px rgba(0,0,0,0.65)",
        transform: skin.tilt ? `rotate(${skin.tilt}deg)` : undefined,
      }}
    >
      <CardDeco kind={skin.deco} accent={cfg.color} item={item} />

      <div
        className="relative flex items-center justify-between"
        style={{ marginTop: ["zigzag", "tabs", "saleband", "casefile"].includes(skin.deco) ? 18 : 0 }}
      >
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
          style={{ background: skin.chrome, color: skin.ink === "transparent" ? cfg.color : skin.ink }}
        >
          <TypeIcon type={item.type} size={12} />
          {cfg.label}
        </span>
        <div className="flex items-center gap-2">
          {item.recurrenceDays && (
            <span className="rounded-full px-2 py-1 text-[11px] font-semibold" style={{ background: skin.chrome, color: skin.sub }}>
              🔁 {Math.round(item.recurrenceDays / 7)}w
            </span>
          )}
          {postureOf(item) && (
            <span className="rounded-full px-2 py-1 text-[11px]" style={{ background: skin.chrome, color: skin.sub }}>
              {postureOf(item) === "sit" ? "🪑" : "🚶"}
            </span>
          )}
          {areaOf(item) && (
            <span className="rounded-full px-2 py-1 text-[11px] font-semibold" style={{ background: skin.chrome, color: skin.sub }}>
              {AREA_CONFIG[areaOf(item)].emoji} {AREA_CONFIG[areaOf(item)].label}
            </span>
          )}
          {item.sourceImageId && <ImageIcon size={13} color={skin.sub} />}
        </div>
      </div>

      <button
        onClick={() => onOpen(item.id)}
        className={`relative mt-6 flex-1 w-full ${skin.center ? "flex flex-col justify-center text-center" : "text-left"}`}
      >
        <h2
          className={skin.shimmerTitle ? "bs-shimmer" : undefined}
          style={{ ...scaledTitle, color: skin.shimmerTitle ? undefined : skin.ink }}
        >
          {skin.meme ? "\u201C" + item.title + "\u201D" : item.title}
        </h2>
        {skin.attribution && (
          <p
            className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: skin.sub, textShadow: "0 1px 6px rgba(0,0,0,0.7)" }}
          >
            {skin.attribution}
          </p>
        )}
        {item.notes ? (
          <p
            className="mt-2.5 text-[14px] leading-relaxed line-clamp-3"
            style={{ color: skin.sub, textShadow: skin.meme ? "0 1px 8px rgba(0,0,0,0.8)" : undefined }}
          >
            {item.notes}
          </p>
        ) : null}
        {item.subtasks.length > 0 && (
          <div className={`mt-3.5 flex items-center gap-2 text-xs ${skin.center ? "justify-center" : ""}`} style={{ color: skin.sub }}>
            <div className="h-1.5 w-24 overflow-hidden rounded-full" style={{ background: skin.chrome }}>
              <div className="h-full rounded-full" style={{ width: `${(doneCount / item.subtasks.length) * 100}%`, background: cfg.color }} />
            </div>
            {doneCount}/{item.subtasks.length} done
          </div>
        )}
        {msg && (
          <p
            className="mt-4 text-[13px] italic"
            style={{ color: skin.sub, textShadow: skin.meme ? "0 1px 8px rgba(0,0,0,0.8)" : undefined }}
          >
            {msg}
          </p>
        )}
      </button>

      <div className="relative mt-5 flex items-center justify-between">
        <ItemActions
          item={item}
          onComplete={onComplete}
          onShortlist={onShortlist}
          onUnshortlist={onUnshortlist}
          onSnooze={onSnooze}
          skin={skin}
        />
        {item.shortlisted && (
          <span className="flex items-center gap-1 text-[11px] font-bold" style={{ color: skin.ink === "transparent" ? "#FFD166" : skin.ink }}>
            <Star size={10} fill="currentColor" /> today
          </span>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Feed ranking                                                           */
/* ---------------------------------------------------------------------- */

function rankPool(items, mode, now, seed, area) {
  let rand = seed;
  const nextRand = () => {
    rand = (rand * 1103515245 + 12345) & 0x7fffffff;
    return (rand % 10000) / 10000;
  };

  let pool = items.filter((i) => i.status === "active");
  pool = pool.filter((i) => !i.snoozedUntil || i.snoozedUntil <= now);

  if (mode === "five") pool = pool.filter((i) => i.estimatedMinutes && i.estimatedMinutes <= 5);
  if (area) pool = pool.filter((i) => areaOf(i) === area);
  if (mode === "sit") pool = pool.filter((i) => postureOf(i) === "sit");
  if (mode === "move") pool = pool.filter((i) => postureOf(i) === "move");
  if (mode === "today") pool = pool.filter((i) => i.shortlisted);

  const scored = pool.map((item) => {
    let score = 0;
    const daysSinceCreated = (now - item.createdAt) / DAY;
    const daysSinceTouched = (now - (item.updatedAt || item.createdAt)) / DAY;
    const wasResurfaced = item.snoozedUntil && item.snoozedUntil <= now;
    if (wasResurfaced) score += 22;
    if (daysSinceCreated < 1) score += 16;
    if (daysSinceTouched > 7) score += Math.min(10 + daysSinceTouched * 0.4, 30);
    if (item.shortlisted) score += 45;
    score += nextRand() * 18;
    return { item: { ...item, resurfaced: !!wasResurfaced }, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/* ---------------------------------------------------------------------- */
/* Item Detail                                                            */
/* ---------------------------------------------------------------------- */

function ItemDetail({ item, allItems, imageUrl, onClose, onUpdate, onComplete, onSnooze, onDelete, onOpenRelated }) {
  const [newSubtask, setNewSubtask] = useState("");
  const [newThought, setNewThought] = useState("");
  const [relPicker, setRelPicker] = useState(false);
  const [relQuery, setRelQuery] = useState("");
  const [showImage, setShowImage] = useState(false);
  const cfg = TYPE_CONFIG[item.type] || TYPE_CONFIG.task;

  const patch = (fields) => onUpdate(item.id, fields);

  const relatedOptions = allItems.filter(
    (i) => i.id !== item.id && !item.relatedItemIds.includes(i.id) && i.title.toLowerCase().includes(relQuery.toLowerCase())
  );

  return (
    <div className="fixed inset-0 flex flex-col" style={{ background: "#14121F", zIndex: 70 }}>
      <div
        className="flex items-center justify-between px-4 pb-4"
        style={{ paddingTop: `calc(env(safe-area-inset-top, 0px) + ${TOP_INSET}px)`, borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <button onClick={onClose} className="p-2 -ml-2 active:scale-90 transition-transform">
          <ArrowLeft size={22} color="#EDEBFB" />
        </button>
        <TypeBadge type={item.type} />
        <button onClick={() => onDelete(item.id)} className="p-2 -mr-2 active:scale-90 transition-transform">
          <Trash2 size={19} color="#8B87A0" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-32 pt-5">
        {/* type switcher */}
        <div className="mb-4 flex flex-wrap gap-1.5">
          {TYPE_ORDER.map((t) => (
            <button
              key={t}
              onClick={() => patch({ type: t })}
              className="flex items-center justify-center rounded-full p-1.5 transition-transform active:scale-90"
              style={{
                background: item.type === t ? TYPE_CONFIG[t].soft : "transparent",
                border: item.type === t ? `1px solid ${TYPE_CONFIG[t].color}55` : "1px solid transparent",
              }}
            >
              <TypeIcon type={t} size={15} />
            </button>
          ))}
        </div>

        <textarea
          value={item.title}
          onChange={(e) => patch({ title: e.target.value })}
          rows={2}
          className="w-full resize-none bg-transparent text-[26px] leading-tight text-white outline-none"
          style={{ fontFamily: "Fraunces, serif" }}
        />

        {item.sourceImageId && (
          <button
            onClick={() => setShowImage(true)}
            className="mt-3 flex items-center gap-1.5 text-xs font-medium"
            style={{ color: "#8FC6FF" }}
          >
            <ImageIcon size={13} /> From photo
          </button>
        )}

        {/* Notes */}
        <div className="mt-7">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "#736E88" }}>
            Notes
          </p>
          <textarea
            value={item.notes}
            onChange={(e) => patch({ notes: e.target.value })}
            placeholder="Add any detail…"
            rows={3}
            className="w-full resize-none rounded-2xl p-3.5 text-[15px] leading-relaxed outline-none"
            style={{ background: "rgba(255,255,255,0.04)", color: "#DAD7E5" }}
          />
        </div>

        {/* Area of life */}
        <div className="mt-7">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider" style={{ color: "#736E88" }}>
            <Layers size={12} /> Area
          </p>
          <div className="flex flex-wrap gap-2">
            {AREA_ORDER.map((a) => {
              const active = areaOf(item) === a;
              return (
                <button
                  key={a}
                  onClick={() => patch({ area: active ? null : a })}
                  className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium active:scale-95 transition-transform"
                  style={{
                    background: active ? "rgba(195,178,255,0.18)" : "rgba(255,255,255,0.04)",
                    color: active ? "#C3B2FF" : "#8B87A0",
                  }}
                >
                  {AREA_CONFIG[a].emoji} {AREA_CONFIG[a].label}
                </button>
              );
            })}
          </div>
          {!item.area && areaOf(item) && (
            <p className="mt-2 text-xs" style={{ color: "#736E88" }}>
              Guessed from the wording — tap to set it yourself.
            </p>
          )}
        </div>

        {/* Sitting down or not */}
        <div className="mt-7">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider" style={{ color: "#736E88" }}>
            <Armchair size={12} /> Can I do it sitting down?
          </p>
          <div className="flex gap-2">
            {[
              { key: "sit", label: "Sitting down", Icon: Armchair },
              { key: "move", label: "Up and about", Icon: Footprints },
            ].map(({ key, label, Icon }) => {
              const active = postureOf(item) === key;
              return (
                <button
                  key={key}
                  onClick={() => patch({ posture: active ? null : key })}
                  className="flex flex-1 items-center justify-center gap-2 rounded-full py-2.5 text-sm font-medium active:scale-95 transition-transform"
                  style={{
                    background: active ? "rgba(159,214,140,0.18)" : "rgba(255,255,255,0.04)",
                    color: active ? "#9FD68C" : "#8B87A0",
                  }}
                >
                  <Icon size={15} /> {label}
                </button>
              );
            })}
          </div>
          {!item.posture && (
            <p className="mt-2 text-xs" style={{ color: "#736E88" }}>
              Guessed from the wording — tap to set it yourself.
            </p>
          )}
        </div>

        {/* Repeats */}
        <div className="mt-7">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider" style={{ color: "#736E88" }}>
            <Repeat size={12} /> Repeats
          </p>
          {!item.recurrenceDays ? (
            <button
              onClick={() => patch({ recurrenceDays: 28 })}
              className="rounded-full px-4 py-2.5 text-sm font-medium"
              style={{ background: "rgba(255,255,255,0.04)", color: "#8FC6FF" }}
            >
              + Make this a repeating task
            </button>
          ) : (
            <div className="rounded-2xl p-3.5" style={{ background: "rgba(255,255,255,0.04)" }}>
              <div className="flex items-center justify-between">
                <span className="text-sm" style={{ color: "#DAD7E5" }}>
                  Every
                </span>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => patch({ recurrenceDays: Math.max(7, item.recurrenceDays - 7) })}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold"
                    style={{ background: "rgba(255,255,255,0.08)", color: "#EDEBFB" }}
                  >
                    –
                  </button>
                  <span className="w-16 text-center text-sm font-semibold" style={{ color: "#8FC6FF" }}>
                    {Math.round(item.recurrenceDays / 7)} week{Math.round(item.recurrenceDays / 7) === 1 ? "" : "s"}
                  </span>
                  <button
                    onClick={() => patch({ recurrenceDays: item.recurrenceDays + 7 })}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold"
                    style={{ background: "rgba(255,255,255,0.08)", color: "#EDEBFB" }}
                  >
                    +
                  </button>
                </div>
              </div>
              <p className="mt-2 text-xs" style={{ color: "#736E88" }}>
                {item.lastCompletedAt
                  ? `Last done ${relativeDays(item.lastCompletedAt, Date.now())} ago.`
                  : "Not done yet."}{" "}
                Counts from whenever you actually tick it off — not a fixed date.
              </p>
              <button
                onClick={() => patch({ recurrenceDays: null })}
                className="mt-3 text-xs font-medium"
                style={{ color: "#8B87A0" }}
              >
                Stop repeating
              </button>
            </div>
          )}
        </div>

        {/* Thinking / rabbit hole */}
        <div className="mt-7">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider" style={{ color: "#736E88" }}>
            <Sparkles size={12} /> Thinking it through
          </p>
          <div className="space-y-2">
            {item.thoughts.map((th, idx) => (
              <div key={idx} className="flex items-start gap-2">
                <div className="mt-1 flex flex-col items-center">
                  <div className="h-1.5 w-1.5 rounded-full" style={{ background: cfg.color }} />
                  {idx < item.thoughts.length - 1 && <div className="my-0.5 h-4 w-px" style={{ background: "rgba(255,255,255,0.12)" }} />}
                </div>
                <p className="flex-1 pb-1 text-[14.5px] leading-relaxed" style={{ color: "#C7C3D6" }}>
                  {th}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <input
              value={newThought}
              onChange={(e) => setNewThought(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newThought.trim()) {
                  patch({ thoughts: [...item.thoughts, newThought.trim()] });
                  setNewThought("");
                }
              }}
              placeholder="Follow this thought…"
              className="flex-1 rounded-full px-4 py-2.5 text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.04)", color: "#EDEBFB" }}
            />
            <button
              onClick={() => {
                if (!newThought.trim()) return;
                patch({ thoughts: [...item.thoughts, newThought.trim()] });
                setNewThought("");
              }}
              className="rounded-full p-2.5 active:scale-90 transition-transform"
              style={{ background: "rgba(255,255,255,0.06)" }}
            >
              <ChevronDown size={16} color="#EDEBFB" />
            </button>
          </div>
        </div>

        {/* Subtasks */}
        <div className="mt-7">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "#736E88" }}>
            Subtasks
          </p>
          <div className="space-y-1.5">
            {item.subtasks.map((s) => (
              <button
                key={s.id}
                onClick={() =>
                  patch({
                    subtasks: item.subtasks.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x)),
                  })
                }
                className="flex w-full items-center gap-2.5 rounded-xl px-1 py-1.5 text-left active:bg-white/5"
              >
                {s.done ? <CheckCircle2 size={18} color={cfg.color} /> : <Circle size={18} color="#736E88" />}
                <span
                  className="text-[14.5px]"
                  style={{ color: s.done ? "#736E88" : "#DAD7E5", textDecoration: s.done ? "line-through" : "none" }}
                >
                  {s.text}
                </span>
              </button>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={newSubtask}
              onChange={(e) => setNewSubtask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newSubtask.trim()) {
                  patch({ subtasks: [...item.subtasks, { id: uid(), text: newSubtask.trim(), done: false }] });
                  setNewSubtask("");
                }
              }}
              placeholder="Add a subtask…"
              className="flex-1 rounded-full px-4 py-2.5 text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.04)", color: "#EDEBFB" }}
            />
          </div>
        </div>

        {/* Related */}
        <div className="mt-7">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider" style={{ color: "#736E88" }}>
            <Link2 size={12} /> Related thoughts
          </p>
          <div className="flex flex-wrap gap-2">
            {item.relatedItemIds.map((rid) => {
              const rel = allItems.find((i) => i.id === rid);
              if (!rel) return null;
              return (
                <button
                  key={rid}
                  onClick={() => onOpenRelated(rid)}
                  className="rounded-full px-3 py-1.5 text-xs font-medium"
                  style={{ background: "rgba(255,255,255,0.06)", color: "#C7C3D6" }}
                >
                  {rel.title}
                </button>
              );
            })}
            <button
              onClick={() => setRelPicker((v) => !v)}
              className="rounded-full px-3 py-1.5 text-xs font-medium"
              style={{ background: "rgba(255,255,255,0.03)", color: "#736E88", border: "1px dashed rgba(255,255,255,0.15)" }}
            >
              + link
            </button>
          </div>
          {relPicker && (
            <div className="mt-2 rounded-2xl p-2" style={{ background: "rgba(255,255,255,0.04)" }}>
              <input
                value={relQuery}
                onChange={(e) => setRelQuery(e.target.value)}
                placeholder="Search thoughts…"
                className="w-full rounded-full px-3 py-2 text-sm outline-none mb-1"
                style={{ background: "rgba(255,255,255,0.06)", color: "#EDEBFB" }}
              />
              <div className="max-h-40 overflow-y-auto">
                {relatedOptions.slice(0, 8).map((r) => (
                  <button
                    key={r.id}
                    onClick={() => {
                      patch({ relatedItemIds: [...item.relatedItemIds, r.id] });
                      setRelPicker(false);
                      setRelQuery("");
                    }}
                    className="block w-full truncate rounded-lg px-2 py-2 text-left text-sm active:bg-white/5"
                    style={{ color: "#C7C3D6" }}
                  >
                    {r.title}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 flex gap-2 p-4" style={{ background: "linear-gradient(0deg,#14121F 60%,transparent)" }}>
        <button
          onClick={() => onComplete(item.id)}
          className="flex flex-1 items-center justify-center gap-2 rounded-full py-3.5 text-sm font-semibold active:scale-95 transition-transform"
          style={{ background: cfg.color, color: "#14121F" }}
        >
          <Check size={17} strokeWidth={2.5} /> {item.recurrenceDays ? "Done for now" : "Mark done"}
        </button>
        <button
          onClick={() => onSnooze(item.id, 1)}
          className="flex items-center justify-center gap-2 rounded-full px-5 py-3.5 text-sm font-medium active:scale-95 transition-transform"
          style={{ background: "rgba(255,255,255,0.06)", color: "#C7C3D6" }}
        >
          <Clock size={16} /> Not now
        </button>
      </div>

      {showImage && imageUrl && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/90 p-4" style={{ zIndex: 90 }} onClick={() => setShowImage(false)}>
          <img src={imageUrl} alt="source" className="max-h-full max-w-full rounded-2xl" />
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Capture sheet                                                          */
/* ---------------------------------------------------------------------- */

function CaptureSheet({ onClose, onAdd, onPhoto, toast }) {
  const [mode, setMode] = useState("menu");
  const [text, setText] = useState("");
  const camInput = useRef(null);
  const libInput = useRef(null);

  return (
    <div className="fixed inset-0 flex items-end justify-center" style={{ background: "rgba(10,9,15,0.6)", zIndex: 60 }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-t-[28px] p-6 pb-8"
        style={{ background: "#1C1A29", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div className="mx-auto mb-5 h-1 w-10 rounded-full" style={{ background: "rgba(255,255,255,0.15)" }} />

        {mode === "menu" && (
          <>
            <p className="mb-5 text-center text-sm" style={{ color: "#8B87A0" }}>
              Capture first. Organise later.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {[
                { key: "text", icon: PenLine, label: "Type or dictate" },
                { key: "camera", icon: Camera, label: "Photograph a note" },
                { key: "library", icon: ImagePlus, label: "Choose a photo" },
                { key: "voice", icon: Mic, label: "Voice note" },
              ].map(({ key, icon: Icon, label }) => (
                <button
                  key={key}
                  onClick={() => {
                    if (key === "text") setMode("text");
                    else if (key === "camera") camInput.current?.click();
                    else if (key === "library") libInput.current?.click();
                    else toast("Voice capture coming soon 🎙️");
                  }}
                  className="flex flex-col items-center gap-2.5 rounded-2xl py-6 active:scale-95 transition-transform"
                  style={{ background: "rgba(255,255,255,0.04)" }}
                >
                  <Icon size={22} color="#EDEBFB" />
                  <span className="text-xs font-medium" style={{ color: "#C7C3D6" }}>
                    {label}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {mode === "text" && (
          <>
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type or dictate anything — one thought, or a whole splurge"
              rows={3}
              className="w-full resize-none rounded-2xl p-4 text-[15px] leading-relaxed outline-none"
              style={{ background: "rgba(255,255,255,0.05)", color: "#EDEBFB" }}
            />
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => setMode("menu")}
                className="rounded-full px-5 py-3 text-sm font-medium"
                style={{ background: "rgba(255,255,255,0.06)", color: "#C7C3D6" }}
              >
                Back
              </button>
              <button
                onClick={() => {
                  if (!text.trim()) return;
                  onAdd(text.trim());
                  setText("");
                }}
                className="flex-1 rounded-full py-3 text-sm active:scale-95 transition-transform"
                style={{ fontFamily: "'Fredoka',sans-serif", fontWeight: 700, background: "#F5A153", color: "#14121F" }}
              >
                Add
              </button>
            </div>
          </>
        )}

        <input
          ref={camInput}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPhoto(f);
            e.target.value = "";
          }}
        />
        <input
          ref={libInput}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPhoto(f);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Extraction confirm                                                     */
/* ---------------------------------------------------------------------- */

// Shown while the brain dump is being categorised: thoughts pour into a
// hopper at the top, get shaken through the machine, and drop down one tube
// per category. Pure CSS so it costs nothing while the request is in flight.
function SortingMachine() {
  // Tubes are drawn as real SVG paths from the hopper spout out to each
  // category, with dots travelling along them via animateMotion — so the
  // dots genuinely follow the pipes rather than approximating the route.
  const W = 260;
  const SPOUT_X = W / 2;
  const cols = TYPE_ORDER.map((t, i) => ({
    type: t,
    color: TYPE_CONFIG[t].color,
    x: (W / (TYPE_ORDER.length + 1)) * (i + 1),
  }));
  const tube = (x) => `M ${SPOUT_X},4 C ${SPOUT_X},34 ${x},30 ${x},72`;

  return (
    <div className="w-full" style={{ maxWidth: W }}>
      <style>{`
        @keyframes bsFeed {
          0%   { transform: translateY(-30px) scale(0.8); opacity: 0; }
          25%  { opacity: 1; }
          75%  { opacity: 1; }
          100% { transform: translateY(24px) scale(0.5); opacity: 0; }
        }
        .bs-feed { animation: bsFeed 1.8s ease-in infinite; }
      `}</style>

      {/* dots pouring into the middle of the hopper */}
      <div className="relative mx-auto" style={{ height: 34, width: 40 }}>
        {TYPE_ORDER.map((t, i) => (
          <span
            key={t}
            className="bs-feed absolute rounded-full"
            style={{
              left: 14 + (i % 3) * 6,
              width: 8,
              height: 8,
              background: TYPE_CONFIG[t].color,
              animationDelay: `${i * 0.4}s`,
            }}
          />
        ))}
      </div>

      {/* hopper */}
      <div
        className="mx-auto"
        style={{
          width: 120,
          height: 30,
          background: "linear-gradient(180deg,rgba(245,161,83,0.3),rgba(245,161,83,0.12))",
          clipPath: "polygon(0% 0%, 100% 0%, 62% 100%, 38% 100%)",
          border: "1px solid rgba(255,255,255,0.07)",
        }}
      />

      {/* machine body */}
      <div
        className="mx-auto flex items-center justify-center rounded-xl"
        style={{
          width: 150,
          height: 26,
          background: "linear-gradient(180deg,#2A2739,#211F2E)",
          border: "1px solid rgba(255,255,255,0.09)",
        }}
      >
        <div className="flex gap-1.5">
          {TYPE_ORDER.map((t, i) => (
            <span
              key={t}
              className="block h-1.5 w-1.5 rounded-full"
              style={{ background: TYPE_CONFIG[t].color, opacity: 0.5, animation: `bsPop 1.4s ease-in-out ${i * 0.18}s infinite` }}
            />
          ))}
        </div>
      </div>

      {/* tubes fanning out to each category */}
      <svg viewBox={`0 0 ${W} 78`} width="100%" style={{ display: "block", marginTop: -2 }}>
        {cols.map((c) => (
          <path key={`t${c.type}`} d={tube(c.x)} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="5" strokeLinecap="round" />
        ))}
        {cols.map((c) => (
          <path key={`i${c.type}`} d={tube(c.x)} fill="none" stroke={c.color} strokeWidth="1" strokeOpacity="0.25" />
        ))}
        {cols.map((c, i) => (
          <circle key={`d${c.type}`} r="4" fill={c.color}>
            <animateMotion dur="1.7s" repeatCount="indefinite" begin={`${i * 0.35}s`} path={tube(c.x)} />
          </circle>
        ))}
        {cols.map((c, i) => (
          <circle key={`d2${c.type}`} r="3" fill={c.color} opacity="0.6">
            <animateMotion dur="1.7s" repeatCount="indefinite" begin={`${i * 0.35 + 0.85}s`} path={tube(c.x)} />
          </circle>
        ))}
      </svg>

      {/* collection trays */}
      <div className="flex justify-between" style={{ width: W, marginTop: -6 }}>
        {cols.map((c) => (
          <div key={c.type} className="flex flex-col items-center" style={{ width: W / (TYPE_ORDER.length + 1) }}>
            <div
              className="flex h-7 w-7 items-center justify-center rounded-lg"
              style={{ background: TYPE_CONFIG[c.type].soft, border: `1px solid ${c.color}44` }}
            >
              <TypeIcon type={c.type} size={13} />
            </div>
            <span className="mt-1 text-[9px] font-medium" style={{ color: "#736E88" }}>
              {TYPE_CONFIG[c.type].label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExtractionConfirm({ status, previewUrl, extracted, setExtracted, onClose, onConfirm, onAddAsOne, sourceText, origin = "photo", errorDetail = null, offline = false }) {
  const selectedCount = extracted.filter((e) => e.selected).length;
  const [pickerFor, setPickerFor] = useState(null);
  const pickerTarget = extracted.find((e) => e.tempId === pickerFor);

  return (
    <div className="fixed inset-0 flex items-end justify-center" style={{ background: "rgba(10,9,15,0.7)", zIndex: 110 }}>
      <div className="w-full max-w-md rounded-t-[28px] p-6 max-h-[85vh] flex flex-col" style={{ background: "#1C1A29" }}>
        <div className="mx-auto mb-4 h-1 w-10 rounded-full" style={{ background: "rgba(255,255,255,0.15)" }} />

        {status === "loading" && (
          <div className="flex flex-col items-center py-8">
            {previewUrl && <img src={previewUrl} className="mb-4 h-20 w-20 rounded-2xl object-cover opacity-50" alt="" />}
            <SortingMachine />
            <p className="mt-4 text-sm" style={{ color: "#B3AFC4" }}>
              {origin === "text" ? "Sorting your brain…" : "Reading your notes…"}
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="flex flex-col items-center py-14 text-center">
            <p className="mb-4 text-sm" style={{ color: "#B3AFC4" }}>
              {origin === "text" ? "Couldn't split that automatically." : "Couldn't quite read that one. You can still add it as a single item."}
            </p>
            <button onClick={onClose} className="rounded-full px-6 py-3 text-sm font-medium" style={{ background: "rgba(255,255,255,0.08)", color: "#EDEBFB" }}>
              Close
            </button>
          </div>
        )}

        {status === "done" && (
          <>
            {errorDetail ? (
              <div className="mb-3 rounded-2xl p-3" style={{ background: offline ? "rgba(143,198,255,0.1)" : "rgba(255,59,48,0.12)", border: `1px solid ${offline ? "rgba(143,198,255,0.28)" : "rgba(255,59,48,0.3)"}` }}>
                <p className="mb-1.5 text-xs font-semibold" style={{ color: offline ? "#8FC6FF" : "#FF6B60" }}>
                  {offline ? "Sorted offline — split on punctuation, so check the types. Details:" : "Automatic sorting failed — full error:"}
                </p>
                <div
                  className="overflow-y-auto rounded-lg p-2"
                  style={{ maxHeight: 120, background: "rgba(0,0,0,0.25)" }}
                >
                  <p
                    className="text-[10px] leading-relaxed"
                    style={{ color: "#DAD7E5", fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text" }}
                  >
                    {errorDetail}
                  </p>
                </div>
                <p className="mt-1.5 text-[10px]" style={{ color: "#8B87A0" }}>
                  {offline ? "Edit anything below before adding." : "Your text is kept below as one item so nothing is lost."}
                </p>
              </div>
            ) : (
              <>
                <p className="mb-1 text-center text-[15px] font-semibold text-white" style={{ fontFamily: "'Fredoka',sans-serif" }}>
                  {origin === "text" && sourceText
                    ? `This looks like ${extracted.length} different things`
                    : `I found ${extracted.length} thing${extracted.length === 1 ? "" : "s"}`}
                </p>
                {origin === "text" && sourceText ? (
                  <p className="mb-3 text-center text-xs" style={{ color: "#8B87A0" }}>
                    Want me to split it up?
                  </p>
                ) : (
                  <div className="mb-3" />
                )}
              </>
            )}
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {extracted.map((ex) => (
                <div key={ex.tempId} className="flex items-start gap-2.5 rounded-2xl p-3" style={{ background: "rgba(255,255,255,0.04)" }}>
                  <button
                    onClick={() =>
                      setExtracted((arr) => arr.map((x) => (x.tempId === ex.tempId ? { ...x, selected: !x.selected } : x)))
                    }
                    className="mt-0.5 shrink-0"
                  >
                    {ex.selected ? <CheckCircle2 size={19} color={TYPE_CONFIG[ex.type].color} /> : <Circle size={19} color="#736E88" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <input
                      value={ex.title}
                      onChange={(e) =>
                        setExtracted((arr) => arr.map((x) => (x.tempId === ex.tempId ? { ...x, title: e.target.value } : x)))
                      }
                      className="w-full bg-transparent text-sm font-medium outline-none"
                      style={{ color: "#EDEBFB" }}
                    />
                    {ex.notes ? (
                      <p className="mt-0.5 truncate text-xs" style={{ color: "#736E88" }}>
                        {ex.notes}
                      </p>
                    ) : null}
                  </div>
                  <button
                    onClick={() => setPickerFor(pickerFor === ex.tempId ? null : ex.tempId)}
                    className="shrink-0 rounded-full p-1.5"
                    style={{ background: TYPE_CONFIG[ex.type].soft }}
                    title="Change type"
                  >
                    <TypeIcon type={ex.type} size={13} />
                  </button>
                  <button
                    onClick={() => setExtracted((arr) => arr.filter((x) => x.tempId !== ex.tempId))}
                    className="shrink-0 p-1.5"
                  >
                    <X size={15} color="#736E88" />
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              <button
                onClick={sourceText && onAddAsOne ? () => onAddAsOne(sourceText) : onClose}
                className="rounded-full px-4 py-3.5 text-sm font-medium"
                style={{ background: "rgba(255,255,255,0.06)", color: "#C7C3D6" }}
              >
                {sourceText && onAddAsOne ? "No, add as one" : "Cancel"}
              </button>
              <button
                onClick={onConfirm}
                disabled={selectedCount === 0}
                className="flex-1 rounded-full py-3.5 text-sm font-semibold disabled:opacity-40 active:scale-95 transition-transform"
                style={{ background: "#F5A153", color: "#14121F" }}
              >
                Split into {selectedCount}
              </button>
            </div>
          </>
        )}
      </div>

      {pickerTarget && (
        <TypePicker
          currentType={pickerTarget.type}
          onPick={(t) =>
            setExtracted((arr) => arr.map((x) => (x.tempId === pickerTarget.tempId ? { ...x, type: t } : x)))
          }
          onClose={() => setPickerFor(null)}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Search overlay                                                         */
/* ---------------------------------------------------------------------- */

function ListsPage({ items, now, onOpen, onComplete, onSnooze, onShortlist, onUnshortlist, onWake, onReorder, expanded, setExpanded }) {
  // Drag-to-reorder. Rows are a fixed height, so the target slot is just the
  // drag distance divided by row height — no measuring or collision needed.
  const ROW_H = 50;
  const [drag, setDrag] = useState(null); // { type, id, from, dy }
  const dragRef = useRef(null);

  const startDrag = (e, type, id, from, groupItems) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    dragRef.current = { type, id, from, startY, ids: groupItems.map((i) => i.id) };
    setDrag({ type, id, from, dy: 0 });
    // Kill text selection for the duration of the drag — without this a slow
    // press on the handle selects the row's text instead of picking it up.
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    if (e.currentTarget.setPointerCapture) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch (err) {
        /* not fatal */
      }
    }

    const move = (ev) => {
      const g = dragRef.current;
      if (!g) return;
      setDrag({ type: g.type, id: g.id, from: g.from, dy: ev.clientY - g.startY });
    };
    const end = () => {
      const g = dragRef.current;
      if (g) {
        setDrag((d) => {
          if (d) {
            const shift = Math.round(d.dy / ROW_H);
            const to = Math.max(0, Math.min(g.ids.length - 1, g.from + shift));
            if (to !== g.from) {
              const ids = g.ids.slice();
              ids.splice(to, 0, ids.splice(g.from, 1)[0]);
              onReorder(g.type, ids);
            }
          }
          return null;
        });
      }
      dragRef.current = null;
      document.body.style.userSelect = prevSelect;
      document.body.style.webkitUserSelect = prevSelect;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  // How far a given row should slide to make room for the dragged one.
  const rowOffset = (type, index) => {
    if (!drag || drag.type !== type) return 0;
    const shift = Math.round(drag.dy / ROW_H);
    const to = drag.from + shift;
    if (index === drag.from) return drag.dy;
    if (drag.from < to && index > drag.from && index <= to) return -ROW_H;
    if (drag.from > to && index < drag.from && index >= to) return ROW_H;
    return 0;
  };

  const isSnoozed = (i) => i.snoozedUntil && i.snoozedUntil > now;
  const byRecency = (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);

  // Once a group has been hand-sorted, that order wins; until then fall back
  // to prioritised-first, then most recently touched.
  const groups = TYPE_ORDER.map((t) => {
    const all = items.filter((i) => i.type === t);
    const active = all.filter((i) => !isSnoozed(i));
    const hasManual = active.some((i) => typeof i.sortIndex === "number");
    return {
      type: t,
      items: active
        .slice()
        .sort((a, b) =>
          hasManual
            ? (a.sortIndex ?? 9999) - (b.sortIndex ?? 9999)
            : (b.shortlisted ? 1 : 0) - (a.shortlisted ? 1 : 0) || byRecency(a, b)
        ),
      snoozed: all
        .filter(isSnoozed)
        .slice()
        .sort((a, b) => a.snoozedUntil - b.snoozedUntil),
    };
  }).filter((g) => g.items.length + g.snoozed.length > 0);

  if (groups.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <p className="mb-2 text-lg text-white" style={{ fontFamily: "Fraunces, serif" }}>
          Nothing here.
        </p>
        <p className="text-sm" style={{ color: "#8B87A0" }}>
          Which is either extremely productive or mildly suspicious.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 pb-32">
      {groups.map((g) => {
        const cfg = TYPE_CONFIG[g.type];
        const isOpen = expanded[g.type] !== false; // default open
        return (
          <div
            key={g.type}
            className="rounded-2xl"
            style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${cfg.color}22` }}
          >
            <button
              onClick={() => setExpanded((prev) => ({ ...prev, [g.type]: !isOpen }))}
              className="flex w-full items-center justify-between rounded-2xl px-3 py-2.5"
              style={{ background: cfg.soft }}
            >
              <span className="flex items-center gap-2">
                <span
                  className="flex h-7 w-7 items-center justify-center rounded-xl"
                  style={{ background: cfg.color, boxShadow: "0 2px 0 rgba(0,0,0,0.3)" }}
                >
                  <TypeIcon type={g.type} size={14} color="#14121F" />
                </span>
                <span
                  className="text-[15px]"
                  style={{ fontFamily: "'Fredoka',sans-serif", fontWeight: 700, color: "#EDEBFB" }}
                >
                  {cfg.label}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="flex items-center gap-1.5">
                  <span
                    className="rounded-full px-2 py-0.5 text-[11px] font-bold"
                    style={{ background: cfg.color, color: "#14121F" }}
                  >
                    {g.items.length}
                  </span>
                  {g.snoozed.length > 0 && (
                    <span className="flex items-center gap-0.5 text-[10px]" style={{ color: "#5C5870" }}>
                      <Clock size={9} />
                      {g.snoozed.length}
                    </span>
                  )}
                </span>
                <ChevronDown
                  size={15}
                  color="#736E88"
                  style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}
                />
              </span>
            </button>
            {isOpen && (
              <div className="space-y-1 px-2 pb-2">
                {g.items.map((it, idx) => {
                  const dragging = drag && drag.id === it.id;
                  return (
                  <div
                    key={it.id}
                    className="flex items-center gap-1 rounded-xl px-1 py-2"
                    style={{
                      userSelect: dragging ? "none" : undefined,
                      WebkitUserSelect: dragging ? "none" : undefined,
                      background: dragging ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.035)",
                      height: 46,
                      transform: `translateY(${rowOffset(g.type, idx)}px)`,
                      transition: dragging ? "none" : "transform 0.18s ease",
                      zIndex: dragging ? 30 : 1,
                      position: "relative",
                      boxShadow: dragging ? "0 8px 20px rgba(0,0,0,0.45)" : "none",
                    }}
                  >
                    <span
                      onPointerDown={(e) => startDrag(e, g.type, it.id, idx, g.items)}
                      className="flex shrink-0 cursor-grab items-center justify-center"
                      style={{
                        touchAction: "none",
                        userSelect: "none",
                        WebkitUserSelect: "none",
                        WebkitTouchCallout: "none",
                        width: 30,
                        height: 40,
                      }}
                      title="Drag to reorder"
                    >
                      <GripVertical size={17} color={dragging ? "#EDEBFB" : "#5A5570"} />
                    </span>
                    <button onClick={() => onOpen(it.id)} className="min-w-0 flex-1 text-left">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13.5px]" style={{ color: "#EDEBFB" }}>
                          {it.title}
                        </span>
                        {areaOf(it) && <span className="shrink-0 text-[10px]">{AREA_CONFIG[areaOf(it)].emoji}</span>}
                        {it.recurrenceDays && <Repeat size={10} color="#8FC6FF" className="shrink-0" />}
                        {it.sourceImageId && <ImageIcon size={10} color="#7B7690" className="shrink-0" />}
                      </span>
                      {it.subtasks.length > 0 && (
                        <span className="mt-0.5 block text-[10.5px]" style={{ color: "#736E88" }}>
                          {it.subtasks.filter((s) => s.done).length}/{it.subtasks.length} done
                        </span>
                      )}
                    </button>
                    <ItemActions
                      item={it}
                      onComplete={onComplete}
                      onShortlist={onShortlist}
                      onUnshortlist={onUnshortlist}
                      onSnooze={onSnooze}
                      compact
                    />
                  </div>
                  );
                })}

                {g.snoozed.length > 0 && (
                  <div className="pt-1">
                    {g.items.length > 0 && (
                      <p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider" style={{ color: "#4A4658" }}>
                        Snoozed
                      </p>
                    )}
                    {g.snoozed.map((it) => (
                      <div
                        key={it.id}
                        className="mb-1 flex items-center gap-2 rounded-xl px-2 py-2"
                        style={{ background: "rgba(255,255,255,0.02)" }}
                      >
                        <button onClick={() => onOpen(it.id)} className="min-w-0 flex-1 text-left">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[13px]" style={{ color: "#6B6780" }}>
                              {it.title}
                            </span>
                            {it.recurrenceDays && <Repeat size={10} color="#4E5C6B" className="shrink-0" />}
                          </span>
                          <span className="mt-0.5 block text-[10.5px]" style={{ color: "#4A4658" }}>
                            {snoozeLabel(it.snoozedUntil, now)}
                          </span>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onWake(it.id);
                          }}
                          className="shrink-0 rounded-full p-2 active:scale-90 transition-transform"
                          style={{ background: "rgba(255,255,255,0.05)" }}
                          title="Bring back now"
                        >
                          <RotateCcw size={14} color="#8B87A0" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SearchOverlay({ items, onClose, onOpen }) {
  const [q, setQ] = useState("");
  const results = useMemo(() => {
    if (!q.trim()) return [];
    const lc = q.toLowerCase();
    return items.filter(
      (i) =>
        i.title.toLowerCase().includes(lc) ||
        i.notes.toLowerCase().includes(lc) ||
        i.thoughts.some((t) => t.toLowerCase().includes(lc)) ||
        i.subtasks.some((s) => s.text.toLowerCase().includes(lc))
    );
  }, [q, items]);

  return (
    <div className="fixed inset-0 flex flex-col" style={{ background: "#14121F", zIndex: 75 }}>
      <div className="flex items-center gap-2 px-4 pb-4" style={{ paddingTop: `calc(env(safe-area-inset-top, 0px) + ${TOP_INSET}px)` }}>
        <Search size={18} color="#736E88" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search everything…"
          className="flex-1 bg-transparent text-[15px] outline-none"
          style={{ color: "#EDEBFB" }}
        />
        <button onClick={onClose}>
          <X size={20} color="#8B87A0" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-8">
        {results.map((r) => (
          <button
            key={r.id}
            onClick={() => onOpen(r.id)}
            className="mb-2 flex w-full items-start gap-3 rounded-2xl p-3.5 text-left active:bg-white/5"
            style={{ background: "rgba(255,255,255,0.03)" }}
          >
            <TypeIcon type={r.type} size={16} style={{ marginTop: 2 }} />
            <div className="min-w-0">
              <p
                className="truncate text-sm font-medium"
                style={{ color: r.status === "done" ? "#736E88" : "#EDEBFB", textDecoration: r.status === "done" ? "line-through" : "none" }}
              >
                {r.title}
              </p>
              {r.notes && (
                <p className="truncate text-xs mt-0.5" style={{ color: "#736E88" }}>
                  {r.notes}
                </p>
              )}
            </div>
          </button>
        ))}
        {q.trim() && results.length === 0 && (
          <p className="mt-10 text-center text-sm" style={{ color: "#736E88" }}>
            Nothing matching that yet.
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Main App                                                                */
/* ---------------------------------------------------------------------- */

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [onboarded, setOnboarded] = useState(false);
  const [items, setItems] = useState([]);
  const [mode, setMode] = useState("all"); // all | five | sit | move | today
  const [areaFilter, setAreaFilter] = useState(null); // null | house | family | work | me
  const [areaPickerOpen, setAreaPickerOpen] = useState(false);
  const [page, setPage] = useState(0); // 0 = cards, 1 = lists
  const [listExpanded, setListExpanded] = useState({});
  const [seed, setSeed] = useState(() => Date.now() % 1000000);
  const [detailId, setDetailId] = useState(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [extraction, setExtraction] = useState(null); // {status, previewUrl, list, imageId}
  const [toastText, setToastText] = useState("");
  const [imageCache, setImageCache] = useState({});
  const [dueBanner, setDueBanner] = useState(null); // [{ id, title, type }]
  const [dueOpen, setDueOpen] = useState(false);
  const [dataMenuOpen, setDataMenuOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState(null); // { title, body, confirmLabel, danger, onConfirm }
  const feedRef = useRef(null);
  const pagerRef = useRef(null);
  const now = Date.now();

  // Since this runs in a browser tab rather than an installed app, there's no
  // reliable way to fire a notification while it's closed — so instead, once
  // per app open, surface anything that's currently due (including repeating
  // tasks) as a gentle in-app nudge.
  useEffect(() => {
    if (!loaded) return;
    const nowAtLoad = Date.now();
    const due = items.filter((i) => i.status === "active" && i.snoozedUntil && i.snoozedUntil <= nowAtLoad);
    if (due.length > 0) setDueBanner(due.map((i) => ({ id: i.id, title: i.title, type: i.type })));
  }, [loaded]); // eslint-disable-line

  // Keep the page indicator in sync with horizontal swipes between the
  // cards and lists pages.
  useEffect(() => {
    const el = pagerRef.current;
    if (!el) return;
    let raf = null;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const w = el.clientWidth || 1;
        setPage(Math.round(el.scrollLeft / w));
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [onboarded]);

  const goToPage = useCallback((idx) => {
    const el = pagerRef.current;
    if (!el) return;
    el.scrollTo({ left: idx * el.clientWidth, behavior: "smooth" });
    setPage(idx);
  }, []);

  // load
  useEffect(() => {
    (async () => {
      const ob = await storeGet("app:onboarded");
      const raw = await storeGet("app:items");
      if (raw) {
        try {
          // Migrate items saved under older category sets: Sidequest,
          // Idea, Research and Remember have all been absorbed into Note.
          const parsed = JSON.parse(raw).map((i) => ({
            ...i,
            type: ["sidequest", "idea", "research", "remember"].includes(i.type) ? "note" : i.type,
          }));
          setItems(parsed);
        } catch {
          setItems(seedItems());
        }
        setOnboarded(ob === "true");
      } else {
        // Fresh start: load the sample set (covering every category, plus a
        // repeating item and a prioritised one) and go straight to the feed,
        // so there's always something to look at without setting it up first.
        // Tap the build stamp in the header to wipe it and run onboarding.
        setItems(seedItems());
        setOnboarded(true);
        storeSet("app:onboarded", "true");
      }
      setLoaded(true);
    })();
  }, []);

  // persist
  useEffect(() => {
    if (!loaded) return;
    storeSet("app:items", JSON.stringify(items));
  }, [items, loaded]);

  const showToast = useCallback((t) => {
    setToastText(t);
    setTimeout(() => setToastText(""), Math.min(1800 + t.length * 40, 6000));
  }, []);

  const pool = useMemo(() => rankPool(items, mode, now, seed, areaFilter), [items, mode, seed, areaFilter]); // eslint-disable-line

  // Buy items render as one shared shopping-list card (up to 5 per card)
  // rather than one card each — keeps the feed from being dominated by a
  // long errand list, and reads more like an actual scrap of paper.
  const cardFeed = useMemo(() => {
    const chunks = [];
    const buyItems = pool.filter((i) => i.type === "buy");
    for (let i = 0; i < buyItems.length; i += 5) chunks.push(buyItems.slice(i, i + 5));
    const seenBuy = new Set();
    const out = [];
    let chunkIdx = 0;
    for (const item of pool) {
      if (item.type === "buy") {
        if (seenBuy.has(item.id)) continue;
        const chunk = chunks[chunkIdx++];
        chunk.forEach((c) => seenBuy.add(c.id));
        out.push({ kind: "shopping", key: `shop-${chunk.map((c) => c.id).join("-")}`, items: chunk });
      } else {
        out.push({ kind: "item", key: item.id, item });
      }
    }
    return out;
  }, [pool]);

  // Lists page shows the same filtered set as the cards page, but grouped by
  // category rather than shuffled — and unlike cards, it keeps snoozed items
  // visible (greyed, at the bottom of their group) so nothing feels lost.
  const listItems = useMemo(() => {
    let arr = items.filter((i) => i.status === "active");
    if (mode === "five") arr = arr.filter((i) => i.estimatedMinutes && i.estimatedMinutes <= 5);
    if (areaFilter) arr = arr.filter((i) => areaOf(i) === areaFilter);
    if (mode === "sit") arr = arr.filter((i) => postureOf(i) === "sit");
    if (mode === "move") arr = arr.filter((i) => postureOf(i) === "move");
    if (mode === "today") arr = arr.filter((i) => i.shortlisted);
    return arr;
  }, [items, mode, areaFilter]); // eslint-disable-line

  const updateItem = useCallback((id, fields) => {
    setItems((arr) => arr.map((i) => (i.id === id ? { ...i, ...fields, updatedAt: Date.now() } : i)));
  }, []);

  const completeItem = useCallback(
    (id) => {
      let toastMsg = "Done ✓";
      setItems((arr) =>
        arr.map((i) => {
          if (i.id !== id) return i;
          const now2 = Date.now();
          if (i.recurrenceDays) {
            const weeks = Math.round(i.recurrenceDays / 7);
            toastMsg = `See you in ~${weeks} week${weeks === 1 ? "" : "s"} ✓`;
            return {
              ...i,
              completedAt: now2,
              lastCompletedAt: now2,
              snoozedUntil: now2 + i.recurrenceDays * DAY,
              subtasks: i.subtasks.map((s) => ({ ...s, done: false })),
              updatedAt: now2,
            };
          }
          return { ...i, status: "done", completedAt: now2, updatedAt: now2 };
        })
      );
      showToast(toastMsg);
    },
    [showToast]
  );

  const snoozeItem = useCallback(
    (id, days) => {
      updateItem(id, { snoozedUntil: Date.now() + days * DAY });
      showToast("Tucked away for later");
    },
    [updateItem, showToast]
  );

  const shortlistItem = useCallback(
    (id) => {
      updateItem(id, { shortlisted: true, shortlistedAt: Date.now() });
      showToast("Shortlisted for today ⭐");
    },
    [updateItem, showToast]
  );

  const unshortlistItem = useCallback(
    (id) => {
      updateItem(id, { shortlisted: false, shortlistedAt: null });
      showToast("Removed from today");
    },
    [updateItem, showToast]
  );

  // Writes an explicit position onto every item in the group, so the
  // hand-sorted order survives reloads and future additions.
  const reorderItems = useCallback((type, orderedIds) => {
    setItems((arr) =>
      arr.map((i) => {
        const pos = orderedIds.indexOf(i.id);
        return pos === -1 ? i : { ...i, sortIndex: pos };
      })
    );
  }, []);

  const wakeItem = useCallback(
    (id) => {
      updateItem(id, { snoozedUntil: null });
      showToast("Back in the feed");
    },
    [updateItem, showToast]
  );

  // Export: every item plus every stored photo, as one JSON file the person
  // can keep somewhere safe and reload from later — the only real recovery
  // path since everything else lives solely in this device's storage.
  const exportBackup = useCallback(async () => {
    try {
      const imageKeys = await storeListKeys("img:");
      const images = {};
      for (const key of imageKeys) {
        const raw = await storeGet(key);
        if (raw) images[key] = raw;
      }
      const backup = {
        app: "brainsorter",
        version: 1,
        exportedAt: new Date().toISOString(),
        items,
        images,
      };
      const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `brainsorter-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      showToast(`Backed up ${items.length} thing${items.length === 1 ? "" : "s"}`);
    } catch (e) {
      console.error("Brainsorter: export failed", e);
      showToast("Backup failed — see console for details");
    }
  }, [items, showToast]);

  const applyImportedBackup = useCallback(
    async (parsed) => {
      const importedItems = Array.isArray(parsed.items) ? parsed.items : [];
      setItems(importedItems);
      setOnboarded(true);
      await storeSet("app:onboarded", "true");
      const images = parsed.images && typeof parsed.images === "object" ? parsed.images : {};
      const cacheAdds = {};
      for (const [key, dataUrl] of Object.entries(images)) {
        await storeSet(key, dataUrl);
        cacheAdds[key.replace(/^img:/, "")] = dataUrl;
      }
      if (Object.keys(cacheAdds).length) setImageCache((c) => ({ ...c, ...cacheAdds }));
      showToast(`Restored ${importedItems.length} thing${importedItems.length === 1 ? "" : "s"}`);
    },
    [showToast]
  );

  const importBackupFile = useCallback(
    (file) => {
      const reader = new FileReader();
      reader.onload = () => {
        let parsed;
        try {
          parsed = JSON.parse(String(reader.result));
        } catch (e) {
          showToast("That file doesn't look like a Brainsorter backup");
          return;
        }
        if (!parsed || !Array.isArray(parsed.items)) {
          showToast("That file doesn't look like a Brainsorter backup");
          return;
        }
        const dateStr = parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleDateString() : "an unknown date";
        setConfirmDialog({
          title: "Replace everything on this device?",
          body: `This backup has ${parsed.items.length} thing${parsed.items.length === 1 ? "" : "s"}, from ${dateStr}. It'll replace what's currently here — that can't be undone.`,
          confirmLabel: "Restore",
          danger: false,
          onConfirm: () => {
            applyImportedBackup(parsed);
            setConfirmDialog(null);
          },
        });
      };
      reader.readAsText(file);
    },
    [applyImportedBackup, showToast]
  );

  const requestReset = useCallback(() => {
    setConfirmDialog({
      title: "Reset everything?",
      body: "Deletes every item on this device and starts the setup wizard fresh. This can't be undone — back up first if you want to keep anything.",
      confirmLabel: "Reset",
      danger: true,
      onConfirm: async () => {
        await storeSet("app:items", "");
        await storeSet("app:onboarded", "");
        setItems([]);
        setOnboarded(false);
        setConfirmDialog(null);
      },
    });
  }, []);

  const deleteItem = useCallback((id) => {
    setItems((arr) => arr.filter((i) => i.id !== id));
    setDetailId(null);
  }, []);

  const addTextItem = useCallback(
    (text, opts = {}) => {
      const item = {
        id: uid(),
        title: text,
        type: inferType(text),
        status: "active",
        notes: "",
        subtasks: [],
        thoughts: [],
        relatedItemIds: [],
        tags: [],
        sourceImageId: null,
        snoozedUntil: null,
        completedAt: null,
        estimatedMinutes: inferMinutes(text),
        recurrenceDays: inferRecurrenceDays(text),
        lastCompletedAt: null,
        posture: null,
        area: null,
        sortIndex: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setItems((arr) => [item, ...arr]);
      if (!opts.silent) showToast("Added ✨");
    },
    [showToast]
  );

  const handlePhoto = useCallback(
    async (file) => {
      const reader = new FileReader();
      const dataUrl = await new Promise((res, rej) => {
        reader.onload = () => res(reader.result);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });
      const imageId = uid();
      storeSet("img:" + imageId, dataUrl);
      setImageCache((c) => ({ ...c, [imageId]: dataUrl }));

      // No AI connection in this build — there's no offline substitute for
      // reading a photo, so add it as one item to fill in by hand instead of
      // attempting a network call that has nowhere to go.
      if (!AI_ENABLED) {
        setExtraction({
          status: "done",
          previewUrl: dataUrl,
          imageId,
          origin: "photo",
          list: [
            {
              tempId: uid(),
              title: "From photo — tap to add detail",
              type: "task",
              notes: "",
              selected: true,
            },
          ],
        });
        return;
      }

      setExtraction({ status: "loading", previewUrl: dataUrl, list: [], imageId, origin: "photo" });
      try {
        const list = await extractItemsFromImage(dataUrl, file.type || "image/jpeg");
        setExtraction({ status: "done", previewUrl: dataUrl, list, imageId, origin: "photo" });
      } catch (e) {
        console.error("Brainsorter: photo extraction failed", e);
        showToast("Couldn't read that photo — details shown below");
        setExtraction({
          status: "done",
          previewUrl: dataUrl,
          imageId,
          origin: "photo",
          errorDetail: e.message || String(e),
          list: [
            {
              tempId: uid(),
              title: "From photo — tap to add detail",
              type: "task",
              notes: "",
              selected: true,
            },
          ],
        });
      }
    },
    [showToast]
  );

  // One "Add" button: obvious single thoughts go straight in, anything that
  // looks like several things goes to the review sheet to be confirmed.
  const handleSmartAdd = useCallback(
    (rawText) => {
      const text = String(rawText || "").trim();
      if (!text) return;
      if (looksSplittable(text)) {
        handleTextSplurgeRef.current(text);
      } else {
        addTextItemRef.current(text);
        setCaptureOpen(false);
      }
    },
    []
  );

  const handleTextSplurge = useCallback(
    async (rawText) => {
      const text = rawText.trim();
      if (!text) return;

      // No AI connection in this build — split locally and go straight to
      // the review sheet, rather than attempting a network call that has
      // nowhere to go.
      if (!AI_ENABLED) {
        const offline = localSplit(text);
        setExtraction({
          status: "done",
          previewUrl: null,
          imageId: null,
          origin: "text",
          offline: true,
          sourceText: text,
          list: offline.length
            ? offline
            : [
                {
                  tempId: uid(),
                  title: text.length > 140 ? text.slice(0, 140) + "…" : text,
                  type: inferType(text),
                  notes: "",
                  selected: true,
                },
              ],
        });
        return;
      }

      setExtraction({ status: "loading", previewUrl: null, list: [], imageId: null, origin: "text", sourceText: text });
      try {
        const list = await extractItemsFromText(text);
        setExtraction({ status: "done", previewUrl: null, list, imageId: null, origin: "text", sourceText: text });
      } catch (e) {
        console.error("Brainsorter: text splitting failed", e);
        const offline = localSplit(text);
        showToast(
          offline.length > 1 ? `Sorted offline — found ${offline.length} things` : "Sorted offline"
        );
        setExtraction({
          status: "done",
          previewUrl: null,
          imageId: null,
          origin: "text",
          offline: true,
          sourceText: text,
          errorDetail: e.message || String(e),
          list: offline.length
            ? offline
            : [
                {
                  tempId: uid(),
                  title: text.length > 140 ? text.slice(0, 140) + "…" : text,
                  type: inferType(text),
                  notes: "",
                  selected: true,
                },
              ],
        });
      }
    },
    [showToast]
  );

  const addTextItemRef = useRef(addTextItem);
  const handleTextSplurgeRef = useRef(handleTextSplurge);
  useEffect(() => {
    addTextItemRef.current = addTextItem;
    handleTextSplurgeRef.current = handleTextSplurge;
  }, [addTextItem, handleTextSplurge]);

  const confirmExtraction = useCallback(() => {
    if (!extraction) return;
    const chosen = extraction.list.filter((e) => e.selected);
    const newItems = chosen.map((e) => ({
      id: uid(),
      title: e.title,
      type: e.type,
      status: "active",
      notes: e.notes || "",
      subtasks: [],
      thoughts: [],
      relatedItemIds: [],
      tags: [],
      sourceImageId: extraction.imageId,
      snoozedUntil: null,
      completedAt: null,
      estimatedMinutes: inferMinutes(e.title),
      recurrenceDays: null,
      lastCompletedAt: null,
      posture: null,
      area: null,
      sortIndex: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    setItems((arr) => [...newItems, ...arr]);
    setExtraction(null);
    setCaptureOpen(false);
    showToast(`Added ${newItems.length} thing${newItems.length === 1 ? "" : "s"} ✨`);
  }, [extraction, showToast]);

  const openImageFor = useCallback(
    async (imageId) => {
      if (imageCache[imageId]) return imageCache[imageId];
      const v = await storeGet("img:" + imageId);
      if (v) setImageCache((c) => ({ ...c, [imageId]: v }));
      return v;
    },
    [imageCache]
  );

  useEffect(() => {
    const detail = items.find((i) => i.id === detailId);
    if (detail?.sourceImageId) openImageFor(detail.sourceImageId);
  }, [detailId]); // eslint-disable-line

  if (!loaded) return <div className="fixed inset-0" style={{ background: "#14121F" }} />;
  if (!onboarded)
    return (
      <FontLoader>
        <OnboardingFlow
          items={items}
          onAdd={handleSmartAdd}
          addTextItem={addTextItem}
          onPhoto={handlePhoto}
          extraction={extraction}
          setExtraction={setExtraction}
          confirmExtraction={confirmExtraction}
          updateItem={updateItem}
          deleteItem={deleteItem}
          toast={showToast}
          onFinish={(seedDemo) => {
            if (seedDemo) setItems(seedItems());
            storeSet("app:onboarded", "true");
            setOnboarded(true);
          }}
        />
        <Toast text={toastText} />
      </FontLoader>
    );

  const detailItem = items.find((i) => i.id === detailId);
  const empty = pool.length === 0;
  const shortlistCount = items.filter((i) => i.shortlisted && i.status === "active").length;
  // The header grows when a mode pill or due banner is showing, so pages need
  // matching top padding to avoid content hiding underneath it.
  const headerPad =
    TOP_INSET + 96 + (mode !== "all" ? 28 : 0) + (dueBanner ? (dueOpen ? 40 + Math.min(dueBanner.length, 5) * 34 : 34) : 0);

  return (
    <FontLoader>
      <div
        className="fixed inset-0 flex flex-col"
        style={{
          background:
            "radial-gradient(120% 80% at 10% -5%, rgba(255,45,149,0.16), transparent 55%)," +
            "radial-gradient(110% 70% at 95% 8%, rgba(0,229,255,0.14), transparent 55%)," +
            "radial-gradient(120% 80% at 50% 105%, rgba(255,209,102,0.12), transparent 55%)," +
            "#0E0C17",
        }}
      >
        {/* header */}
        <div
          className="absolute top-0 left-0 right-0 z-40 px-4 pb-2"
          style={{
            paddingTop: `calc(env(safe-area-inset-top, 0px) + ${TOP_INSET}px)`,
            background: "linear-gradient(180deg,#0E0C17 70%,transparent)",
          }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span
                className="flex h-7 w-7 items-center justify-center rounded-xl"
                style={{ background: "linear-gradient(135deg,#FF2D95,#FFB800)", boxShadow: "0 3px 0 rgba(0,0,0,0.35)" }}
              >
                <Filter size={15} color="#14121F" strokeWidth={2.6} />
              </span>
              <span
                className="text-[17px] text-white"
                style={{ fontFamily: "'Fredoka',sans-serif", fontWeight: 700, letterSpacing: "-0.01em" }}
              >
                Brainsorter
              </span>
              <span className="text-[10px]" style={{ color: "#4A4658" }}>
                {BUILD_STAMP}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setMode(mode === "five" ? "all" : "five")}
                className="rounded-full p-2 active:scale-90 transition-transform"
                style={{ background: mode === "five" ? "rgba(255,209,102,0.18)" : "rgba(255,255,255,0.05)" }}
                title="5-minute mode"
              >
                <Zap size={16} color={mode === "five" ? "#FFD166" : "#C7C3D6"} />
              </button>
              <button
                onClick={() => setMode(mode === "sit" ? "move" : mode === "move" ? "all" : "sit")}
                className="rounded-full p-2 active:scale-90 transition-transform"
                style={{ background: mode === "sit" || mode === "move" ? "rgba(159,214,140,0.18)" : "rgba(255,255,255,0.05)" }}
                title="Sitting down / up and about"
              >
                {mode === "move" ? (
                  <Footprints size={16} color="#9FD68C" />
                ) : (
                  <Armchair size={16} color={mode === "sit" ? "#9FD68C" : "#C7C3D6"} />
                )}
              </button>
              <button
                onClick={() => setAreaPickerOpen(true)}
                className="flex items-center gap-1 rounded-full px-2 py-2 active:scale-90 transition-transform"
                style={{ background: areaFilter ? "rgba(195,178,255,0.2)" : "rgba(255,255,255,0.05)" }}
                title="Filter by area of life"
              >
                {areaFilter ? (
                  <span className="text-[13px] leading-none">{AREA_CONFIG[areaFilter].emoji}</span>
                ) : (
                  <Layers size={16} color="#C7C3D6" />
                )}
              </button>
              <button
                onClick={() => setMode(mode === "today" ? "all" : "today")}
                className="relative rounded-full p-2 active:scale-90 transition-transform"
                style={{ background: mode === "today" ? "rgba(255,209,102,0.18)" : "rgba(255,255,255,0.05)" }}
                title="Today's shortlist"
              >
                <Star size={16} color={mode === "today" ? "#FFD166" : "#C7C3D6"} fill={mode === "today" ? "#FFD166" : "none"} />
                {shortlistCount > 0 && (
                  <span
                    className="absolute -top-1 -right-1 flex h-4 items-center justify-center rounded-full px-1 text-[10px] font-bold"
                    style={{ background: "#FFD166", color: "#14121F", minWidth: 16 }}
                  >
                    {shortlistCount}
                  </span>
                )}
              </button>
              {page === 0 && (
                <button onClick={() => setSeed(Date.now() % 1000000)} className="rounded-full p-2 active:scale-90 transition-transform" style={{ background: "rgba(255,255,255,0.05)" }} title="Shuffle">
                  <RefreshCw size={16} color="#C7C3D6" />
                </button>
              )}
              <button onClick={() => setDataMenuOpen(true)} className="rounded-full p-2 active:scale-90 transition-transform" style={{ background: "rgba(255,255,255,0.05)" }} title="Backup, restore, reset">
                <MoreVertical size={16} color="#C7C3D6" />
              </button>
              <button onClick={() => setSearchOpen(true)} className="rounded-full p-2 active:scale-90 transition-transform" style={{ background: "rgba(255,255,255,0.05)" }}>
                <Search size={16} color="#C7C3D6" />
              </button>
            </div>
          </div>

          {/* page tabs */}
          <div className="mt-2 flex justify-center gap-1">
            {["Cards", "Lists"].map((label, i) => (
              <button
                key={label}
                onClick={() => goToPage(i)}
                className="rounded-full px-5 py-1.5 text-xs transition-all active:scale-95"
                style={{
                  fontFamily: "'Fredoka',sans-serif",
                  fontWeight: 700,
                  background: page === i ? "#F2F0F5" : "rgba(255,255,255,0.07)",
                  color: page === i ? "#14121F" : "#8B87A0",
                  boxShadow: page === i ? "0 3px 0 rgba(255,45,149,0.7)" : "none",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {(mode !== "all" || areaFilter) && (
            <div className="mt-1.5 flex justify-center gap-1.5">
              {areaFilter && (
                <button
                  onClick={() => setAreaFilter(null)}
                  className="flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium"
                  style={{ background: "rgba(195,178,255,0.16)", color: "#C3B2FF" }}
                >
                  {AREA_CONFIG[areaFilter].emoji} {AREA_CONFIG[areaFilter].label}
                  <X size={11} />
                </button>
              )}
              {mode !== "all" && (
              <span
                className="rounded-full px-3 py-1 text-xs font-medium"
                style={{
                  background: mode === "sit" || mode === "move" ? "rgba(159,214,140,0.14)" : "rgba(255,209,102,0.14)",
                  color: mode === "sit" || mode === "move" ? "#9FD68C" : "#FFD166",
                }}
              >
                {mode === "five"
                  ? "⚡ 5-minute mode"
                  : mode === "sit"
                  ? "🪑 Can do sitting down"
                  : mode === "move"
                  ? "🚶 Up and about"
                  : "⭐ Today's shortlist"}
              </span>
              )}
            </div>
          )}

          {dueBanner && (
            <div className="mt-1.5 flex justify-center">
              <div className="w-full max-w-sm overflow-hidden rounded-2xl shadow-lg" style={{ background: "#EDEBFB" }}>
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    onClick={() => {
                      if (dueBanner.length === 1) {
                        setDetailId(dueBanner[0].id);
                        setDueBanner(null);
                      } else {
                        setDueOpen((v) => !v);
                      }
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-medium"
                    style={{ color: "#1B1A24" }}
                  >
                    <Bell size={12} className="shrink-0" />
                    <span className="truncate">
                      {dueBanner.length === 1
                        ? `"${dueBanner[0].title}" is back today`
                        : `${dueBanner.length} things are back today`}
                    </span>
                    {dueBanner.length > 1 && (
                      <ChevronDown
                        size={13}
                        className="shrink-0"
                        style={{ transform: dueOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}
                      />
                    )}
                  </button>
                  <button onClick={() => setDueBanner(null)} className="shrink-0 p-0.5">
                    <X size={13} color="#5C5870" />
                  </button>
                </div>
                {dueOpen && dueBanner.length > 1 && (
                  <div className="px-2 pb-2">
                    {dueBanner.map((d) => (
                      <button
                        key={d.id}
                        onClick={() => {
                          setDetailId(d.id);
                          setDueBanner(null);
                          setDueOpen(false);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left active:bg-black/5"
                      >
                        <TypeIcon type={d.type} size={12} />
                        <span className="truncate text-xs" style={{ color: "#1B1A24" }}>
                          {d.title}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* swipeable pages: cards | lists */}
        <div
          ref={pagerRef}
          className="flex-1 flex overflow-x-auto overflow-y-hidden hide-scrollbar"
          style={{ scrollSnapType: "x mandatory" }}
        >
          {/* page 1 — cards */}
          <div
            className="h-full w-full shrink-0 overflow-y-auto hide-scrollbar"
            style={{ scrollSnapAlign: "start" }}
          >
            {empty ? (
              <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                <p className="mb-2 text-lg text-white" style={{ fontFamily: "Fraunces, serif" }}>
                  {mode === "today" ? "Nothing prioritised yet." : "Nothing here."}
                </p>
                <p className="mb-8 text-sm" style={{ color: "#8B87A0" }}>
                  {mode === "today"
                    ? "Tap the ☆ on anything to line it up for today."
                    : "Which is either extremely productive or mildly suspicious."}
                </p>
                <button
                  onClick={() => (mode === "today" ? setMode("all") : setCaptureOpen(true))}
                  className="rounded-full px-6 py-3 text-sm font-semibold"
                  style={{ background: "#F5A153", color: "#14121F" }}
                >
                  {mode === "today" ? "Back to the feed" : "+ Add something"}
                </button>
              </div>
            ) : (
              <div ref={feedRef} className="mx-auto flex max-w-md flex-col gap-3 px-4 pb-32" style={{ paddingTop: headerPad }}>
                {cardFeed.map((entry) =>
                  entry.kind === "shopping" ? (
                    <ShoppingListCard key={entry.key} items={entry.items} onOpen={setDetailId} />
                  ) : (
                    <Card
                      key={entry.key}
                      item={entry.item}
                      now={now}
                      onOpen={setDetailId}
                      onComplete={completeItem}
                      onSnooze={snoozeItem}
                      onShortlist={shortlistItem}
                      onUnshortlist={unshortlistItem}
                    />
                  )
                )}
                <p className="pt-4 text-center text-xs" style={{ color: "#4A4658" }}>
                  That's everything for now.
                </p>
              </div>
            )}
          </div>

          {/* page 2 — lists */}
          <div
            className="h-full w-full shrink-0 overflow-y-auto hide-scrollbar"
            style={{ scrollSnapAlign: "start" }}
          >
            <div className="mx-auto max-w-md px-4" style={{ paddingTop: headerPad }}>
              <ListsPage
                items={listItems}
                now={now}
                onOpen={setDetailId}
                onComplete={completeItem}
                onSnooze={snoozeItem}
                onShortlist={shortlistItem}
                onUnshortlist={unshortlistItem}
                onWake={wakeItem}
                onReorder={reorderItems}
                expanded={listExpanded}
                setExpanded={setListExpanded}
              />
            </div>
          </div>
        </div>


        {/* capture fab */}
        <button
          onClick={() => setCaptureOpen(true)}
          className="fixed bottom-7 left-1/2 z-50 -translate-x-1/2 flex h-16 w-16 items-center justify-center rounded-full active:scale-90 transition-transform"
          style={{
            background: "linear-gradient(135deg,#FF2D95,#FFB800)",
            boxShadow: "0 6px 0 rgba(140,20,80,0.55), 0 14px 28px rgba(0,0,0,0.5)",
          }}
        >
          <Plus size={30} color="#14121F" strokeWidth={3} />
        </button>

        {captureOpen && !extraction && (
          <CaptureSheet onClose={() => setCaptureOpen(false)} onAdd={handleSmartAdd} onPhoto={handlePhoto} toast={showToast} />
        )}

        {extraction && (
          <ExtractionConfirm
            status={extraction.status}
            previewUrl={extraction.previewUrl}
            extracted={extraction.list}
            origin={extraction.origin}
          errorDetail={extraction.errorDetail}
          offline={extraction.offline}
          sourceText={extraction.sourceText}
          onAddAsOne={(t) => {
            addTextItem(t);
            setExtraction(null);
          }}
            setExtracted={(fn) => setExtraction((ex) => ({ ...ex, list: typeof fn === "function" ? fn(ex.list) : fn }))}
            onClose={() => {
              setExtraction(null);
              setCaptureOpen(false);
            }}
            onConfirm={confirmExtraction}
          />
        )}

        {detailItem && (
          <ItemDetail
            item={detailItem}
            allItems={items}
            imageUrl={detailItem.sourceImageId ? imageCache[detailItem.sourceImageId] : null}
            onClose={() => setDetailId(null)}
            onUpdate={updateItem}
            onComplete={(id) => {
              completeItem(id);
              setDetailId(null);
            }}
            onSnooze={(id, d) => {
              snoozeItem(id, d);
              setDetailId(null);
            }}
            onDelete={deleteItem}
            onOpenRelated={setDetailId}
          />
        )}

        {areaPickerOpen && (
          <div
            className="fixed inset-0 flex items-center justify-center px-8"
            style={{ background: "rgba(10,9,15,0.75)", zIndex: 200 }}
            onClick={() => setAreaPickerOpen(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full overflow-hidden rounded-3xl shadow-2xl"
              style={{ maxWidth: 260, background: "#242233", border: "1px solid rgba(255,255,255,0.1)" }}
            >
              <p className="px-4 pt-4 pb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "#736E88" }}>
                Area of life
              </p>
              <button
                onClick={() => {
                  setAreaFilter(null);
                  setAreaPickerOpen(false);
                }}
                className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-white/5"
                style={{ background: !areaFilter ? "rgba(255,255,255,0.07)" : "transparent" }}
              >
                <Layers size={15} color="#C7C3D6" />
                <span className="flex-1 text-sm font-medium" style={{ color: "#DAD7E5" }}>
                  Everything
                </span>
                {!areaFilter && <Check size={14} color="#C3B2FF" />}
              </button>
              {AREA_ORDER.map((a) => (
                <button
                  key={a}
                  onClick={() => {
                    setAreaFilter(a);
                    setAreaPickerOpen(false);
                  }}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-white/5"
                  style={{ background: areaFilter === a ? "rgba(195,178,255,0.16)" : "transparent" }}
                >
                  <span className="text-[15px] leading-none">{AREA_CONFIG[a].emoji}</span>
                  <span className="flex-1 text-sm font-medium" style={{ color: areaFilter === a ? "#C3B2FF" : "#DAD7E5" }}>
                    {AREA_CONFIG[a].label}
                  </span>
                  {areaFilter === a && <Check size={14} color="#C3B2FF" />}
                </button>
              ))}
            </div>
          </div>
        )}

        {dataMenuOpen && (
          <DataMenu
            items={items}
            imageCache={imageCache}
            onClose={() => setDataMenuOpen(false)}
            onExport={exportBackup}
            onImportFile={importBackupFile}
            onReset={requestReset}
            toast={showToast}
          />
        )}

        {confirmDialog && (
          <ConfirmDialog
            title={confirmDialog.title}
            body={confirmDialog.body}
            confirmLabel={confirmDialog.confirmLabel}
            danger={confirmDialog.danger}
            onConfirm={confirmDialog.onConfirm}
            onCancel={() => setConfirmDialog(null)}
          />
        )}

        {searchOpen && (
          <SearchOverlay
            items={items}
            onClose={() => setSearchOpen(false)}
            onOpen={(id) => {
              setSearchOpen(false);
              setDetailId(id);
            }}
          />
        )}

        <Toast text={toastText} />
      </div>
    </FontLoader>
  );
}

function FontLoader({ children }) {
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..600&family=Inter:wght@400;500;600;700&family=Bebas+Neue&family=Rubik+Mono+One&family=Caveat:wght@600;700&family=Abril+Fatface&family=Space+Grotesk:wght@500;700&family=Righteous&family=VT323&family=Press+Start+2P&family=Monoton&family=Bungee&family=Bungee+Shade&family=Shrikhand&family=Titan+One&family=Faster+One&family=Alfa+Slab+One&family=Permanent+Marker&family=Fredoka:wght@600;700&family=Pacifico&family=Audiowide&family=Creepster&family=Anton&family=Special+Elite&family=Playfair+Display:wght@700;900&family=Kalam:wght@400;700&display=swap');
        * { font-family: 'Inter', sans-serif; }
        .hide-scrollbar::-webkit-scrollbar { display: none; }
        .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }

        /* ---- card personality animations ---- */
        @keyframes bsFloat {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          50%      { transform: translateY(-9px) rotate(8deg); }
        }
        @keyframes bsShimmer {
          0%   { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        @keyframes bsBlob {
          0%, 100% { transform: translate(0,0) scale(1); }
          33%      { transform: translate(14px,-10px) scale(1.15); }
          66%      { transform: translate(-10px,8px) scale(0.92); }
        }
        @keyframes bsPop {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(1.18); }
        }
        .bs-float   { animation: bsFloat 3.4s ease-in-out infinite; }
        .bs-blob    { animation: bsBlob 9s ease-in-out infinite; }
        .bs-pop     { animation: bsPop 2.6s ease-in-out infinite; }
        .bs-shimmer {
          background-size: 200% auto;
          animation: bsShimmer 4.5s linear infinite;
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
        }
      `}</style>
      {children}
    </>
  );
}
