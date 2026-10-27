/**
 * Price helpers for the extension: read a product price from a page and
 * format prices as euros.
 *
 * The popup loads this file normally and also injects it into the active tab
 * with chrome.scripting.executeScript({ files: ['price-extractor.js'] }), so
 * this is the ONE implementation used by both sides. extractPriceFromDocument
 * only touches the document it is given (querySelectorAll, getAttribute,
 * textContent), which keeps it testable with a tiny fake document in Node.
 *
 * Exposed as window.BIFMPrice in the browser and module.exports in Node.
 */
(function (global) {
  'use strict';

  const MAX_PRICE = 1000000;

  const JSONLD_SELECTOR = 'script[type="application/ld+json"]';
  const AMOUNT_SELECTORS = [
    'meta[property="product:price:amount"]',
    'meta[property="og:price:amount"]',
  ];
  const CURRENCY_SELECTORS = [
    'meta[property="product:price:currency"]',
    'meta[property="og:price:currency"]',
  ];
  const ITEMPROP_SELECTOR = '[itemprop="price"]';

  // Last resort: visible price markup. Order matters because these classes are
  // also used by search results and recommendation blocks, so broad selectors
  // stay at the end. Each selector takes its first element with a valid price.
  const DOM_PRICE_SELECTORS = [
    '.a-price .a-offscreen',
    '.purchase-box-price',
    '.price.notranslate',
    '.product-price',
  ];

  // First numeric run in a text blob. Handles "17,09", "1.649,99",
  // "1 234,56" and "1,234.56" without merging neighbouring numbers.
  const FIRST_NUMBER = /\d{1,3}(?:[.\s]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,3})*/;

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

  /**
   * Parse a price out of display text or a data attribute. Accepts "12.99",
   * "12,99", "1.234,56" and "1,234.56" plus currency symbols and spaces.
   * Only the first number in the text is used, so a blob such as
   * "17,09€18,99€" (current price plus old price) yields 17.09.
   * Negative values and ranges ("10-12") are rejected.
   */
  function parsePriceText(raw) {
    try {
      if (typeof raw === 'number') return roundPrice(raw);
      if (typeof raw !== 'string') return null;
      // A minus sign next to a digit means a negative value or a price range.
      if (/-|\u2212/.test(raw)) return null;

      const match = FIRST_NUMBER.exec(raw);
      if (!match) return null;
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

  /** Visible marketing markup: first element with a usable price wins. */
  function extractFromDom(doc) {
    for (const selector of DOM_PRICE_SELECTORS) {
      for (const element of selectAll(doc, selector)) {
        const price = parsePriceText(textOf(element));
        if (price !== null) return price;
      }
    }
    return null;
  }

  /**
   * Best-effort price lookup for a page document.
   * Order: JSON-LD (any offer-bearing node, plus a tolerant scan of blocks that
   * do not parse) -> price meta tags -> itemprop="price" -> visible price
   * selectors. Returns a number rounded to 2 decimals, or null. Never throws.
   */
  function extractPriceFromDocument(doc) {
    try {
      if (!doc) return null;
      return (
        extractFromJsonLd(doc) ??
        extractFromMeta(doc) ??
        extractFromItemProp(doc) ??
        extractFromDom(doc)
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
