import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'

export default function AuthCallback() {
  const navigate = useNavigate()

  useEffect(() => {
    async function handleCallback() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        navigate('/login', { replace: true })
        return
      }

      const user = session.user

      // Retry up to 5 times — the handle_new_user trigger may not have
      // fired yet when the OAuth callback lands (trigger race).
      let profile = null
      for (let i = 0; i < 5; i++) {
        const { data } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .maybeSingle()
        if (data) { profile = data; break }
        await new Promise(r => setTimeout(r, 600))
      }

      // If the trigger never fired (e.g. first OAuth login), insert the
      // profile row directly. Role defaults to 'student' for OAuth users.
      if (!profile) {
        const username =
          user.user_metadata?.full_name?.replace(/\s+/g, '').toLowerCase() ||
          user.email.split('@')[0]
        await supabase.from('profiles').insert({
          id: user.id,
          username,
          email: user.email,
          role: 'student',
        })
        navigate('/student', { replace: true })
      } else {
        navigate(profile.role === 'faculty' ? '/faculty' : '/student', { replace: true })
      }
    }

    handleCallback()
  }, [navigate])

  return (
    <div className="min-h-screen flex items-center justify-center bg-white dark:bg-gray-950">
      <Loader2 size={32} strokeWidth={1.75} className="text-green-500 animate-spin" />
    </div>
  )
}
