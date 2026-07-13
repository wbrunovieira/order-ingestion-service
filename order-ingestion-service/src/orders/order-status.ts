/**
 * The only order states the platform understands. Each customer speaks its own
 * dialect — English, Portuguese, integer codes — and config maps it onto these.
 *
 * There is deliberately no "in transit" state. BairroBox has one ("Em entrega");
 * the decision for how it lands here is documented in the README.
 */
export const ORDER_STATUSES = [
  'received',
  'picking',
  'ready',
  'delivered',
  'cancelled',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
