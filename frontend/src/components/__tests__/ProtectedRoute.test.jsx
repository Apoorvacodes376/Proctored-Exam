import { describe, it, expect } from 'vitest'
import { routeDecision } from '../ProtectedRoute'

const session = { user: { id: 'u1' } }

describe('routeDecision (UI role guard)', () => {
  it('waits while the session or profile is loading', () => {
    expect(routeDecision({ loading: true })).toBe('loading')
  })
  it('sends signed-out visitors to login', () => {
    expect(routeDecision({ session: null, loading: false, requiredRole: 'faculty' })).toBe('/login')
  })
  it('lets each role into its own area only', () => {
    expect(routeDecision({ session, profile: { role: 'faculty' }, requiredRole: 'faculty' })).toBe('allow')
    expect(routeDecision({ session, profile: { role: 'student' }, requiredRole: 'student' })).toBe('allow')
    expect(routeDecision({ session, profile: { role: 'student' }, requiredRole: 'faculty' })).toBe('/student')
    expect(routeDecision({ session, profile: { role: 'faculty' }, requiredRole: 'student' })).toBe('/faculty')
  })
  it('treats a missing profile as a student (never as faculty)', () => {
    expect(routeDecision({ session, profile: null, requiredRole: 'faculty' })).toBe('/student')
  })
})
