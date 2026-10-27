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

function fakeElement({ textContent = '', attributes = {} } = {}) {
  return {
    textContent,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
  };
}

/**
 * Minimal document double: only querySelectorAll, so the extractor is tested
 * with plain data instead of a DOM implementation.
 */
function makeDocument({ scripts = [], metas = [], itemProps = [] } = {}) {
  const scriptElements = scripts.map((textContent) => fakeElement({ textContent }));
  const metaElements = metas.map(({ property, content }) =>
    fakeElement({ attributes: { property, content } })
  );
  const itemPropElements = itemProps.map((item) =>
    fakeElement({
      textContent: item.textContent || '',
      attributes: item.content === undefined ? {} : { content: item.content },
    })
  );

  return {
    querySelectorAll(selector) {
      if (selector === 'script[type="application/ld+json"]') return scriptElements;
      const metaProperty = /^meta\[property="([^"]+)"\]$/.exec(selector);
      if (metaProperty) {
        return metaElements.filter(
          (element) => element.getAttribute('property') === metaProperty[1]
        );
      }
      if (selector === '[itemprop="price"]') return itemPropElements;
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
