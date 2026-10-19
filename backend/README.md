# Ace backend (FastAPI + Gemini)

Extracts study concepts from notes. Requires a valid **Supabase user access token** (not the service role key).

## Setup (Windows PowerShell)

From the project root:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `backend\.env`:

- `GEMINI_API_KEY` — from [Google AI Studio](https://aistudio.google.com/apikey)
- `SUPABASE_URL` — your project URL (e.g. `https://YOUR_REF.supabase.co`). **Required** for ace-study ES256/JWKS access tokens.
- `SUPABASE_JWT_SECRET` — only for **legacy HS256** projects (optional if `SUPABASE_URL` is set)

Optional:

- `CORS_ORIGINS` — add your production site origin (comma-separated, no trailing slash), e.g. `https://yourdomain.com`
- `GEMINI_MODEL` — default `gemini-2.0-flash`
- `QUIZ_GRADING_SECRET` — server-only key for signing quiz grading tokens. If unset, the API derives one from `GEMINI_API_KEY` + `SUPABASE_URL` (or uses `SUPABASE_JWT_SECRET` when set).

## Run

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
uvicorn main:app --reload --host 127.0.0.1 --port 8081
```

- Health: http://127.0.0.1:8081/health  
- API docs: http://127.0.0.1:8081/docs  

Run unit tests (no network):

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

## Frontend

In `supabase-config.js` (local, gitignored), set:

```js
window.ACE_API_BASE_URL = "http://127.0.0.1:8081";
```

Serve `dashboard.html` from the same origin listed in `CORS_ORIGINS` (e.g. Live Server on port 5500).

## Security notes

- Never put `GEMINI_API_KEY` or `SUPABASE_JWT_SECRET` in frontend files.
- Do not use the Supabase **service_role** key in this backend unless you add a separate, carefully scoped feature; extract auth uses the user's JWT only.
