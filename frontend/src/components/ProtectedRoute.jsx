import { Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

/**
 * Where a visitor may go: 'loading' | 'allow' | a redirect path.
 * This only shapes the UI — the database (RLS) is what actually enforces
 * access, so a user who bypasses the router still cannot read other data.
 */
export function routeDecision({ session, profile, loading, requiredRole }) {
  if (loading) return 'loading'
  if (!session) return '/login'
  if (requiredRole && profile?.role !== requiredRole) {
    return profile?.role === 'faculty' ? '/faculty' : '/student'
  }
  return 'allow'
}

export default function ProtectedRoute({ children, requiredRole }) {
  const { session, profile, loading } = useAuth()
  const decision = routeDecision({ session, profile, loading, requiredRole })

  if (decision === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-gray-950">
        <Loader2 size={32} strokeWidth={1.75} className="text-green-500 animate-spin" />
      </div>
    )
  }
  if (decision !== 'allow') return <Navigate to={decision} replace />
  return children
}
