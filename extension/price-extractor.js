/**
 * Price helpers for the extension: read a product price from a page and
 * format prices as euros.
 *
 * The popup loads this file normally and also injects it into the active tab
 * with chrome.scripting.executeScript({ files: ['price-extractor.js'] }), so
 * this is the ONE implementation used by both sides. extractPriceFromDocument
 * only touches the document it is given (querySelectorAll, getAttribute,
 * textContent, parentElement), which keeps it testable with a tiny fake
 * document in Node.
 *
 * Sources, most reliable first. The first valid price wins:
 *   1. JSON-LD offers (any offer-bearing node, plus a tolerant scan).
 *   2. Price meta tags (product:/og:/itemprop variants, twitter:data1 with a
 *      euro marker) and itemprop="price".
 *   3. Site-specific visible markup (Amazon, purchase box, Radio Popular...).
 *   4. Ecommerce data attributes: data-price, data-product-price, ...
 *   5. dataLayer / GTM objects inside inline scripts.
 *   6. Class/id heuristics on visible elements ("price" in class or id).
 *   7. Last-resort visible text, e.g. "12,99 €" in an anonymous element.
 *
 * Heuristics guess. The popup fills the price field and the user confirms
 * before saving, so a wrong guess costs one edit rather than a wrong request.
 * That is why the generic stages stay conservative: they only
 * accept a euro marker or an exact 2-decimal amount, and they skip old prices,
 * shipping, fees, discount badges and header/nav/footer/aside regions.
 *
 * Exposed as window.BIFMPrice in the browser and module.exports in Node.
 */
