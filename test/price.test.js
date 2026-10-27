'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractPriceFromDocument,
  formatPrice,
  parsePriceText,
} = require('../extension/price-extractor');
const { formatPrice: formatDashboardPrice } = require('../public/list-utils');

// Same options as extension/price-extractor.js and public/list-utils.js.
const EURO = new Intl.NumberFormat('pt-PT', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fakeElement({ textContent = '', attributes = {}, tagName = 'DIV', parentElement = null } = {}) {
  return {
    textContent,
    tagName,
    parentElement,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
  };
}

/** Nested element spec for the class/id and visible-text passes. */
function makeTree(spec = {}) {
  const element = fakeElement({
    tagName: spec.tag || 'DIV',
    attributes: {
      ...(spec.class ? { class: spec.class } : {}),
      ...(spec.id ? { id: spec.id } : {}),
      ...(spec.attributes || {}),
    },
  });
  const children = (spec.children || []).map((child) => {
    const built = makeTree(child);
    built.parentElement = element;
    return built;
  });
  element.children = children;
  element.textContent =
    spec.text === undefined ? children.map((child) => child.textContent).join('') : spec.text;
  return element;
}

function labelMentionsPrice(element) {
  const label = `${element.getAttribute('class') || ''} ${element.getAttribute('id') || ''}`;
  return /price/i.test(label);
}

/**
 * Minimal document double: only querySelectorAll, so the extractor is tested
 * with plain data instead of a DOM implementation.
 */
function makeDocument({
  scripts = [],
  inlineScripts = [],
  metas = [],
  namedMetas = [],
  itempropMetas = [],
  itemProps = [],
  domPrices = {},
  attributeElements = {},
  elements = [],
} = {}) {
  const scriptElements = scripts.map((textContent) =>
    fakeElement({
      textContent,
      tagName: 'SCRIPT',
      attributes: { type: 'application/ld+json' },
    })
  );
  const inlineScriptElements = inlineScripts.map((textContent) =>
    fakeElement({ textContent, tagName: 'SCRIPT' })
  );
  const metaElements = metas.map(({ property, content }) =>
    fakeElement({ attributes: { property, content } })
  );
  const namedMetaElements = namedMetas.map(({ name, content }) =>
    fakeElement({ attributes: { name, content } })
  );
  const itempropMetaElements = itempropMetas.map(({ itemprop, content }) =>
    fakeElement({ attributes: { itemprop, content } })
  );
  const itemPropElements = itemProps.map((item) =>
    fakeElement({
      textContent: item.textContent || '',
      attributes: item.content === undefined ? {} : { content: item.content },
    })
  );

  const attributeLists = {};
  for (const [selector, items] of Object.entries(attributeElements)) {
    attributeLists[selector] = items.map((item) =>
      fakeElement({ textContent: item.textContent || '', attributes: item.attributes || {} })
    );
  }

  const allElements = [];
  const collect = (element) => {
    allElements.push(element);
    for (const child of element.children || []) collect(child);
  };
  for (const spec of elements) collect(makeTree(spec));

  return {
    querySelectorAll(selector) {
      if (selector === 'script[type="application/ld+json"]') return scriptElements;
      if (selector === 'script') return scriptElements.concat(inlineScriptElements);
      const metaProperty = /^meta\[property="([^"]+)"\]$/.exec(selector);
      if (metaProperty) {
        return metaElements.filter(
          (element) => element.getAttribute('property') === metaProperty[1]
        );
      }
      const metaName = /^meta\[name="([^"]+)"\]$/.exec(selector);
      if (metaName) {
        return namedMetaElements.filter((element) => element.getAttribute('name') === metaName[1]);
      }
      const metaItemprop = /^meta\[itemprop="([^"]+)"\]$/.exec(selector);
      if (metaItemprop) {
        return itempropMetaElements.filter(
          (element) => element.getAttribute('itemprop') === metaItemprop[1]
        );
      }
      if (selector === '[itemprop="price"]') return itemPropElements;
      if (selector === '[class*="price" i], [id*="price" i]') {
        return allElements.filter(labelMentionsPrice);
      }
      if (selector === 'body *') return allElements;
      if (Object.prototype.hasOwnProperty.call(domPrices, selector)) {
        return domPrices[selector].map((textContent) => fakeElement({ textContent }));
      }
      if (Object.prototype.hasOwnProperty.call(attributeLists, selector)) {
        return attributeLists[selector];
      }
      return [];
    },
  };
}

