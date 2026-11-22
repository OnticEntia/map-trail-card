/**
 * map-trail-card — HA's map card plus a button to show or hide history trails,
 * with the trails cleaned up: GPS jitter collapses into one "stop" per place,
 * the legs between stops are simplified, and the line is coloured by time
 * (old to new) so the direction of travel is readable.
 *
 * Takes the same options as `type: map`. `hours_to_show` is how long a trail
 * is when trails are on. The on/off choice is remembered per browser.
 *
 *   type: custom:map-trail-card
 *   hours_to_show: 24
 *   theme_mode: dark
 *   entities: [person.example, zone.home]
 *
 * Everyone set up as a person in Home Assistant is shown, including people
 * added later; `all_people: false` limits the map to the entities listed.
 *
 * Trail options (all optional):
 *   trail_cleanup: true        false = HA's stock trails, one dot per report
 *   trail_stop_radius: 75      metres; reports this close together are one place
 *   trail_stop_minutes: 5      shortest stay that counts as a stop
 *   trail_tolerance: 20        metres; how far a simplified leg may cut corners
 *   trail_jitter_radius: 500   metres; anything this near a stop is that stop
 *   trail_max_accuracy: 150    metres; vaguer fixes never bend the line
 *   trail_zones: true          a fix inside a zone counts as at the zone's centre
 *   trail_number_home: false   true = stops at the Home zone get numbers too
 *   trail_colors: [..]         two or more hex colours, oldest first, for every
 *                              trail; "entity" = each person's own colour.
 *                              Default: blue-magenta-orange for one trail,
 *                              own colours once two people have trails
 *
 * The button sits in the map's own button column (under zoom on a panel view).
 */

const VERSION = "1.0.0";

const STORE_KEY = "map-trail-card:trails";
const ICON_ON = "mdi:map-marker-path";
const ICON_OFF = "mdi:map-marker-outline";

function loadTrails() {
  try {
    return localStorage.getItem(STORE_KEY) !== "off";
  } catch {
    return true;
  }
}

function saveTrails(on) {
  try {
    localStorage.setItem(STORE_KEY, on ? "on" : "off");
  } catch {
    /* private mode etc. — just don't remember */
  }
}

// ---- Trail clean-up: plain functions, no DOM ------------------------------

const RAD = Math.PI / 180;
const EARTH = 6371000; // metres
const MAX_SPEED = 70; // m/s; a jump faster than this is a bad fix
const TRAVEL_SPEED = 5; // m/s; slow travel, used to tell waiting from moving
const SPIKE_WINDOW = 10 * 60e3; // ms; an out-and-back this quick is a bad fix
const DEFAULT_RAMP = ["#4f8cff", "#d946ef", "#ff9f1c"]; // oldest to newest
const COLOR_STEPS = 10;

function dist(a, b) {
  const x = (b.lon - a.lon) * RAD * Math.cos(((a.lat + b.lat) / 2) * RAD);
  const y = (b.lat - a.lat) * RAD;
  return Math.sqrt(x * x + y * y) * EARTH;
}

// Drop fixes that jump impossibly fast, and single fixes that leap away from
// a place and straight back.
function dropSpikes(pts, radius) {
  const kept = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = kept[kept.length - 1];
    if (a) {
      const d = dist(a, p);
      const dt = Math.max((p.t - a.t) / 1000, 1);
      if (d > radius && d > MAX_SPEED * dt) continue;
      const c = pts[i + 1];
      if (
        c &&
        c.t - a.t <= SPIKE_WINDOW &&
        d > 2 * radius &&
        dist(p, c) > 2 * radius &&
        dist(a, c) <= radius
      ) {
        continue;
      }
    }
    kept.push(p);
  }
  return kept;
}

// A fix inside a zone (as Home Assistant judges it: the fix's accuracy circle
// touches the zone) is "at" that zone: it is moved to the zone's centre. The
// smallest matching zone wins. The reported position is kept in `raw`.
function snapZones(pts, zones) {
  if (!zones?.length) return pts;
  return pts.map((p) => {
    let hit = null;
    for (const z of zones) {
      const inside = dist(z, p) - Math.min(p.acc || 0, 200) <= z.radius;
      if (inside && (!hit || z.radius < hit.radius)) hit = z;
    }
    return hit
      ? { lat: hit.lat, lon: hit.lon, t: p.t, acc: 0, zone: hit.name, raw: p }
      : p;
  });
}

