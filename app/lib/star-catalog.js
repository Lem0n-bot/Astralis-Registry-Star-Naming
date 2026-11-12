/**
 * Server-side star catalogue — the same 38,000 stars the galaxy explorer shows,
 * resolvable by catalogue id.
 *
 * WHY THIS CAN EXIST AT ALL: nothing about a star is stored. Every position is
 * derived from `h1(i, salt)` (a deterministic hash of the star's index) with no
 * `Math.random()` anywhere, and every attribute comes from `starInfo(i, pos)`.
 * So the whole catalogue is a pure function of the index and is reproducible
 * here with no database and no Three.js.
 *
 * WHY IT EXTRACTS RATHER THAN REIMPLEMENTS: these coordinates get printed on a
 * certificate a customer pays for, so a second copy of the maths that silently
 * drifted from the explorer would put a star at the wrong address. The
 * generators are therefore sliced straight out of public/index.html — the same
 * single-source-of-truth approach ./cert-template.js already uses — and the
 * only thing supplied here is a tiny stand-in for the one browser dependency
 * they touch, THREE.Vector3. If a marker below ever stops matching, this throws
 * loudly at the first call rather than quietly inventing numbers.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const STAR_COUNT = 38000; // must match N in buildGalaxy()
const ID_STRIDE = 7919; // id = 'AST-' + (100000 + (i * 7919) % 900000)
const ID_MOD = 900000;
const ID_BASE = 100000;
/** Modular inverse of 7919 mod 900000 (7919 is prime, so they are coprime).
 *  Because STAR_COUNT < ID_MOD the map index -> id is injective, which makes
 *  this inverse an exact, collision-free id -> index lookup. */
const ID_STRIDE_INV = 517679;
/** The star-map seed the live cart sends: `seed: s.gi % 89` in currentCertData(). */
const SEED_MOD = 89;

/** Minimal stand-in for the only browser API the extracted generators use. */
class Vec3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  distanceTo(v) {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }
}

let _gen = null;

/** Slice `from` (inclusive) up to `to` (exclusive) out of the site source. */
function between(src, from, to, what) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`star-catalog: could not find "${from}" in public/index.html (${what})`);
  const b = src.indexOf(to, a + from.length);
  if (b < 0) throw new Error(`star-catalog: could not find "${to}" after "${from}" (${what})`);
  return src.slice(a, b);
}

/**
 * Build the catalogue functions once per process by evaluating the explorer's
 * own generator source. Compiled with `new Function` so the extracted code runs
 * verbatim, with `THREE` bound to the shim above.
 */
function generators() {
  if (_gen) return _gen;
  const src = readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

  // CONSTELLATIONS + CONST_INFO + SPECTRAL + SECTORS + h1 + galaxy constants +
  // EARTH_POS + LY_PER_UNIT + starInfo. One contiguous block in the source.
  const tables = between(src, 'const CONSTELLATIONS=[', 'const EXP={', 'star tables + starInfo');

  // The position formula, lifted out of buildGalaxy()'s loop body.
  const posBody = between(
    src,
    'const arm=i%ARMS',
    'pos[i*3]=x;pos[i*3+1]=y;pos[i*3+2]=z;',
    'galaxy position formula'
  );

  const factory = new Function(
    'THREE',
    `${tables}
    const ARMS = 3, RMAX = GALAXY_RMAX, TWIST = GALAXY_TWIST;
    function positionOf(i) {
      ${posBody}
      return new THREE.Vector3(x, y, z);
    }
    return { starInfo, positionOf, CONSTELLATIONS };`
  );

  _gen = factory({ Vector3: Vec3 });
  if (typeof _gen.starInfo !== 'function' || typeof _gen.positionOf !== 'function') {
    throw new Error('star-catalog: extracted generators did not compile');
  }
  return _gen;
}

/** Catalogue id for a star index, identical to the explorer's. */
export function idForIndex(i) {
  return 'AST-' + String(ID_BASE + (i * ID_STRIDE) % ID_MOD);
}

/**
 * Index for a catalogue id, or -1 when the id is malformed or outside the
 * catalogue. Accepts `AST-660055`, `ast-660055` and a bare `660055`.
 */
export function indexForId(id) {
  const m = String(id || '').trim().toUpperCase().match(/^(?:AST-)?(\d{6})$/);
  if (!m) return -1;
  const n = parseInt(m[1], 10) - ID_BASE;
  if (n < 0 || n >= ID_MOD) return -1;
  const i = (n * ID_STRIDE_INV) % ID_MOD;
  return i < STAR_COUNT ? i : -1;
}

/**
 * Full record for a catalogue id, shaped exactly like the `star` object the live
 * cart sends to checkout (see currentCertData() in public/index.html), so an
 * admin-issued certificate is indistinguishable from a purchased one.
 * @returns {{id:string,ra:string,dec:string,cons:string,mag:string,sec:string,cls:string,status:string,seed:number,index:number}|null}
 */
export function starFromId(id) {
  const i = indexForId(id);
  if (i < 0) return null;
  const { starInfo, positionOf, CONSTELLATIONS } = generators();
  const info = starInfo(i, positionOf(i));
  return {
    id: info.id,
    ra: info.ra,
    dec: info.dec,
    cons: (CONSTELLATIONS[info.ci] && CONSTELLATIONS[info.ci][0]) || '—',
    mag: info.mag,
    sec: info.sec,
    cls: info.spec, // the cart maps info.spec -> star.cls
    status: info.status, // available | reserved | featured
    seed: i % SEED_MOD,
    index: i,
  };
}

export { STAR_COUNT };
