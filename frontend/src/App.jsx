import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { ThemeProvider } from './context/ThemeContext'
import ProtectedRoute from './components/ProtectedRoute'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Signup from './pages/Signup'
import AuthCallback from './pages/AuthCallback'
import StudentDashboard from './pages/StudentDashboard'
import ExamRoom from './pages/student/ExamRoom'
import FacultyDashboard from './pages/FacultyDashboard'
import FacultyStudents from './pages/faculty/FacultyStudents'
import FacultyExams from './pages/faculty/FacultyExams'
import MonitorPage from './pages/faculty/MonitorPage'
import ReviewPage from './pages/faculty/ReviewPage'
import SessionReviewPage from './pages/faculty/SessionReviewPage'
import EvaluationPage from './pages/faculty/EvaluationPage'
import AnnotatePage from './pages/faculty/AnnotatePage'

function FacultyRoute({ children }) {
  return (
    <ProtectedRoute requiredRole="faculty">
      {children}
    </ProtectedRoute>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route
              path="/student"
              element={
                <ProtectedRoute requiredRole="student">
                  <StudentDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/student/exam/:examId"
              element={
                <ProtectedRoute requiredRole="student">
                  <ExamRoom />
                </ProtectedRoute>
              }
            />
            <Route path="/faculty" element={<FacultyRoute><FacultyDashboard /></FacultyRoute>} />
            <Route path="/faculty/students" element={<FacultyRoute><FacultyStudents /></FacultyRoute>} />
            <Route path="/faculty/exams" element={<FacultyRoute><FacultyExams /></FacultyRoute>} />
            <Route path="/faculty/monitor" element={<FacultyRoute><MonitorPage /></FacultyRoute>} />
            <Route path="/faculty/review" element={<FacultyRoute><ReviewPage /></FacultyRoute>} />
            <Route path="/faculty/review/:sessionId" element={<FacultyRoute><SessionReviewPage /></FacultyRoute>} />
            <Route path="/faculty/evaluation" element={<FacultyRoute><EvaluationPage /></FacultyRoute>} />
            <Route path="/faculty/evaluation/annotate/:sessionId" element={<FacultyRoute><AnnotatePage /></FacultyRoute>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  )
}
