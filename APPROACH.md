# Pilot Pro – JSON Tool: Complete Approach Document

**Project:** PDF → Quiz JSON Extractor (Gemini-assisted)
**Target Repo Path:** `json tool/` (this folder)
**Owner:** upsc-serv-1
**Schema Version Target:** `2.0`
**Last Updated:** Jan 2026

---

## 1. Problem Statement

User uploads UPSC / state-PSC coaching test PDFs (Question Paper + Solutions). Output needed: a clean JSON file matching schema 2.0 (see `forum-gs-simulator-2026-test1.json`) which feeds the Pilot Pro quiz engine.

Current pain points:
- Watermarks, coaching names, photos, ad pages dirty the extracted text
- QP and SOL come as **two separate PDFs** that need to be merged by Q-number
- Different coaching institutes → different layouts; some are scanned (OCR needed)
- Each question needs a `subject → sectionGroup → microTopic` taxonomy tag (240-entry fixed list)
- 50–400 questions per test; manual JSON authoring is impossible at scale

User has **Gemini 3 Pro web subscription only** (no API key). So the tool must be a **prompt-builder + output-parser**, not a direct AI integration.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    REACT FRONTEND                           │
│  Upload → Pre-process → Generate Prompt → Paste Output →    │
│  Side-by-Side Review → Edit → Download JSON / MD            │
└─────────────────────────────────────────────────────────────┘
                            ↕  /api
┌─────────────────────────────────────────────────────────────┐
│                FASTAPI BACKEND                              │
│  • PyMuPDF (text-based PDFs)                                │
│  • Tesseract OCR (scanned PDFs, auto-detect)                │
│  • Regex Q.N) splitter + QP↔SOL matcher                     │
│  • Prompt builder (text + .docx export)                     │
│  • Gemini-output parser (marker-based)                      │
│  • PDF page → PNG renderer for review pane                  │
└─────────────────────────────────────────────────────────────┘
                            ↕
                  Supabase (Postgres)
        (jobs, questions, edit history, low-confidence queue)
                            ↕
                  Supabase Storage
              (uploaded PDFs, page renders)
