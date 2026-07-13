require('dotenv').config();
const express = require('express');
const { createCustomerBRouter } = require('./customer-b');
const { createCustomerCRouter } = require('./customer-c');

const app = express();
app.use('/customer-b', createCustomerBRouter());
app.use('/customer-c', createCustomerCRouter());

const port = process.env.MOCKS_PORT || 4000;
app.listen(port, () => {
  console.log(`Mock customer APIs listening on http://localhost:${port}`);
  console.log('  GET /customer-b/orders');
  console.log('  GET /customer-c/orders?page=1');
});
