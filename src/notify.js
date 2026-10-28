// Push notifications for new shopping requests.
// Two channels: ntfy (topic + optional token) and a Discord webhook.
// Pure builders plus small senders, so tests can inject a fake fetch.
// Nothing here may log or return a secret. The ntfy topic is effectively a
// password, and anyone holding the Discord webhook URL can post to that channel.

const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';
const MAX_BODY_LENGTH = 300;
const NOTIFICATION_TITLE = 'New shopping request';
const NOTIFICATION_TAGS = 'shopping_cart';
const NOTIFICATION_PRIORITY = 'default';

const DISCORD_EMBED_COLOR = 0x2563eb;
const DISCORD_MAX_TITLE = 256;
const DISCORD_MAX_DESCRIPTION = 300;
const DISCORD_MAX_FIELD_VALUE = 1024;

// Only these hosts may receive the webhook secret.
const DISCORD_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'ptb.discord.com',
  'canary.discord.com',
]);

function priceText(price) {
  return typeof price === 'number' && Number.isFinite(price)
    ? price.toFixed(2)
    : null;
}

function euroText(price) {
  const plain = priceText(price);
  return plain === null ? null : `${plain.replace('.', ',')} €`;
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
 * Build the Discord webhook payload for one created request.
 * Uses a single embed so the product link is clickable and the layout stays
 * consistent in the Discord app and on mobile.
 */
export function buildDiscordMessage(request, origin) {
  const item = request && typeof request === 'object' ? request : {};
  const url = typeof item.url === 'string' ? item.url.trim() : '';
  const note = typeof item.note === 'string' ? item.note.trim() : '';

  const embed = {
    title: clip(subjectLine(item), DISCORD_MAX_TITLE),
    color: DISCORD_EMBED_COLOR,
    fields: [],
  };

  if (url) embed.url = url;
  if (note) embed.description = clip(note, DISCORD_MAX_DESCRIPTION);

  const quantity =
    typeof item.quantity === 'number' && Number.isInteger(item.quantity)
      ? item.quantity
      : null;
  if (quantity !== null) {
    embed.fields.push({ name: 'Quantity', value: String(quantity), inline: true });
  }

  const price = euroText(item.price);
  if (price !== null) {
    embed.fields.push({
      name: 'Price',
      value: clip(price, DISCORD_MAX_FIELD_VALUE),
      inline: true,
    });
  }

  if (typeof origin === 'string' && origin) {
    embed.fields.push({ name: 'Dashboard', value: clip(origin, DISCORD_MAX_FIELD_VALUE), inline: false });
  }

  const submittedAt = typeof item.submittedAt === 'string' ? item.submittedAt : '';
  if (submittedAt && !Number.isNaN(Date.parse(submittedAt))) {
    embed.timestamp = submittedAt;
  }

  return { embeds: [embed] };
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
 * Read and validate DISCORD_WEBHOOK_URL. Returns null unless it is an https
 * Discord webhook endpoint, which keeps a stolen secret from posting anywhere
 * unexpected.
 */
export function discordWebhookUrl(env) {
  const configured =
    env && typeof env.DISCORD_WEBHOOK_URL === 'string' ? env.DISCORD_WEBHOOK_URL.trim() : '';
  if (!configured) return null;

  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;
  if (!DISCORD_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  if (!parsed.pathname.startsWith('/api/webhooks/')) return null;
  return parsed.toString();
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

/**
 * Post a message to a Discord webhook. Never throws: every failure is logged
 * without the URL and reported as { sent: false }.
 */
export async function sendDiscordNotification(env, message, fetchImpl = fetch) {
  const configured =
    env && typeof env.DISCORD_WEBHOOK_URL === 'string' ? env.DISCORD_WEBHOOK_URL.trim() : '';
  if (!configured) return { sent: false, reason: 'no-webhook' };

  const webhook = discordWebhookUrl(env);
  if (!webhook) {
    console.error('Discord notification skipped: invalid webhook URL.');
    return { sent: false, reason: 'invalid-webhook' };
  }

  try {
    const response = await fetchImpl(webhook, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Discord requires a User-Agent; Workers send none by default.
        'User-Agent': 'BIFM-Shopping-Requests (https://github.com/mvazmota/Buy-This-For-Me)',
      },
      body: JSON.stringify(message),
    });

    if (!response || response.ok !== true) {
      const status = response && Number.isInteger(response.status) ? response.status : 'unknown';
      console.error(`Discord notification failed with status ${status}.`);
      return { sent: false, reason: 'bad-status' };
    }

    return { sent: true };
  } catch {
    console.error('Discord notification failed: network error.');
    return { sent: false, reason: 'network-error' };
  }
}

/**
 * Send the new-request notification to every configured channel.
 * Channels are independent: one failing never blocks the other, and this
 * function never throws.
 */
export async function notifyNewRequest(env, request, origin, { fetchImpl = fetch } = {}) {
  const results = {};

  const ntfyTopic = env && typeof env.NTFY_TOPIC === 'string' ? env.NTFY_TOPIC.trim() : '';
  const discordSecret =
    env && typeof env.DISCORD_WEBHOOK_URL === 'string' ? env.DISCORD_WEBHOOK_URL.trim() : '';

  const tasks = [];
  if (ntfyTopic) {
    tasks.push(
      sendNtfyNotification(env, buildNtfyMessage(request, origin), fetchImpl).then((result) => {
        results.ntfy = result;
      })
    );
  }
  if (discordSecret) {
    tasks.push(
      sendDiscordNotification(env, buildDiscordMessage(request, origin), fetchImpl).then((result) => {
        results.discord = result;
      })
    );
  }

  if (tasks.length === 0) return { sent: false, reason: 'no-channel', results };

  await Promise.allSettled(tasks);
  return { sent: true, results };
}