```

**No third-party API calls from server.** All AI happens in user's Gemini web session.

---

## 3. End-to-End Workflow

### Phase A – Upload & Pre-process
1. User uploads QP PDF (required) + SOL PDF (optional) OR a single combined PDF
2. User fills **Test Metadata Form** (common for all questions in this PDF):
   - `id` (auto-suggested slug, editable)
   - `title`, `launch_year`, `institute`, `program_id`, `program_name`
   - `series`, `level`, `paperType`, `defaultMinutes`, `sourceMode`
   - `schema_version` (default `2.0`)
   - `institute_id`, `institute_name`
   - `exam_frame`: `exam_category`, `specific_exam`, `stage`, `paper`
3. **Subject scope filter** (Question 3, Option C):
   - Multi-select dropdown of 9 subjects → "Extract only these"
   - "All subjects" default
4. Backend pipeline:
   - Detect text-based vs scanned (PyMuPDF page text length heuristic)
   - If scanned → Tesseract OCR per page
   - Strip headers/footers via regex (coaching names, page numbers, "DO NOT OPEN..." etc.)
   - Drop trailing ad pages (heuristic: pages with no `Q.\d+\)` pattern after Q.N count completes)
   - Split into Q1..QN raw text blocks using `Q\.?\s*\d+[\.\)]` regex
   - If SOL PDF present, do the same and **bundle each Q's QP-block + SOL-block by number**
   - **Sanity check:** report missing Q numbers (e.g., QP has 1–100, SOL has 1–98 → flag Q99, Q100 missing)
5. Auto-chunk into batches of **30–40 questions** (default 35; user-adjustable)

### Phase B – Generate Gemini Input
For each batch, tool generates a self-contained prompt with:
1. **Role & rules** (system instructions)
2. **Output format spec** with `[Markers]` and `--- DELIMITERS ---`
3. **Full 240-entry taxonomy list**
4. **Few-shot examples** (1 standard Q, 1 statement-type Q, 1 pair-matching Q)
5. **Subject filter clause** (if user selected subset)
6. **Inconsistency check rules**
7. **The 30–40 question raw blocks** (with their bundled SOL text)

User chooses **input mode** per batch:
- **Mode A – Copy Text:** Click "Copy Prompt" → paste in Gemini chat
- **Mode B – Download .docx:** Tool generates a Word file with the same content → upload to Gemini chat with short cover prompt

The generated prompt is **editable** before copying (user can add custom instructions like "be extra careful with PYQ years" or "ignore questions about cricket").

### Phase C – Paste Gemini Output Back
1. User pastes Gemini's marker-formatted output into the response textarea
2. Tool's parser uses regex to extract each `=== QUESTION N ===` block, then the `[Field: value]` markers and `--- SECTION ---` content
3. Validation:
   - Each Q has all required markers (subject, microtopic, options, correct answer, explanation, confidence)
   - Microtopic value exists in taxonomy
   - Option count is correct (4 options usually)
   - Correct answer is one of `a/b/c/d`
4. Parsed questions saved to MongoDB linked to the upload job

### Phase D – Side-by-Side Review
- Left pane: PDF page image (PyMuPDF rendered PNG, ~1200px wide), with Q.N highlighted via heuristic crop / scroll
- Right pane: Editable form for that question:
  - Statement Lines (add/remove/reorder)
  - Options a/b/c/d (textareas)
  - Correct answer (radio)
  - Explanation (markdown editor with live preview)
  - Subject / SectionGroup / MicroTopic (cascading dropdowns from taxonomy)
  - PYQ source / year (text fields, AI-suggested)
  - Confidence display (read-only)
  - Inconsistency flag display (if any, in red)
- Top bar: "Q 23 of 100", batch info, save status
- Q-list sidebar: scrollable, with confidence color-coding (green ≥80, yellow 60–79, red <60)

### Phase E – Confidence Threshold & Re-verify
1. User sets threshold (default 80) → tool lists all Qs below threshold
2. "Re-verify with Gemini" button → tool generates a fresh prompt with **only those low-confidence questions** (rebatched to 30–40)
3. User runs in Gemini → pastes new output → tool **replaces only those questions** in the job (old version saved in edit history)
4. User can also manually fix low-confidence Qs without re-querying Gemini

### Phase F – Export & History
- **Download formats:**
  - JSON (matches sample schema 2.0)
  - Markdown (per-question readable file)
  - Word .docx (optional)
- **Edit history:** every save creates a new revision in MongoDB; user can view diffs and restore
- **Job persistence:** user can close browser, reopen later, continue from same place

---

## 4. Gemini Output Format (Strict)

All outputs from Gemini MUST follow this format. Tool's parser is regex-based and forgiving of extra whitespace.

```
=== QUESTION 1 ===
[Subject: Polity]
[SectionGroup: Institutions & Governance]
[Microtopic: Governance and Policies]
[PYQSource: UPSC]
[PYQYear: 2023]
[Confidence: 95]
[InconsistencyFlag: none]
[InconsistencyReason: ]

--- STATEMENT LINES ---
With reference to Indian polity, which of the following statements is not correct regarding the whip system in Parliament?

--- OPTIONS ---
a) The office of the Whip is mentioned neither in the Constitution of India nor in the Rules of Procedure...
b) The Minister of Home Affairs serves as the Chief Whip of the ruling party in the Lok Sabha.
c) Violation of a party whip may attract disqualification under the provisions of Tenth Schedule...
d) A political party cannot issue an enforceable whip to its members for voting in the Presidential election.

--- CORRECT ANSWER ---
b

--- EXPLANATION ---
Option b is the correct answer. A **Whip is a formal direction** issued by a political party to its legislators...
- It is an **important instrument for maintaining party discipline** in a parliamentary system.
- The term 'whip' is derived from the **old British practice** of "whipping in" lawmakers...

Statement a is correct: **The office of the Whip is not mentioned anywhere in the Constitution of India**...

=== QUESTION 2 ===
[Subject: Polity]
[SectionGroup: Constitutional Framework]
[Microtopic: Directive Principles of State Policy]
[PYQSource: ]
[PYQYear: ]
[Confidence: 90]
[InconsistencyFlag: none]
[InconsistencyReason: ]

--- STATEMENT LINES ---
Consider the following Directive Principles of State Policy (DPSPs):
I. To take steps to secure the participation of workers in the management of industries
II. Providing children the opportunities and facilities to develop in a healthy manner
III. To minimize inequalities in income, status, facilities, and opportunities.
IV. To protect and improve the environment and safeguard forests and wildlife.
How many of the above DPSPs were added to the Constitution of India through the 42nd Constitutional Amendment Act, 1976?

--- OPTIONS ---
a) Only one
b) Only two
c) Only three
d) All the four

--- CORRECT ANSWER ---
c

