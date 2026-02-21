// ---------------------------------------------------------------------------
// WhatsApp adapter error types
//
// RetryableError: thrown by adapters for transient failures that should be
//   retried with exponential backoff (HTTP 5xx, 429 rate limit, network timeout).
//
// Regular Error: permanent failures (HTTP 4xx except 429, invalid credentials,
//   bad phone number format) — mark recipient as 'failed' immediately.
// ---------------------------------------------------------------------------

export class RetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RetryableError'
  }
}
