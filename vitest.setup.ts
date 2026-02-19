import { beforeAll, afterAll, afterEach } from 'vitest'
import { server } from './__tests__/mocks/server'

// MSW: intercept fetch at the network level for all tests
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers()) // reset per-test overrides
afterAll(() => server.close())
