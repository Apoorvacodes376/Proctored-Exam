import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

export function useStudentRecord() {
  const { profile } = useAuth()
  const [student, setStudent] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!profile?.email) {
      setLoading(false)
      return
    }
    setLoading(true)
    supabase
      .from('students')
      .select('id, name, email, photo_url')
      .eq('email', profile.email)
      .maybeSingle()
      .then(({ data }) => {
        setStudent(data)
        setLoading(false)
      })
  }, [profile?.email])

  return { student, loading }
}