function jsonLdDoc(data) {
  return makeDocument({ scripts: [JSON.stringify(data)] });
}

function product(offers, extra = {}) {
  return { '@context': 'https://schema.org', '@type': 'Product', name: 'Running shoes', offers, ...extra };
}

test('reads a price from a single Product JSON-LD object', () => {
  const doc = jsonLdDoc(
    product({ '@type': 'Offer', price: '12.99', priceCurrency: 'EUR' })
  );
  assert.equal(extractPriceFromDocument(doc), 12.99);
});

test('reads a price from a Product inside @graph and nested arrays', () => {
  const graph = jsonLdDoc({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'BreadcrumbList', itemListElement: [] },
      product({ '@type': 'Offer', price: '59.95', priceCurrency: 'EUR' }),
    ],
  });
  assert.equal(extractPriceFromDocument(graph), 59.95);

  const nested = jsonLdDoc([
    [{ '@type': 'Organization', name: 'Shop' }],
    [product({ '@type': 'Offer', price: '7,50', priceCurrency: 'EUR' })],
  ]);
  assert.equal(extractPriceFromDocument(nested), 7.5);
});

test('handles offers arrays, skipping offers in another currency', () => {
  const doc = jsonLdDoc(
    product([
      { '@type': 'Offer', price: '10.00', priceCurrency: 'USD' },
      { '@type': 'Offer', price: '8.50', priceCurrency: 'EUR' },
    ])
  );
  assert.equal(extractPriceFromDocument(doc), 8.5);
});

test('accepts AggregateOffer lowPrice and a missing currency', () => {
  assert.equal(
    extractPriceFromDocument(
      jsonLdDoc(product({ '@type': 'AggregateOffer', lowPrice: '3.20', priceCurrency: 'EUR' }))
    ),
    3.2
  );
  assert.equal(
    extractPriceFromDocument(jsonLdDoc(product({ '@type': 'Offer', price: '4.10' }))),
    4.1
  );
});

test('ignores JSON-LD products priced in another currency', () => {
  assert.equal(
    extractPriceFromDocument(
      jsonLdDoc(product({ '@type': 'Offer', price: '19.99', priceCurrency: 'USD' }))
    ),
    null
  );
  assert.equal(
    extractPriceFromDocument(
      jsonLdDoc(product({ '@type': 'AggregateOffer', lowPrice: '5', priceCurrency: 'GBP' }))
    ),
    null
  );
});

test('reads product:price / og:price meta tags with a euro or missing currency', () => {
  assert.equal(
    extractPriceFromDocument(
      makeDocument({
        metas: [
          { property: 'product:price:amount', content: '12.99' },
          { property: 'product:price:currency', content: 'EUR' },
        ],
      })
    ),
    12.99
  );

  assert.equal(
    extractPriceFromDocument(
      makeDocument({ metas: [{ property: 'og:price:amount', content: '1.234,56' }] })
    ),
    1234.56
  );
});

test('ignores meta amounts in another currency', () => {
  assert.equal(
    extractPriceFromDocument(
      makeDocument({
        metas: [
          { property: 'product:price:amount', content: '19.99' },
          { property: 'product:price:currency', content: 'USD' },
        ],
      })
    ),
    null
  );
});

test('reads itemprop="price" from content or from the text', () => {
  assert.equal(
    extractPriceFromDocument(makeDocument({ itemProps: [{ content: '24,90' }] })),
    24.9
  );
  assert.equal(
    extractPriceFromDocument(makeDocument({ itemProps: [{ textContent: ' 15,00 € ' }] })),
    15
  );
});

test('JSON-LD wins over meta tags and itemprop', () => {
  const doc = makeDocument({
    scripts: [JSON.stringify(product({ '@type': 'Offer', price: '30', priceCurrency: 'EUR' }))],
    metas: [{ property: 'product:price:amount', content: '20' }],
    itemProps: [{ content: '10' }],
  });
  assert.equal(extractPriceFromDocument(doc), 30);
});

