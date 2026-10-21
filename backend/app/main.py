from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from app.auth import get_current_user, require_role
from app.database import supabase

app = FastAPI(title="ProctorAI API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/me")
def get_me(user: dict = Depends(get_current_user)):
    user_id = user.get("sub")
    result = supabase.table("profiles").select("*").eq("id", user_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    return result.data


@app.get("/api/student/dashboard")
def student_dashboard(user: dict = Depends(require_role("student"))):
    return {"message": "Student dashboard data", "user_id": user.get("sub")}


@app.get("/api/faculty/dashboard")
def faculty_dashboard(user: dict = Depends(require_role("faculty"))):
    return {"message": "Faculty dashboard data", "user_id": user.get("sub")}
