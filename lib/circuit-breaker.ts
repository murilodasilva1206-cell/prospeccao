import { logger } from './logger'

// ---------------------------------------------------------------------------
// Three-state circuit breaker: CLOSED → OPEN → HALF_OPEN → CLOSED
//
// CLOSED:    Normal operation; failures are counted.
// OPEN:      Requests rejected immediately without calling the target.
//            Prevents cascade failures when a downstream service is degraded.
// HALF_OPEN: After the timeout, one probe is allowed through.
//            On success: close the circuit. On failure: reopen.
// ---------------------------------------------------------------------------

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit */
  failureThreshold: number
  /** Number of successes in HALF_OPEN needed to close the circuit */
  successThreshold: number
  /** Milliseconds to wait in OPEN state before attempting HALF_OPEN */
  timeout: number
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED'
  private failureCount = 0
  private successCount = 0
  private lastFailureAt = 0

  constructor(
    private readonly name: string,
    private readonly config: CircuitBreakerConfig,
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureAt
      if (elapsed < this.config.timeout) {
        throw new Error(
          `Circuit ${this.name} is OPEN — service temporarily unavailable`,
        )
      }
      // Attempt recovery
      this.state = 'HALF_OPEN'
      this.successCount = 0
      logger.info({ circuit: this.name }, 'Circuit transitioning to HALF_OPEN')
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (err) {
      this.onFailure()
      throw err
    }
  }

  private onSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.successCount++
      if (this.successCount >= this.config.successThreshold) {
        this.state = 'CLOSED'
        this.failureCount = 0
        logger.info({ circuit: this.name }, 'Circuit CLOSED — service recovered')
      }
    } else {
      this.failureCount = 0
    }
  }

  private onFailure() {
    this.failureCount++
    this.lastFailureAt = Date.now()
    if (
      this.state !== 'OPEN' &&
      this.failureCount >= this.config.failureThreshold
    ) {
      this.state = 'OPEN'
      logger.error(
        { circuit: this.name, failureCount: this.failureCount },
        'Circuit OPEN — too many failures',
      )
    }
  }

  getState(): CircuitState {
    return this.state
  }

  /** Exposed for testing purposes only */
  _reset() {
    this.state = 'CLOSED'
    this.failureCount = 0
    this.successCount = 0
    this.lastFailureAt = 0
  }
}

/** Singleton circuit breaker for OpenRouter API calls */
export const openRouterBreaker = new CircuitBreaker('openrouter', {
  failureThreshold: 5, // open after 5 consecutive failures
  successThreshold: 2, // close after 2 successes in HALF_OPEN
  timeout: 30_000, // wait 30 seconds before probing
})
