-- ============================================================
-- JSON Tool – Supabase Schema
-- Apply via Supabase SQL editor or `supabase db push`
-- All tables prefixed `jt_` to avoid clashing with Pilot Pro app
-- ============================================================

-- 1. JOBS
CREATE TABLE IF NOT EXISTS jt_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  status          text NOT NULL DEFAULT 'created',
  qp_pdf_path     text,
  sol_pdf_path    text,
  metadata        jsonb NOT NULL,
  total_questions int  DEFAULT 0,
  batch_size      int  DEFAULT 35,
  subject_filter  text[] DEFAULT '{}',
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- 2. QUESTIONS
CREATE TABLE IF NOT EXISTS jt_questions (
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
  options               jsonb DEFAULT '{}'::jsonb,
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
CREATE INDEX IF NOT EXISTS idx_jt_q_job_num   ON jt_questions (job_id, question_number);
CREATE INDEX IF NOT EXISTS idx_jt_q_conf      ON jt_questions (job_id, confidence);
CREATE INDEX IF NOT EXISTS idx_jt_q_flag      ON jt_questions (job_id, inconsistency_flag);

-- 3. PROMPT BATCHES
CREATE TABLE IF NOT EXISTS jt_prompt_batches (
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
CREATE INDEX IF NOT EXISTS idx_jt_pb_job ON jt_prompt_batches (job_id, batch_index);

-- 4. EDIT HISTORY
CREATE TABLE IF NOT EXISTS jt_revisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES jt_jobs(id) ON DELETE CASCADE,
  question_number int  NOT NULL,
  snapshot        jsonb NOT NULL,
  source          text NOT NULL,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jt_rev_jobq ON jt_revisions (job_id, question_number);

-- 5. TAXONOMY
CREATE TABLE IF NOT EXISTS jt_taxonomy (
  id            serial PRIMARY KEY,
  subject       text NOT NULL,
  section_group text NOT NULL,
  microtopic    text NOT NULL,
  UNIQUE (subject, section_group, microtopic)
);

-- 6. METADATA DROPDOWN OPTIONS (user-editable)
CREATE TABLE IF NOT EXISTS jt_dropdown_options (
  id          serial PRIMARY KEY,
  field_name  text NOT NULL,
  value       text NOT NULL,
  label       text,
  sort_order  int DEFAULT 0,
  UNIQUE (field_name, value)
);

-- Seed default dropdown values
INSERT INTO jt_dropdown_options (field_name, value, label, sort_order) VALUES
  ('exam_category', 'cse', 'UPSC CSE', 10),
  ('exam_category', 'state_psc', 'State PSC', 20),
  ('exam_category', 'bpsc', 'BPSC', 30),
  ('exam_category', 'uppcs', 'UPPCS', 40),
  ('exam_category', 'mppsc', 'MPPSC', 50),
  ('exam_category', 'other', 'Other', 99),
  ('stage', 'prelims', 'Prelims', 10),
  ('stage', 'mains', 'Mains', 20),
  ('paper', 'pre_gs1', 'Prelims GS Paper 1', 10),
  ('paper', 'pre_csat', 'Prelims CSAT', 20),
  ('paper', 'mains_gs1', 'Mains GS Paper 1', 30),
  ('paper', 'mains_gs2', 'Mains GS Paper 2', 40),
  ('paper', 'mains_gs3', 'Mains GS Paper 3', 50),
  ('paper', 'mains_gs4', 'Mains GS Paper 4', 60),
  ('paper', 'mains_essay', 'Mains Essay', 70),
  ('paper', 'other', 'Other', 99),
  ('level', 'Full Test', 'Full Test', 10),
  ('level', 'Sectional Test', 'Sectional Test', 20),
  ('level', 'Subject Test', 'Subject Test', 30),
  ('level', 'PYQ', 'Previous Year Questions', 40),
  ('paperType', 'Full Length', 'Full Length', 10),
  ('paperType', 'Sectional', 'Sectional', 20),
  ('paperType', 'Topic-wise', 'Topic-wise', 30)
ON CONFLICT (field_name, value) DO NOTHING;

-- ============================================================
-- Storage bucket (run separately via Supabase dashboard or SDK)
-- ============================================================
-- INSERT INTO storage.buckets (id, name, public)
-- VALUES ('json-tool-pdfs', 'json-tool-pdfs', false)
-- ON CONFLICT (id) DO NOTHING;
