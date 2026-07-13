const { Router } = require('express');
const CUSTOMER_B_ORDERS = require('./fixtures/customer-b.fixtures.json');

const WINDOW_SIZE = 4;
const STEP = 2;

// Simulates BairroBox's export endpoint: no "since"/cursor param, so polling
// it repeatedly returns a sliding, overlapping window of the same underlying
// rows — same as the real customer's flat file export.
function createCustomerBRouter() {
  const router = Router();
  let cursor = 0;

  router.get('/orders', (req, res) => {
    const total = CUSTOMER_B_ORDERS.length;
    const window = [];
    for (let i = 0; i < WINDOW_SIZE; i++) {
      window.push(CUSTOMER_B_ORDERS[(cursor + i) % total]);
    }
    cursor = (cursor + STEP) % total;
    res.json(window);
  });

  return router;
}

module.exports = { createCustomerBRouter };