test('reads offers from a non-Product JSON-LD node (Bertrand Book)', () => {
  // https://www.bertrand.pt/... product page shape.
  const doc = jsonLdDoc({
    '@context': 'https://schema.org',
    '@type': 'Book',
    name: 'Murdoku - Volume 3',
    isbn: '9789891234567',
    offers: { '@type': 'Offer', priceCurrency: 'EUR', price: '17.09' },
  });
  assert.equal(extractPriceFromDocument(doc), 17.09);
});

test('reads offers from any node type nested in @graph', () => {
  const doc = jsonLdDoc({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'Shop' },
      {
        '@type': ['Book', 'Product'],
        offers: [{ '@type': 'Offer', priceCurrency: 'EUR', price: 21.5 }],
      },
    ],
  });
  assert.equal(extractPriceFromDocument(doc), 21.5);
});

test('falls back to a tolerant scan when a JSON-LD block has invalid JSON', () => {
  // Ásua Farmácia: a PHP fragment used as a key makes JSON.parse fail.
  const broken = `{
  "@context": "https://schema.org",
  "@type": "Product",
  "<?php $__contextArgs = [];
  echo json_encode($__contextArgs);
?>": "https://schema.org/",
  "name": "Microlife OXY210",
  "offers": {
    "@type": "Offer",
    "priceCurrency": "EUR",
    "price": 45.47,
    "availability": "https://schema.org/InStock"
  }
}`;
  assert.equal(extractPriceFromDocument(makeDocument({ scripts: [broken] })), 45.47);
});

test('tolerant JSON-LD scan accepts a string price and no currency', () => {
  const noCurrency = '{ "offers": { "price": "45,47", } }';
  assert.equal(extractPriceFromDocument(makeDocument({ scripts: [noCurrency] })), 45.47);

  const quotedDecimal = '{ "offers": { "priceCurrency": "EUR", "price": "1.649,99", } }';
  assert.equal(extractPriceFromDocument(makeDocument({ scripts: [quotedDecimal] })), 1649.99);
});

test('tolerant JSON-LD scan still rejects a broken block in another currency', () => {
  const dollars = '{ "offers": { "priceCurrency": "USD", "price": 19.99, } }';
  assert.equal(extractPriceFromDocument(makeDocument({ scripts: [dollars] })), null);
});

test('reads the Radio Popular .price.notranslate price', () => {
  // <div class="price notranslate">19<sup>,99</sup></div> -> textContent "19,99".
  const doc = makeDocument({ domPrices: { '.price.notranslate': ['19,99'] } });
  assert.equal(extractPriceFromDocument(doc), 19.99);
});

test('reads the Amazon .a-offscreen price', () => {
  const doc = makeDocument({
    domPrices: { '.a-price .a-offscreen': ['12,99 €'] },
  });
  assert.equal(extractPriceFromDocument(doc), 12.99);
});

test('takes the first price from a purchase-box text blob', () => {
  // Bertrand: current price followed by the old price in the same element.
  const doc = makeDocument({
    domPrices: { '.purchase-box-price': ['17,09€18,99€'] },
  });
  assert.equal(extractPriceFromDocument(doc), 17.09);
});

test('DOM selectors are ordered and skip elements without a usable price', () => {
  const doc = makeDocument({
    domPrices: {
      '.a-price .a-offscreen': ['Indisponível'],
      '.purchase-box-price': [],
      '.price.notranslate': ['19,99'],
      '.product-price': ['9,99'],
    },
  });
  // .price.notranslate comes before the .product-price catch-all.
  assert.equal(extractPriceFromDocument(doc), 19.99);
});

test('JSON-LD and meta tags win over visible price markup', () => {
  const doc = makeDocument({
    scripts: [JSON.stringify(product({ '@type': 'Offer', price: '30', priceCurrency: 'EUR' }))],
    metas: [{ property: 'product:price:amount', content: '20' }],
    domPrices: { '.product-price': ['9,99'] },
  });
  assert.equal(extractPriceFromDocument(doc), 30);

  const metaOnly = makeDocument({
    metas: [{ property: 'product:price:amount', content: '20' }],
    domPrices: { '.product-price': ['9,99'] },
  });
  assert.equal(extractPriceFromDocument(metaOnly), 20);
});

