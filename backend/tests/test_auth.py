"""
Backend authentication / role checks.

Run from backend/ (with the backend venv active):  python -m unittest discover tests
No network access: the profile lookup is replaced with an in-memory table.
"""

import os
import time
import unittest
from unittest import mock

SECRET = "test-secret-not-a-real-key"
os.environ.setdefault("SUPABASE_JWT_SECRET", SECRET)
os.environ.setdefault("SUPABASE_URL", "http://localhost:54321")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl")

from fastapi.testclient import TestClient  # noqa: E402
from jose import jwt  # noqa: E402

from app import auth  # noqa: E402
from app.main import app  # noqa: E402

PROFILES = {"student-1": "student", "faculty-1": "faculty"}


def token(sub, *, user_metadata=None, exp_in=3600, secret=None, aud="authenticated"):
    claims = {"sub": sub, "aud": aud, "role": "authenticated", "exp": int(time.time()) + exp_in,
              "user_metadata": user_metadata or {}}
    return jwt.encode(claims, secret or os.environ["SUPABASE_JWT_SECRET"], algorithm="HS256")


class AuthTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(auth, "lookup_role", side_effect=lambda uid: PROFILES.get(uid))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(app)

    def get(self, path, tok=None):
        headers = {"Authorization": f"Bearer {tok}"} if tok else {}
        return self.client.get(path, headers=headers)

    def test_health_is_public(self):
        self.assertEqual(self.get("/api/health").status_code, 200)

    def test_missing_invalid_or_expired_tokens_are_rejected(self):
        self.assertIn(self.get("/api/student/dashboard").status_code, (401, 403))
        self.assertEqual(self.get("/api/student/dashboard", "not-a-jwt").status_code, 401)
        self.assertEqual(self.get("/api/student/dashboard", token("student-1", secret="wrong")).status_code, 401)
        self.assertEqual(self.get("/api/student/dashboard", token("student-1", exp_in=-60)).status_code, 401)
        self.assertEqual(self.get("/api/student/dashboard", token("student-1", aud="anon")).status_code, 401)

    def test_each_role_reaches_only_its_own_routes(self):
        self.assertEqual(self.get("/api/student/dashboard", token("student-1")).status_code, 200)
        self.assertEqual(self.get("/api/faculty/dashboard", token("student-1")).status_code, 403)
        self.assertEqual(self.get("/api/faculty/dashboard", token("faculty-1")).status_code, 200)
        self.assertEqual(self.get("/api/student/dashboard", token("faculty-1")).status_code, 403)

    def test_role_in_client_metadata_is_ignored(self):
        # The signup form puts the chosen role in user_metadata; it must not grant faculty access.
        forged = token("student-1", user_metadata={"role": "faculty"})
        self.assertEqual(self.get("/api/faculty/dashboard", forged).status_code, 403)

    def test_unknown_users_have_no_role(self):
        self.assertEqual(self.get("/api/student/dashboard", token("nobody")).status_code, 403)


if __name__ == "__main__":
    unittest.main()
