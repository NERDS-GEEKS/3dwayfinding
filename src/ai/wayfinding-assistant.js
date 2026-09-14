/**
 * Intent matching for the wayfinding chat.
 *
 * Runs entirely in the browser against the POIs already in memory — no model,
 * no API call, no new dependency. That is deliberate: the chat is used while
 * someone is standing in the building trying to get somewhere, often on venue
 * Wi-Fi, so an answer that needs a round trip to a language model is an answer
 * that sometimes never arrives. Everything here is a table lookup and a sort
 * over a few hundred rows — instant, and it works offline.
 *
 * The chat never invents a place. Every answer is a POI that exists on the
 * current map; when nothing matches it says so instead of guessing. That rule
 * is load-bearing, and the scoring below is shaped by three ways it can break,
 * each seen on real project data:
 *
 *  1. A fuzzy match on a short word will find almost anything — "rockets" is
 *     two edits from "socket", which once turned a question about rockets into
 *     a list of charging points. Fuzz is therefore tight, and tighter still for
 *     the words that pick an intent than for the words that pick a name.
 *  2. Descriptions are prose, so a single common word hits dozens of unrelated
 *     places. They are scored last, capped, and cut by the relevance floor.
 *  3. An intent must be answered by a place that actually serves it. Asking for
 *     a lift must not return "LIFI Technology" because the letters line up;
 *     if the map has no lift, the honest answer is that it has no lift.
 */

/** Words that carry no routing meaning; dropped before matching. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'am', 'i', 'im', 'me', 'my', 'we', 'us', 'you',
  'to', 'at', 'in', 'on', 'of', 'for', 'from', 'and', 'or', 'please', 'pls',
  'can', 'could', 'would', 'will', 'do', 'does', 'did', 'want', 'need', 'like',
  'go', 'going', 'get', 'take', 'show', 'tell', 'find', 'looking', 'look',
  'where', 'what', 'which', 'how', 'there', 'here', 'this', 'that', 'it',
  'some', 'any', 'now', 'right', 'hey', 'hi', 'hello', 'ok', 'okay', 'thanks',
  'have', 'has', 'be', 'been', 'was', 'were', 'so', 'very', 'really', 'too',
  'see', 'visit', 'know', 'tell', 'about', 'lead', 'bring', 'way', 'point',
  'whats', 'wheres', 'hows', 'lets', 'ive', 'id', 'theres', 'gimme', 'give',
]);

/**
 * What someone might say, and which places answer it.
 *
 * The three word lists are deliberately different jobs, and mixing them is the
 * classic source of nonsense answers:
 *
 *   `says`   — what the **user** types, including the indirect phrasings
 *              ("hungry", not "canteen"), which is the whole reason to ask a
 *              chat instead of scrolling the list. Never matched against place
 *              names: "escape" is how you ask for an exit, but a place called
 *              "Escape Velocity" is a physics exhibit.
 *   `strong` — words that, in a **place's** name or category, mean this *is*
 *              one of those places. "Cafeteria" is somewhere to eat.
 *   `weak`   — words that merely suggest it. "Space Food" contains "food" but
 *              is an exhibit about astronaut meals, so it ranks below the real
 *              canteen while still being findable.
 *
 * `icons` are lucide `icon_key` values on the project's categories — the most
 * reliable signal when a project has amenity categories at all, since "Food",
 * "Canteen" and "Mess Hall" are one `pizza` underneath. Museum-style projects
 * have no such categories, which is exactly why names and descriptions matter.
 */