test('reads the broader price meta tags', () => {
  assert.equal(
    extractPriceFromDocument(
      makeDocument({ itempropMetas: [{ itemprop: 'lowPrice', content: '9.99' }] })
    ),
    9.99
  );
  assert.equal(
    extractPriceFromDocument(makeDocument({ namedMetas: [{ name: 'price', content: '19,90' }] })),
    19.9
  );
  assert.equal(
    extractPriceFromDocument(
      makeDocument({ metas: [{ property: 'product:sale_price:amount', content: '14.50' }] })
    ),
    14.5
  );
  assert.equal(
    extractPriceFromDocument(
      makeDocument({ metas: [{ property: 'og:price:standard_amount', content: '21.00' }] })
    ),
    21
  );
});

test('twitter:data1 only counts when it names the euro', () => {
  assert.equal(
    extractPriceFromDocument(
      makeDocument({ namedMetas: [{ name: 'twitter:data1', content: '12,99 €' }] })
    ),
    12.99
  );
  assert.equal(
    extractPriceFromDocument(
      makeDocument({ namedMetas: [{ name: 'twitter:data1', content: 'EUR 12,99' }] })
    ),
    12.99
  );
  // A bare number in that slot is not a price.
  assert.equal(
    extractPriceFromDocument(
      makeDocument({ namedMetas: [{ name: 'twitter:data1', content: '12.99' }] })
    ),
    null
  );
});

test('reads ecommerce data-price attributes', () => {
  const cases = [
    ['[data-price]', { 'data-price': '17.09' }, 17.09],
    ['[data-product-price]', { 'data-product-price': '19.99' }, 19.99],
    ['[data-price-amount]', { 'data-price-amount': '1.234,56' }, 1234.56],
    ['[data-sale-price]', { 'data-sale-price': '8,50' }, 8.5],
  ];
  for (const [selector, attributes, expected] of cases) {
    const doc = makeDocument({
      attributeElements: {
        [selector]: [{ textContent: 'Preço sob consulta', attributes }],
      },
    });
    assert.equal(extractPriceFromDocument(doc), expected);
  }
});

test('reads a euro price from a dataLayer ecommerce object', () => {
  const withCurrency = `window.dataLayer = window.dataLayer || [];
dataLayer.push({ event: 'view_item', ecommerce: { currency: 'EUR', items: [{ item_id: 'x', price: 12.99 }] } });`;
  assert.equal(extractPriceFromDocument(makeDocument({ inlineScripts: [withCurrency] })), 12.99);

  const withoutCurrency = `dataLayer.push({ ecommerce: { products: [{ name: 'A', price: '45,47' }] } });`;
  assert.equal(extractPriceFromDocument(makeDocument({ inlineScripts: [withoutCurrency] })), 45.47);

  const dollars = `dataLayer.push({ ecommerce: { currency: 'USD', items: [{ price: 19.99 }] } });`;
  assert.equal(extractPriceFromDocument(makeDocument({ inlineScripts: [dollars] })), null);

  // A "price" key outside an ecommerce/products/items block is not a product price.
  assert.equal(
    extractPriceFromDocument(makeDocument({ inlineScripts: ['var config = { price: 99.99 };'] })),
    null
  );
});

test('falls back to class/id price heuristics on visible elements', () => {
  const classDoc = makeDocument({
    elements: [
      {
        tag: 'div',
        class: 'product-card',
        children: [{ tag: 'span', class: 'price-value', text: '12,99 €' }],
      },
    ],
  });
  assert.equal(extractPriceFromDocument(classDoc), 12.99);

  const idDoc = makeDocument({
    elements: [{ tag: 'strong', id: 'product-price', text: 'EUR 24,90' }],
  });
  assert.equal(extractPriceFromDocument(idDoc), 24.9);
});