--- EXPLANATION ---
...
```

### Marker Rules
- `[InconsistencyFlag]` ∈ {`none`, `qp_sol_topic_mismatch`, `option_not_found_in_qp`, `q_number_suspected_swap`, `incomplete_question`, `incomplete_explanation`}
- `[Confidence]` ∈ 0–100 integer
- `[Microtopic]` MUST be one of the 240 valid entries (Gemini given the full list)
- `[PYQSource]` / `[PYQYear]` empty string if not detected
- Statement lines: each new line in `--- STATEMENT LINES ---` becomes one entry in `statementLines[]`
- Options: lines starting `a)`, `b)`, `c)`, `d)` (or `A.` etc., parser lenient)

---

## 5. JSON Schema (Output)

Final downloaded JSON exactly matches sample format. Tool maps parsed Gemini output → schema fields:

```json
{
  "id": "<from form>",
  "title": "<from form>",
  "launch_year": <from form>,
  "institute": "<from form>",
  "program_id": "<from form>",
  "program_name": "<from form>",
  "series": "<from form>",
  "level": "<from form>",
  "paperType": "<from form>",
  "defaultMinutes": <from form>,
  "sourceMode": "<from form>",
  "schema_version": "2.0",
  "institute_id": "<from form>",
  "institute_name": "<from form>",
  "exam_frame": {
    "exam_category": "cse",
    "specific_exam": null,
    "stage": "prelims",
    "paper": "pre_gs1"
  },
  "questions": [
    {
      "id": "{testId}-q01",
      "questionNumber": 1,
      "subject": "Polity",                  // from Gemini [Subject]
      "sectionGroup": "...",                // from Gemini
      "microTopic": "...",                  // from Gemini, validated against taxonomy
      "statementLines": ["..."],            // split by newline
      "questionText": "...",                // joined by space
      "options": {"a": "...", "b": "...", "c": "...", "d": "..."},
      "correctAnswer": "b",
      "explanationMarkdown": "...",
      "exam_info": {                        // populated only if PYQSource present
        "source": "UPSC",
        "year": 2023,
        "is_pyq": true
      }
    }
  ]
}
```

---

## 6. Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18, Tailwind, shadcn/ui, react-dropzone, react-markdown, axios |
| Backend | FastAPI, PyMuPDF (`fitz`), Tesseract via `pytesseract`, `python-docx` |
| DB | **Supabase (PostgreSQL)** via `supabase-py` client |
| Storage | **Supabase Storage** bucket `json-tool-pdfs` for PDFs + page renders |
| Infra | Supervisor-managed, hot-reload enabled, internal ports 8001/3000, ingress via REACT_APP_BACKEND_URL |
| AI | Gemini 3 Pro (user's web subscription, **no API integration**) |

**No third-party paid services. Tool runs fully self-contained.**

---

## 7. Backend API Surface

All routes prefixed `/api`.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/jobs` | Create new extraction job (multipart: QP PDF, optional SOL PDF, metadata JSON) |
| GET | `/jobs/{id}` | Get job status + parsed questions |
| GET | `/jobs/{id}/preview` | Get raw extracted text + Q-number sanity report |
| POST | `/jobs/{id}/prompts` | Generate Gemini prompts (returns array of batched prompts) |
| GET | `/jobs/{id}/prompts/{batchIdx}/docx` | Download .docx file for a batch |
| POST | `/jobs/{id}/parse-output` | Submit Gemini output text → parsed + validated → saved |
| GET | `/jobs/{id}/page-image/{pageNum}` | Render PDF page as PNG |
| PATCH | `/jobs/{id}/questions/{qNum}` | Update individual question fields |
| GET | `/jobs/{id}/questions?confidence_lt=80` | List low-confidence questions |
| POST | `/jobs/{id}/reverify-prompt` | Generate re-verify prompt for low-confidence Qs |
| GET | `/jobs/{id}/export?format=json|md|docx` | Download final file |
| GET | `/jobs/{id}/history` | List edit revisions |
| POST | `/jobs/{id}/restore/{revId}` | Restore to a revision |
| GET | `/taxonomy` | Get full 240-entry taxonomy |
| GET | `/jobs` | List user's jobs |
| DELETE | `/jobs/{id}` | Delete job + cleanup |

---

## 8. Supabase Schema (PostgreSQL)

All tables in `public` schema. Prefixed `jt_` to avoid clashing with existing Pilot Pro tables (cards, attempts, etc.).

