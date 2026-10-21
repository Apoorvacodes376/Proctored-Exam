# ProctorAI — AI-Based Online Exam Proctoring System

## Project Structure

```
Proctored-Exam/
├── frontend/          # React + Vite + Tailwind CSS
├── backend/           # Python + FastAPI
├── supabase/
│   └── schema.sql     # Database schema & RLS policies
└── README.md
```

---

## Phase 1 Features

- **Landing Page** — Hero, feature grid, responsive navbar
- **Signup** — Email/password + Google OAuth, role selection (Student / Faculty)
- **Login** — Email or username + password, Google OAuth, role-based redirect
- **Dashboards** — Separate Student (green) and Faculty (amber) dashboards
- **Themes** — Light/dark toggle, persisted in localStorage
- **Auth** — Supabase Auth with email confirmation, JWT-protected API routes
- **Security** — RLS policies, role enforcement, service role key never in frontend

---

## Prerequisites

- Node.js 18+
- Python 3.11+
- A [Supabase](https://supabase.com) project

---

## 1. Supabase Setup

1. Create a new project at [supabase.com](https://supabase.com).
2. Go to **SQL Editor** and run the contents of `supabase/schema.sql`.
3. Go to **Authentication → Providers** and enable **Google** (add your OAuth credentials).
4. Under **Authentication → URL Configuration**, add:
   - Site URL: `http://localhost:5173`
   - Redirect URL: `http://localhost:5173/auth/callback`
5. Collect your keys from **Project Settings → API**:
   - `Project URL`
   - `anon / public` key
   - `service_role` key (keep secret — backend only)
   - `JWT Secret` (under **Project Settings → API → JWT Settings**)

---

## 2. Frontend Setup

```bash
cd frontend
cp .env.example .env
```

Edit `.env`:
```
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

```bash
npm install
npm run dev
```

Frontend runs at `http://localhost:5173`.

---

## 3. Backend Setup

```bash
cd backend
cp .env.example .env
```

Edit `.env`:
```
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_JWT_SECRET=your-jwt-secret
```

```bash
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS/Linux

pip install -r requirements.txt
uvicorn app.main:app --reload
```

Backend runs at `http://localhost:8000`.  
API docs: `http://localhost:8000/docs`

---

## Security Notes

- The `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS — **never expose it in frontend code**.
- Faculty role assignment via signup is flagged for admin review (RLS prevents self-elevation).
- Google OAuth users are assigned the `student` role by default.
- All API routes requiring auth validate the Supabase JWT on the backend.

---

## Theme System

| Role    | Accent Color | 
|---------|-------------|
| Student | Green (`#16a34a`) |
| Faculty | Amber (`#d97706`) |

Theme preference (light/dark) is persisted in `localStorage`.