test('ignores old, shipping, tax, instalment and tooltip price elements', () => {
  const excluded = [
    { tag: 'span', class: 'old-price', text: '19,99 €' },
    { tag: 'span', class: 'price-was', text: '19,99 €' },
    { tag: 'span', class: 'price-shipping', text: '4,99 €' },
    { tag: 'span', class: 'price-iva', text: '2,37 €' },
    { tag: 'span', class: 'price-installment', text: '6,00 €' },
    { tag: 'span', class: 'price-mensal', text: '6,00 €' },
    { tag: 'span', class: 'price-points', text: '500,00' },
    { tag: 'span', class: 'price-tooltip', text: '12,99 €' },
    { tag: 'del', children: [{ tag: 'span', class: 'price', text: '19,99 €' }] },
    { tag: 'div', class: 'old-price-wrapper', children: [{ tag: 'span', class: 'price', text: '19,99 €' }] },
  ];
  for (const spec of excluded) {
    assert.equal(
      extractPriceFromDocument(makeDocument({ elements: [spec] })),
      null,
      `expected null for ${JSON.stringify(spec)}`
    );
  }

  // The current price still wins when an old price comes first in the DOM.
  const currentPrice = makeDocument({
    elements: [
      { tag: 'span', class: 'old-price', text: '19,99 €' },
      { tag: 'span', class: 'price', text: '12,99 €' },
    ],
  });
  assert.equal(extractPriceFromDocument(currentPrice), 12.99);
});

test('ignores prices inside header, nav, footer and aside', () => {
  for (const tag of ['header', 'nav', 'footer', 'aside']) {
    const doc = makeDocument({
      elements: [{ tag, children: [{ tag: 'span', class: 'price', text: '12,99 €' }] }],
    });
    assert.equal(extractPriceFromDocument(doc), null, `expected null inside <${tag}>`);
  }
});

test('last-resort visible text needs a euro marker or exactly two decimals', () => {
  const visible = (text) => makeDocument({ elements: [{ tag: 'div', text }] });

  assert.equal(extractPriceFromDocument(visible('12,99 €')), 12.99);
  assert.equal(extractPriceFromDocument(visible('€12.99')), 12.99);
  assert.equal(extractPriceFromDocument(visible('EUR 12,99')), 12.99);
  assert.equal(extractPriceFromDocument(visible('12,99€')), 12.99);

  // Quantities, years, one-decimal numbers and foreign currencies are not prices.
  assert.equal(extractPriceFromDocument(visible('3 unidades')), null);
  assert.equal(extractPriceFromDocument(visible('2026')), null);
  assert.equal(extractPriceFromDocument(visible('12.9')), null);
  assert.equal(extractPriceFromDocument(visible('R$ 12,99')), null);
});

test('sources are ordered from structured data down to heuristics', () => {
  const elements = [{ tag: 'span', class: 'price', text: '5,00 €' }];
  const attributeElements = { '[data-price]': [{ attributes: { 'data-price': '6.00' } }] };
  const inlineScripts = ['dataLayer.push({ ecommerce: { items: [{ price: 7.00 }] } });'];
  const namedMetas = [{ name: 'price', content: '8.00' }];

  assert.equal(
    extractPriceFromDocument(
      makeDocument({
        scripts: [JSON.stringify(product({ '@type': 'Offer', price: '30', priceCurrency: 'EUR' }))],
        namedMetas,
        attributeElements,
        inlineScripts,
        elements,
      })
    ),
    30
  );
  assert.equal(
    extractPriceFromDocument(makeDocument({ namedMetas, attributeElements, inlineScripts, elements })),
    8
  );
  assert.equal(extractPriceFromDocument(makeDocument({ attributeElements, inlineScripts, elements })), 6);
  assert.equal(extractPriceFromDocument(makeDocument({ inlineScripts, elements })), 7);
  assert.equal(extractPriceFromDocument(makeDocument({ elements })), 5);
});