const CONCEPTS = [
  {
    id: 'food',
    says: [
      'hungry', 'hunger', 'starving', 'famished', 'food', 'eat', 'eating',
      'meal', 'meals', 'lunch', 'dinner', 'breakfast', 'canteen', 'cafeteria',
      'cafe', 'coffee', 'tea', 'snack', 'snacks', 'restaurant', 'dining',
      'mess', 'foodcourt', 'bite', 'pizza', 'burger', 'refreshments',
    ],
    icons: ['pizza', 'utensils', 'utensils-crossed', 'coffee', 'cup-soda', 'sandwich', 'chef-hat', 'barrel'],
    strong: ['cafeteria', 'canteen', 'restaurant', 'food court', 'foodcourt', 'dining', 'mess hall', 'cafe', 'coffee shop', 'snack bar', 'eatery', 'refreshment'],
    weak: ['food', 'kitchen', 'coffee', 'tea', 'snack', 'meal'],
    lead: 'Hungry? Here’s the closest place to eat.',
    leadMany: 'Hungry? Here’s where you can eat.',
    none: 'I can’t find anywhere to eat on this map.',
  },
  {
    id: 'drink',
    says: ['thirsty', 'thirst', 'water', 'drink', 'drinking', 'hydrate', 'refill'],
    icons: ['cup-soda', 'droplet', 'droplets'],
    // "Water" alone is not a drinking point — on a science map it is a turbine.
    strong: ['drinking water', 'water cooler', 'water fountain', 'drinking fountain', 'hydration'],
    weak: ['water dispenser'],
    lead: 'Here’s the nearest place to get a drink.',
    leadMany: 'Places to get a drink:',
    none: 'I can’t find a drinking-water point marked on this map.',
    fallback: 'food',
    fallbackLead: 'There’s no drinking-water point marked, but you can get a drink here:',
  },
  {
    id: 'restroom',
    says: ['toilet', 'toilets', 'restroom', 'restrooms', 'washroom', 'bathroom', 'loo', 'wc', 'lavatory', 'urinal'],
    icons: ['toilet', 'shower-head'],
    strong: ['restroom', 'rest room', 'toilet', 'washroom', 'bathroom', 'lavatory', 'ladies', 'gents'],
    weak: ['wc', 'wash'],
    lead: 'Nearest restroom:',
    leadMany: 'Restrooms nearby:',
    none: 'I can’t find a restroom marked on this map. The help desk can point you to one.',
  },
  {
    id: 'medical',
    says: ['sick', 'ill', 'unwell', 'hurt', 'injured', 'injury', 'medical', 'medic', 'doctor', 'nurse', 'clinic', 'hospital', 'firstaid', 'ambulance', 'faint', 'dizzy', 'bleeding'],
    icons: ['hospital', 'stethoscope', 'heart-pulse', 'pill', 'bandage', 'cross'],
    strong: ['first aid', 'firstaid', 'medical room', 'medical centre', 'medical center', 'clinic', 'infirmary', 'dispensary', 'sick bay', 'doctor', 'nurse'],
    weak: ['medical', 'health'],
    lead: 'Medical help is here — head straight there.',
    leadMany: 'Medical points on this map:',
    none: 'No medical point is marked on this map. If this is an emergency, call for help where you are rather than walking.',
    urgent: true,
  },
  {
    id: 'exit',
    says: ['exit', 'exits', 'outside', 'leave', 'escape', 'evacuate', 'fire'],
    icons: ['log-out', 'flame', 'triangle-alert'],
    strong: ['exit', 'fire exit', 'fire exist', 'emergency exit', 'way out', 'entry exit'],
    weak: ['gate', 'entrance'],
    lead: 'Nearest exit:',
    leadMany: 'Exits:',
    none: 'No exit is marked on this map.',
    urgent: true,
  },
  {
    id: 'entrance',
    says: ['entrance', 'entry', 'gate', 'reception', 'lobby', 'foyer', 'ticket', 'tickets', 'checkin'],
    icons: ['door-open', 'armchair', 'log-in', 'concierge-bell'],
    strong: ['entrance', 'entry', 'main gate', 'reception', 'lobby', 'foyer', 'ticket counter', 'ticket'],
    weak: ['gate', 'door'],
    lead: 'The entrance is here.',
    leadMany: 'Entrances and ticketing:',
    none: 'No entrance is marked on this map.',
  },
  {
    id: 'help',
    says: ['help', 'helpdesk', 'information', 'info', 'enquiry', 'inquiry', 'assistance', 'lost', 'staff', 'guide'],
    icons: ['info', 'circle-help', 'headset', 'concierge-bell'],
    strong: ['help desk', 'helpdesk', 'info desk', 'information desk', 'information centre', 'enquiry', 'reception', 'front desk'],
    weak: ['info', 'information', 'help'],
    lead: 'The help desk is here — the people there can answer what I can’t.',
    leadMany: 'Information points:',
    none: 'No help desk is marked on this map.',
  },
  {
    id: 'lift',
    says: ['lift', 'lifts', 'elevator', 'elevators', 'upstairs', 'downstairs', 'wheelchair', 'accessible'],
    icons: ['move-vertical', 'arrow-up-down', 'accessibility'],
    strong: ['elevator', 'lift'],
    weak: [],
    lead: 'Nearest lift:',
    leadMany: 'Lifts:',
    none: 'No lift is marked on this map.',
  },
  {
    id: 'stairs',
    says: ['stairs', 'staircase', 'steps', 'stairway'],
    icons: ['footprints'],
    strong: ['stairs', 'staircase', 'stairway', 'steps'],
    weak: [],
    lead: 'Nearest staircase:',
    leadMany: 'Staircases:',
    none: 'No staircase is marked on this map.',
  },
  {
    id: 'rest',
    says: ['tired', 'rest', 'relax', 'sit', 'seat', 'lounge', 'sleep', 'nap'],
    icons: ['bed-double', 'armchair', 'sofa'],
    strong: ['lounge', 'rest area', 'waiting area', 'seating', 'bedroom', 'guest room'],
    weak: ['lobby', 'rest'],
    lead: 'Somewhere to sit down:',
    leadMany: 'Places to sit or rest:',
    none: 'I can’t find a rest area marked on this map.',
  },
  {
    id: 'shop',
    says: ['shop', 'shopping', 'buy', 'store', 'souvenir', 'gift', 'merchandise', 'purchase'],
    icons: ['shopping-bag', 'shopping-cart', 'store', 'gift'],
    strong: ['shop', 'store', 'gift shop', 'souvenir', 'book shop', 'bookstore', 'kiosk'],
    weak: ['market', 'retail'],
    lead: 'Nearest shop:',
    leadMany: 'Shops:',
    none: 'I can’t find a shop on this map.',
  },
  {
    id: 'money',
    says: ['atm', 'cash', 'money', 'bank', 'withdraw'],
    icons: ['banknote', 'credit-card', 'landmark', 'wallet'],
    strong: ['atm', 'cash point', 'cashpoint', 'bank'],
    weak: ['cash', 'payment'],
    lead: 'Nearest ATM:',
    leadMany: 'Cash points:',
    none: 'I can’t find an ATM on this map.',
  },
  {
    id: 'parking',
    says: ['parking', 'car', 'bike', 'vehicle', 'garage', 'scooter'],
    icons: ['car', 'circle-parking', 'bike'],
    strong: ['parking', 'car park', 'garage', 'drop off'],
    weak: ['vehicle'],
    lead: 'Parking is here.',
    leadMany: 'Parking areas:',
    none: 'No parking is marked on this map.',
  },
  {
    id: 'charge',
    says: ['charging', 'charger', 'battery', 'plug', 'powerbank'],
    icons: ['battery-charging', 'plug', 'plug-zap', 'zap'],
    strong: ['charging point', 'charging station', 'charger', 'power point'],
    weak: ['charging'],
    lead: 'Nearest charging point:',
    leadMany: 'Charging points:',
    none: 'I can’t find a charging point on this map.',
  },
  {
    id: 'prayer',
    says: ['prayer', 'pray', 'worship', 'temple', 'church', 'mosque', 'chapel', 'meditation'],
    icons: ['church', 'moon-star', 'hand-heart'],
    strong: ['prayer room', 'prayer', 'worship', 'temple', 'chapel', 'mosque', 'meditation'],
    weak: ['quiet room'],
    lead: 'Prayer room:',
    leadMany: 'Prayer and quiet rooms:',
    none: 'I can’t find a prayer room on this map.',
  },
];

