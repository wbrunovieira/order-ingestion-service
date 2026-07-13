/**
 * Point the customer config at the mock we spawn for this suite, before anything
 * imports it. customer.config.ts reads this at module load, so it has to be set in a
 * setup file rather than at the top of a test.
 */
process.env.CUSTOMER_APIS_BASE_URL = 'http://localhost:4101';
