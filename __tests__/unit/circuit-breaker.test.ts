import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CircuitBreaker } from '@/lib/circuit-breaker'

const makeBreaker = () =>
  new CircuitBreaker('test', {
    failureThreshold: 3,
    successThreshold: 2,
    timeout: 1000, // 1 second for fast tests
  })

const succeed = () => Promise.resolve('ok')
const fail = () => Promise.reject(new Error('failure'))

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker

  beforeEach(() => {
    breaker = makeBreaker()
  })

  it('starts in CLOSED state', () => {
    expect(breaker.getState()).toBe('CLOSED')
  })

  it('allows requests when CLOSED', async () => {
    const result = await breaker.execute(succeed)
    expect(result).toBe('ok')
    expect(breaker.getState()).toBe('CLOSED')
  })

  it('opens after failureThreshold consecutive failures', async () => {
    await expect(breaker.execute(fail)).rejects.toThrow()
    await expect(breaker.execute(fail)).rejects.toThrow()
    await expect(breaker.execute(fail)).rejects.toThrow()
    expect(breaker.getState()).toBe('OPEN')
  })

  it('rejects immediately when OPEN without calling fn', async () => {
    const spy = vi.fn().mockRejectedValue(new Error('fail'))
    // Open the circuit
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(spy)).rejects.toThrow()
    }
    spy.mockClear()
    // Now OPEN — next call should reject without calling fn
    await expect(breaker.execute(spy)).rejects.toThrow('OPEN')
    expect(spy).not.toHaveBeenCalled()
  })

  it('transitions to HALF_OPEN after timeout', async () => {
    // Open the circuit
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fail)).rejects.toThrow()
    }
    expect(breaker.getState()).toBe('OPEN')

    // Simulate time passing
    await new Promise((r) => setTimeout(r, 1100))

    // Next call should attempt (HALF_OPEN)
    await expect(breaker.execute(fail)).rejects.toThrow()
    // Still should be OPEN (failed in HALF_OPEN)
    expect(breaker.getState()).toBe('OPEN')
  })

  it('closes after successThreshold successes in HALF_OPEN', async () => {
    // Open the circuit
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fail)).rejects.toThrow()
    }
    // Wait for timeout
    await new Promise((r) => setTimeout(r, 1100))

    // First success in HALF_OPEN
    await breaker.execute(succeed)
    // Second success — should close
    await breaker.execute(succeed)
    expect(breaker.getState()).toBe('CLOSED')
  })

  it('resets failure count after a success in CLOSED state', async () => {
    // Two failures — not yet at threshold
    await expect(breaker.execute(fail)).rejects.toThrow()
    await expect(breaker.execute(fail)).rejects.toThrow()
    // One success — should reset counter
    await breaker.execute(succeed)
    // Two more failures — should not open (counter was reset)
    await expect(breaker.execute(fail)).rejects.toThrow()
    await expect(breaker.execute(fail)).rejects.toThrow()
    expect(breaker.getState()).toBe('CLOSED')
  })

  it('reopens if failure occurs in HALF_OPEN', async () => {
    // Open
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fail)).rejects.toThrow()
    }
    // Wait for timeout
    await new Promise((r) => setTimeout(r, 1100))
    // Fail in HALF_OPEN → back to OPEN
    await expect(breaker.execute(fail)).rejects.toThrow()
    expect(breaker.getState()).toBe('OPEN')
  })
})