const CONCEPTS_BY_ID = new Map(CONCEPTS.map((c) => [c.id, c]));

/** Phrases meaning "closest to me", which flips ranking toward distance. */
const NEAR_WORDS = ['near', 'nearest', 'nearby', 'closest', 'close', 'around', 'next'];

/** Follow-ups that accept whatever was just offered. */
const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'go', 'lets go', 'take me', 'take me there', 'navigate', 'route', 'start', 'y', 'do it', 'first one', 'that one']);

/** Nouns that name no particular place, so "nearest ___" means "anything". */
const GENERIC_PLACE_WORDS = new Set(['place', 'places', 'thing', 'things', 'spot', 'spots', 'poi', 'pois', 'destination', 'destinations', 'exhibit', 'exhibits', 'anything', 'something']);

/** Strip accents and punctuation so matching is about words, not typing. */
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeText(value).split(' ').filter(Boolean);
}

function contentTokens(value) {
  return tokenize(value).filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

/**
 * Edit distance, capped — anything further apart than `max` is reported as
 * `max + 1` rather than computed, since callers only compare against a small
 * threshold.
 */
function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1; // no later row can recover
    prev = row;
  }
  return prev[b.length];
}

/**
 * How well a typed word matches a target word, 0 (not at all) to 1 (exactly).
 *
 * A degree rather than a yes/no, because the ranking needs to separate a typo
 * from a coincidence: against "chandrayan", the exhibit "Chandrayaan-3" is one
 * edit away while "Acharya Jagadish Chandra Bose" merely starts with the same
 * seven letters. Both "match"; only one is what was asked for.
 */
