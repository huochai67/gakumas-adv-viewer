// Parser for the game's ADV script format.
//
// Every line is one command in a bracketed, space separated form:
//   [message text=... name=麻央 clip=\{"_startTime":0.8,"_duration":4.02\}]
//   [actorgroup actors=[actor id=amao body=... face=... hair=...]]
// Values are JSON objects (Unity-serialized, so quote/brace characters arrive
// backslash-escaped), nested command lists, or bare tokens. Repeated keys are
// legal (backgroundgroup emits one "backgrounds=" per entry), so every key is
// also collected into `all[key]`.

const UNESCAPE = /\\(?=["{}[\]])/g;

function scanBracketed(s, i) {
  const open = s[i];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '"') {
      j++;
      while (j < s.length && s[j] !== '"') j++;
      j++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return [s.slice(i, j + 1), j + 1];
    }
    j++;
  }
  return [s.slice(i), s.length];
}

function scanBare(s, i) {
  let j = i;
  while (j < s.length) {
    if (/\s/.test(s[j]) && /^\s+[A-Za-z_][\w-]*=/.test(s.slice(j))) break;
    j++;
  }
  return [s.slice(i, j), j];
}

function convert(raw) {
  const v = raw.replace(/\\n/g, '\n');
  if (v.startsWith('{')) {
    try { return JSON.parse(v); } catch { return v; }
  }
  if (v.startsWith('[')) return parseList(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

/**
 * A bracketed value holds either one command written inline
 * (`layouts=[actorlayout id=amao ...]`) or a sequence of bracketed commands
 * (`actors=[actor id=a ...][actor id=b ...]`). Both normalise to an array.
 */
function parseList(s) {
  const body = s.slice(1, s.endsWith(']') ? -1 : undefined);
  if (!/^\s*\[/.test(body)) return [parseCommand('[' + body + ']')];
  const out = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === '[') {
      const [inner, next] = scanBracketed(body, i);
      out.push(parseCommand(inner));
      i = next;
    } else {
      i++;
    }
  }
  return out;
}

/** Parse one "[type key=value ...]" command (brackets optional). */
export function parseCommand(str) {
  let s = str.trim();
  if (s.startsWith('[')) s = s.slice(1, s.endsWith(']') ? -1 : undefined);
  s = s.replace(UNESCAPE, '');
  const first = /^\s*([A-Za-z_][\w]*)\s*/.exec(s);
  const type = first ? first[1] : '';
  let i = first ? first[0].length : 0;
  const params = {};
  const all = {};
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const km = /^([A-Za-z_][\w-]*)=/.exec(s.slice(i));
    if (!km) { i++; continue; }
    i += km[0].length;
    const [raw, next] = (s[i] === '{' || s[i] === '[') ? scanBracketed(s, i) : scanBare(s, i);
    i = next;
    const val = convert(raw);
    params[km[1]] = val;
    (all[km[1]] = all[km[1]] || []).push(val);
  }
  return { type, params, all };
}

/** Parse a whole ADV script text into a flat command list. */
export function parseAdv(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '[') continue;
    events.push(parseCommand(t));
  }
  return events;
}

/**
 * Order the commands into a playable timeline.
 * @returns {{cues: Array, backgrounds: Map, actors: Map, duration: number}}
 */
export function buildTimeline(events) {
  const backgrounds = new Map();
  const actors = new Map();
  let duration = 0;
  const cues = events.map((ev, order) => {
    const c = ev.params.clip || {};
    const t = Number(c._startTime ?? 0);
    const dur = Number(c._duration ?? 0);
    duration = Math.max(duration, t + dur);
    if (ev.type === 'backgroundgroup') {
      for (const b of (ev.all.backgrounds || []).flat()) {
        backgrounds.set(b.params.id, { src: b.params.src });
      }
    } else if (ev.type === 'actorgroup') {
      for (const a of (ev.all.actors || []).flat()) {
        actors.set(a.params.id, {
          body: a.params.body, face: a.params.face, hair: a.params.hair,
        });
      }
    }
    return { ...ev, t, dur, clipIn: Number(c._clipIn ?? 0), order };
  });
  cues.sort((a, b) => a.t - b.t || a.order - b.order);
  return { cues, backgrounds, actors, duration };
}
