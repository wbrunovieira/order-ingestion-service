/**
 * BairroBox sends no product code at all — their item is just
 * "Arroz 5kg|x1|29.90". The canonical model requires `item.sku`, so one has to be
 * produced, and the honest options are all imperfect:
 *
 *   - empty string      — rejected by the DTO, and would drop every BairroBox order
 *   - a random id       — unstable: the same product would get a new sku each poll,
 *                         which is worse than useless for anything downstream
 *   - a slug of the name — stable for as long as the name is stable
 *
 * We synthesize the slug, and namespace it so nobody mistakes it for a code the
 * customer issued: "bairrobox:arroz-5kg".
 *
 * The trade-off is stated plainly in the README: if BairroBox renames a product, its
 * sku changes and it looks like a new product downstream. That is acceptable because
 * the sku is only a within-order line identifier here, and the real fix is asking
 * them for a product code — which is exactly the kind of gap worth raising with a
 * customer rather than silently papering over.
 */
export function synthesizeSku(customerId: string, productName: string): string {
  const slug = productName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents: "Feijão" -> "Feijao"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `${customerId}:${slug}`;
}