function matchQuality(typed, target) {
  if (typed === target) return 1;
  let best = 0;
  // A prefix is weak evidence — many unrelated words share an opening.
  if (target.length >= 5 && (target.startsWith(typed) || typed.startsWith(target))) {
    if (Math.min(typed.length, target.length) >= 4) best = 0.6;
  }
  if (typed.length >= 4) {
    // Cap at 2 and judge the result, rather than capping at the tolerance:
    // editDistance reports `max + 1` for "further than you asked", so capping
    // at 1 makes every non-match come back as 2 and look like a near miss.
    const d = editDistance(typed, target, 2);
    if (d === 1) best = Math.max(best, 0.85);
    else if (d === 2 && typed.length >= 8) best = Math.max(best, 0.65);
  }
  return best;
}

/**
 * Strict variant for intent words, where a false positive rewrites the whole
 * answer rather than just adding a row. Only genuine typos pass: one edit, and
 * never on a word short enough for one edit to reach an unrelated meaning —
 * "rockets" is two edits from "socket", which once turned a question about
 * rockets into a list of charging points.
 */
function intentMatches(typed, target) {
  if (typed === target) return true;
  if (typed.length < 5 || target.length < 5) return false;
  if (Math.abs(typed.length - target.length) > 1) return false;
  return editDistance(typed, target, 1) <= 1;
}