```sql
-- 1. JOBS
CREATE TABLE jt_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  status          text NOT NULL DEFAULT 'created',
                  -- created | extracted | prompts_generated | partially_parsed | reviewed | exported
  qp_pdf_path     text,             -- Supabase Storage object path
  sol_pdf_path    text,
  metadata        jsonb NOT NULL,   -- full test-level metadata (id, title, exam_frame, etc.)
  total_questions int  DEFAULT 0,
  batch_size      int  DEFAULT 35,
  subject_filter  text[] DEFAULT '{}',  -- empty = all subjects
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- 2. QUESTIONS
CREATE TABLE jt_questions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                uuid NOT NULL REFERENCES jt_jobs(id) ON DELETE CASCADE,
  question_number       int  NOT NULL,
  raw_qp_text           text,
  raw_sol_text          text,
  subject               text,
  section_group         text,
  microtopic            text,
  statement_lines       jsonb DEFAULT '[]'::jsonb,
  question_text         text,
  options               jsonb DEFAULT '{}'::jsonb,   -- {a, b, c, d}
  correct_answer        text,
  explanation_markdown  text,
  pyq_source            text,
  pyq_year              int,
  is_pyq                boolean DEFAULT false,
  confidence            int,
  inconsistency_flag    text DEFAULT 'none',
  inconsistency_reason  text,
  edited                boolean DEFAULT false,
  parsed_from_gemini    boolean DEFAULT false,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now(),
  UNIQUE (job_id, question_number)
);
CREATE INDEX ON jt_questions (job_id, question_number);
CREATE INDEX ON jt_questions (job_id, confidence);
CREATE INDEX ON jt_questions (job_id, inconsistency_flag);

-- 3. PROMPT BATCHES
CREATE TABLE jt_prompt_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid NOT NULL REFERENCES jt_jobs(id) ON DELETE CASCADE,
  batch_index       int  NOT NULL,
  question_numbers  int[] NOT NULL,
  prompt_text       text NOT NULL,
  docx_path         text,
  parsed            boolean DEFAULT false,
  parsed_at         timestamptz,
  created_at        timestamptz DEFAULT now()
);
CREATE INDEX ON jt_prompt_batches (job_id, batch_index);

-- 4. EDIT HISTORY
CREATE TABLE jt_revisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES jt_jobs(id) ON DELETE CASCADE,
  question_number int  NOT NULL,
  snapshot        jsonb NOT NULL,
  source          text NOT NULL,    -- gemini | manual | reverify
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX ON jt_revisions (job_id, question_number);

-- 5. TAXONOMY (240 entries seeded once)
CREATE TABLE jt_taxonomy (
  id            serial PRIMARY KEY,
  subject       text NOT NULL,
  section_group text NOT NULL,
  microtopic    text NOT NULL,
  UNIQUE (subject, section_group, microtopic)
);

-- 6. METADATA DROPDOWN OPTIONS (user-editable)
CREATE TABLE jt_dropdown_options (
  id          serial PRIMARY KEY,
  field_name  text NOT NULL,    -- exam_category | stage | paper | level | paperType
  value       text NOT NULL,
  label       text,
  sort_order  int DEFAULT 0,
  UNIQUE (field_name, value)
);
```

**Storage bucket:** `json-tool-pdfs` (private)
- Path format: `{job_id}/qp.pdf`, `{job_id}/sol.pdf`, `{job_id}/pages/page_{n}.png`
- Signed URLs generated on demand for frontend display

**RLS:** Disabled for MVP (no auth). Will enable when auth added in Phase 3.

---

## 9. Frontend Pages

1. **`/`** – Job list (recent jobs, status badges, "New Job" button)
2. **`/new`** – Upload + metadata form
3. **`/jobs/:id/preview`** – Pre-Gemini preview (raw extracted Qs, sanity report, batch generator)
4. **`/jobs/:id/prompts`** – List of generated prompts; copy / download .docx; paste-back area
5. **`/jobs/:id/review`** – Side-by-side review (PDF page | editable Q form)
6. **`/jobs/:id/low-confidence`** – Filtered list, re-verify trigger
7. **`/jobs/:id/export`** – Download JSON / MD / DOCX

---

## 10. Implementation Phases

### Phase 1 – MVP (first delivery)
- Upload QP + SOL, metadata form (with add/remove dropdown values)
- PDF text extraction (PyMuPDF, no OCR yet — assume digital PDFs first)
- Q-splitter + QP↔SOL matcher + sanity report
- Prompt generator (text mode + .docx)
- Output paste-back + parser
- Basic side-by-side review (page image + form)
- JSON download

