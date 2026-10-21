import { Link } from 'react-router-dom'
import { Video, Bot, ShieldCheck, BarChart2, Zap, Globe, ArrowRight, LogIn } from 'lucide-react'
import ThemeToggle from '../components/ThemeToggle'

const features = [
  { icon: Video,        title: 'Live Proctoring',  desc: 'Real-time webcam and screen monitoring during exams.' },
  { icon: Bot,          title: 'AI Detection',     desc: 'Automated detection of suspicious behavior and anomalies.' },
  { icon: ShieldCheck,  title: 'Secure Exams',     desc: 'Encrypted sessions with role-based access control.' },
  { icon: BarChart2,    title: 'Analytics',        desc: 'Detailed reports and insights for faculty review.' },
  { icon: Zap,          title: 'Instant Results',  desc: 'Auto-graded exams with immediate feedback.' },
  { icon: Globe,        title: 'Remote Ready',     desc: 'Fully browser-based, no software installation needed.' },
]

export default function Landing() {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 transition-colors">
      {/* Navbar */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 max-w-6xl mx-auto">
        <span className="text-xl font-bold text-green-600 dark:text-green-400">ProctorAI</span>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Link
            to="/login"
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-green-600 dark:hover:text-green-400 transition-colors"
          >
            <LogIn size={15} strokeWidth={1.75} />
            Login
          </Link>
          <Link
            to="/signup"
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors"
          >
            Sign Up
            <ArrowRight size={15} strokeWidth={1.75} />
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 py-24 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 mb-6 text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full">
          <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          AI-Powered Exam Security
        </div>
        <h1 className="text-5xl md:text-6xl font-bold tracking-tight mb-6 bg-gradient-to-br from-gray-900 to-gray-600 dark:from-white dark:to-gray-400 bg-clip-text text-transparent">
          Proctored Exams,<br />Reimagined with AI
        </h1>
        <p className="text-lg text-gray-500 dark:text-gray-400 max-w-2xl mx-auto mb-10">
          ProctorAI delivers intelligent, real-time exam monitoring that ensures academic integrity while providing a seamless experience for students and faculty.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            to="/signup"
            className="inline-flex items-center justify-center gap-2 px-8 py-3 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-green-500/20"
          >
            Get Started Free
            <ArrowRight size={16} strokeWidth={1.75} />
          </Link>
          <Link
            to="/login"
            className="inline-flex items-center justify-center gap-2 px-8 py-3 border border-gray-300 dark:border-gray-700 hover:border-green-500 dark:hover:border-green-500 text-gray-700 dark:text-gray-300 font-semibold rounded-xl transition-colors"
          >
            <LogIn size={16} strokeWidth={1.75} />
            Sign In
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
        <h2 className="text-3xl font-bold text-center mb-12 text-gray-900 dark:text-white">
          Everything you need for secure online exams
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map(({ icon: Icon, title, desc }) => (
            <div
              key={title}
              className="p-6 rounded-2xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 hover:border-green-400 dark:hover:border-green-600 transition-colors"
            >
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 mb-4">
                <Icon size={20} strokeWidth={1.75} />
              </div>
              <h3 className="font-semibold text-gray-900 dark:text-white mb-1">{title}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 dark:border-gray-800 py-6 text-center text-sm text-gray-400">
        © {new Date().getFullYear()} ProctorAI. All rights reserved.
      </footer>
    </div>
  )
}