// Turn runs of fixes that stay around one spot into one stop node. A fix
// belongs to the run if its accuracy circle reaches it, so a vague fix far off
// does not end a stay; precise fixes decide where the stop is drawn. Trackers
// go quiet when still, so the time until the next fix elsewhere counts as
// part of the stay, less the time it would take to travel there.
function findStops(pts, radius, minStop, now) {
  const blur = (p) => Math.min(p.acc || 0, 1000);
  const weight = (p) => 1 / Math.max(p.acc || 0, 10) ** 2;
  const nodes = [];
  let i = 0;
  while (i < pts.length) {
    let w = weight(pts[i]);
    let lat = pts[i].lat * w;
    let lon = pts[i].lon * w;
    let best = blur(pts[i]);
    let n = 1;
    let j = i;
    let inZone = pts[i].zone ? pts[i] : null;
    while (j + 1 < pts.length) {
      const p = pts[j + 1];
      const reach = radius + blur(p) + best;
      if (dist({ lat: lat / w, lon: lon / w }, p) > reach) break;
      j++;
      if (!inZone && p.zone) inZone = p;
      const pw = weight(p);
      lat += p.lat * pw;
      lon += p.lon * pw;
      w += pw;
      best = Math.min(best, blur(p));
      n++;
    }
    // A stay that touches a zone is drawn at the zone.
    const centre = inZone
      ? { lat: inZone.lat, lon: inZone.lon, zone: inZone.zone }
      : { lat: lat / w, lon: lon / w };
    const next = pts[j + 1];
    const leftBy = next
      ? next.t - (dist(centre, next) / TRAVEL_SPEED) * 1000
      : now;
    const to = Math.max(pts[j].t, leftBy);
    if (to - pts[i].t >= minStop) {
      nodes.push({
        ...centre,
        t: pts[i].t,
        stop: { from: pts[i].t, to: next ? to : null, n },
      });
      i = j + 1;
    } else {
      const p = pts[i].raw ?? pts[i];
      nodes.push({ lat: p.lat, lon: p.lon, t: p.t, acc: p.acc });
      i++;
    }
  }
  return nodes;
}

// Everything within `reach` of a stop is that stop: wandering fixes around it
// are dropped and other "stops" there are folded in, the longest stay deciding
// where it is drawn unless one of them is a zone. A quick leap further out
// and back is folded in too.
function mergeStops(nodes, reach, now) {
  const out = [];
  const span = (s) => Math.max(60e3, (s.stop.to ?? now) - s.stop.from);
  for (const node of nodes) {
    if (!node.stop) {
      const prev = out[out.length - 1];
      if (prev?.stop && dist(prev, node) <= reach) {
        prev.stop.to = Math.max(prev.stop.to, node.t);
      } else {
        out.push(node);
      }
      continue;
    }
    while (
      out.length &&
      !out[out.length - 1].stop &&
      dist(node, out[out.length - 1]) <= reach
    ) {
      out.pop();
    }
    let merged = false;
    let seen = 0;
    for (let k = out.length - 1; k >= 0 && seen < 3 && !merged; k--) {
      const prev = out[k];
      if (!prev.stop) continue;
      seen++;
      if (dist(prev, node) > reach) continue;
      if (prev.zone && node.zone && prev.zone !== node.zone) continue;
      const between = out.slice(k + 1);
      const stayedNear = between.every((m) => dist(prev, m) <= reach);
      const brief =
        between.length <= 3 &&
        node.stop.from - prev.stop.to <= 1.5 * SPIKE_WINDOW &&
        between.every((m) => !m.stop || dist(prev, m) <= reach);
      if (!stayedNear && !brief) continue;
      if (!prev.zone && node.zone) {
        prev.lat = node.lat;
        prev.lon = node.lon;
        prev.zone = node.zone;
      } else if (!prev.zone) {
        const a = span(prev);
        const b = span(node);
        prev.lat = (prev.lat * a + node.lat * b) / (a + b);
        prev.lon = (prev.lon * a + node.lon * b) / (a + b);
      }
      prev.stop.to = node.stop.to;
      prev.stop.n += node.stop.n;
      out.length = k + 1;
      merged = true;
    }
    if (!merged) out.push(node);
  }
  return out;
}

