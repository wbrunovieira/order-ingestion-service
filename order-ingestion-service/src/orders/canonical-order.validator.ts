import { plainToInstance } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';
import { CanonicalOrderDto } from './canonical-order.dto';
import type { CanonicalOrder } from './canonical-order.model';

/** A single reason a record was rejected, pinned to the field that caused it. */
export interface FieldError {
  field: string;
  message: string;
}

export type ValidationOutcome =
  | { valid: true; order: CanonicalOrder }
  | { valid: false; errors: FieldError[] };

/**
 * class-validator nests errors by object graph. Flatten them into dotted paths
 * ("items.0.unitPrice.amount") so a failure can be reported with a field and a
 * reason rather than an opaque blob.
 */
function flattenErrors(errors: ValidationError[], path = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = path ? `${path}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => ({
      field,
      message,
    }));
    const nested = error.children?.length
      ? flattenErrors(error.children, field)
      : [];
    return [...own, ...nested];
  });
}

/**
 * The gate between "a mapper produced something" and "the platform trusts it".
 *
 * Returns an outcome rather than throwing: a record that fails validation is a
 * captured failure with reasons, and the rest of its batch must keep going.
 * Infrastructure errors throw; bad customer data does not.
 */
export function validateCanonicalOrder(candidate: unknown): ValidationOutcome {
  const instance = plainToInstance(CanonicalOrderDto, candidate);
  const errors = validateSync(instance, { whitelist: true });

  if (errors.length > 0) {
    return { valid: false, errors: flattenErrors(errors) };
  }

  // No cast: the DTO structurally satisfies CanonicalOrder, so the two cannot
  // drift apart without failing to compile.
  const order: CanonicalOrder = instance;
  return { valid: true, order };
}
