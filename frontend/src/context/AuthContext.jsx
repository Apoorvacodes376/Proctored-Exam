import { createContext, useContext, useEffect, useState, useRef } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  // undefined = not yet determined; null = determined, no session
  const [session, setSession]           = useState(undefined)
  const [profile, setProfile]           = useState(null)
  // Start true so ProtectedRoute never sees (session=set, profile=null, loading=false)
  const [profileLoading, setProfileLoading] = useState(true)
  const fetchingFor = useRef(null) // track which userId we're fetching to avoid stale updates

  async function fetchProfile(userId) {
    if (!userId) { setProfile(null); setProfileLoading(false); return }
    fetchingFor.current = userId
    setProfileLoading(true)

    // Retry up to 5 times with 600 ms gaps to handle the trigger race on signup
    let data = null
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: row } = await supabase
        .from('profiles')
        .select('id, username, email, role, created_at')
        .eq('id', userId)
        .maybeSingle()
      if (row) { data = row; break }
      if (attempt < 4) await new Promise(r => setTimeout(r, 600))
    }

    // Ignore stale responses if a newer fetch was started
    if (fetchingFor.current !== userId) return
    setProfile(data ?? null)
    setProfileLoading(false)
  }

  useEffect(() => {
    // Resolve the initial session once
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session ?? null)
      if (session) {
        fetchProfile(session.user.id)
      } else {
        setProfileLoading(false)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session ?? null)
      if (session) {
        fetchProfile(session.user.id)
      } else {
        fetchingFor.current = null
        setProfile(null)
        setProfileLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function signOut() {
    await supabase.auth.signOut()
  }

  // loading is true until BOTH session and profile are resolved
  const loading = session === undefined || profileLoading

  return (
    <AuthContext.Provider value={{ session, profile, signOut, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