function offLine(p, a, b) {
  const kx = RAD * Math.cos(a.lat * RAD) * EARTH;
  const ky = RAD * EARTH;
  const bx = (b.lon - a.lon) * kx;
  const by = (b.lat - a.lat) * ky;
  const px = (p.lon - a.lon) * kx;
  const py = (p.lat - a.lat) * ky;
  const len2 = bx * bx + by * by;
  const f = len2 ? Math.min(1, Math.max(0, (px * bx + py * by) / len2)) : 0;
  return Math.hypot(px - f * bx, py - f * by);
}

// Douglas-Peucker on each leg between stops; stops and both ends always stay.
function simplify(nodes, tolerance) {
  const last = nodes.length - 1;
  if (last < 2) return nodes;
  const keep = nodes.map((n, i) => i === 0 || i === last || Boolean(n.stop));
  let from = 0;
  for (let to = 1; to <= last; to++) {
    if (!keep[to]) continue;
    const stack = [[from, to]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let worst = 0;
      let at = -1;
      for (let k = a + 1; k < b; k++) {
        const d = offLine(nodes[k], nodes[a], nodes[b]);
        if (d > worst) {
          worst = d;
          at = k;
        }
      }
      if (at >= 0 && worst > tolerance) {
        keep[at] = true;
        stack.push([a, at], [at, b]);
      }
    }
    from = to;
  }
  return nodes.filter((_, i) => keep[i]);
}

// points: [{lat, lon, t, acc?}] (t in ms, acc = reported accuracy in metres).
// Returns nodes in time order; a node with `stop: {from, to, n}` is a place
// stayed at (`to` null = still there).
function cleanTrail(points, opts, now) {
  const pts = points
    .filter(
      (p) =>
        Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.t)
    )
    .sort((a, b) => a.t - b.t);
  const stops = findStops(
    dropSpikes(snapZones(pts, opts.zones), opts.radius),
    opts.radius,
    opts.minStop,
    now
  );
  const reach = Math.max(opts.reach ?? 0, opts.radius);
  // A vague fix between stops would only add a zigzag to the line.
  const sure = mergeStops(stops, reach, now).filter(
    (n) => n.stop || !(n.acc > (opts.maxAccuracy ?? Infinity))
  );
  return simplify(sure, opts.tolerance);
}

// Hex or rgb()/rgba() text to [r, g, b]; null for anything else.
function parseColor(text) {
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(String(text).trim());
  return m ? [+m[1], +m[2], +m[3]] : parseHex(text);
}

