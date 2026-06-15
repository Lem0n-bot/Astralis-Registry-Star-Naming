/**
 * Order-confirmation email — on-brand, table-based, fully inline CSS for broad
 * client compatibility (Gmail / Outlook / Apple Mail). Mirrors the verification
 * email styling, with the hosted starfield backdrop.
 */
import { formatMoney } from './catalog';

const BG_URL = 'https://astralisregistry.com/email-bg.png';
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function itemRow(it) {
  const pkgNames = { standard: 'Standard', premium: 'Premium', ultimate: 'Ultimate Gift' };
  const coords = [it.star?.ra, it.star?.dec].filter(Boolean).join('  ');
  return `
  <tr>
    <td style="padding:14px 0;border-top:1px solid rgba(255,255,255,0.08);">
      <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:20px;color:#F2ECDD;">${esc(it.name)}</div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#99A2C4;margin-top:3px;">
        ${esc(pkgNames[it.pkg] || it.pkg)} &middot; ${esc(it.theme === 'ivory' ? 'Ivory' : 'Midnight')} finish${
    it.star?.id ? ` &middot; ${esc(it.star.id)}` : ''
  }${it.cons ? ` &middot; ${esc(it.cons)}` : ''}
      </div>
      ${coords ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#6E7799;margin-top:2px;">${esc(coords)}</div>` : ''}
    </td>
    <td align="right" style="padding:14px 0;border-top:1px solid rgba(255,255,255,0.08);font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#C9D0E6;white-space:nowrap;">
      ${formatMoney(it.priceCents, '')}
    </td>
  </tr>`;
}

export function orderConfirmationHtml(order) {
  const d = order.delivery || {};
  const addr = [d.address1, d.address2, [d.suburb, d.city].filter(Boolean).join(', '), [d.state, d.postcode].filter(Boolean).join(' '), d.country]
    .filter(Boolean)
    .map(esc)
    .join('<br>');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="dark">
<title>Your Astralis order is confirmed</title></head>
<body style="margin:0;padding:0;background-color:#070917;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#070917;">
  <tr><td align="center" background="${BG_URL}" style="padding:32px 16px;background-color:#070917;background-image:url('${BG_URL}');background-repeat:no-repeat;background-position:top center;background-size:cover;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;background:rgba(13,17,40,0.82);border:1px solid rgba(217,185,108,0.22);border-radius:18px;overflow:hidden;">
      <tr><td align="center" style="padding:34px 28px 6px 28px;">
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:26px;font-weight:600;letter-spacing:2px;color:#D9B96C;">ASTRALIS</div>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#99A2C4;margin-top:6px;">Registry</div>
      </td></tr>
      <tr><td align="center" style="padding:18px 32px 2px 32px;font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;color:#F2ECDD;">Their star is named.</td></tr>
      <tr><td align="center" style="padding:4px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#C9D0E6;">
        Thank you — your payment was successful and your order is confirmed.<br>Order <b style="color:#D9B96C;">${esc(order.orderNo)}</b>
      </td></tr>
      <tr><td style="padding:18px 32px 8px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${order.items.map(itemRow).join('')}
          <tr><td style="padding:14px 0 0 0;border-top:1px solid rgba(217,185,108,0.3);font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#F2ECDD;">Total</td>
          <td align="right" style="padding:14px 0 0 0;border-top:1px solid rgba(217,185,108,0.3);font-family:'Cormorant Garamond',Georgia,serif;font-size:20px;color:#D9B96C;white-space:nowrap;">${esc(formatMoney(order.totalCents, order.currency))}</td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:8px 32px 4px 32px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#99A2C4;">Delivery</td></tr>
      <tr><td style="padding:0 32px 18px 32px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#C9D0E6;">${addr || '&mdash;'}</td></tr>
      <tr><td align="center" style="padding:6px 32px 28px 32px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#6E7799;">
        Your personalised certificate${order.items.length > 1 ? 's are' : ' is'} being prepared and will arrive by email shortly. Printed keepsakes ship within Australia.
      </td></tr>
      <tr><td align="center" style="padding:16px 32px;border-top:1px solid rgba(255,255,255,0.06);font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;color:#6E7799;">
        Astralis Registry &middot; astralisregistry.com
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}
