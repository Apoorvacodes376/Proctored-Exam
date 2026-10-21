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
      const { data: existing } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      if (!existing) {
        await supabase.from('profiles').insert({
          id: user.id,
          username: user.user_metadata?.full_name?.replace(/\s+/g, '').toLowerCase() || user.email.split('@')[0],
          email: user.email,
          role: 'student',
        })
        navigate('/student', { replace: true })
      } else {
        navigate(existing.role === 'faculty' ? '/faculty' : '/student', { replace: true })
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
