# JSON Tool

PDF → Quiz JSON Extractor for the Pilot Pro quiz engine.

A self-contained web tool that:
1. Accepts coaching test PDFs (Question Paper + Solutions, separate or combined)
2. Extracts and cleans text (PyMuPDF; OCR is Phase-2)
3. Generates structured prompts for Gemini 3 Pro (user pastes into Gemini web)
4. Parses Gemini's marker-based output back
5. Provides a tabbed Review screen (edit subject, options, explanation, etc.)
6. Exports final JSON in **schema 2.0** (compatible with the existing Pilot Pro app)

**No third-party AI API costs.** Uses the user's Gemini Pro web subscription via copy-paste.

## Status

- 📋 **Approach:** see [`APPROACH.md`](./APPROACH.md)
- 🛠️ **Build progress / handoff log:** see [`PROGRESS.md`](./PROGRESS.md)
- ✅ **Step 1 MVP foundation:** complete (upload → extract → prompt → parse → export)
- ⏳ **Step 2 next-up:** side-by-side PDF preview, subject scope filter, low-confidence sidebar, OCR

## Run locally

```bash
# Backend
cd "json tool/backend"
cp .env.example .env                      # edit MONGO_URL / DB_NAME if needed
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8001 --reload

# Frontend (in another terminal)
cd "json tool/frontend"
cp .env.example .env                      # set EXPO_PUBLIC_BACKEND_URL to backend URL
yarn install
yarn web
```

On the Emergent dev pod the same code runs at `/app/backend` (FastAPI) and `/app/frontend` (Expo).
The folder layout in this repo mirrors `/app/`. See `PROGRESS.md` "Sync & push procedure".

## Tech Stack

- **Backend:** FastAPI · PyMuPDF · python-docx · pytesseract (Phase-2)
- **Frontend:** Expo (React Native + RN-Web) · expo-router
- **DB:** MongoDB (collections: `jt_jobs`, `jt_questions`, `jt_batches`, `jt_revisions`)
- **Storage:** Local FS at `backend/data/uploads/{job_id}/`

> **Why not the React + Tailwind + shadcn + Supabase stack from APPROACH.md?**
> The Emergent pod's supervisor pins port-3000 to Expo and provides MongoDB locally with no
> Supabase service-role key. The user-facing flow and the JSON output format are identical.
> See `PROGRESS.md` for the full deviation rationale.
