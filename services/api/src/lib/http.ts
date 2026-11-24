import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

// TS: a type alias gives a long type a short name.
export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;
export type ApiResult = APIGatewayProxyResultV2;

/** Throw this anywhere in a handler to return a clean error to the browser. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** Throw this to end a request early with a normal (non-error) response, e.g. 202 "sent for approval". */
export class Respond extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: unknown,
  ) {
    super(`HTTP ${statusCode}`);
  }
}

export function json(statusCode: number, body: unknown): ApiResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// TS: <T> is a "generic": the caller says what shape it expects back.
export function parseBody<T>(event: ApiEvent): T {
  if (!event.body) throw new HttpError(400, 'Request body is required.');
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

/**
 * Wraps a handler so HttpErrors become proper responses and anything
 * unexpected becomes a 500 without leaking details.
 */
export function handle(fn: (event: ApiEvent) => Promise<ApiResult>) {
  return async (event: ApiEvent): Promise<ApiResult> => {
    try {
      return await fn(event);
    } catch (err) {
      if (err instanceof Respond) return json(err.statusCode, err.body);
      if (err instanceof HttpError) return json(err.statusCode, { error: err.message });
      console.error('Unhandled error', err);
      return json(500, { error: 'Something went wrong. Check the API logs.' });
    }
  };
}
