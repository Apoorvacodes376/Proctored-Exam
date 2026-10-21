import { NavLink, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Users, FileText, LogOut, ShieldCheck, Radio, ClipboardList, FlaskConical } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import ThemeToggle from './ThemeToggle'

const navItems = [
  { to: '/faculty',           icon: LayoutDashboard, label: 'Dashboard', end: true },
  { to: '/faculty/students',  icon: Users,           label: 'Students' },
  { to: '/faculty/exams',     icon: FileText,        label: 'Exams' },
  { to: '/faculty/monitor',   icon: Radio,           label: 'Live Monitor' },
  { to: '/faculty/review',    icon: ClipboardList,   label: 'Review' },
  { to: '/faculty/evaluation', icon: FlaskConical,  label: 'Evaluation' },
]

export default function FacultyLayout({ children }) {
  const { profile, signOut } = useAuth()
  const navigate = useNavigate()

  async function handleSignOut() {
    await signOut()
    navigate('/')
  }

  return (
    <div className="min-h-screen flex bg-gray-50 dark:bg-gray-950 transition-colors">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
        {/* Brand */}
        <div className="px-5 py-5 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-600 flex items-center justify-center">
              <ShieldCheck size={16} strokeWidth={2} className="text-white" />
            </div>
            <span className="text-base font-bold text-amber-600 dark:text-amber-400">ProctorAI</span>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center text-amber-700 dark:text-amber-400 text-xs font-bold uppercase">
              {profile?.username?.[0] || 'F'}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-gray-900 dark:text-white truncate">{profile?.username}</p>
              <p className="text-xs text-amber-600 dark:text-amber-400">Faculty</p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {navItems.map(({ to, icon: Icon, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white'
                }`
              }
            >
              <Icon size={17} strokeWidth={1.75} />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-3 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between">
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <LogOut size={15} strokeWidth={1.75} />
            Sign Out
          </button>
          <ThemeToggle />
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col">
        {children}
      </div>
    </div>
  )
}