test('parses European and US number formats and strips currency symbols', () => {
  assert.equal(parsePriceText('12.99'), 12.99);
  assert.equal(parsePriceText('12,99'), 12.99);
  assert.equal(parsePriceText('1.234,56'), 1234.56);
  assert.equal(parsePriceText('1,234.56'), 1234.56);
  assert.equal(parsePriceText('€ 12,99'), 12.99);
  assert.equal(parsePriceText('12,99 €'), 12.99);
  assert.equal(parsePriceText('1 234,56'), 1234.56);
  assert.equal(parsePriceText(12.5), 12.5);
  assert.equal(parsePriceText('12.994'), 12.99);
  assert.equal(parsePriceText('12.999'), 13);
});

test('parses only the first number in a text blob', () => {
  assert.equal(parsePriceText('17,09€18,99€'), 17.09);
  assert.equal(parsePriceText('€ 1.649,99'), 1649.99);
  assert.equal(parsePriceText('19,99'), 19.99);
  assert.equal(parsePriceText('12.99'), 12.99);
  assert.equal(parsePriceText('1,234.56'), 1234.56);
  assert.equal(parsePriceText('Preço 12,99 € (antes 15,00 €)'), 12.99);
});

test('strict parsing rejects quantities, years and foreign currencies', () => {
  // Used only by the generic heuristics, so it must not guess from a plain number.
  assert.equal(parsePriceText('3 unidades', { strict: true }), null);
  assert.equal(parsePriceText('2026', { strict: true }), null);
  assert.equal(parsePriceText('12.9', { strict: true }), null);
  assert.equal(parsePriceText('R$ 12,99', { strict: true }), null);
  assert.equal(parsePriceText('Ref. 12345, 12,99 €', { strict: true }), null);

  assert.equal(parsePriceText('12,99 €', { strict: true }), 12.99);
  assert.equal(parsePriceText('12.99', { strict: true }), 12.99);
  assert.equal(parsePriceText('€ 1.649,99', { strict: true }), 1649.99);
  assert.equal(parsePriceText('EUR 12,99', { strict: true }), 12.99);
});

test('rejects unusable prices without throwing', () => {
  for (const value of [null, undefined, '', '  ', 'free', 'N/A', '0', 0, '-5', '-5,00']) {
    assert.equal(parsePriceText(value), null, `expected null for ${JSON.stringify(value)}`);
  }

  assert.equal(parsePriceText('2000000'), null);
  assert.equal(parsePriceText(1000001), null);

  assert.equal(extractPriceFromDocument(null), null);
  assert.equal(extractPriceFromDocument(undefined), null);
  assert.equal(extractPriceFromDocument({}), null);
  assert.equal(extractPriceFromDocument(makeDocument()), null);
  assert.equal(extractPriceFromDocument(jsonLdDoc({ '@type': 'Product' })), null);
  assert.equal(extractPriceFromDocument(makeDocument({ scripts: ['{not json'] })), null);
  assert.equal(
    extractPriceFromDocument(jsonLdDoc(product({ '@type': 'Offer', price: 'abc' }))),
    null
  );
  assert.equal(
    extractPriceFromDocument(
      makeDocument({ itemProps: [{ textContent: 'Free shipping' }, { content: '0' }] })
    ),
    null
  );
});

test('never throws when the document misbehaves', () => {
  const broken = {
    querySelectorAll() {
      throw new Error('boom');
    },
  };
  assert.equal(extractPriceFromDocument(broken), null);

  const empty = {
    querySelectorAll() {
      return null;
    },
  };
  assert.equal(extractPriceFromDocument(empty), null);
});

test('formatPrice renders euros with pt-PT formatting', () => {
  const formatted = formatPrice(12.5);
  assert.equal(formatted, EURO.format(12.5));
  assert.equal(formatted.replace(/\u00a0/g, ' '), '12,50 €');
  assert.ok(formatted.includes('€'));
  assert.ok(formatted.includes('12,50'));

  assert.equal(formatPrice(null), '');
  assert.equal(formatPrice(undefined), '');
  assert.equal(formatPrice(''), '');
  assert.equal(formatPrice('abc'), '');
  assert.equal(formatPrice(0), EURO.format(0));
});

test('the popup and dashboard formatters agree', () => {
  for (const value of [0, 4.5, 12.5, 1234.56, 999999.99]) {
    assert.equal(formatPrice(value), formatDashboardPrice(value));
  }
  assert.equal(formatDashboardPrice(null), '');
});
