/**
 * Certificate generation workflow (stub).
 *
 * TODO: Real generation belongs here — render the certificate template to a PDF
 * (e.g. server-side with the same data the live preview uses), upload it to
 * storage, and email/link it to the customer. That work should run in a
 * background worker / queue, not inline in the webhook. For now we record a
 * queued job per purchased star so each order has an explicit certificate
 * lifecycle to build on, and so the fulfilment path is already wired.
 */
const jobs = globalThis.__astralisCertJobs || (globalThis.__astralisCertJobs = new Map());

/**
 * Queue a certificate job for one purchased star.
 * @returns {string} jobId
 */
export function queueCertificate(order, item) {
  const jobId = `${order.id}:${item.star?.id || item.name}`;
  jobs.set(jobId, {
    jobId,
    orderId: order.id,
    orderNo: order.orderNo,
    email: order.email,
    star: item.star,
    name: item.name,
    recip: item.recip,
    occ: item.occ,
    msg: item.msg,
    theme: item.theme,
    status: 'queued',
    queuedAt: Date.now(),
  });
  return jobId;
}

export function listCertificateJobs(orderId) {
  return [...jobs.values()].filter((j) => j.orderId === orderId);
}