/** Concepts the sentence is asking about, strongest first. */
function detectConcepts(tokens, raw) {
  const hits = [];
  for (const concept of CONCEPTS) {
    let score = 0;
    for (const phrase of concept.says) {
      if (phrase.includes(' ')) {
        if (raw.includes(phrase)) score += 6;
        continue;
      }
      for (const token of tokens) {
        if (token === phrase) score += 5;
        else if (intentMatches(token, phrase)) score += 2;
      }
    }
    if (score > 0) hits.push({ concept, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/** Whole-word containment — "cafe" must not match "cafeteria" by accident. */
function hasPhrase(haystack, phrase) {
  if (!haystack || !phrase) return false;
  return ` ${haystack} `.includes(` ${phrase} `);
}

/**
 * How well one POI answers the sentence.
 *
 * The concept part is reported split by where the evidence came from. A place's
 * own name or category saying what it is counts; its description mentioning the
 * word in passing does not, because "Lever" explains that it lifts loads and
 * that must never be the answer to "where is the lift".
 */
function scorePoi(entry, { tokens, concepts, raw }) {
  let score = 0;
  let nameExact = false;
  let nameHit = false;

  if (raw.length >= 3 && entry.nameNorm === raw) {
    score += 100;
    nameExact = true;
  } else if (raw.includes(' ') && hasPhrase(entry.nameNorm, raw)) {
    // Multi-word only: a single word is already worth 20 through the token
    // path, and treating it as a phrase let "food" score "Space Food" above
    // the actual Cafeteria.
    score += 55;
    nameExact = true;
  }

  let descScore = 0;
  for (const token of tokens) {
    if (entry.nameTokens.includes(token)) {
      score += 20;
      nameExact = true;
      nameHit = true;
      continue;
    }
    const nameQ = bestQuality(token, entry.nameTokens);
    if (nameQ > 0) {
      score += 20 * nameQ;
      nameHit = true;
      continue;
    }
    if (entry.categoryTokens.includes(token)) {
      score += 10;
      continue;
    }
    const catQ = bestQuality(token, entry.categoryTokens);
    if (catQ > 0) {
      score += 10 * catQ;
      continue;
    }
    if (token.length >= 4 && entry.descriptionTokens.has(token)) {
      // Prose matches stack up fast across unrelated places, so they are
      // capped: a description can support an answer, never carry it.
      descScore = Math.min(descScore + 4, 8);
    }
  }
  score += descScore;

  let conceptNameCat = 0;
  let conceptDesc = 0;
  for (let i = 0; i < concepts.length; i += 1) {
    const { concept } = concepts[i];
    // A second concept in one sentence is a weaker signal than the first.
    const weight = i === 0 ? 1 : 0.4;
    let named = 0;
    let described = 0;
    if (entry.iconKeys.some((k) => concept.icons.includes(k))) named = Math.max(named, 30);
    for (const phrase of concept.strong) {
      if (hasPhrase(entry.nameNorm, phrase)) named = Math.max(named, 34);
      else if (hasPhrase(entry.categoryNorm, phrase)) named = Math.max(named, 30);
      else if (hasPhrase(entry.descriptionNorm, phrase)) described = Math.max(described, 12);
    }
    for (const phrase of concept.weak) {
      if (hasPhrase(entry.nameNorm, phrase)) named = Math.max(named, 14);
      else if (hasPhrase(entry.categoryNorm, phrase)) named = Math.max(named, 16);
      else if (hasPhrase(entry.descriptionNorm, phrase)) described = Math.max(described, 7);
    }
    conceptNameCat += named * weight;
    conceptDesc += described * weight;
  }

  return {
    score: score + Math.max(conceptNameCat, conceptDesc),
    conceptNameCat,
    nameExact,
    nameHit,
  };
}

/** Best match quality of a typed word against any of a place's words. */
function bestQuality(token, targets) {
  let best = 0;
  for (const t of targets) {
    const q = matchQuality(token, t);
    if (q > best) best = q;
  }
  return best;
}

/**
 * Answer one message.
 *
 * @param {string} message what the user typed
 * @param {{
 *   pois: Array<Record<string, any>>,
 *   categoryLabel?: (id: string) => string,
 *   categoryIcon?: (id: string) => string,
 *   distanceOf?: (poi: any) => number | null,
 *   floorNameOf?: (poi: any) => string,
 *   sameFloor?: (poi: any) => boolean,
 *   lastOffer?: number[],
 * }} ctx
 * @returns {{ kind: string, text: string, results: Array<{ idx: number, name: string, floor: string, distance: number|null, note: string }>, navigateTo?: number, urgent?: boolean }}
 */
export function answerMessage(message, ctx) {
  const raw = normalizeText(message);
  const tokens = contentTokens(message);
  const pois = ctx.pois ?? [];

  if (!raw) {
    return reply('empty', 'Ask me where something is — “I’m hungry”, “nearest restroom”, or the name of a place.');
  }

  // ── conversational shortcuts, before any place matching ──
  if (/^(hi|hello|hey|yo|hai|namaste|good (morning|afternoon|evening))\b/.test(raw)) {
    return reply('greeting', 'Hi. Tell me what you’re after and I’ll take you there — try “I’m hungry”, “nearest restroom”, or the name of a place.');
  }
  if (/\b(thanks|thank you|thx|cheers)\b/.test(raw)) {
    return reply('thanks', 'Any time. Ask again whenever you need a direction.');
  }
  if (/\b(cancel|stop|clear|reset|nevermind|never mind)\b/.test(raw)) {
    return { kind: 'clear', text: 'Cleared the route. Where to next?', results: [] };
  }
  if (/\b(who are you|what can you do|help me|how does this work)\b/.test(raw)) {
    return reply('about', 'I find places on this map and route you to them. Ask by purpose (“I’m hungry”, “I need a toilet”, “nearest exit”) or by name (“Auditorium”). Tap a result and the route is drawn for you.');
  }

  // "yes" / "take me there" — accept the suggestion still on screen.
  if (YES_WORDS.has(raw)) {
    const offered = ctx.lastOffer ?? [];
    if (offered.length) {
      return {
        kind: 'navigate',
        text: `Routing you to ${pois[offered[0]]?.poi_name ?? 'it'} now.`,
        results: [],
        navigateTo: offered[0],
      };
    }
    return reply('none', 'Tell me where to first — for example “nearest restroom”.');
  }

  if (!pois.length) {
    return reply('none', 'This map has no destinations on it yet, so there is nothing I can route you to.');
  }

  const wantsNearest = tokens.some((t) => NEAR_WORDS.includes(t)) || raw.includes('close to me') || raw.includes('around me');
  const concepts = detectConcepts(tokens, raw);

  // Words describing the *kind* of question are not the target of the search:
  // leaving "nearest" in would score it against a place called Near Field Lab.
  const searchTokens = tokens.filter((t) => !NEAR_WORDS.includes(t) && !GENERIC_PLACE_WORDS.has(t));

  if (/\bwhere am i\b/.test(raw) || (wantsNearest && !concepts.length && !searchTokens.length)) {
    return { kind: 'nearest', ...nearestAnswer(ctx, 'The closest places to you right now:') };
  }
  if (!concepts.length && !searchTokens.length) {
    return reply('none', 'I didn’t catch a place in that. Try “I’m hungry”, “nearest toilet”, or the name of somewhere on this map.');
  }

  const index = buildIndex(pois, ctx);
  const answer = rank(index, { tokens: searchTokens, concepts, raw, wantsNearest });

  // Nothing served the intent. Some intents have a sensible neighbour — no
  // drinking fountain, but the canteen sells drinks — which beats a dead end.
  if (!answer.length && concepts.length) {
    const concept = concepts[0].concept;
    const alt = concept.fallback ? CONCEPTS_BY_ID.get(concept.fallback) : null;
    if (alt) {
      const altAnswer = rank(index, { tokens: [], concepts: [{ concept: alt }], raw: '', wantsNearest });
      if (altAnswer.length) {
        return {
          kind: 'results',
          text: concept.fallbackLead ?? alt.leadMany,
          results: altAnswer.slice(0, 4).map(toResult),
        };
      }
    }
    return reply('none', concept.none);
  }

  if (!answer.length) {
    return reply('none', `I can’t find anything matching “${String(message).trim()}” on this map. Try a purpose — food, restroom, exit, help desk — or part of a place’s name.`);
  }

  const top = answer.slice(0, 4);
  const concept = concepts[0]?.concept;
  const single = top.length === 1;
  let text;
  if (concept) text = single ? concept.lead : concept.leadMany;
  else if (single) text = `${top[0].name} — here it is.`;
  else text = `${top.length} matches. Tap one and I’ll take you there.`;

  return {
    kind: 'results',
    text,
    urgent: Boolean(concept?.urgent),
    results: top.map(toResult),
  };
}

/**
 * Score, filter and order candidates.
 *
 * The relevance floor is what keeps prose noise out: once the best answer is
 * known, anything scoring far below it is not a worse answer to the same
 * question, it is an answer to a different one.
 */
function rank(index, { tokens, concepts, raw, wantsNearest }) {
  const scored = [];
  for (const entry of index) {
    const { score, conceptNameCat, nameExact } = scorePoi(entry, { tokens, concepts, raw });
    if (score <= 0) continue;
    // An intent must be answered by somewhere that actually serves it, named
    // as such or matched exactly by name. Without this, "lift" comes back with
    // "LIFI Technology" and "Lever" — the letters line up and the description
    // mentions lifting, but neither is a lift, and a confident wrong direction
    // is worse than "there isn't one here".
    if (concepts.length && conceptNameCat <= 0 && !nameExact) continue;
    scored.push({ entry, score });
  }
  if (!scored.length) return [];

  const topScore = scored.reduce((m, s) => Math.max(m, s.score), 0);
  const floor = Math.max(topScore * 0.45, 10);

  return scored
    .filter((s) => s.score >= floor)
    .sort((a, b) => {
      // Scores within a band are treated as equally good answers, so the
      // shorter walk wins. "Nearest" widens the band so distance leads.
      const band = wantsNearest ? 25 : 5;
      const diff = Math.round(b.score / band) - Math.round(a.score / band);
      if (diff !== 0) return diff;
      if (a.entry.sameFloor !== b.entry.sameFloor) return a.entry.sameFloor ? -1 : 1;
      const aD = Number.isFinite(a.entry.distance) ? a.entry.distance : Infinity;
      const bD = Number.isFinite(b.entry.distance) ? b.entry.distance : Infinity;
      if (aD !== bD) return aD - bD;
      return b.score - a.score;
    })
    .map((s) => s.entry);
}

/** The closest handful of anything, for when the question has no subject. */
function nearestAnswer(ctx, lead) {
  const index = buildIndex(ctx.pois ?? [], ctx);
  const ranked = index
    .filter((e) => Number.isFinite(e.distance))
    .sort((a, b) => {
      if (a.sameFloor !== b.sameFloor) return a.sameFloor ? -1 : 1;
      return a.distance - b.distance;
    })
    .slice(0, 5);

  if (ranked.length) return { text: lead, results: ranked.map(toResult) };

  // Without a camera pose there is no "closest" — say so, offer the list.
  const any = index.slice(0, 5);
  return {
    text: any.length
      ? 'I don’t know where you’re standing yet, so I can’t rank by distance. Here are some places on this map:'
      : 'There are no destinations on this map yet.',
    results: any.map(toResult),
  };
}

function reply(kind, text) {
  return { kind, text, results: [] };
}

function toResult(entry) {
  return {
    idx: entry.idx,
    name: entry.name,
    floor: entry.floor,
    distance: entry.distance,
    note: entry.categoryLabel,
  };
}

/**
 * Pre-tokenized view of every POI.
 *
 * Rebuilt per message rather than cached: distance depends on where the user is
 * standing, which changes between questions, and a few hundred short string
 * splits is far cheaper than the bug of serving a stale ranking.
 */
function buildIndex(pois, ctx) {
  const out = [];
  for (let i = 0; i < pois.length; i += 1) {
    const poi = pois[i];
    const name = String(poi?.poi_name ?? '').trim() || `POI ${i + 1}`;
    const ids = categoryIdsOf(poi);
    const labels = ids.map((id) => ctx.categoryLabel?.(id) ?? '').filter(Boolean);
    const icons = ids.map((id) => ctx.categoryIcon?.(id) ?? '').filter(Boolean);
    // Long descriptions are trimmed: the first couple of sentences say what a
    // place is, the rest is exhibit copy that only adds false matches.
    const descriptionNorm = normalizeText(String(poi?.description ?? '').slice(0, 320));
    out.push({
      idx: i,
      name,
      nameNorm: normalizeText(name),
      nameTokens: contentTokens(name),
      categoryLabel: labels[0] ?? '',
      categoryNorm: normalizeText(labels.join(' ')),
      categoryTokens: contentTokens(labels.join(' ')),
      iconKeys: icons,
      descriptionNorm,
      descriptionTokens: new Set(contentTokens(descriptionNorm)),
      distance: ctx.distanceOf?.(poi) ?? null,
      floor: ctx.floorNameOf?.(poi) ?? '',
      sameFloor: ctx.sameFloor ? ctx.sameFloor(poi) !== false : true,
    });
  }
  return out;
}

function categoryIdsOf(poi) {
  if (Array.isArray(poi?.category_ids) && poi.category_ids.length) return poi.category_ids.map(String);
  return poi?.category_type ? [String(poi.category_type)] : [];
}

/** Openers offered as taps, so the first message costs no typing. */
export const QUICK_ASKS = [
  'I’m hungry',
  'Nearest restroom',
  'What’s close to me?',
  'Help desk',
  'Emergency exit',
];
