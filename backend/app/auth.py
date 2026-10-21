import os
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from dotenv import load_dotenv

load_dotenv()

JWT_SECRET = os.environ["SUPABASE_JWT_SECRET"]
ALGORITHM = "HS256"

bearer_scheme = HTTPBearer()


def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme)):
    token = credentials.credentials
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[ALGORITHM], audience="authenticated")
        return payload
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")


def lookup_role(user_id):
    """
    The user's role from public.profiles — the same source of truth the
    database's RLS uses. Never read the role from the token's
    user_metadata: that is set by the client (the signup form sends a
    "role" there), so trusting it let any user claim to be faculty.
    """
    if not user_id:
        return None
    from app.database import supabase  # imported lazily: needs the service-role env vars
    result = supabase.table("profiles").select("role").eq("id", user_id).maybe_single().execute()
    return (getattr(result, "data", None) or {}).get("role")


def require_role(role: str):
    def checker(user: dict = Depends(get_current_user)):
        if lookup_role(user.get("sub")) != role:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Requires {role} role")
        return user
    return checker
