// ntfy.sh push notifications for new shopping requests.
// Pure helpers plus one small sender, so tests can inject a fake fetch.
// Nothing here may log or return the topic value: it is effectively a password.

const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';
const MAX_BODY_LENGTH = 300;
const NOTIFICATION_TITLE = 'New shopping request';
const NOTIFICATION_TAGS = 'shopping_cart';
const NOTIFICATION_PRIORITY = 'default';

function priceText(price) {
  return typeof price === 'number' && Number.isFinite(price)
    ? price.toFixed(2)
    : null;
}

function clip(text, max) {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max === 1) return text.slice(0, 1);
  return `${text.slice(0, max - 1)}…`;
}

function subjectLine(request) {
  const title = typeof request.title === 'string' ? request.title.trim() : '';
  return title || 'New request';
}

function detailsLine(request) {
  const quantity =
    typeof request.quantity === 'number' && Number.isInteger(request.quantity)
      ? request.quantity
      : null;
  const price = priceText(request.price);

  if (quantity !== null && price !== null) return `Qty ${quantity} · ${price}`;
  if (quantity !== null) return `Qty ${quantity}`;
  if (price !== null) return `Price ${price}`;
  return null;
}

/**
 * Build the plain-text ntfy message for one created request.
 * The body stays at or under 300 characters: the note is only kept when the
 * whole message still fits, then the product link is dropped, then the title
 * is clipped.
 */
export function buildNtfyMessage(request, origin) {
  const item = request && typeof request === 'object' ? request : {};

  const head = [subjectLine(item)];
  const details = detailsLine(item);
  if (details) head.push(details);

  const url = typeof item.url === 'string' ? item.url.trim() : '';
  const note = typeof item.note === 'string' ? item.note.trim() : '';
  const tail = [];
  if (url) tail.push(url);
  if (note && [...head, ...tail, note].join('\n').length <= MAX_BODY_LENGTH) {
    tail.push(note);
  }

  let body = [...head, ...tail].join('\n');
  while (body.length > MAX_BODY_LENGTH && tail.length > 0) {
    tail.pop();
    body = [...head, ...tail].join('\n');
  }

  if (body.length > MAX_BODY_LENGTH) {
    const rest = head.slice(1).join('\n');
    const room = MAX_BODY_LENGTH - (rest ? rest.length + 1 : 0);
    head[0] = clip(head[0], room);
    body = head.join('\n');
  }

  return {
    title: NOTIFICATION_TITLE,
    tags: NOTIFICATION_TAGS,
    priority: NOTIFICATION_PRIORITY,
    click: typeof origin === 'string' ? origin : '',
    body: clip(body, MAX_BODY_LENGTH),
  };
}

/**
 * Resolve the ntfy base URL. NTFY_SERVER is optional and must be https.
 * Returns null when the configured value is unusable.
 */
export function ntfyServer(env) {
  const configured =
    env && typeof env.NTFY_SERVER === 'string' ? env.NTFY_SERVER.trim() : '';
  let parsed;
  try {
    parsed = new URL(configured || DEFAULT_NTFY_SERVER);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * Publish a message to ntfy. Never throws: every failure is logged without the
 * topic or token and reported as { sent: false }.
 */
export async function sendNtfyNotification(env, message, fetchImpl = fetch) {
  const topic =
    env && typeof env.NTFY_TOPIC === 'string' ? env.NTFY_TOPIC.trim().replace(/^\/+/, '') : '';
  if (!topic) return { sent: false, reason: 'no-topic' };

  const server = ntfyServer(env);
  if (!server) {
    console.error('ntfy notification skipped: NTFY_SERVER must be an https URL.');
    return { sent: false, reason: 'insecure-server' };
  }

  // NTFY_TOKEN is optional; when set it is sent only as a Bearer header.
  const token =
    env && typeof env.NTFY_TOKEN === 'string' ? env.NTFY_TOKEN.trim() : '';

  const target = `${server}/${encodeURIComponent(topic)}`;
  try {
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: message.title,
      Tags: message.tags,
      Priority: message.priority,
      Click: message.click,
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetchImpl(target, {
      method: 'POST',
      headers,
      body: message.body,
    });

    if (!response || response.ok !== true) {
      const status = response && Number.isInteger(response.status) ? response.status : 'unknown';
      console.error(`ntfy notification failed with status ${status}.`);
      return { sent: false, reason: 'bad-status' };
    }

    return { sent: true };
  } catch {
    console.error('ntfy notification failed: network error.');
    return { sent: false, reason: 'network-error' };
  }
}
