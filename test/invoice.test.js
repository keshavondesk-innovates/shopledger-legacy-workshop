'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const coupons = require('../lib/coupons');
const invoice = require('../lib/invoice');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

function billedOrder(items, coupon = '') {
  // Use the saved order shape without calling the route or store.
  const bill = pricing.computeTotals(items, coupon);
  return {
    id: 1,
    date: '21/11/2026',
    items,
    coupon,
    subtotal: bill.subtotal,
    discount: bill.discount,
    tax: bill.tax,
    total: bill.total
  };
}

test('a mixed-rate SAVE10 invoice shows the billed total, GST split, and line taxes', () => {
  const order = billedOrder([
    { name: 'Rice', hsn: '1006', price: 500, qty: 2 },
    { name: 'Ghee', hsn: '0405', price: 1000, qty: 1 }
  ], 'SAVE10');
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.total, 2007.25);
  assert.deepEqual([figures.discount, figures.tax, figures.cgst, figures.sgst], [150, 157.25, 78.63, 78.62]);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [[5, 46.25], [12, 111]]);

  const html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹157\.25/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹2007\.25/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('an uncouponed 18% HSN order matches the billed GST and total', () => {
  const order = billedOrder([{ name: 'Tea', hsn: '0902', price: 125, qty: 2 }]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 45);
  assert.equal(order.total, 295);
  assert.equal(figures.tax, 45);
  assert.equal(figures.cgst, 22.50);
  assert.equal(figures.sgst, 22.50);
  assert.equal(figures.total, 295);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).rows[0].matched, true);
});

test('invoice resolves 5% and 12% GST from HSN when gstRate is absent', () => {
  const items = [
    { name: 'Rice', hsn: '1006', price: 100, qty: 1 },
    { name: 'Ghee', hsn: '0405', price: 200, qty: 1 }
  ];
  const billed = pricing.computeTotals(items, '');
  const order = billedOrder(items);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(billed.lines.map(({ gstPercent, tax }) => [gstPercent, tax]), [[5, 5], [12, 24]]);
  assert.deepEqual([billed.tax, billed.cgst, billed.sgst, order.total], [29, 14.50, 14.50, 329]);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [[5, 5], [12, 24]]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [29, 14.50, 14.50, 329]);

  const html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹29\.00/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹329\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('a capped SAVE10 discount is allocated before GST and reconciles to the ledger', () => {
  const items = [
    { name: 'Rice', hsn: '1006', price: 500, qty: 2 },
    { name: 'Ghee', hsn: '0405', price: 1000, qty: 1 }
  ];
  const billed = pricing.computeTotals(items, 'SAVE10');
  const order = billedOrder(items, 'SAVE10');
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(billed.lines.map(({ discount, taxable, tax }) => [discount, taxable, tax]), [
    [75, 925, 46.25],
    [75, 925, 111]
  ]);
  assert.deepEqual([order.subtotal, order.discount, order.tax, order.total], [2000, 150, 157.25, 2007.25]);
  assert.deepEqual([billed.cgst, billed.sgst], [78.63, 78.62]);
  assert.deepEqual([figures.subtotal, figures.discount, figures.tax, figures.total], [2000, 150, 157.25, 2007.25]);

  const result = reports.getGstReconciliation({ orders: [order] });
  assert.equal(result.mismatchCount, 0);
  assert.equal(result.totalDelta, 0);
  assert.equal(result.rows[0].delta, 0);
  assert.equal(result.rows[0].matched, true);
});

test('invoice calculates GST after subtracting a flat coupon', () => {
  const order = billedOrder([{ name: 'Tea', hsn: '0902', price: 300, qty: 1 }], 'FLAT50');
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [50, 45, 295]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [50, 45, 295]);
});

test('invoice applies no discount for a coupon below its minimum or an inactive coupon', () => {
  const cases = [
    { coupon: 'FLAT50', price: 100 },
    { coupon: 'DIWALI20', price: 2000 }
  ];

  for (const { coupon, price } of cases) {
    const items = [{ name: 'Tea', hsn: '0902', price, qty: 1 }];
    assert.equal(coupons.validate(coupon, pricing.subtotal(items)).valid, false, coupon);
    assert.equal(pricing.computeTotals(items, coupon).discount, 0, coupon);
    assert.equal(invoice.computeInvoiceFigures({ items, coupon }).discount, 0, coupon);
  }
});

test('an invoice retains the recorded discount and GST after a coupon expires', () => {
  const order = {
    id: 2,
    items: [{ name: 'Tea', hsn: '0902', price: 2000, qty: 1 }],
    coupon: 'DIWALI20',
    subtotal: 2000,
    discount: 250,
    tax: 315,
    total: 2065
  };
  assert.equal(coupons.validate(order.coupon, order.subtotal).valid, false);

  const figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [250, 315, 2065]);
  assert.equal(figures.rows[0].lineTax, 315);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).rows[0].matched, true);
});

test('invoice respects explicit percentage, decimal, and zero GST rates', () => {
  const items = [5, 0.05, 0].map(gstRate => ({ name: 'Rice', hsn: '1006', price: 100, qty: 1, gstRate }));
  const billed = pricing.computeTotals(items, '');
  const figures = invoice.computeInvoiceFigures({ items });

  assert.deepEqual(billed.lines.map(line => line.tax), [5, 5, 0]);
  assert.deepEqual(figures.rows.map(row => row.lineTax), [5, 5, 0]);
  assert.equal(figures.tax, 10);
  assert.equal(figures.total, 310);
});

test('a saved GST rate takes precedence over the current HSN slab on reprint', () => {
  const order = {
    items: [{ name: 'Rice', hsn: '1006', price: 100, qty: 1, gstRate: 0.18 }],
    subtotal: 100,
    discount: 0,
    tax: 18,
    total: 118
  };
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [18, 9, 9, 118]);
  assert.equal(figures.rows[0].gstPercent, 18);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).rows[0].matched, true);
});

test('invoice GST sums the rounded line taxes', () => {
  const items = [
    { name: 'Tea', hsn: '0902', price: 0.03, qty: 1 },
    { name: 'Coffee', hsn: '0901', price: 0.03, qty: 1 }
  ];
  const order = billedOrder(items);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.tax, order.total], [0.02, 0.08]);
  assert.deepEqual(figures.rows.map(row => row.lineTax), [0.01, 0.01]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [0.02, 0.01, 0.01, 0.08]);
});

test('reconciliation matches both GST and total for an uncapped SAVE10 order', () => {
  const order = billedOrder([{ name: 'Tea', hsn: '0902', price: 1000, qty: 1 }], 'SAVE10');
  const result = reports.getGstReconciliation({ orders: [order] });
  const [row] = result.rows;

  assert.deepEqual([row.ledgerTotal, row.invoiceTotal], [1062, 1062]);
  assert.deepEqual([row.ledgerTax, row.invoiceTax], [162, 162]);
  assert.equal(row.matched, true);
  assert.equal(row.delta, 0);
  assert.equal(result.mismatchCount, 0);
  assert.equal(result.totalDelta, 0);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});