function parseHex(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

// f in 0..1 along a list of [r, g, b] stops.
function rampColor(ramp, f) {
  const x = Math.min(1, Math.max(0, f)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const c = ramp[i].map((v, k) => Math.round(v + (ramp[i + 1][k] - v) * (x - i)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
}

function formatDuration(ms) {
  const min = Math.max(1, Math.round(ms / 60e3));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

// ---- The card -------------------------------------------------------------

// How many frames to wait for the map to render its button column (~5 s).
const MAX_ATTACH_TRIES = 300;

class MapTrailCard extends HTMLElement {
  static getStubConfig(hass) {
    const located = Object.keys(hass?.states ?? {}).filter((id) => {
      const attrs = hass.states[id].attributes;
      return attrs.latitude != null && attrs.longitude != null;
    });
    const people = located.filter((id) => id.startsWith("person."));
    const trackers = located.filter((id) => id.startsWith("device_tracker."));
    const moving = people.length ? people : trackers;
    const zones = located.filter((id) => id === "zone.home");
    return {
      type: "custom:map-trail-card",
      hours_to_show: 24,
      entities: [...moving.slice(0, 3), ...zones],
    };
  }

  setConfig(config) {
    this._config = { hours_to_show: 24, ...config };
    this._trails = loadTrails();
    if (this._helpers) this._render();
  }

  set hass(hass) {
    const wasDark = this._hass?.themes?.darkMode;
    this._hass = hass;
    if (this._map) {
      this._map.hass = hass;
      if (wasDark !== hass?.themes?.darkMode) this._styleButton();
      // The entity registry only changes when something is added or removed,
      // so that is the moment to look for a new person.
      if (hass?.entities !== this._registry) {
        this._registry = hass?.entities;
        if (this._people().join() !== this._peopleKey) this._render();
      }
    } else {
      this._init();
    }
  }

  // Passed down so the map lays itself out as a full-screen panel.
  set layout(v) {
    this._layout = v;
    if (this._map) this._map.layout = v;
  }
  get layout() {
    return this._layout;
  }
  set isPanel(v) {
    this._isPanel = v;
    if (this._map) this._map.isPanel = v;
  }
  get isPanel() {
    return this._isPanel;
  }

  getCardSize() {
    return this._map?.getCardSize?.() ?? 7;
  }

  getGridOptions() {
    return this._map?.getGridOptions?.() ?? { columns: "full", rows: 6 };
  }

  // A failure leaves the card blank but retries on the next hass update.
  async _init() {
    if (this._initing) return;
    this._initing = true;
    try {
      this._helpers = await window.loadCardHelpers();
    } catch (err) {
      this._initing = false;
      if (!this._warnedHelpers) {
        this._warnedHelpers = true;
        console.warn("map-trail-card: could not load card helpers", err);
      }
      return;
    }
    this._render();
  }

  // The map only reads hours_to_show when it starts, so a toggle builds a
  // fresh map card.
  _render() {
    if (!this._config || !this._helpers) return;
    const root = this.shadowRoot || this.attachShadow({ mode: "open" });
    if (!root.querySelector("style")) {
      root.innerHTML = `<style>
        :host { display: block; height: 100%; }
        :host > * { height: 100%; }
      </style>`;
    }
    const { type, all_people, ...all } = this._config;
    const rest = Object.fromEntries(
      Object.entries(all).filter(([key]) => !key.startsWith("trail_"))
    );
    const people = this._people();
    this._peopleKey = people.join();
    this._registry = this._hass?.entities;
    const listed = Array.isArray(rest.entities) ? rest.entities : [];
    const have = new Set(listed.map((e) => (typeof e === "string" ? e : e?.entity)));
    rest.entities = [...listed, ...people.filter((id) => !have.has(id))];
    this._haMap = null;
    this._trailHandles = [];
    this._drawnOn = null;
    const map = this._helpers.createCardElement({
      ...rest,
      type: "map",
      hours_to_show: this._trails ? this._config.hours_to_show : 0,
    });
    // Until HA has loaded the map card's code, createCardElement hands back a
    // placeholder and fires ll-rebuild on it when the real card is ready.
    map.addEventListener("ll-rebuild", (ev) => {
      ev.stopPropagation();
      if (this._map === map) this._render();
    });
    if (this._layout !== undefined) map.layout = this._layout;
    if (this._isPanel !== undefined) map.isPanel = this._isPanel;
    if (this._hass) map.hass = this._hass;
    if (this._map) this._map.replaceWith(map);
    else root.appendChild(map);
    this._map = map;
    this._watchButtons();
  }

  // Every person in Home Assistant, unless all_people is off. They are added
  // to the map after the entities the config lists.
  _people() {
    if (this._config?.all_people === false) return [];
    return Object.keys(this._hass?.states ?? {})
      .filter((id) => id.startsWith("person."))
      .sort();
  }

  _toggle() {
    this._trails = !this._trails;
    saveTrails(this._trails);
    this._render();
  }

  // Same rule the map uses for its own buttons: white on a dark map.
  _isDark() {
    const mode = this._config?.theme_mode ?? "auto";
    if (mode === "dark") return true;
    if (mode === "light") return false;
    return Boolean(this._hass?.themes?.darkMode);
  }

  _styleButton() {
    const btn = this._map?.shadowRoot?.querySelector("#buttons .trail-toggle");
    if (!btn) return;
    btn.style.color = this._trails
      ? "var(--primary-color)"
      : this._isDark() ? "#ffffff" : "#000000";
  }

  // True once the map's button column exists and holds the toggle.
  _attachButton() {
    this._hookMap();
    const buttons = this._map?.shadowRoot?.querySelector("#buttons");
    if (!buttons) return false;
    if (!buttons.querySelector(".trail-toggle")) {
      const btn = document.createElement("ha-icon-button");
      btn.className = "trail-toggle";
      const icon = document.createElement("ha-icon");
      icon.icon = this._trails ? ICON_ON : ICON_OFF;
      btn.appendChild(icon);
      btn.label = this._trails ? "Hide trails" : "Show trails";
      btn.title = btn.label;
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._toggle();
      });
      buttons.appendChild(btn);
      this._styleButton();
    }
    return true;
  }

  _warnOnce(message, err) {
    if (this._warned?.has(message)) return;
    (this._warned ??= new Set()).add(message);
    console.warn(`map-trail-card: ${message}`, err ?? "");
  }

  // Take over trail drawing from the inner <ha-map>. It calls _drawPaths
  // whenever trails need (re)drawing: new history, map engine ready, theme
  // change. If its internals ever change shape, the stock trails stay.
  _hookMap() {
    if (this._config.trail_cleanup === false) return;
    const haMap = this._map?.shadowRoot?.querySelector("ha-map");
    if (!haMap || haMap === this._haMap) return;
    this._haMap = haMap;
    if (typeof haMap._drawPaths !== "function") {
      this._warnOnce("the map's trail drawing changed; showing stock trails");
      return;
    }
    const stock = haMap._drawPaths.bind(haMap);
    haMap._drawPaths = () => {
      if (!this._drawTrails(haMap)) stock();
    };
    // A tap anywhere else on the map closes a pinned stop tooltip.
    haMap.addEventListener?.("click", () => this._closeTip());
    haMap._drawPaths();
  }

  _clearTrails(engine) {
    // Handles on a replaced engine died with it.
    if (this._drawnOn === engine) {
      for (const handle of this._trailHandles ?? []) {
        try {
          handle.remove();
        } catch {
          /* already gone */
        }
      }
    }
    this._trailHandles = [];
    this._openTip = null;
    this._drawnOn = engine;
  }

  // False = could not draw; let the map draw its stock trails.
  _drawTrails(haMap) {
    const engine = haMap._engine;
    this._clearTrails(engine);
    if (!engine) return true; // the map draws again once its engine is up
    if (
      typeof engine.addPath !== "function" ||
      typeof engine.addMarker !== "function"
    ) {
      this._warnOnce("the map engine changed; showing stock trails");
      return false;
    }
    try {
      if (Array.isArray(haMap._pathHandles)) {
        haMap._pathHandles.splice(0).forEach((handle) => handle.remove());
      }
      const now = Date.now();
      const inputs = this._trailInputs(haMap);
      const several = inputs.filter((input) => input.points.length).length > 1;
      for (const { path, points } of inputs) {
        this._drawTrail(engine, path, points, now, several);
      }
      return true;
    } catch (err) {
      this._clearTrails(engine);
      this._warnOnce("could not draw cleaned trails; showing stock trails", err);
      return false;
    }
  }

  // The map's paths carry only position and time. The map card's own history
  // also has each fix's accuracy, so use that when the two line up.
  _trailInputs(haMap) {
    const paths = haMap.paths ?? [];
    const history = this._map?._stateHistory;
    let ids = null;
    if (history && typeof history === "object") {
      ids = Object.keys(history).filter(
        (id) => !id.startsWith("zone.") && history[id]?.length
      );
      if (ids.length !== paths.length) ids = null;
    }
    return paths.map((path, i) => {
      const plain = (path.points ?? []).map((p) => ({
        lat: p.point?.[0],
        lon: p.point?.[1],
        t: +p.timestamp,
      }));
      if (!ids) return { path, points: plain };
      const rich = history[ids[i]]
        .filter((s) => s.a?.latitude && s.a?.longitude)
        .map((s) => ({
          lat: s.a.latitude,
          lon: s.a.longitude,
          t: s.lu * 1000,
          acc: Number(s.a.gps_accuracy) || 0,
        }));
      return { path, points: rich.length === plain.length ? rich : plain };
    });
  }

  _zones() {
    const zones = [];
    for (const [id, state] of Object.entries(this._hass?.states ?? {})) {
      if (!id.startsWith("zone.")) continue;
      const a = state.attributes;
      if (a.passive) continue;
      const zone = {
        name: a.friendly_name ?? id.slice(5),
        home: id === "zone.home",
        lat: Number(a.latitude),
        lon: Number(a.longitude),
        radius: Number(a.radius),
      };
      if ([zone.lat, zone.lon, zone.radius].every(Number.isFinite)) zones.push(zone);
    }
    return zones;
  }

  _trailOptions() {
    const num = (value, fallback) =>
      Number.isFinite(Number(value)) && Number(value) > 0
        ? Number(value)
        : fallback;
    const c = this._config;
    const colors = Array.isArray(c.trail_colors)
      ? c.trail_colors.map(parseHex)
      : null;
    return {
      radius: num(c.trail_stop_radius, 75),
      minStop: num(c.trail_stop_minutes, 5) * 60e3,
      tolerance: num(c.trail_tolerance, 20),
      reach: num(c.trail_jitter_radius, 500),
      zones: c.trail_zones === false ? [] : this._zones(),
      maxAccuracy: num(c.trail_max_accuracy, 150),
      // "list" = the configured colours for everyone, "entity" = each
      // person's own colour, "auto" = own colours once there are two trails.
      colorMode:
        colors && colors.length >= 2 && colors.every(Boolean)
          ? "list"
          : c.trail_colors === "entity"
            ? "entity"
            : "auto",
      ramp:
        colors && colors.length >= 2 && colors.every(Boolean)
          ? colors
          : DEFAULT_RAMP.map(parseHex),
    };
  }

  _formatTime(ms) {
    const date = new Date(ms);
    const locale = this._hass?.locale;
    const options = { hour: "numeric", minute: "2-digit" };
    if (locale?.time_format === "12") options.hourCycle = "h12";
    if (locale?.time_format === "24") options.hourCycle = "h23";
    if (locale?.time_zone === "server" && this._hass?.config?.time_zone) {
      options.timeZone = this._hass.config.time_zone;
    }
    if (date.toDateString() !== new Date().toDateString()) {
      options.weekday = "short";
    }
    try {
      return new Intl.DateTimeFormat(locale?.language, options).format(date);
    } catch {
      return date.toLocaleString();
    }
  }

  // One line of a stop's tooltip: when this visit was.
  _visitLine(node, isFirst, now) {
    const { from, to } = node.stop;
    if (to === null) {
      return isFirst
        ? `Here for over ${formatDuration(now - from)}`
        : `Here since ${this._formatTime(from)}`;
    }
    if (isFirst) return `Trail start, left about ${this._formatTime(to)}`;
    return (
      `${this._formatTime(from)} – ${this._formatTime(to)} ` +
      `(about ${formatDuration(to - from)})`
    );
  }

  // A ring drawn over a stop; bigger = stayed longer. Dashed = trail start.
  // The border is the person's own colour, the fill the colour of the line there.
  // Hover shows the times; a tap or click pins them until the next tap.
  _ring(engine, node, px, color, dashed, border, label, tipHtml) {
    const el = document.createElement("div");
    const [ink, halo] = this._isDark() ? ["#fff", "#000"] : ["#000", "#fff"];
    el.style.cssText =
      `box-sizing:border-box;border-radius:50%;cursor:pointer;` +
      `border:2px ${dashed ? "dashed" : "solid"} ${border || color};` +
      `background:color-mix(in srgb, ${color} 22%, transparent);` +
      `display:flex;align-items:center;justify-content:center;` +
      `white-space:nowrap;font:700 11px/1 sans-serif;color:${ink};` +
      `text-shadow:0 0 2px ${halo},0 0 2px ${halo},0 0 3px ${halo};`;
    el.textContent = label;

    const tip = document.createElement("div");
    tip.style.cssText =
      `position:absolute;bottom:calc(100% + 6px);left:50%;` +
      `transform:translateX(-50%);display:none;pointer-events:none;` +
      `padding:6px 8px;border-radius:6px;background:rgba(0,0,0,.85);` +
      `color:#fff;text-shadow:none;text-align:center;white-space:nowrap;` +
      `font:400 12px/1.4 var(--ha-font-family-body, sans-serif);`;
    tip.innerHTML = tipHtml;
    el.appendChild(tip);

    const show = (on) => {
      tip.style.display = on ? "block" : "none";
      // Lift the open ring above its neighbours (Leaflet wraps it in an icon).
      const wrap = el.parentElement?.classList?.contains("leaflet-marker-icon")
        ? el.parentElement
        : el;
      wrap.style.zIndex = on ? "10000" : "";
    };
    const tipState = { show, pinned: false };
    el.addEventListener("mouseenter", () => show(true));
    el.addEventListener("mouseleave", () => tipState.pinned || show(false));
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const pin = !tipState.pinned;
      this._closeTip();
      tipState.pinned = pin;
      show(pin);
      if (pin) this._openTip = tipState;
    });

    this._trailHandles.push(
      engine.addMarker(el, [node.lat, node.lon], {
        size: [px, px],
        interactive: true,
        focusable: false,
      })
    );
  }

  _closeTip() {
    if (!this._openTip) return;
    this._openTip.pinned = false;
    this._openTip.show(false);
    this._openTip = null;
  }

  _drawTrail(engine, path, points, now, several) {
    const opts = this._trailOptions();
    // With several people, each line runs from a pale tint of that person's
    // marker colour (dark tint on a light map) to the full colour.
    let ramp = opts.ramp;
    const own = parseColor(path.color);
    if (own && (opts.colorMode === "entity" || (opts.colorMode === "auto" && several))) {
      const [toward, share] = this._isDark() ? [255, 0.75] : [0, 0.6];
      ramp = [own.map((v) => Math.round(v + (toward - v) * share)), own];
    }
    const nodes = cleanTrail(points, opts, now);
    if (!nodes.length) return;
    const name = path.name ?? "";
    // Number the stops in visit order. Visits to the same place share one
    // ring, so going home twice reads "1·4" on one ring, not two stacked.
    const reach = Math.max(opts.reach, opts.radius);
    const places = [];
    const homeName =
      this._config.trail_number_home === true
        ? null
        : opts.zones.find((zone) => zone.home)?.name;
    let visitNo = 0;
    nodes.forEach((node, i) => {
      if (!node.stop) return;
      let place = places.find((g) =>
        g.zone && node.zone ? g.zone === node.zone : dist(g, node) <= reach
      );
      if (!place) {
        place = { lat: node.lat, lon: node.lon, zone: node.zone, visits: [] };
        places.push(place);
      } else if (!place.zone && node.zone) {
        Object.assign(place, { lat: node.lat, lon: node.lon, zone: node.zone });
        for (const visit of place.visits) {
          visit.node.lat = place.lat;
          visit.node.lon = place.lon;
        }
      }
      node.lat = place.lat;
      node.lon = place.lon;
      // Home is where trails start and end; it needs no number.
      const atHome = Boolean(homeName) && place.zone === homeName;
      place.visits.push({ no: atHome ? null : ++visitNo, node, i });
    });
    // Colour runs along the distance travelled, so every leg shows its
    // direction however long the stops between legs were.
    const travelled = [0];
    for (let i = 1; i < nodes.length; i++) {
      travelled.push(travelled[i - 1] + dist(nodes[i - 1], nodes[i]));
    }
    const total = Math.max(1, travelled[travelled.length - 1]);
    const step = (f) => Math.min(COLOR_STEPS - 1, Math.floor(f * COLOR_STEPS));
    const style = (q) => {
      const f = (q + 0.5) / COLOR_STEPS;
      return { color: rampColor(ramp, f), opacity: 0.9 };
    };
    // One engine path per colour step.
    const steps = new Map();
    const bucket = (q) => {
      if (!steps.has(q)) steps.set(q, { segments: [], markers: [], tail: null });
      return steps.get(q);
    };

    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];
      const fa = travelled[i] / total;
      const fb = travelled[i + 1] / total;
      if (fb <= fa) continue;
      const at = (f) => {
        if (f === fa) return a;
        if (f === fb) return b;
        const u = (f - fa) / (fb - fa);
        return { lat: a.lat + (b.lat - a.lat) * u, lon: a.lon + (b.lon - a.lon) * u };
      };
      // Cut the leg wherever the colour changes.
      for (let q = step(fa); q <= step(fb); q++) {
        const f1 = Math.max(fa, q / COLOR_STEPS);
        const f2 = Math.min(fb, (q + 1) / COLOR_STEPS);
        if (f2 <= f1) continue;
        const p1 = at(f1);
        const p2 = at(f2);
        const group = bucket(q);
        if (group.tail === p1) {
          group.segments[group.segments.length - 1].points.push([p2.lat, p2.lon]);
        } else {
          group.segments.push({
            points: [[p1.lat, p1.lon], [p2.lat, p2.lon]],
            opacity: style(q).opacity,
          });
        }
        group.tail = p2;
      }
    }

    // A trail that starts on the move gets a small dashed ring there.
    if (!nodes[0].stop) {
      const tip = `${escapeHtml(name)}<br>Trail start<br>${this._formatTime(nodes[0].t)}`;
      this._ring(engine, nodes[0], 16, style(0).color, true, path.color, "", tip);
    }

    for (const place of places) {
      const latest = place.visits[place.visits.length - 1];
      const q = step(travelled[latest.i] / total);
      const { color } = style(q);
      const minutes = place.visits.reduce(
        (sum, v) => sum + ((v.node.stop.to ?? now) - v.node.stop.from) / 60e3,
        0
      );
      const px = Math.round(2 * Math.min(20, 10 + 2.2 * Math.log2(1 + minutes / 15)));
      const numbers = place.visits.map((v) => v.no).filter(Boolean);
      const label =
        numbers.length > 2
          ? `${numbers[0]}·${numbers[1]}+${numbers.length - 2}`
          : numbers.join("·");
      const lines = [escapeHtml(name)];
      if (place.zone) lines.push(`At ${escapeHtml(place.zone)}`);
      for (const v of place.visits) {
        const line = this._visitLine(v.node, v.i === 0, now);
        lines.push(v.no ? `<b>${v.no}</b> · ${line}` : line);
      }
      this._ring(
        engine,
        place,
        px,
        color,
        place.visits[0].i === 0,
        path.color,
        label,
        lines.join("<br>")
      );
    }

    for (const [q, group] of steps) {
      this._trailHandles.push(
        engine.addPath({
          color: style(q).color,
          segments: group.segments,
          markers: group.markers,
        })
      );
    }
  }

  _stopWatching() {
    if (this._raf != null) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._buttonObserver?.disconnect();
    this._buttonObserver = null;
  }

  // Put the toggle into the map's own button column, and put it back if the
  // map re-renders that column. Only waits while this card is on the page and
  // the inner element really is the map (not an error or placeholder card).
  _watchButtons() {
    this._stopWatching();
    if (!this.isConnected || this._map?.localName !== "hui-map-card") return;
    const map = this._map;
    let tries = 0;
    const tryAttach = () => {
      this._raf = null;
      if (!this.isConnected || this._map !== map) return;
      if (this._attachButton()) {
        this._buttonObserver = new MutationObserver(() => this._attachButton());
        this._buttonObserver.observe(map.shadowRoot, {
          childList: true,
          subtree: true,
        });
        return;
      }
      if (++tries > MAX_ATTACH_TRIES) {
        console.warn(
          "map-trail-card: the map's button column (#buttons) never appeared; no trail toggle shown"
        );
        return;
      }
      this._raf = requestAnimationFrame(tryAttach);
    };
    tryAttach();
  }

  disconnectedCallback() {
    this._stopWatching();
  }

  connectedCallback() {
    if (this._map) this._watchButtons();
  }
}

// Exposed for tests.
MapTrailCard.version = VERSION;
MapTrailCard.trailMaths = { cleanTrail, dist, rampColor, parseHex, parseColor, formatDuration };

if (!customElements.get("map-trail-card")) {
  customElements.define("map-trail-card", MapTrailCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "map-trail-card")) {
  window.customCards.push({
    type: "map-trail-card",
    name: "Map with trail toggle",
    description:
      "The map card with a button to show or hide movement trails, cleaned up into stops and direction of travel.",
    preview: true,
    documentationURL: "https://github.com/OnticEntia/map-trail-card",
  });
}

console.info(
  `%c MAP-TRAIL-CARD %c v${VERSION} `,
  "color: white; background: #4f8cff; font-weight: 700;",
  "color: #4f8cff; background: white; font-weight: 700;"
);
