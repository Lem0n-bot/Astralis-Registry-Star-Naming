/**
 * Product catalogue + order validation. No SDK imports — this is the pure,
 * security-critical logic (prices + input validation) and is unit-testable on
 * its own. Prices live ONLY here: the client never sends amounts, so a tampered
 * cart can never change what is charged.
 */
export const CURRENCY = 'aud';

/** Server-side price catalogue, in cents. The single source of truth. */
export const PACKAGES = {
  standard: { name: 'Standard Package', priceCents: 3900, desc: 'Digital certificate · instant delivery' },
  premium: { name: 'Premium Package', priceCents: 7900, desc: 'Printed certificate · luxury folder · star map' },
  ultimate: { name: 'Ultimate Gift Package', priceCents: 13900, desc: 'Framed · gift box · priority' },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
const MAX_ITEMS = 20;

const STR = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

/**
 * @typedef {{id:string,ra:string,dec:string,cons:string,mag:string,cls:string,sec:string}} Star
 * @typedef {{pkg:string,priceCents:number,name:string,recip:string,occ:string,msg:string,theme:'midnight'|'ivory',cons:string,star:Star}} OrderItem
 * @typedef {{address1:string,address2:string,suburb:string,city:string,state:string,postcode:string,phone:string,email:string,country:'Australia'}} Delivery
 * @typedef {{email:string,items:OrderItem[],delivery:Delivery,totalCents:number,currency:string}} ValidatedOrder
 */

/**
 * Validate and normalise an order payload from the client.
 * Returns {ok:true, order} or {ok:false, error} — never throws.
 * @returns {{ok:true, order:ValidatedOrder}|{ok:false, error:string}}
 */
export function validateOrderInput(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_body' };

  const rawItems = Array.isArray(body.items) ? body.items : null;
  if (!rawItems || rawItems.length === 0) return { ok: false, error: 'empty_cart' };
  if (rawItems.length > MAX_ITEMS) return { ok: false, error: 'too_many_items' };

  const email = STR(body.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' };

  const d = body.delivery && typeof body.delivery === 'object' ? body.delivery : {};
  const delivery = {
    address1: STR(d.address1, 120),
    address2: STR(d.address2, 120),
    suburb: STR(d.suburb, 80),
    city: STR(d.city, 80),
    state: STR(d.state, 8).toUpperCase(),
    postcode: STR(d.postcode, 8),
    phone: STR(d.phone, 40),
    email,
    country: 'Australia',
  };
  if (!delivery.address1) return { ok: false, error: 'missing_address' };
  if (!delivery.suburb || !delivery.city) return { ok: false, error: 'missing_locality' };
  if (!AU_STATES.includes(delivery.state)) return { ok: false, error: 'invalid_state' };
  if (!/^\d{4}$/.test(delivery.postcode)) return { ok: false, error: 'invalid_postcode' };
  if (!delivery.phone) return { ok: false, error: 'missing_phone' };

  const items = [];
  let totalCents = 0;
  for (const it of rawItems) {
    if (!it || typeof it !== 'object') return { ok: false, error: 'invalid_item' };
    const pkg = STR(it.pkg, 20);
    if (!PACKAGES[pkg]) return { ok: false, error: 'invalid_package' };
    const priceCents = PACKAGES[pkg].priceCents;
    totalCents += priceCents;
    const cons = STR(it.cons, 40);
    items.push({
      pkg,
      priceCents,
      name: STR(it.name, 60) || 'Unnamed star',
      recip: STR(it.recip, 60),
      occ: STR(it.occ, 40),
      msg: STR(it.msg, 200),
      theme: it.theme === 'ivory' ? 'ivory' : 'midnight',
      cons,
      star: {
        id: STR(it.id, 30),
        ra: STR(it.ra, 30),
        dec: STR(it.dec, 30),
        cons,
        mag: STR(it.mag, 20),
        cls: STR(it.cls || it.spec, 40),
        sec: STR(it.sec, 40),
      },
    });
  }

  return { ok: true, order: { email, items, delivery, totalCents, currency: CURRENCY } };
}

/** Money formatting helper for emails / pages. */
export function formatMoney(cents, currency = CURRENCY) {
  return `$${(cents / 100).toFixed(2)} ${String(currency).toUpperCase()}`;
}
