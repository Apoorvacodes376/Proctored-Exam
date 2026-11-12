import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { User, Mail, Lock, GraduationCap, BookOpen, AlertCircle, Info, Loader2, MailCheck, ArrowLeft } from 'lucide-react'
import { supabase } from '../lib/supabase'
import ThemeToggle from '../components/ThemeToggle'

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>
)

export default function Signup() {
  const navigate = useNavigate()
  const [form, setForm]       = useState({ username: '', email: '', password: '', role: 'student' })
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  function handleChange(e) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }))
    setError('')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    if (form.username.trim().length < 3) return setError('Username must be at least 3 characters.')
    if (form.password.length < 8)        return setError('Password must be at least 8 characters.')

    setLoading(true)

    // Pass username and role in user_metadata so the DB trigger can read them.
    // The trigger (handle_new_user) creates the profiles row — we do NOT insert
    // from the frontend because there is no INSERT policy for authenticated users
    // (the trigger runs as SECURITY DEFINER and bypasses RLS).
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: form.email,
      password: form.password,
      options: {
        data: {
          username: form.username.trim(),
          // Role is stored in user_metadata by the trigger and used by RLS policies.
          // The trigger validates it — only 'student' or 'faculty' are accepted.
          role: form.role,
        },
      },
    })

    if (signUpError) {
      setError(signUpError.message)
      setLoading(false)
      return
    }

    // If Supabase email confirmation is disabled (common in dev), data.session
    // is populated immediately. Redirect straight to the dashboard.
    if (data.session) {
      setLoading(false)
      navigate(form.role === 'faculty' ? '/faculty' : '/student', { replace: true })
      return
    }

    // Email confirmation is enabled — show the "check your email" screen.
    setLoading(false)
    setSuccess(true)
  }

  async function handleGoogle() {
    setError('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    if (error) setError(error.message)
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-gray-950 px-4">
        <div className="text-center max-w-md">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 mb-5">
            <MailCheck size={32} strokeWidth={1.5} />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Check your email</h2>
          <p className="text-gray-500 dark:text-gray-400 mb-6">
            We sent a confirmation link to{' '}
            <strong className="text-gray-700 dark:text-gray-300">{form.email}</strong>.
            Click it to activate your account.
          </p>
          <Link
            to="/login"
            className="inline-flex items-center gap-2 text-green-600 dark:text-green-400 font-medium hover:underline"
          >
            <ArrowLeft size={15} strokeWidth={1.75} />
            Back to Login
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-white dark:bg-gray-950 transition-colors">
      <div className="flex justify-between items-center px-6 py-4 max-w-6xl mx-auto w-full">
        <Link to="/" className="text-xl font-bold text-green-600 dark:text-green-400">ProctorAI</Link>
        <ThemeToggle />
      </div>

      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Create account</h1>
          <p className="text-gray-500 dark:text-gray-400 mb-8">
            Already have an account?{' '}
            <Link to="/login" className="text-green-600 dark:text-green-400 font-medium hover:underline">Sign in</Link>
          </p>

          <button
            onClick={handleGoogle}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 border border-gray-300 dark:border-gray-700 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors mb-6 font-medium"
          >
            <GoogleIcon />
            Continue with Google
          </button>

          <div className="flex items-center gap-3 mb-6">
            <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800" />
            <span className="text-xs text-gray-400">or</span>
            <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label>
              <div className="relative">
                <User size={16} strokeWidth={1.75} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                <input
                  name="username"
                  value={form.username}
                  onChange={handleChange}
                  required
                  placeholder="johndoe"
                  className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500 transition"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
              <div className="relative">
                <Mail size={16} strokeWidth={1.75} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                <input
                  name="email"
                  type="email"
                  value={form.email}
                  onChange={handleChange}
                  required
                  placeholder="you@example.com"
                  className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500 transition"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
              <div className="relative">
                <Lock size={16} strokeWidth={1.75} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                <input
                  name="password"
                  type="password"
                  value={form.password}
                  onChange={handleChange}
                  required
                  placeholder="Min. 8 characters"
                  className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500 transition"
                />
              </div>
            </div>

            {/* Role selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">I am a...</label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, role: 'student' }))}
                  className={`flex items-center justify-center gap-2 py-3 rounded-xl border-2 font-medium transition-colors ${
                    form.role === 'student'
                      ? 'border-green-500 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                      : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-400'
                  }`}
                >
                  <GraduationCap size={17} strokeWidth={1.75} />
                  Student
                </button>
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, role: 'faculty' }))}
                  className={`flex items-center justify-center gap-2 py-3 rounded-xl border-2 font-medium transition-colors ${
                    form.role === 'faculty'
                      ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
                      : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-400'
                  }`}
                >
                  <BookOpen size={17} strokeWidth={1.75} />
                  Faculty
                </button>
              </div>
              {form.role === 'faculty' && (
                <div className="flex items-start gap-2 mt-2 text-xs text-amber-600 dark:text-amber-400">
                  <Info size={13} strokeWidth={1.75} className="shrink-0 mt-0.5" />
                  Faculty accounts are activated immediately — no email confirmation needed.
                </div>
              )}
            </div>

            {error && (
              <div className="flex items-start gap-2.5 px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-600 dark:text-red-400">
                <AlertCircle size={16} strokeWidth={1.75} className="shrink-0 mt-0.5" />
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-3 bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white font-semibold rounded-xl transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 size={16} strokeWidth={1.75} className="animate-spin" />
                  Creating account...
                </>
              ) : 'Create Account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
