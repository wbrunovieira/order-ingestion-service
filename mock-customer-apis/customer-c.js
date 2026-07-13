const { Router } = require('express');
const CUSTOMER_C_ORDERS = require('./fixtures/customer-c.fixtures.json');

const WINDOW_SIZE = 4;
const STEP = 2;
const PAGE_SIZE = 2;

// Simulates GlobalGoods' paginated, rate-limited API. Requesting page=1
// starts a new "poll cycle" and advances the underlying window — like
// BairroBox, there is no cursor/since param, so consecutive cycles overlap
// unless the caller tracks what it has already seen.
function createCustomerCRouter() {
  const router = Router();
  let cursor = 0;
  let requestTimestamps = [];

  router.get('/orders', (req, res) => {
    const limit = parseInt(
      process.env.MOCKS_CUSTOMER_C_RATE_LIMIT_PER_MINUTE || '60',
      10,
    );
    const now = Date.now();
    const windowStart = now - 60_000;
    requestTimestamps = requestTimestamps.filter((t) => t > windowStart);

    if (requestTimestamps.length >= limit) {
      res.set('Retry-After', '60');
      return res
        .status(429)
        .json({ message: 'Rate limit exceeded', limit, windowSeconds: 60 });
    }
    requestTimestamps.push(now);

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const total = CUSTOMER_C_ORDERS.length;

    if (page === 1) {
      cursor = (cursor + STEP) % total;
    }

    const window = [];
    for (let i = 0; i < WINDOW_SIZE; i++) {
      window.push(CUSTOMER_C_ORDERS[(cursor + i) % total]);
    }

    const start = (page - 1) * PAGE_SIZE;
    const orders = window.slice(start, start + PAGE_SIZE);

    res.json({
      page,
      pageSize: PAGE_SIZE,
      hasMore: start + PAGE_SIZE < window.length,
      orders,
    });
  });

  return router;
}

module.exports = { createCustomerCRouter };