### Phase 2
- OCR for scanned PDFs (Tesseract)
- Confidence threshold filter + re-verify flow
- Edit history + restore
- Markdown / Word export
- Low-confidence sidebar with red/yellow/green coding
- Subject scope pre-filter

### Phase 3
- Bulk operations (re-tag all Polity Qs, etc.)
- Multi-PDF queue
- Direct integration to user's existing app (push final JSON)
- Custom output schema templates

---

## 11. Edge Cases & Handling

| Case | Handling |
|------|----------|
| Scanned PDF | Auto-detect via low text density per page → Tesseract OCR |
| Multi-column PDF | PyMuPDF "blocks" mode preserves reading order; AI cleans residuals |
| Question split across pages | Regex matcher uses `Q\.?\s*\d+[\.\)]` boundaries irrespective of page breaks |
| Tables/pairs in Qs (Q.3, Q.19) | Raw text bundled as-is; Gemini reasons & reassembles into clean statement lines |
| Image-only diagrams | Tool ignores (text-only extraction); user marks question as "has-figure" if needed |
| SOL has fewer Qs than QP | Sanity report flags missing; affected Qs sent to Gemini with empty SOL block + note |
| QP has subjective questions | Tool detects no `a) b) c) d)` → marks as "non-MCQ" for user review (skipped from JSON) |
| Coaching watermark unique per institute | Generic regex strips repeated lines appearing on >50% of pages |
| PYQ tag like "(UPSC 2023)" inline | Gemini extracts → tool maps to `exam_info.source / year / is_pyq` |
| Invalid microtopic from Gemini | Validator marks Q as "needs review", suggests closest taxonomy match (fuzzy) |
| Mixed-language PDF (English + Hindi) | Out of MVP scope; Phase 2 if needed |

---

## 12. Confidence Score Methodology

Tool asks Gemini to compute confidence per question based on:
- Clarity of QP text post-cleanup (typos, broken words → low)
- Match between SOL explanation and QP options (mismatch → low)
- Taxonomy assignment certainty (ambiguous topic → low)
- Inconsistency flag presence (any flag → max 70)

Color coding in UI:
- 🟢 Green: 80–100 (auto-accepted)
- 🟡 Yellow: 60–79 (review suggested)
- 🔴 Red: <60 OR any inconsistency flag (review required)

---

## 13. Security & Storage

- No auth in MVP (user said "simple tool, no login")
- PDFs stored in **Supabase Storage bucket `json-tool-pdfs`** (private bucket, signed URLs for frontend)
- Postgres tables prefixed `jt_` (won't clash with existing Pilot Pro app tables)
- RLS disabled in MVP (no auth) → enable in Phase 3 with user auth
- Service role key kept server-side only (`SUPABASE_SERVICE_ROLE_KEY`); frontend uses anon key only for read-only public flows
- No data sent to external services
- User's GitHub PAT and Gemini credentials never stored in tool

---

## 14. Future Enhancements (Backlog)

- Direct push of final JSON to Pilot Pro repo (GitHub PR via PAT)
- Bulk PDF processing queue
- AI-free fast mode (rules-only extraction for very clean PDFs)
- Annotation layer on PDF page image (highlight extracted Q region)
- Versioned taxonomy support (multiple syllabus profiles)
- Collaborative editing (multi-user)

---

## 15. References

- Sample JSON: `Pilots pro app/pdf and json files/forum-gs-simulator-2026-test1.json`
- Sample QP PDF: `Pilots pro app/pdf and json files/Test 1 QP GS Simulator Test 2026.pdf`
- Sample SOL PDF: `Pilots pro app/pdf and json files/Test 1 SOL GS Simulator Test 2026.pdf`
- Taxonomy: `Pilots pro app/pdf and json files/new New syllabus hierarchy json with csat.txt` (240 entries)

---

## 16. Required Environment Variables

```
# Backend (.env)
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key, server-only>
SUPABASE_BUCKET=json-tool-pdfs

# Frontend (.env)
REACT_APP_BACKEND_URL=<existing>
REACT_APP_SUPABASE_URL=<same as above>
REACT_APP_SUPABASE_ANON_KEY=<anon key>
```

User must provide:
- Supabase project URL
- Supabase service role key (for backend writes)
- Supabase anon key (for frontend if needed for direct file downloads)
- Confirmation that bucket `json-tool-pdfs` is created (or tool creates it on first run)

---

**Approved by user:** [pending]
**Implementation start:** [pending approval]
