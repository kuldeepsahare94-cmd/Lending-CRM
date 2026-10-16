/* ---------------------------------------------------------------------------
   Per-record avatar colours.

   Deliberately NOT the module accent. Module identity is already carried by
   the header icon, the KPI tiles, the table header band and the page
   background tint — four places. Repeating it on every avatar adds nothing
   and costs something real: when every row's chip is the same blue, the
   chip stops helping you tell rows apart, which is most of what an avatar
   is for in a list.

   The colour is derived from the record's own name, so it is:
     - stable    — the same record is always the same colour, on every page
     - spread    — twelve hues far enough apart to be distinguishable
     - free      — no storage, no extra field, no API change

   Used by both the list chip and the record-detail avatar, so a record
   looks the same in both places.
   --------------------------------------------------------------------------- */

const AVATAR_GRADIENTS = [
  ['#F472B6', '#BE185D'], // pink
  ['#818CF8', '#4338CA'], // indigo
  ['#34D399', '#047857'], // emerald
  ['#FBBF24', '#B45309'], // amber
  ['#60A5FA', '#1D4ED8'], // blue
  ['#FB7185', '#BE123C'], // rose
  ['#2DD4BF', '#0F766E'], // teal
  ['#C084FC', '#7C3AED'], // violet
  ['#FB923C', '#C2410C'], // orange
  ['#38BDF8', '#0369A1'], // sky
  ['#A3E635', '#4D7C0F'], // lime
  ['#F0ABFC', '#A21CAF'], // fuchsia
];

// A simple deterministic string hash. Not cryptographic — it only needs to
// spread names evenly across the palette and give the same answer every
// time for the same input.
function hashOf(value) {
  const label = String(value || '').trim();
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) {
    hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function avatarPair(name) {
  return AVATAR_GRADIENTS[hashOf(name) % AVATAR_GRADIENTS.length];
}

export function avatarGradientFor(name) {
  const [from, to] = avatarPair(name);
  return `linear-gradient(135deg, ${from}, ${to})`;
}

export function initialsOf(name) {
  return String(name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0]).join('').toUpperCase() || '?';
}
