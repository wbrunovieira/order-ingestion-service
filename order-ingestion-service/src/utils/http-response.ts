export interface SuccessResponse<T> {
  message: string;
  data: T;
}

export interface ErrorResponse {
  message: string;
  error: string;
  detail?: Record<string, unknown>;
}

export function success<T>(message: string, data: T): SuccessResponse<T> {
  return { message, data };
}

export function failure(
  message: string,
  error: string,
  detail?: Record<string, unknown>,
): ErrorResponse {
  return { message, error, detail };
}