(function (global) {
  'use strict';

  const MAX_PRICE = 1000000;

  // Generic heuristics are capped so a huge page cannot stall the popup.
  const MAX_CANDIDATE_ELEMENTS = 200;
  const MAX_HEURISTIC_TEXT = 120;
  const MAX_PRIMARY_TEXT = 40;

  const JSONLD_SELECTOR = 'script[type="application/ld+json"]';
  const AMOUNT_SELECTORS = [
    'meta[property="product:price:amount"]',
    'meta[property="og:price:amount"]',
    'meta[property="product:sale_price:amount"]',
    'meta[property="og:price:standard_amount"]',
    'meta[name="price"]',
    'meta[itemprop="lowPrice"]',
  ];
  const CURRENCY_SELECTORS = [
    'meta[property="product:price:currency"]',
    'meta[property="product:sale_price:currency"]',
    'meta[property="og:price:currency"]',
  ];
  // Only used when the content itself names the euro ("12,99 €" / "EUR 12,99").
  const TWITTER_AMOUNT_SELECTOR = 'meta[name="twitter:data1"]';
  const ITEMPROP_SELECTOR = '[itemprop="price"]';

  // Site-specific price markup, most specific first. These predate the generic
  // heuristics, so they keep their position ahead of them: they are known-good
  // shapes for shops the family actually uses.
  const DOM_PRICE_SELECTORS = [
    '.a-price .a-offscreen',
    '.purchase-box-price',
    '.price.notranslate',
    '.product-price',
  ];

  // Ecommerce frameworks expose the product price as a machine-readable
  // attribute; reading the attribute avoids the surrounding text.
  const DATA_PRICE_SELECTORS = [
    '[data-price]',
    '[data-product-price]',
    '[data-price-amount]',
    '[data-sale-price]',
  ];

  // Elements whose class or id mentions a price, plus every element for the
  // final visible-text pass.
  const PRICE_LABEL_SELECTOR = '[class*="price" i], [id*="price" i]';
  const ANY_ELEMENT_SELECTOR = 'body *';

  // Words that mark an element (or an ancestor) as "not the current price":
  // old/was prices, shipping, fees/taxes, instalments, discounts, loyalty
  // points and tooltips. Substring matching on lower-cased class+id.
  const EXCLUDED_WORDS = [
    'old',
    'was',
    'strike',
    'original',
    'regular',
    'list',
    'compare',
    'shipping',
    'delivery',
    'fee',
    'tax',
    'iva',
    'installment',
    'month',
    'mensal',
    'monthly',
    'save',
    'desconto',
    'discount',
    'points',
    'pontos',
    'reward',
    'cashback',
    'mega',
    'warranty',
    'garantia',
    'tooltip',
  ];

  // Elements that wrap a crossed-out price.
  const EXCLUDED_TAGS = ['DEL', 'S', 'STRIKE'];
  // Page regions that never hold the product price we want.
  const REGION_TAGS = ['HEADER', 'NAV', 'FOOTER', 'ASIDE'];
  // Non-content elements: their textContent is script/style source, not text.
  const SKIP_TAGS = [
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'HEAD',
    'TITLE',
    'META',
    'LINK',
  ];

  // First numeric run in a text blob. Handles "17,09", "1.649,99",
  // "1 234,56" and "1,234.56" without merging neighbouring numbers.
  const FIRST_NUMBER = /\d{1,3}(?:[.\s]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,3})*/;

  // dataLayer / GTM shape: price: 12.99, "price": 12.99 or 'price': '12.99'.
  // The unquoted form must not swallow keys such as listPrice / salePrice.
  const DATALAYER_PRICE =
    /(?:["']price["']|(?:^|[^A-Za-z0-9_$])price)\s*:\s*["']?([0-9][0-9.,]*)/gi;
  const DATALAYER_CURRENCY =
    /(?:["']currency["']|(?:^|[^A-Za-z0-9_$])currency)\s*:\s*["']([A-Za-z]{3}|\u20ac)["']/gi;
  // The price key must sit inside an ecommerce/products/items/dataLayer block.
  const DATALAYER_CONTEXT = /ecommerce|products|items|dataLayer/i;

  // Keep in sync with public/list-utils.js (the dashboard copy).
  const PRICE_FORMATTER = new Intl.NumberFormat('pt-PT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  /** Format a stored plain number as a euro amount, e.g. 12.5 -> "12,50 €". */
  function formatPrice(value) {
    if (value === null || value === undefined || value === '') return '';
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return PRICE_FORMATTER.format(number);
  }

  function roundPrice(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (value <= 0 || value > MAX_PRICE) return null;
    const rounded = Math.round(value * 100) / 100;
    return rounded > 0 ? rounded : null;
  }

  /**
   * Normalize one already-isolated numeric token. When both separators appear,
   * the last one is the decimal separator; a single separator is decimal unless
   * it repeats (then it groups thousands).
   */
  function parseDecimalToken(token) {
    try {
      const digits = String(token).replace(/[^0-9.,]/g, '');
      if (!digits) return null;

      const lastDot = digits.lastIndexOf('.');
      const lastComma = digits.lastIndexOf(',');
      let decimalIndex = -1;

      if (lastDot >= 0 && lastComma >= 0) {
        decimalIndex = Math.max(lastDot, lastComma);
      } else if (lastComma >= 0) {
        decimalIndex = digits.indexOf(',') === lastComma ? lastComma : -1;
      } else if (lastDot >= 0) {
        decimalIndex = digits.indexOf('.') === lastDot ? lastDot : -1;
      }

      let integerPart;
      let fractionPart;
      if (decimalIndex >= 0) {
        integerPart = digits.slice(0, decimalIndex).replace(/[.,]/g, '');
        fractionPart = digits.slice(decimalIndex + 1).replace(/[.,]/g, '');
      } else {
        integerPart = digits.replace(/[.,]/g, '');
        fractionPart = '';
      }

      if (!integerPart && !fractionPart) return null;
      if (!integerPart) integerPart = '0';
      if (!fractionPart) return roundPrice(Number(integerPart));
      return roundPrice(Number(`${integerPart}.${fractionPart}`));
    } catch {
      return null;
    }
  }

  /** 12,99 / 1.234,56 / 1,234.56 end in exactly two decimal digits. */
  function hasTwoDecimals(token) {
    return /[.,]\d{2}$/.test(token);
  }

  /** "€" or "EUR" right next to the token (not anywhere in the element). */
  function hasEuroMarkerNear(text, match) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text.slice(Math.max(0, start - 6), start);
    const after = text.slice(end, end + 6);
    return /\u20ac|eur/i.test(before) || /\u20ac|eur/i.test(after);
  }

  /** Text that only names a foreign currency is not a euro price. */
  function onlyForeignCurrency(text) {
    return /[$£]|usd|gbp|brl/i.test(text) && !/\u20ac|eur/i.test(text);
  }

  /**
   * Parse a price out of display text or a data attribute. Accepts "12.99",
   * "12,99", "1.234,56" and "1,234.56" plus currency symbols and spaces.
   * Only the first number in the text is used, so a blob such as
   * "17,09€18,99€" (current price plus old price) yields 17.09.
   * Negative values and ranges ("10-12") are rejected.
   *
   * options.strict is for the generic heuristics: the first number must be
   * euro-marked ("€ 12,99", "12,99 €", "EUR 12,99") or carry exactly two
   * decimals. That keeps quantities ("3 unidades") and years ("2026") out.
   */
  function parsePriceText(raw, options) {
    try {
      if (typeof raw === 'number') return roundPrice(raw);
      if (typeof raw !== 'string') return null;
      // A minus sign next to a digit means a negative value or a price range.
      if (/-|\u2212/.test(raw)) return null;

      const strict = Boolean(options && options.strict);
      if (strict && onlyForeignCurrency(raw)) return null;

      const match = FIRST_NUMBER.exec(raw);
      if (!match) return null;
      if (strict && !hasTwoDecimals(match[0]) && !hasEuroMarkerNear(raw, match)) return null;
      return parseDecimalToken(match[0]);
    } catch {
      return null;
    }
  }

  function toArray(value) {
    if (Array.isArray(value)) return value;
    return value === undefined || value === null ? [] : [value];
  }

  function textOf(element) {
    if (!element) return '';
    if (typeof element.textContent === 'string') return element.textContent;
    if (typeof element.text === 'string') return element.text;
    return '';
  }

  function getAttribute(element, name) {
    if (!element) return null;
    try {
      if (typeof element.getAttribute === 'function') {
        const value = element.getAttribute(name);
        if (value !== null && value !== undefined) return String(value);
      }
    } catch {
      // Fall through to the property lookup below.
    }
    const property = element[name];
    return typeof property === 'string' ? property : null;
  }

  function selectAll(doc, selector) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    try {
      const found = doc.querySelectorAll(selector);
      return found ? Array.prototype.slice.call(found) : [];
    } catch {
      return [];
    }
  }

  /** First MAX_CANDIDATE_ELEMENTS matches in document order. */
  function firstElements(doc, selector) {
    const found = selectAll(doc, selector);
    return found.length > MAX_CANDIDATE_ELEMENTS
      ? found.slice(0, MAX_CANDIDATE_ELEMENTS)
      : found;
  }

  function firstNonEmpty() {
    for (let index = 0; index < arguments.length; index += 1) {
      const value = arguments[index];
      if (value === null || value === undefined) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return '';
  }

  /** Missing currency counts as euro; anything else must say EUR (or €). */
  function isEuroCurrency(value) {
    const code = firstNonEmpty(value).toUpperCase();
    return !code || code === 'EUR' || code === '€';
  }

  function priceFromOffers(offers) {
    for (const offer of toArray(offers)) {
      if (!offer || typeof offer !== 'object' || Array.isArray(offer)) continue;
      if (!isEuroCurrency(offer.priceCurrency)) continue;
      const raw = firstNonEmpty(offer.price, offer.lowPrice);
      const price = parsePriceText(raw);
      if (price !== null) return price;
    }
    return null;
  }

  /** Any node that carries offers, not just @type Product (Book, Course, ...). */
  function hasOffers(node) {
    return node.offers !== undefined && node.offers !== null;
  }

  /** Depth-first walk: handles @graph, nested objects and offer-bearing nodes. */
  function findOfferPrice(node, depth, seen) {
    if (!node || typeof node !== 'object' || depth > 10) return null;
    if (seen.indexOf(node) !== -1) return null;
    seen.push(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        const nested = findOfferPrice(item, depth + 1, seen);
        if (nested !== null) return nested;
      }
      return null;
    }

    if (hasOffers(node)) {
      const price = priceFromOffers(node.offers);
      if (price !== null) return price;
    }

    for (const key of Object.keys(node)) {
      if (key === '@context' || key === '@type') continue;
      const child = node[key];
      if (child && typeof child === 'object') {
        const nested = findOfferPrice(child, depth + 1, seen);
        if (nested !== null) return nested;
      }
    }

    return null;
  }

  /**
   * Fallback for JSON-LD blocks that do not parse (a PHP fragment or other junk
   * inside the script). Scans the raw text for "priceCurrency"/"price" pairs and
   * pairs each price with its nearest currency declaration.
   */
  function extractFromRawJsonLd(text) {
    const currencies = [];
    const currencyPattern = /"priceCurrency"\s*:\s*"(EUR|[A-Za-z]{3})"/g;
    let currencyMatch;
    while ((currencyMatch = currencyPattern.exec(text)) !== null) {
      currencies.push({ index: currencyMatch.index, code: currencyMatch[1] });
    }

    const pricePattern = /"price"\s*:\s*"?([0-9][0-9.,]*)"?/g;
    let priceMatch;
    while ((priceMatch = pricePattern.exec(text)) !== null) {
      // Drop a trailing separator such as the comma in `"price": 19.99,`.
      const raw = priceMatch[1].replace(/[.,]+$/, '');
      const price = parsePriceText(raw);
      if (price === null) continue;
      if (!nearestCurrencyIsEuro(currencies, priceMatch.index)) continue;
      return price;
    }
    return null;
  }

  function nearestCurrencyIsEuro(currencies, index) {
    let nearest = null;
    let nearestDistance = Infinity;
    for (const currency of currencies) {
      const distance = Math.abs(currency.index - index);
      if (distance < nearestDistance) {
        nearest = currency;
        nearestDistance = distance;
      }
    }
    return nearest === null || isEuroCurrency(nearest.code);
  }

  function extractFromJsonLd(doc) {
    for (const script of selectAll(doc, JSONLD_SELECTOR)) {
      const text = textOf(script).trim();
      if (!text) continue;
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        const fallback = extractFromRawJsonLd(text);
        if (fallback !== null) return fallback;
        continue;
      }
      const price = findOfferPrice(data, 0, []);
      if (price !== null) return price;
    }
    return null;
  }

  function extractFromMeta(doc) {
    for (const selector of CURRENCY_SELECTORS) {
      for (const element of selectAll(doc, selector)) {
        const currency = firstNonEmpty(getAttribute(element, 'content'));
        if (currency && !isEuroCurrency(currency)) return null;
      }
    }

    for (const selector of AMOUNT_SELECTORS) {
      for (const element of selectAll(doc, selector)) {
        const price = parsePriceText(firstNonEmpty(getAttribute(element, 'content')));
        if (price !== null) return price;
      }
    }

    // Twitter cards sometimes carry the price in a generic slot, so demand an
    // explicit euro marker before trusting it.
    for (const element of selectAll(doc, TWITTER_AMOUNT_SELECTOR)) {
      const content = firstNonEmpty(getAttribute(element, 'content'));
      if (!/\u20ac|eur/i.test(content)) continue;
      const price = parsePriceText(content);
      if (price !== null) return price;
    }
    return null;
  }

  function extractFromItemProp(doc) {
    for (const element of selectAll(doc, ITEMPROP_SELECTOR)) {
      const raw = firstNonEmpty(getAttribute(element, 'content'), textOf(element));
      const price = parsePriceText(raw);
      if (price !== null) return price;
    }
    return null;
  }

  /** Known visible marketing markup: first element with a usable price wins. */
  function extractFromDom(doc) {
    for (const selector of DOM_PRICE_SELECTORS) {
      for (const element of selectAll(doc, selector)) {
        const price = parsePriceText(textOf(element));
        if (price !== null) return price;
      }
    }
    return null;
  }

  /** Machine-readable attributes, e.g. <button data-price="17.09">. */
  function extractFromDataAttributes(doc) {
    for (const selector of DATA_PRICE_SELECTORS) {
      for (const element of firstElements(doc, selector)) {
        const name = selector.slice(1, -1);
        const price = parsePriceText(firstNonEmpty(getAttribute(element, name)));
        if (price !== null) return price;
      }
    }
    return null;
  }

  /**
   * Frames/GTM dataLayer inside inline scripts:
   *   dataLayer.push({ ecommerce: { items: [{ price: 12.99 }] } })
   * Tolerant regex scan, never JSON.parse of the page. Only the first "price"
   * key inside an ecommerce/products/items block counts, and its nearest
   * "currency" must be euro (or absent).
   */
  function scanDataLayerScript(text) {
    const currencies = [];
    let match;
    DATALAYER_CURRENCY.lastIndex = 0;
    while ((match = DATALAYER_CURRENCY.exec(text)) !== null) {
      currencies.push({ index: match.index, code: match[1] });
    }

    DATALAYER_PRICE.lastIndex = 0;
    while ((match = DATALAYER_PRICE.exec(text)) !== null) {
      const context = text.slice(Math.max(0, match.index - 600), match.index);
      if (!DATALAYER_CONTEXT.test(context)) continue;
      if (!nearestCurrencyIsEuro(currencies, match.index)) continue;
      const raw = match[1].replace(/[.,]+$/, '');
      const price = parsePriceText(raw);
      if (price !== null) return price;
    }
    return null;
  }

  function extractFromDataLayer(doc) {
    for (const script of selectAll(doc, 'script')) {
      if (firstNonEmpty(getAttribute(script, 'src'))) continue;
      const type = firstNonEmpty(getAttribute(script, 'type')).toLowerCase();
      // Skip JSON-LD (already handled) and non-JS data blocks.
      if (type && type.indexOf('javascript') === -1 && type !== 'module') continue;
      const text = textOf(script);
      if (!text || text.length > 300000) continue;
      const price = scanDataLayerScript(text);
      if (price !== null) return price;
    }
    return null;
  }

  function tagNameOf(element) {
    if (!element || typeof element.tagName !== 'string') return '';
    return element.tagName.toUpperCase();
  }

  function parentOf(element) {
    if (!element) return null;
    let parent = element.parentElement;
    if (!parent) parent = element.parentNode;
    if (!parent) return null;
    // Stop at the document/fragment: only elements carry tagName.
    if (typeof parent.tagName !== 'string') return null;
    return parent;
  }

  /** Lower-cased class + id, the text matched against EXCLUDED_WORDS. */
  function labelOf(element) {
    if (!element) return '';
    const parts = [];
    const className = getAttribute(element, 'class');
    if (className) parts.push(className);
    if (typeof element.className === 'string' && element.className) parts.push(element.className);
    const id = getAttribute(element, 'id');
    if (id) parts.push(id);
    if (typeof element.id === 'string' && element.id) parts.push(element.id);
    return parts.join(' ').toLowerCase();
  }

  function hasExcludedWord(label) {
    for (const word of EXCLUDED_WORDS) {
      if (label.indexOf(word) !== -1) return true;
    }
    return false;
  }

  /**
   * True when the element is not a usable price candidate: script/style markup,
   * a crossed-out price, a header/nav/footer/aside region, or an ancestor whose
   * class/id names old prices, shipping, discounts, taxes, etc.
   */
  function isUnusableElement(element) {
    const tag = tagNameOf(element);
    if (SKIP_TAGS.indexOf(tag) !== -1) return true;
    if (REGION_TAGS.indexOf(tag) !== -1) return true;
    if (EXCLUDED_TAGS.indexOf(tag) !== -1) return true;
    if (hasExcludedWord(labelOf(element))) return true;

    let node = parentOf(element);
    let depth = 0;
    while (node && depth < 60) {
      const ancestorTag = tagNameOf(node);
      if (EXCLUDED_TAGS.indexOf(ancestorTag) !== -1) return true;
      if (REGION_TAGS.indexOf(ancestorTag) !== -1) return true;
      if (hasExcludedWord(labelOf(node))) return true;
      node = parentOf(node);
      depth += 1;
    }
    return false;
  }

  /** Text that is essentially just an amount, e.g. "12,99 €" or "€12.99". */
  function isPrimarilyPriceText(text) {
    const trimmed = String(text).replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed.length > MAX_PRIMARY_TEXT) return false;
    const stripped = trimmed
      .replace(/eur/gi, '')
      .replace(/[\u20ac\s\u00a0]/g, '')
      .replace(/[0-9.,]/g, '');
    return stripped === '';
  }

  /** Elements whose class/id says "price": the broadest reliable generic pass. */
  function extractFromPriceLabels(doc) {
    for (const element of firstElements(doc, PRICE_LABEL_SELECTOR)) {
      if (isUnusableElement(element)) continue;
      const text = textOf(element).trim();
      if (!text || text.length > MAX_HEURISTIC_TEXT) continue;
      const price = parsePriceText(text, { strict: true });
      if (price !== null) return price;
    }
    return null;
  }

  /** Last resort: an anonymous element whose whole text is a euro amount. */
  function extractFromVisibleText(doc) {
    for (const element of firstElements(doc, ANY_ELEMENT_SELECTOR)) {
      if (isUnusableElement(element)) continue;
      const text = textOf(element).replace(/\s+/g, ' ').trim();
      if (!isPrimarilyPriceText(text)) continue;
      const price = parsePriceText(text, { strict: true });
      if (price !== null) return price;
    }
    return null;
  }

  /**
   * Best-effort price lookup for a page document.
   * Order: JSON-LD (any offer-bearing node, plus a tolerant scan of blocks that
   * do not parse) -> price meta tags -> itemprop="price" -> known site markup
   * -> data attributes -> dataLayer -> class/id heuristics -> visible text.
   * Returns a number rounded to 2 decimals, or null. Never throws.
   */
  function extractPriceFromDocument(doc) {
    try {
      if (!doc) return null;
      return (
        extractFromJsonLd(doc) ??
        extractFromMeta(doc) ??
        extractFromItemProp(doc) ??
        extractFromDom(doc) ??
        extractFromDataAttributes(doc) ??
        extractFromDataLayer(doc) ??
        extractFromPriceLabels(doc) ??
        extractFromVisibleText(doc)
      );
    } catch {
      return null;
    }
  }

  const api = {
    extractPriceFromDocument,
    formatPrice,
    parsePriceText,
    MAX_PRICE,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (global) {
    global.BIFMPrice = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
