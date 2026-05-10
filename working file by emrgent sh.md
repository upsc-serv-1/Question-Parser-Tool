/app/backend/server.py
Now let me build the complete backend server and frontend. I'll start with the backend:
Action: file_editor create /app/backend/server.py --file-text "\"\"\"JSON Tool — FastAPI backend.
PDF → Quiz JSON Extractor (Gemini-assisted, copy-paste flow). Schema 2.0 output.
All routes prefixed `/api`. Uses MongoDB (jt_jobs, jt_questions, jt_revisions, jt_batches).
\"\"\"
from __future__ import annotations

import io
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Dict, Any

from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import Response, JSONResponse, StreamingResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware

from services.pdf_extract import (
    extract_pages, is_scanned, repeated_line_strip, clean_lines, full_text, render_page_png,
)
from services.q_splitter import split_questions, bundle_qp_sol, chunk_into_batches
from services.prompt_builder import build_batch_prompt, load_taxonomy, build_reverify_prompt
from services.output_parser import parse_output, validate_against_taxonomy
from services.exporter import build_schema2_json, build_markdown
from services.docx_export import prompt_to_docx_bytes

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / \".env\")

UPLOADS_DIR = ROOT_DIR / \"data\" / \"uploads\"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

mongo_url = os.environ[\"MONGO_URL\"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ[\"DB_NAME\"]]

app = FastAPI(title=\"JSON Tool API\")
api = APIRouter(prefix=\"/api\")

logging.basicConfig(level=logging.INFO, format=\"%(asctime)s %(levelname)s %(name)s: %(message)s\")
logger = logging.getLogger(\"jsontool\")

# ─────────────── INSTITUTE / PROGRAM PATTERNS ────────────────────────────────

INSTITUTE_PATTERNS = [
    (\"forum_ias_official\", \"Forum IAS\", [\"forum ias\", \"forumias\"]),
    (\"pmfias_official\", \"PMF IAS\", [\"pmf ias\", \"pmfias\"]),
    (\"vision_ias_official\", \"Vision IAS\", [\"vision ias\", \"visionias\"]),
    (\"drishti_official\", \"Drishti IAS\", [\"drishti ias\", \"drishtiias\", \"drishti\"]),
    (\"upsc_official\", \"UPSC\", [\"upsc\"]),
    (\"insights_official\", \"Insights IAS\", [\"insights ias\", \"insightsias\"]),
    (\"gsbg_official\", \"GSBG\", [\"gsbg\"]),
]

PROGRAM_PATTERNS = [
    (\"gs-simulator\", \"GS Simulator\", [\"gs simulator\", \"gs-simulator\"]),
    (\"gsbg\", \"GSBG\", [\"gsbg\"]),
    (\"pyq-toolkit\", \"PYQ Toolkit\", [\"pyq toolkit\", \"pyq-toolkit\"]),
    (\"pyq-book\", \"PYQ Book\", [\"pyq book\", \"pyq-book\"]),
    (\"test-series\", \"Test Series\", [\"test series\", \"test-series\"]),
    (\"cse\", \"CSE\", [\"cse prelims\", \"cse mains\"]),
]


def auto_fill_from_filename(filename: str) -> Dict[str, Any]:
    \"\"\"Extract institute, program, and title hints from filename.\"\"\"
    name = Path(filename).stem
    lower = name.lower()
    result: Dict[str, Any] = {}

    # Institute
    for inst_id, inst_name, patterns in INSTITUTE_PATTERNS:
        if any(p in lower for p in patterns):
            result[\"institute\"] = inst_name
            result[\"institute_id\"] = inst_id
            result[\"institute_name\"] = inst_name
            break

    # Program
    for prog_id, prog_name, patterns in PROGRAM_PATTERNS:
        if any(p in lower for p in patterns):
            result[\"program_id\"] = prog_id
            result[\"program_name\"] = prog_name
            break

    # Title suggestion — clean up the filename
    title = re.sub(r'\.(pdf|PDF)$', '', name)
    title = re.sub(r'[_-]+', ' ', title).strip()
    result[\"title_suggestion\"] = title

    return result


# ───────────────────────────── Models ────────────────────────────────────────

class Metadata(BaseModel):
    id: Optional[str] = None
    title: str
    launch_year: Optional[int] = None
    institute: Optional[str] = \"\"
    program_id: Optional[str] = \"\"
    program_name: Optional[str] = \"\"
    series: Optional[str] = \"\"
    level: Optional[str] = \"\"
    paperType: Optional[str] = \"\"
    defaultMinutes: Optional[int] = None
    sourceMode: Optional[str] = \"docx-inline\"
    schema_version: Optional[str] = \"2.0\"
    institute_id: Optional[str] = None
    institute_name: Optional[str] = None
    exam_frame: Dict[str, Any] = Field(
        default_factory=lambda: {
            \"exam_category\": \"cse\",
            \"specific_exam\": None,
            \"stage\": \"prelims\",
            \"paper\": \"pre_gs1\",
        }
    )


class JobCreateResponse(BaseModel):
    id: str
    title: str
    status: str
    total_questions: int
    created_at: str


class GeneratePromptsRequest(BaseModel):
    batch_size: int = 35
    subject_filter: List[str] = []
    extra_instructions: str = \"\"


class ParseOutputRequest(BaseModel):
    output_text: str
    batch_index: Optional[int] = None


class QuestionUpdate(BaseModel):
    subject: Optional[str] = None
    section_group: Optional[str] = None
    microtopic: Optional[str] = None
    statement_lines: Optional[List[str]] = None
    options: Optional[Dict[str, str]] = None
    correct_answer: Optional[str] = None
    explanation_markdown: Optional[str] = None
    # PYQ fields
    pyq_source: Optional[str] = None
    pyq_year: Optional[int] = None
    is_pyq: Optional[bool] = None
    is_ncert: Optional[bool] = None
    pyq_exam_label: Optional[str] = None   # \"Prelims\" / \"Mains\"
    pyq_group: Optional[str] = None        # \"UPSC CSE\" / \"UPSC CDS\" / \"BPSC\" …
    source_attribution_label: Optional[str] = None
    confidence: Optional[int] = None
    inconsistency_flag: Optional[str] = None
    inconsistency_reason: Optional[str] = None


class ExportPdfRequest(BaseModel):
    font_family: str = \"sans\"
    font_size: int = 12
    columns: int = 1
    theme: str = \"modern\"
    paper_style: str = \"plain\"
    content_scope: str = \"q_options_expl\"  # q_only | q_options | q_options_expl
    answer_placement: str = \"inline\"       # inline | end
    visual_style: str = \"document\"         # document | flashcard
    qa_background_color: str = \"transparent\"
    show_toc: bool = False
    header_text: str = \"\"
    footer_text: str = \"\"
    watermark: str = \"\"


# ────────────────────────── Helpers ──────────────────────────────────────────

def slugify(s: str) -> str:
    s = (s or \"\").lower().strip()
    s = re.sub(r\"[^a-z0-9]+\", \"-\", s)
    return re.sub(r\"-+\", \"-\", s).strip(\"-\") or \"untitled\"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _get_job(job_id: str) -> Dict:
    job = await db.jt_jobs.find_one({\"id\": job_id}, {\"_id\": 0})
    if not job:
        raise HTTPException(404, f\"Job {job_id} not found\")
    return job


def _compute_pyq_flags(group: str) -> Dict[str, bool]:
    \"\"\"Compute is_upsc_cse / is_allied / is_others from group string.\"\"\"
    g = (group or \"\").strip().upper()
    is_upsc_cse = g == \"UPSC CSE\"
    is_allied = g.startswith(\"UPSC\") and g != \"UPSC CSE\"
    is_others = bool(g) and not g.startswith(\"UPSC\")
    return {\"is_upsc_cse\": is_upsc_cse, \"is_allied\": is_allied, \"is_others\": is_others}


# ─────────────────────────── Routes ──────────────────────────────────────────

@api.get(\"/\")
async def root():
    return {\"service\": \"json-tool\", \"status\": \"ok\", \"version\": \"0.2.0\"}


@api.get(\"/taxonomy\")
async def get_taxonomy():
    return {\"entries\": load_taxonomy()}


@api.get(\"/filename-hints\")
async def filename_hints(filename: str):
    \"\"\"Return auto-fill hints from a filename.\"\"\"
    return auto_fill_from_filename(filename)


@api.get(\"/jobs\")
async def list_jobs():
    cursor = db.jt_jobs.find({}, {\"_id\": 0}).sort(\"created_at\", -1)
    items = await cursor.to_list(length=500)
    return {\"items\": items}


@api.post(\"/jobs\", response_model=JobCreateResponse)
async def create_job(
    title: str = Form(...),
    metadata_json: str = Form(...),
    qp_pdf: UploadFile = File(...),
    sol_pdf: Optional[UploadFile] = File(None),
):
    import json as _json
    try:
        metadata = _json.loads(metadata_json)
    except _json.JSONDecodeError as e:
        raise HTTPException(400, f\"Invalid metadata_json: {e}\")

    if not metadata.get(\"id\"):
        metadata[\"id\"] = slugify(metadata.get(\"title\") or title)

    job_id = str(uuid.uuid4())
    job_dir = UPLOADS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    qp_path = job_dir / \"qp.pdf\"
    qp_path.write_bytes(await qp_pdf.read())
    sol_path = None
    if sol_pdf is not None:
        if getattr(sol_pdf, \"filename\", None):
            sp = job_dir / \"sol.pdf\"
            sp.write_bytes(await sol_pdf.read())
            sol_path = str(sp)

    job_doc = {
        \"id\": job_id,
        \"title\": title,
        \"status\": \"created\",
        \"metadata\": metadata,
        \"qp_pdf_path\": str(qp_path),
        \"sol_pdf_path\": sol_path,
        \"total_questions\": 0,
        \"batch_size\": 35,
        \"subject_filter\": [],
        \"created_at\": now_iso(),
        \"updated_at\": now_iso(),
    }
    await db.jt_jobs.insert_one(dict(job_doc))
    job_doc.pop(\"_id\", None)
    return JobCreateResponse(
        id=job_id, title=title, status=\"created\", total_questions=0, created_at=job_doc[\"created_at\"]
    )


@api.get(\"/jobs/{job_id}\")
async def get_job(job_id: str):
    job = await _get_job(job_id)
    qs = await db.jt_questions.find({\"job_id\": job_id}, {\"_id\": 0}).sort(\"question_number\", 1).to_list(length=2000)
    batches = await db.jt_batches.find({\"job_id\": job_id}, {\"_id\": 0}).sort(\"batch_index\", 1).to_list(length=200)
    return {\"job\": job, \"questions\": qs, \"batches\": batches}


@api.delete(\"/jobs/{job_id}\")
async def delete_job(job_id: str):
    await _get_job(job_id)
    await db.jt_questions.delete_many({\"job_id\": job_id})
    await db.jt_batches.delete_many({\"job_id\": job_id})
    await db.jt_revisions.delete_many({\"job_id\": job_id})
    await db.jt_jobs.delete_one({\"id\": job_id})
    job_dir = UPLOADS_DIR / job_id
    if job_dir.exists():
        for p in job_dir.rglob(\"*\"):
            if p.is_file():
                p.unlink()
        for p in sorted(job_dir.rglob(\"*\"), reverse=True):
            if p.is_dir():
                p.rmdir()
        job_dir.rmdir()
    return {\"deleted\": True, \"id\": job_id}


@api.get(\"/jobs/{job_id}/preview\")
async def preview_job(job_id: str):
    job = await _get_job(job_id)
    qp_pages = extract_pages(job[\"qp_pdf_path\"])
    qp_pages = repeated_line_strip(qp_pages)
    qp_text = clean_lines(full_text(qp_pages))
    qp_blocks = split_questions(qp_text)

    sol_blocks: list = []
    sol_pages: list = []
    if job.get(\"sol_pdf_path\"):
        sol_pages = extract_pages(job[\"sol_pdf_path\"])
        sol_pages = repeated_line_strip(sol_pages)
        sol_text = clean_lines(full_text(sol_pages))
        sol_blocks = split_questions(sol_text)

    bundle = bundle_qp_sol(qp_blocks, sol_blocks)
    qp_scanned = is_scanned(qp_pages)
    sol_scanned = is_scanned(sol_pages) if sol_pages else False

    await db.jt_jobs.update_one(
        {\"id\": job_id},
        {\"$set\": {
            \"total_questions\": len(bundle[\"items\"]),
            \"status\": \"extracted\",
            \"updated_at\": now_iso(),
        }},
    )
    return {
        \"items\": bundle[\"items\"][:200],
        \"items_count\": len(bundle[\"items\"]),
        \"qp_numbers\": bundle[\"qp_numbers\"],
        \"sol_numbers\": bundle[\"sol_numbers\"],
        \"missing_in_qp\": bundle[\"missing_in_qp\"],
        \"missing_in_sol\": bundle[\"missing_in_sol\"],
        \"total_qp\": bundle[\"total_qp\"],
        \"total_sol\": bundle[\"total_sol\"],
        \"qp_scanned\": qp_scanned,
        \"sol_scanned\": sol_scanned,
        \"qp_pages\": len(qp_pages),
        \"sol_pages\": len(sol_pages),
    }


@api.post(\"/jobs/{job_id}/prompts\")
async def generate_prompts(job_id: str, body: GeneratePromptsRequest):
    job = await _get_job(job_id)
    qp_pages = extract_pages(job[\"qp_pdf_path\"])
    qp_pages = repeated_line_strip(qp_pages)
    qp_text = clean_lines(full_text(qp_pages))
    qp_blocks = split_questions(qp_text)
    sol_blocks: list = []
    if job.get(\"sol_pdf_path\"):
        sp = extract_pages(job[\"sol_pdf_path\"])
        sp = repeated_line_strip(sp)
        sol_blocks = split_questions(clean_lines(full_text(sp)))
    bundle = bundle_qp_sol(qp_blocks, sol_blocks)
    items = bundle[\"items\"]
    if not items:
        raise HTTPException(400, \"No questions detected in PDF\")

    batches = chunk_into_batches(items, batch_size=body.batch_size)
    await db.jt_batches.delete_many({\"job_id\": job_id})

    out = []
    for idx, batch in enumerate(batches):
        prompt_text = build_batch_prompt(
            batch,
            batch_index=idx,
            total_batches=len(batches),
            subject_filter=body.subject_filter or None,
            extra_instructions=body.extra_instructions,
        )
        nums = [it[\"number\"] for it in batch]
        doc = {
            \"id\": str(uuid.uuid4()),
            \"job_id\": job_id,
            \"batch_index\": idx,
            \"question_numbers\": nums,
            \"prompt_text\": prompt_text,
            \"parsed\": False,
            \"parsed_at\": None,
            \"created_at\": now_iso(),
            \"char_count\": len(prompt_text),
        }
        await db.jt_batches.insert_one(dict(doc))
        doc.pop(\"_id\", None)
        out.append({k: doc[k] for k in (\"id\",\"batch_index\",\"question_numbers\",\"char_count\",\"parsed\",\"created_at\")})

    await db.jt_jobs.update_one(
        {\"id\": job_id},
        {\"$set\": {
            \"status\": \"prompts_generated\",
            \"batch_size\": body.batch_size,
            \"subject_filter\": body.subject_filter,
            \"total_questions\": len(items),
            \"updated_at\": now_iso(),
        }},
    )
    return {\"batches\": out, \"total\": len(items), \"batch_count\": len(batches)}


@api.get(\"/jobs/{job_id}/prompts/{batch_index}\")
async def get_prompt(job_id: str, batch_index: int):
    await _get_job(job_id)
    b = await db.jt_batches.find_one({\"job_id\": job_id, \"batch_index\": batch_index}, {\"_id\": 0})
    if not b:
        raise HTTPException(404, f\"Batch {batch_index} not found\")
    return b


@api.get(\"/jobs/{job_id}/prompts/{batch_index}/docx\")
async def get_prompt_docx(job_id: str, batch_index: int):
    await _get_job(job_id)
    b = await db.jt_batches.find_one({\"job_id\": job_id, \"batch_index\": batch_index}, {\"_id\": 0})
    if not b:
        raise HTTPException(404, f\"Batch {batch_index} not found\")
    data = prompt_to_docx_bytes(b[\"prompt_text\"], title=f\"Gemini Prompt Batch {batch_index + 1}\")
    return Response(
        content=data,
        media_type=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document\",
        headers={\"Content-Disposition\": f'attachment; filename=\"prompt-batch-{batch_index + 1}.docx\"'},
    )


@api.post(\"/jobs/{job_id}/parse-output\")
async def parse_output_endpoint(job_id: str, body: ParseOutputRequest):
    await _get_job(job_id)
    parsed = parse_output(body.output_text)
    tax = load_taxonomy()
    parsed[\"questions\"] = validate_against_taxonomy(parsed[\"questions\"], tax)

    saved = 0
    for q in parsed[\"questions\"]:
        n = q[\"number\"]
        existing = await db.jt_questions.find_one({\"job_id\": job_id, \"question_number\": n}, {\"_id\": 0})
        if existing:
            await db.jt_revisions.insert_one({
                \"id\": str(uuid.uuid4()),
                \"job_id\": job_id,
                \"question_number\": n,
                \"snapshot\": existing,
                \"source\": \"gemini\",
                \"created_at\": now_iso(),
            })
        pyq_source = q.get(\"pyq_source\") or \"\"
        is_pyq = bool(pyq_source)
        pyq_group = q.get(\"pyq_group\") or \"\"
        pyq_flags = _compute_pyq_flags(pyq_group)
        doc = {
            \"id\": existing[\"id\"] if existing else str(uuid.uuid4()),
            \"job_id\": job_id,
            \"question_number\": n,
            \"subject\": q.get(\"subject\"),
            \"section_group\": q.get(\"section_group\"),
            \"microtopic\": q.get(\"microtopic\"),
            \"microtopic_valid\": q.get(\"microtopic_valid\", False),
            \"microtopic_known\": q.get(\"microtopic_known\", False),
            \"statement_lines\": q.get(\"statement_lines\", []),
            \"question_text\": q.get(\"question_text\", \"\"),
            \"options\": q.get(\"options\", {}),
            \"correct_answer\": q.get(\"correct_answer\"),
            \"explanation_markdown\": q.get(\"explanation_markdown\"),
            # PYQ fields
            \"pyq_source\": pyq_source,
            \"pyq_year\": q.get(\"pyq_year\"),
            \"is_pyq\": is_pyq,
            \"is_ncert\": q.get(\"is_ncert\", False),
            \"pyq_exam_label\": q.get(\"pyq_exam_label\", \"\"),
            \"pyq_group\": pyq_group,
            \"source_attribution_label\": q.get(\"source_attribution_label\", \"\"),
            **pyq_flags,
            \"confidence\": q.get(\"confidence\", 0),
            \"inconsistency_flag\": q.get(\"inconsistency_flag\", \"none\"),
            \"inconsistency_reason\": q.get(\"inconsistency_reason\", \"\"),
            \"edited\": False,
            \"parsed_from_gemini\": True,
            \"created_at\": existing[\"created_at\"] if existing else now_iso(),
            \"updated_at\": now_iso(),
        }
        await db.jt_questions.update_one(
            {\"job_id\": job_id, \"question_number\": n},
            {\"$set\": doc},
            upsert=True,
        )
        saved += 1

    if body.batch_index is not None:
        await db.jt_batches.update_one(
            {\"job_id\": job_id, \"batch_index\": body.batch_index},
            {\"$set\": {\"parsed\": True, \"parsed_at\": now_iso()}},
        )

    total_parsed = await db.jt_questions.count_documents({\"job_id\": job_id})
    job = await _get_job(job_id)
    new_status = \"reviewed\" if total_parsed >= job.get(\"total_questions\", 0) else \"partially_parsed\"
    await db.jt_jobs.update_one({\"id\": job_id}, {\"$set\": {\"status\": new_status, \"updated_at\": now_iso()}})

    return {
        \"saved\": saved,
        \"errors\": parsed[\"errors\"],
        \"skipped\": parsed[\"skipped\"],
        \"total_parsed_in_job\": total_parsed,
    }


@api.patch(\"/jobs/{job_id}/questions/{q_num}\")
async def update_question(job_id: str, q_num: int, body: QuestionUpdate):
    await _get_job(job_id)
    existing = await db.jt_questions.find_one({\"job_id\": job_id, \"question_number\": q_num}, {\"_id\": 0})
    if not existing:
        raise HTTPException(404, f\"Question {q_num} not found\")
    await db.jt_revisions.insert_one({
        \"id\": str(uuid.uuid4()),
        \"job_id\": job_id,
        \"question_number\": q_num,
        \"snapshot\": existing,
        \"source\": \"manual\",
        \"created_at\": now_iso(),
    })
    update = {k: v for k, v in body.dict(exclude_unset=True).items() if v is not None}
    update[\"edited\"] = True
    update[\"updated_at\"] = now_iso()
    if \"microtopic\" in update or \"subject\" in update or \"section_group\" in update:
        tax = load_taxonomy()
        triple = (
            update.get(\"subject\", existing.get(\"subject\")),
            update.get(\"section_group\", existing.get(\"section_group\")),
            update.get(\"microtopic\", existing.get(\"microtopic\")),
        )
        update[\"microtopic_valid\"] = triple in {(t[\"subject\"], t[\"sectionGroup\"], t[\"microTopic\"]) for t in tax}
    # Recompute PYQ flags if group changes
    if \"pyq_group\" in update:
        flags = _compute_pyq_flags(update[\"pyq_group\"])
        update.update(flags)
    # Auto-build source attribution label
    if (\"pyq_group\" in update or \"pyq_year\" in update or \"pyq_exam_label\" in update) and not update.get(\"source_attribution_label\"):
        group = update.get(\"pyq_group\", existing.get(\"pyq_group\", \"\"))
        year = update.get(\"pyq_year\", existing.get(\"pyq_year\"))
        label = update.get(\"pyq_exam_label\", existing.get(\"pyq_exam_label\", \"Prelims\"))
        if group and year:
            update[\"source_attribution_label\"] = f\"{group} {label} {year}\"

    await db.jt_questions.update_one(
        {\"job_id\": job_id, \"question_number\": q_num},
        {\"$set\": update},
    )
    q = await db.jt_questions.find_one({\"job_id\": job_id, \"question_number\": q_num}, {\"_id\": 0})
    return q


@api.get(\"/jobs/{job_id}/questions\")
async def list_questions(job_id: str, confidence_lt: Optional[int] = None):
    await _get_job(job_id)
    query: Dict[str, Any] = {\"job_id\": job_id}
    if confidence_lt is not None:
        query[\"confidence\"] = {\"$lt\": confidence_lt}
    qs = await db.jt_questions.find(query, {\"_id\": 0}).sort(\"question_number\", 1).to_list(length=2000)
    return {\"items\": qs}


@api.get(\"/jobs/{job_id}/page-image/{page_num}\")
async def page_image(job_id: str, page_num: int, source: str = \"qp\"):
    job = await _get_job(job_id)
    path = job.get(\"qp_pdf_path\") if source == \"qp\" else job.get(\"sol_pdf_path\")
    if not path:
        raise HTTPException(404, f\"No {source.upper()} PDF for job\")
    try:
        png = render_page_png(path, page_num)
    except IndexError as e:
        raise HTTPException(404, str(e))
    return Response(content=png, media_type=\"image/png\")


@api.get(\"/jobs/{job_id}/export\")
async def export_job(job_id: str, format: str = \"json\"):
    job = await _get_job(job_id)
    qs = await db.jt_questions.find({\"job_id\": job_id}, {\"_id\": 0}).sort(\"question_number\", 1).to_list(length=2000)
    if format == \"json\":
        data = build_schema2_json(job, qs)
        return JSONResponse(data)
    if format == \"md\":
        text = build_markdown(job, qs)
        return Response(content=text, media_type=\"text/markdown\",
                        headers={\"Content-Disposition\": f'attachment; filename=\"{job[\"metadata\"].get(\"id\",\"job\")}.md\"'})
    if format == \"docx\":
        data = _build_output_docx(job, qs)
        fname = f'{job[\"metadata\"].get(\"id\",\"job\")}.docx'
        return Response(
            content=data,
            media_type=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document\",
            headers={\"Content-Disposition\": f'attachment; filename=\"{fname}\"'},
        )
    raise HTTPException(400, f\"Unsupported format: {format}\")


@api.post(\"/jobs/{job_id}/export/pdf\")
async def export_pdf(job_id: str, body: ExportPdfRequest):
    \"\"\"Generate a styled PDF using reportlab. Returns file bytes.\"\"\"
    job = await _get_job(job_id)
    qs = await db.jt_questions.find({\"job_id\": job_id}, {\"_id\": 0}).sort(\"question_number\", 1).to_list(length=2000)
    pdf_bytes = _build_output_pdf(job, qs, body)
    fname = f'{job[\"metadata\"].get(\"id\",\"job\")}.pdf'
    return Response(
        content=pdf_bytes,
        media_type=\"application/pdf\",
        headers={\"Content-Disposition\": f'attachment; filename=\"{fname}\"'},
    )


# ─────────────── PDF Generator ───────────────────────────────────────────────

THEME_COLORS = {
    \"modern\":    {\"bg\": (255,255,255), \"fg\": (15,23,42),   \"accent\": (16,185,129), \"rule\": (226,232,240)},
    \"classic\":   {\"bg\": (255,255,255), \"fg\": (17,17,17),   \"accent\": (29,78,216),  \"rule\": (229,231,235)},
    \"sepia\":     {\"bg\": (247,239,225), \"fg\": (59,42,24),   \"accent\": (154,52,18),  \"rule\": (217,199,163)},
    \"historical\":{\"bg\": (247,239,225), \"fg\": (59,42,24),   \"accent\": (154,52,18),  \"rule\": (217,199,163)},
    \"dark\":      {\"bg\": (11,15,23),    \"fg\": (229,231,235), \"accent\": (96,165,250), \"rule\": (31,41,55)},
}


def _rgb(tup):
    from reportlab.lib.colors import Color
    return Color(tup[0]/255, tup[1]/255, tup[2]/255)


def _build_output_pdf(job: Dict, questions: List[Dict], opts: ExportPdfRequest) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable, PageBreak
    )
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.colors import HexColor, Color
    from reportlab.lib.enums import TA_LEFT, TA_CENTER

    buf = io.BytesIO()
    md = job.get(\"metadata\") or {}
    colors = THEME_COLORS.get(opts.theme, THEME_COLORS[\"modern\"])
    accent_c = _rgb(colors[\"accent\"])
    fg_c = _rgb(colors[\"fg\"])
    rule_c = _rgb(colors[\"rule\"])

    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        rightMargin=14*mm, leftMargin=14*mm, topMargin=18*mm, bottomMargin=18*mm,
        title=md.get(\"title\", \"\"),
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(\"Title\", parent=styles[\"Heading1\"],
        textColor=accent_c, fontSize=opts.font_size + 10, spaceAfter=4, alignment=TA_LEFT)
    meta_style  = ParagraphStyle(\"Meta\", parent=styles[\"Normal\"],
        textColor=accent_c, fontSize=opts.font_size - 2, spaceAfter=8)
    q_style     = ParagraphStyle(\"QStem\", parent=styles[\"Normal\"],
        textColor=fg_c, fontSize=opts.font_size, fontName=\"Helvetica-Bold\", spaceAfter=2, leading=opts.font_size*1.4)
    opt_style   = ParagraphStyle(\"Opt\", parent=styles[\"Normal\"],
        textColor=fg_c, fontSize=opts.font_size - 1, leftIndent=10, spaceAfter=1, leading=opts.font_size*1.3)
    ans_style   = ParagraphStyle(\"Ans\", parent=styles[\"Normal\"],
        textColor=accent_c, fontSize=opts.font_size - 1, fontName=\"Helvetica-Bold\", spaceAfter=2)
    expl_style  = ParagraphStyle(\"Expl\", parent=styles[\"Normal\"],
        textColor=fg_c, fontSize=opts.font_size - 2, spaceAfter=4, leading=opts.font_size*1.35)

    story = []

    # Cover / Test metadata block
    story.append(Paragraph(md.get(\"title\", job.get(\"title\", \"Test\")), title_style))
    meta_parts = []
    if md.get(\"institute\"):
        meta_parts.append(f\"Institute: {md['institute']}\")
    if md.get(\"program_name\"):
        meta_parts.append(f\"Program: {md['program_name']}\")
    if md.get(\"series\"):
        meta_parts.append(f\"Series: {md['series']}\")
    if md.get(\"launch_year\"):
        meta_parts.append(f\"Year: {md['launch_year']}\")
    if md.get(\"level\"):
        meta_parts.append(f\"Level: {md['level']}\")
    total_qs = len(questions)
    meta_parts.append(f\"Total Questions: {total_qs}\")
    if md.get(\"defaultMinutes\"):
        meta_parts.append(f\"Duration: {md['defaultMinutes']} min\")
    if meta_parts:
        story.append(Paragraph(\"  |  \".join(meta_parts), meta_style))
    story.append(HRFlowable(width=\"100%\", color=rule_c, thickness=1, spaceAfter=8))

    # Separate answer key if needed
    answer_key = []

    sorted_qs = sorted(questions, key=lambda x: x.get(\"question_number\", 0))

    if opts.visual_style == \"flashcard\":
        # Flashcard: Q on left, Answer+Expl on right, 2-col table
        for q in sorted_qs:
            n = q.get(\"question_number\")
            stem = \" \".join(q.get(\"statement_lines\") or [q.get(\"question_text\",\"\")]).strip()
            opts_dict = q.get(\"options\") or {}
            correct = (q.get(\"correct_answer\") or \"\").upper()
            expl = q.get(\"explanation_markdown\") or \"\"

            q_cell = [Paragraph(f\"<b>Q{n}.</b> {stem}\", q_style)]
            if opts.content_scope in (\"q_options\", \"q_options_expl\"):
                for k in (\"a\",\"b\",\"c\",\"d\"):
                    if opts_dict.get(k):
                        q_cell.append(Paragraph(f\"<b>{k.upper()})</b> {opts_dict[k]}\", opt_style))

            a_cell = []
            if opts.answer_placement == \"inline\":
                if correct:
                    a_cell.append(Paragraph(f\"<b>Answer: {correct}</b>\", ans_style))
            if opts.content_scope == \"q_options_expl\" and expl:
                a_cell.append(Paragraph(expl[:800], expl_style))

            tbl = Table([[q_cell, a_cell]], colWidths=[\"50%\",\"50%\"])
            tbl.setStyle(TableStyle([
                (\"VALIGN\", (0,0), (-1,-1), \"TOP\"),
                (\"BOX\", (0,0), (-1,-1), 0.5, rule_c),
                (\"INNERGRID\", (0,0), (-1,-1), 0.5, rule_c),
                (\"BACKGROUND\", (0,0), (0,-1), _rgb(colors[\"rule\"])),
                (\"LEFTPADDING\", (0,0), (-1,-1), 6),
                (\"RIGHTPADDING\", (0,0), (-1,-1), 6),
                (\"TOPPADDING\", (0,0), (-1,-1), 4),
                (\"BOTTOMPADDING\", (0,0), (-1,-1), 4),
            ]))
            story.append(tbl)
            story.append(Spacer(1, 4))

    else:
        # Normal document layout
        for i, q in enumerate(sorted_qs):
            n = q.get(\"question_number\")
            stem_lines = q.get(\"statement_lines\") or [q.get(\"question_text\",\"\")]
            stem = \"<br/>\".join(stem_lines).strip()
            opts_dict = q.get(\"options\") or {}
            correct = (q.get(\"correct_answer\") or \"\").upper()
            expl = q.get(\"explanation_markdown\") or \"\"
            is_pyq = q.get(\"is_pyq\", False)
            pyq_label = q.get(\"source_attribution_label\") or q.get(\"pyq_group\",\"\")

            story.append(Paragraph(f\"<b>Q{n}.</b> {stem}\", q_style))
            if pyq_label and is_pyq:
                story.append(Paragraph(f\"[{pyq_label}]\", meta_style))

            if opts.content_scope in (\"q_options\",\"q_options_expl\"):
                for k in (\"a\",\"b\",\"c\",\"d\"):
                    if opts_dict.get(k):
                        story.append(Paragraph(f\"<b>{k.upper()})</b> {opts_dict[k]}\", opt_style))

            if opts.answer_placement == \"inline\" and correct:
                story.append(Paragraph(f\"<b>Correct Answer: {correct}</b>\", ans_style))
            elif opts.answer_placement == \"end\" and correct:
                answer_key.append((n, correct))

            if opts.content_scope == \"q_options_expl\" and expl:
                story.append(Spacer(1, 2))
                story.append(Paragraph(\"<b>Explanation:</b>\", ans_style))
                story.append(Paragraph(expl[:2000], expl_style))

            story.append(HRFlowable(width=\"100%\", color=rule_c, thickness=0.5, spaceAfter=4))
            story.append(Spacer(1, 4))

    # Answer key at end
    if answer_key:
        story.append(PageBreak())
        story.append(Paragraph(\"Answer Key\", title_style))
        story.append(HRFlowable(width=\"100%\", color=rule_c, thickness=1, spaceAfter=8))
        for num, ans in answer_key:
            story.append(Paragraph(f\"Q{num}: <b>{ans}</b>\", opt_style))
        story.append(Spacer(1, 8))

    doc.build(story)
    return buf.getvalue()


def _build_output_docx(job: Dict, questions: List[Dict]) -> bytes:
    from docx import Document
    from docx.shared import Pt, RGBColor, Inches
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    md = job.get(\"metadata\") or {}
    buf = io.BytesIO()
    document = Document()

    # Title
    title_p = document.add_heading(md.get(\"title\", job.get(\"title\", \"Test\")), level=1)

    # Test metadata
    meta_parts = []
    if md.get(\"institute\"):
        meta_parts.append(f\"Institute: {md['institute']}\")
    if md.get(\"program_name\"):
        meta_parts.append(f\"Program: {md['program_name']}\")
    if md.get(\"launch_year\"):
        meta_parts.append(f\"Year: {md['launch_year']}\")
    meta_parts.append(f\"Total Questions: {len(questions)}\")
    if meta_parts:
        p = document.add_paragraph(\"  |  \".join(meta_parts))
        p.style = document.styles[\"Body Text\"]

    document.add_paragraph(\"─\" * 60)

    sorted_qs = sorted(questions, key=lambda x: x.get(\"question_number\", 0))
    for q in sorted_qs:
        n = q.get(\"question_number\")
        stem_lines = q.get(\"statement_lines\") or [q.get(\"question_text\",\"\")]
        stem = \" \".join(stem_lines).strip()
        opts_dict = q.get(\"options\") or {}
        correct = (q.get(\"correct_answer\") or \"\").upper()
        expl = q.get(\"explanation_markdown\") or \"\"
        is_pyq = q.get(\"is_pyq\", False)
        pyq_label = q.get(\"source_attribution_label\") or \"\"

        q_para = document.add_paragraph()
        q_run = q_para.add_run(f\"Q{n}. \")
        q_run.bold = True
        q_para.add_run(stem)

        if pyq_label and is_pyq:
            pq_p = document.add_paragraph(f\"[{pyq_label}]\")
            pq_p.runs[0].italic = True

        for k in (\"a\",\"b\",\"c\",\"d\"):
            if opts_dict.get(k):
                opt_p = document.add_paragraph(style=\"List Bullet\")
                opt_run = opt_p.add_run(f\"{k.upper()}) \")
                opt_run.bold = True
                opt_p.add_run(opts_dict[k])

        if correct:
            ans_p = document.add_paragraph()
            ans_run = ans_p.add_run(f\"Correct Answer: {correct}\")
            ans_run.bold = True

        if expl:
            expl_p = document.add_paragraph()
            expl_run = expl_p.add_run(\"Explanation: \")
            expl_run.bold = True
            expl_p.add_run(expl)

        document.add_paragraph(\"─\" * 40)

    document.save(buf)
    return buf.getvalue()


@api.post(\"/jobs/{job_id}/reverify-prompt\")
async def reverify_prompt(job_id: str, threshold: int = 80):
    await _get_job(job_id)
    qs = await db.jt_questions.find(
        {\"job_id\": job_id, \"confidence\": {\"$lt\": threshold}}, {\"_id\": 0}
    ).sort(\"question_number\", 1).to_list(length=2000)
    if not qs:
        return {\"prompt\": \"\", \"count\": 0}
    items = []
    prev_micros: Dict[int, str] = {}
    job = await _get_job(job_id)
    qp_pages = extract_pages(job[\"qp_pdf_path\"])
    qp_pages = repeated_line_strip(qp_pages)
    qp_blocks = {b[\"number\"]: b[\"text\"] for b in split_questions(clean_lines(full_text(qp_pages)))}
    sol_blocks_map: Dict[int, str] = {}
    if job.get(\"sol_pdf_path\"):
        sp = repeated_line_strip(extract_pages(job[\"sol_pdf_path\"]))
        sol_blocks_map = {b[\"number\"]: b[\"text\"] for b in split_questions(clean_lines(full_text(sp)))}
    for q in qs:
        n = q[\"question_number\"]
        items.append({\"number\": n, \"qp_text\": qp_blocks.get(n, \"\"), \"sol_text\": sol_blocks_map.get(n)})
        if q.get(\"microtopic\"):
            prev_micros[n] = q[\"microtopic\"]
    prompt = build_reverify_prompt(items, prev_micros)
    return {\"prompt\": prompt, \"count\": len(items), \"question_numbers\": [it[\"number\"] for it in items]}


# ──────────────────────── App wiring ─────────────────────────────────────────

app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=[\"*\"],
    allow_methods=[\"*\"],
    allow_headers=[\"*\"],
)


@app.on_event(\"shutdown\")
async def shutdown_db_client():
    client.close()
"
Observation: Overwrite successful: /app/backend/server.py


Xxxx


/app/backend/services/exporter.py
Now let me update the exporter to handle the full exam_info schema:
Action: file_editor create /app/backend/services/exporter.py --file-text "\"\"\"Export job → final JSON in schema 2.0 (matches sample schema).\"\"\"
from __future__ import annotations
from typing import Dict, List, Any


def _compute_pyq_flags(group: str) -> Dict[str, bool]:
    g = (group or \"\").strip().upper()
    return {
        \"is_upsc_cse\": g == \"UPSC CSE\",
        \"is_allied\": g.startswith(\"UPSC\") and g != \"UPSC CSE\",
        \"is_others\": bool(g) and not g.startswith(\"UPSC\"),
    }


def build_schema2_json(job: Dict, questions: List[Dict]) -> Dict[str, Any]:
    \"\"\"Build the schema 2.0 JSON given a job document and its questions.\"\"\"
    md = job.get(\"metadata\") or {}
    test_id = md.get(\"id\") or job.get(\"id\") or \"untitled\"
    exam_frame = md.get(\"exam_frame\") or {
        \"exam_category\": \"cse\",
        \"specific_exam\": None,
        \"stage\": \"prelims\",
        \"paper\": \"pre_gs1\",
    }

    out_questions = []
    for q in sorted(questions, key=lambda x: x.get(\"question_number\", 0)):
        n = q.get(\"question_number\")
        statement_lines = q.get(\"statement_lines\") or []
        if not statement_lines and q.get(\"question_text\"):
            statement_lines = [q[\"question_text\"]]
        question_text = q.get(\"question_text\") or \" \".join(statement_lines)
        opts = q.get(\"options\") or {}

        is_pyq = bool(q.get(\"is_pyq\") or q.get(\"pyq_source\"))
        pyq_group = q.get(\"pyq_group\") or \"\"
        pyq_flags = _compute_pyq_flags(pyq_group)

        # Build source_attribution_label if not set
        sal = q.get(\"source_attribution_label\") or \"\"
        if not sal and is_pyq and pyq_group and q.get(\"pyq_year\"):
            exam_label = q.get(\"pyq_exam_label\") or \"Prelims\"
            sal = f\"{pyq_group} {exam_label} {q['pyq_year']}\"

        exam_info = {
            \"isPyq\": is_pyq,
            \"is_ncert\": bool(q.get(\"is_ncert\")),
            \"exam\": q.get(\"pyq_exam_label\") or (q.get(\"pyq_source\") if is_pyq else None),
            \"group\": pyq_group or None,
            \"year\": q.get(\"pyq_year\") or None,
            \"is_upsc_cse\": pyq_flags[\"is_upsc_cse\"],
            \"is_allied\": pyq_flags[\"is_allied\"],
            \"is_others\": pyq_flags[\"is_others\"],
            \"exam_category\": exam_frame.get(\"exam_category\"),
            \"specific_exam\": exam_frame.get(\"specific_exam\"),
            \"stage\": exam_frame.get(\"stage\"),
            \"paper\": exam_frame.get(\"paper\"),
        }

        q_out: Dict[str, Any] = {
            \"id\": f\"{test_id}-q{n:02d}\",
            \"questionNumber\": n,
            \"subject\": q.get(\"subject\") or \"\",
            \"sectionGroup\": q.get(\"section_group\") or \"\",
            \"microTopic\": q.get(\"microtopic\") or \"\",
            \"statementLines\": statement_lines,
            \"questionText\": question_text,
            \"options\": {
                \"a\": opts.get(\"a\", \"\"),
                \"b\": opts.get(\"b\", \"\"),
                \"c\": opts.get(\"c\", \"\"),
                \"d\": opts.get(\"d\", \"\"),
            },
            \"correctAnswer\": q.get(\"correct_answer\") or \"\",
            \"explanationMarkdown\": q.get(\"explanation_markdown\") or \"\",
            \"exam_info\": exam_info,
        }
        if sal:
            q_out[\"source_attribution_label\"] = sal
        out_questions.append(q_out)

    final = {
        \"id\": test_id,
        \"title\": md.get(\"title\", job.get(\"title\", \"\")),
        \"launch_year\": md.get(\"launch_year\"),
        \"institute\": md.get(\"institute\", \"\"),
        \"program_id\": md.get(\"program_id\", \"\"),
        \"program_name\": md.get(\"program_name\", \"\"),
        \"series\": md.get(\"series\", \"\"),
        \"level\": md.get(\"level\", \"\"),
        \"paperType\": md.get(\"paperType\", \"\"),
        \"defaultMinutes\": md.get(\"defaultMinutes\"),
        \"sourceMode\": md.get(\"sourceMode\", \"docx-inline\"),
        \"schema_version\": md.get(\"schema_version\", \"2.0\"),
        \"institute_id\": md.get(\"institute_id\"),
        \"institute_name\": md.get(\"institute_name\"),
        \"exam_frame\": exam_frame,
        \"questions\": out_questions,
    }
    return final


def build_markdown(job: Dict, questions: List[Dict]) -> str:
    md = job.get(\"metadata\") or {}
    out = [f\"# {md.get('title') or job.get('title','')}\", \"\"]
    out.append(f\"- Institute: {md.get('institute','')}\")
    out.append(f\"- Program: {md.get('program_name','')}\")
    out.append(f\"- Total questions: {len(questions)}\")
    out.append(\"\")
    for q in sorted(questions, key=lambda x: x.get(\"question_number\", 0)):
        n = q.get(\"question_number\")
        pyq_tag = f\" [PYQ: {q.get('source_attribution_label') or q.get('pyq_group','')}]\" if q.get(\"is_pyq\") else \"\"
        out.append(f\"## Q{n}. ({q.get('subject','?')} → {q.get('section_group','?')} → {q.get('microtopic','?')}){pyq_tag}\")
        for line in q.get(\"statement_lines\") or []:
            out.append(line)
        out.append(\"\")
        opts = q.get(\"options\") or {}
        for k in (\"a\", \"b\", \"c\", \"d\"):
            out.append(f\"- {k}) {opts.get(k,'')}\")
        out.append(\"\")
        out.append(f\"**Correct:** {q.get('correct_answer','')}    **Confidence:** {q.get('confidence',0)}\")
        out.append(\"\")
        out.append(\"**Explanation:**\")
        out.append(q.get(\"explanation_markdown\") or \"\")
        out.append(\"\")
    return \"\n\".join(out)
"
Observation: Overwrite successful: /app/backend/services/exporter.py


Now let me create the complete React frontend for the JSON tool. I'll build all pages in parallel:
Created /app/frontend/src/api.js

Now let me create the complete React frontend for the JSON tool. I'll build all pages in parallel:
Action: file_editor create /app/frontend/src/api.js --file-text "// Centralised API helper for JSON Tool
const BASE = process.env.REACT_APP_BACKEND_URL || \"\";

async function jsonFetch(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      \"Content-Type\": \"application/json\",
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${r.status} ${r.statusText}: ${text}`);
  }
  return r.json();
}

export const api = {
  base: BASE,
  health: () => jsonFetch(\"/api/\"),
  taxonomy: () => jsonFetch(\"/api/taxonomy\"),
  filenameHints: (filename) => jsonFetch(`/api/filename-hints?filename=${encodeURIComponent(filename)}`),
  listJobs: () => jsonFetch(\"/api/jobs\"),
  getJob: (id) => jsonFetch(`/api/jobs/${id}`),
  deleteJob: (id) => jsonFetch(`/api/jobs/${id}`, { method: \"DELETE\" }),
  preview: (id) => jsonFetch(`/api/jobs/${id}/preview`),
  generatePrompts: (id, body) => jsonFetch(`/api/jobs/${id}/prompts`, { method: \"POST\", body: JSON.stringify(body) }),
  getPrompt: (id, idx) => jsonFetch(`/api/jobs/${id}/prompts/${idx}`),
  promptDocxUrl: (id, idx) => `${BASE}/api/jobs/${id}/prompts/${idx}/docx`,
  parseOutput: (id, body) => jsonFetch(`/api/jobs/${id}/parse-output`, { method: \"POST\", body: JSON.stringify(body) }),
  updateQuestion: (id, qNum, body) => jsonFetch(`/api/jobs/${id}/questions/${qNum}`, { method: \"PATCH\", body: JSON.stringify(body) }),
  exportJsonUrl: (id) => `${BASE}/api/jobs/${id}/export?format=json`,
  exportMdUrl: (id) => `${BASE}/api/jobs/${id}/export?format=md`,
  exportDocxUrl: (id) => `${BASE}/api/jobs/${id}/export?format=docx`,
  exportPdf: (id, opts) => fetch(`${BASE}/api/jobs/${id}/export/pdf`, { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify(opts) }),
  pageImageUrl: (id, page, source = \"qp\") => `${BASE}/api/jobs/${id}/page-image/${page}?source=${source}`,
  reverifyPrompt: (id, threshold) => jsonFetch(`/api/jobs/${id}/reverify-prompt?threshold=${threshold}`, { method: \"POST\" }),
};

export async function createJob(form) {
  const r = await fetch(`${BASE}/api/jobs`, { method: \"POST\", body: form });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${r.status}: ${t}`);
  }
  return r.json();
}
"
Observation: Create successful: /app/frontend/src/api.js


Created /app/frontend/src/theme.js
May 10, 07:37 PM



Action: file_editor create /app/frontend/src/theme.js --file-text "// Theme tokens for JSON Tool
// Supports dark and light modes

export const DARK = {
  bg: \"#0a0e1a\",
  surface: \"#0f1626\",
  surfaceAlt: \"#131b2c\",
  surfaceHover: \"#19243a\",
  border: \"#1f2a3f\",
  borderStrong: \"#2a3a55\",
  text: \"#e6edf7\",
  textMuted: \"#8893ab\",
  textDim: \"#5e6a82\",
  primary: \"#7c5cff\",
  primaryHover: \"#9275ff\",
  accent: \"#22d3ee\",
  ok: \"#22c55e\",
  warn: \"#f59e0b\",
  err: \"#ef4444\",
  info: \"#38bdf8\",
};

export const LIGHT = {
  bg: \"#f8fafc\",
  surface: \"#ffffff\",
  surfaceAlt: \"#f1f5f9\",
  surfaceHover: \"#e2e8f0\",
  border: \"#e2e8f0\",
  borderStrong: \"#cbd5e1\",
  text: \"#0f172a\",
  textMuted: \"#475569\",
  textDim: \"#94a3b8\",
  primary: \"#6d28d9\",
  primaryHover: \"#5b21b6\",
  accent: \"#0891b2\",
  ok: \"#16a34a\",
  warn: \"#d97706\",
  err: \"#dc2626\",
  info: \"#0284c7\",
};

export const STATUS_COLORS = (T) => ({
  created: T.textMuted,
  extracted: T.info,
  prompts_generated: T.warn,
  partially_parsed: T.warn,
  reviewed: T.ok,
  exported: T.primary,
});
"
Observation: Create successful: /app/frontend/src/theme.js


let me build the complete App.js with routing and all pages:
Created /app/frontend/src/App.js


Now let me build the complete App.js with routing and all pages:
Action: file_editor create /app/frontend/src/App.js --file-text "import { useState, useEffect, useCallback, useMemo, useRef } from \"react\";
import \"@/App.css\";
import { BrowserRouter, Routes, Route, useNavigate, useParams, useLocation } from \"react-router-dom\";
import { api, createJob } from \"./api\";
import { DARK, LIGHT, STATUS_COLORS } from \"./theme\";

// ─────────── Theme Context ────────────────────────────────────────────────────
let _theme = DARK;
let _setTheme = () => {};

function useT() { return _theme; }

// ─────────── Root App ─────────────────────────────────────────────────────────
function App() {
  const [isDark, setIsDark] = useState(() => {
    const stored = localStorage.getItem(\"jt_theme\");
    return stored !== \"light\";
  });
  const T = isDark ? DARK : LIGHT;
  _theme = T;

  const toggle = () => {
    const next = !isDark;
    setIsDark(next);
    localStorage.setItem(\"jt_theme\", next ? \"dark\" : \"light\");
  };
  _setTheme = toggle;

  useEffect(() => {
    document.body.style.backgroundColor = T.bg;
    document.body.style.color = T.text;
  }, [T]);

  return (
    <div style={{ minHeight: \"100vh\", backgroundColor: T.bg, color: T.text, fontFamily: \"'Inter', system-ui, sans-serif\" }}>
      <BrowserRouter>
        <Header T={T} isDark={isDark} onToggleTheme={toggle} />
        <Routes>
          <Route path=\"/\" element={<HomePage T={T} />} />
          <Route path=\"/new\" element={<NewJobPage T={T} />} />
          <Route path=\"/jobs/:id\" element={<JobDetailPage T={T} />} />
        </Routes>
      </BrowserRouter>
    </div>
  );
}

// ─────────── Header ────────────────────────────────────────────────────────────
function Header({ T, isDark, onToggleTheme }) {
  return (
    <div style={{
      backgroundColor: T.surface, borderBottom: `1px solid ${T.border}`,
      padding: \"12px 24px\", display: \"flex\", alignItems: \"center\", gap: 12,
      position: \"sticky\", top: 0, zIndex: 100,
    }}>
      <a href=\"/\" style={{ textDecoration: \"none\", color: T.text }}>
        <span style={{ fontWeight: 700, fontSize: 17, color: T.primary }}>JSON Tool</span>
        <span style={{ color: T.textMuted, fontSize: 12, marginLeft: 8 }}>PDF → Quiz JSON</span>
      </a>
      <div style={{ flex: 1 }} />
      <button
        data-testid=\"theme-toggle\"
        onClick={onToggleTheme}
        style={{
          background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 8,
          padding: \"6px 14px\", cursor: \"pointer\", color: T.text, fontSize: 13, fontWeight: 600,
          display: \"flex\", alignItems: \"center\", gap: 6,
        }}
      >
        {isDark ? \"☀ Light\" : \"🌙 Dark\"}
      </button>
    </div>
  );
}

// ─────────── HomePage ──────────────────────────────────────────────────────────
function HomePage({ T }) {
  const nav = useNavigate();
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const SC = STATUS_COLORS(T);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listJobs();
      setJobs(r.items || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm(\"Delete this job and all its data?\")) return;
    try {
      await api.deleteJob(id);
      refresh();
    } catch (e) {
      alert(\"Delete failed: \" + e.message);
    }
  };

  return (
    <div style={{ padding: \"28px 24px\", maxWidth: 1100, margin: \"0 auto\" }}>
      <div style={{ display: \"flex\", alignItems: \"center\", marginBottom: 24, gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, color: T.text, fontSize: 26, fontWeight: 700 }}>JSON Tool</h1>
          <p style={{ margin: \"4px 0 0\", color: T.textMuted, fontSize: 13 }}>
            PDF → Quiz JSON · Gemini-assisted · Schema 2.0
          </p>
        </div>
        <button
          data-testid=\"new-job-btn\"
          onClick={() => nav(\"/new\")}
          style={btnStyle(T)}
        >
          + New Job
        </button>
      </div>

      {error && <div style={cardStyle(T, { borderColor: T.err, marginBottom: 16 })}><p style={{ color: T.err, margin: 0 }}>Error: {error}</p></div>}

      {loading && jobs.length === 0 ? (
        <div style={cardStyle(T, { textAlign: \"center\", padding: 48 })}>
          <div style={{ color: T.textMuted }}>Loading jobs...</div>
        </div>
      ) : jobs.length === 0 ? (
        <div style={cardStyle(T, { textAlign: \"center\", padding: 48 })}>
          <h3 style={{ color: T.text, margin: \"0 0 8px\" }}>No jobs yet</h3>
          <p style={{ color: T.textMuted, margin: 0, fontSize: 13 }}>
            Create a new job to upload PDFs and generate JSON.
          </p>
        </div>
      ) : (
        <div style={{ display: \"flex\", flexDirection: \"column\", gap: 10 }}>
          {jobs.map((j) => (
            <div
              key={j.id}
              data-testid={`job-row-${j.id}`}
              onClick={() => nav(`/jobs/${j.id}`)}
              style={{
                ...cardStyle(T),
                flexDirection: \"row\", alignItems: \"center\", gap: 16,
                cursor: \"pointer\", transition: \"border-color 0.15s\",
              }}
              onMouseEnter={e => e.currentTarget.style.borderColor = T.borderStrong}
              onMouseLeave={e => e.currentTarget.style.borderColor = T.border}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: T.text, fontSize: 15, whiteSpace: \"nowrap\", overflow: \"hidden\", textOverflow: \"ellipsis\" }}>
                  {j.title}
                </div>
                <div style={{ color: T.textMuted, fontSize: 12, marginTop: 3 }}>
                  {j.metadata?.institute || \"—\"} · {j.metadata?.program_name || \"—\"} · {new Date(j.created_at).toLocaleString()}
                </div>
              </div>
              <span style={badgeStyle(T, { borderColor: SC[j.status] || T.border, color: SC[j.status] || T.textMuted })}>
                {j.status}
              </span>
              <span style={{ color: T.textMuted, fontSize: 13, width: 70, textAlign: \"right\" }}>
                {j.total_questions} Qs
              </span>
              <button
                data-testid={`delete-job-${j.id}`}
                onClick={(e) => handleDelete(j.id, e)}
                style={{ ...ghostBtnStyle(T), color: T.err, borderColor: \"transparent\", fontSize: 12 }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ textAlign: \"center\", marginTop: 32, color: T.textDim, fontSize: 12 }}>
        Pilot Pro · pilot-pro-v2.3 · v0.2.0
      </div>
    </div>
  );
}

// ─────────── Constants ─────────────────────────────────────────────────────────
const EXAM_CATEGORIES = [
  { value: \"cse\", label: \"UPSC CSE\" },
  { value: \"upsc_allied\", label: \"UPSC Allied (CDS/CAPF/IES)\" },
  { value: \"state_psc\", label: \"State PSC\" },
  { value: \"bpsc\", label: \"BPSC\" },
  { value: \"uppcs\", label: \"UPPCS\" },
  { value: \"mppcs\", label: \"MPPCS\" },
  { value: \"other\", label: \"Other\" },
];
const STAGES = [\"prelims\", \"mains\"];
const PAPERS = [\"pre_gs1\", \"pre_csat\", \"mains_gs1\", \"mains_gs2\", \"mains_gs3\", \"mains_gs4\", \"mains_essay\", \"other\"];
const LEVELS = [\"Full Test\", \"Sectional Test\", \"Subject Test\", \"PYQ\", \"PYQ Book\", \"Workbook\"];
const PAPER_TYPES = [\"Full Length\", \"Full Length\", \"Sectional\", \"Topic-wise\", \"Question Bank\", \"Workbook\", \"test-paper\"];

const PYQ_GROUPS = [
  \"UPSC CSE\",
  \"UPSC CDS\",
  \"UPSC CAPF\",
  \"UPSC IES\",
  \"BPSC\",
  \"UPPCS\",
  \"MPPCS\",
  \"RPSC\",
  \"JPSC\",
];

// ─────────── NewJobPage ────────────────────────────────────────────────────────
function NewJobPage({ T }) {
  const nav = useNavigate();
  const [batches, setBatches] = useState([createBatchEntry()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState([]);

  function createBatchEntry() {
    return {
      id: Math.random().toString(36).slice(2),
      title: \"\",
      institute: \"\",
      instituteId: \"\",
      instituteName: \"\",
      programId: \"\",
      programName: \"\",
      series: \"Test Series\",
      level: \"Full Test\",
      paperType: \"Full Length\",
      defaultMinutes: \"120\",
      launchYear: new Date().getFullYear().toString(),
      examCategory: \"cse\",
      stage: \"prelims\",
      paper: \"pre_gs1\",
      qpFile: null,
      solFile: null,
    };
  }

  const addBatch = () => setBatches(b => [...b, createBatchEntry()]);
  const removeBatch = (id) => setBatches(b => b.filter(x => x.id !== id));
  const updateBatch = (id, patch) => setBatches(b => b.map(x => x.id === id ? { ...x, ...patch } : x));

  const handleQpFile = async (id, file) => {
    if (!file) { updateBatch(id, { qpFile: null }); return; }
    updateBatch(id, { qpFile: file });
    // Auto-fill from filename
    try {
      const hints = await api.filenameHints(file.name);
      const patch = { qpFile: file };
      if (hints.title_suggestion) patch.title = hints.title_suggestion;
      if (hints.institute) { patch.institute = hints.institute; patch.instituteName = hints.institute; }
      if (hints.institute_id) patch.instituteId = hints.institute_id;
      if (hints.program_id) patch.programId = hints.program_id;
      if (hints.program_name) patch.programName = hints.program_name;
      updateBatch(id, patch);
    } catch {}
  };

  const submitAll = async () => {
    setError(null);
    const valid = batches.filter(b => b.title.trim() && b.qpFile);
    if (valid.length === 0) { setError(\"At least one batch needs a title and QP PDF.\"); return; }
    setSubmitting(true);
    const res = [];
    for (const b of valid) {
      const fd = new FormData();
      fd.append(\"title\", b.title.trim());
      fd.append(\"metadata_json\", JSON.stringify({
        title: b.title.trim(),
        launch_year: parseInt(b.launchYear, 10) || null,
        institute: b.institute.trim(),
        program_id: b.programId.trim(),
        program_name: b.programName.trim(),
        series: b.series.trim(),
        level: b.level,
        paperType: b.paperType,
        defaultMinutes: parseInt(b.defaultMinutes, 10) || null,
        sourceMode: \"docx-inline\",
        schema_version: \"2.0\",
        institute_id: b.instituteId.trim() || null,
        institute_name: b.instituteName.trim() || null,
        exam_frame: { exam_category: b.examCategory, specific_exam: null, stage: b.stage, paper: b.paper },
      }));
      fd.append(\"qp_pdf\", b.qpFile);
      if (b.solFile) fd.append(\"sol_pdf\", b.solFile);
      try {
        const r = await createJob(fd);
        res.push({ ok: true, id: r.id, title: b.title });
      } catch (e) {
        res.push({ ok: false, title: b.title, error: e.message });
      }
    }
    setResults(res);
    setSubmitting(false);
    // If only one, navigate directly
    if (res.length === 1 && res[0].ok) {
      nav(`/jobs/${res[0].id}`);
    }
  };

  if (results.length > 0) {
    return (
      <div style={{ padding: \"28px 24px\", maxWidth: 880, margin: \"0 auto\" }}>
        <h2 style={{ color: T.text }}>Batch Upload Results</h2>
        <div style={{ display: \"flex\", flexDirection: \"column\", gap: 10, marginBottom: 24 }}>
          {results.map((r, i) => (
            <div key={i} style={cardStyle(T, { borderColor: r.ok ? T.ok : T.err })}>
              <div style={{ color: r.ok ? T.ok : T.err, fontWeight: 600 }}>{r.ok ? \"✓\" : \"✗\"} {r.title}</div>
              {r.ok ? (
                <button style={{ ...btnStyle(T), marginTop: 8 }} onClick={() => nav(`/jobs/${r.id}`)}>
                  Open Job →
                </button>
              ) : (
                <div style={{ color: T.err, fontSize: 12, marginTop: 4 }}>{r.error}</div>
              )}
            </div>
          ))}
        </div>
        <button style={ghostBtnStyle(T)} onClick={() => nav(\"/\")}>← Back to Jobs</button>
      </div>
    );
  }

  return (
    <div style={{ padding: \"28px 24px\", maxWidth: 920, margin: \"0 auto\" }}>
      <button onClick={() => nav(\"/\")} style={{ ...ghostBtnStyle(T), marginBottom: 16 }}>← Back</button>
      <h1 style={{ margin: \"0 0 6px\", color: T.text }}>New Job</h1>
      <p style={{ color: T.textMuted, margin: \"0 0 24px\", fontSize: 13 }}>
        Upload QP PDF + optional SOL PDF for each test. Title auto-fills from filename.
      </p>

      {batches.map((b, idx) => (
        <BatchCard
          key={b.id}
          b={b}
          idx={idx}
          T={T}
          onUpdate={(patch) => updateBatch(b.id, patch)}
          onQpFile={(f) => handleQpFile(b.id, f)}
          onSolFile={(f) => updateBatch(b.id, { solFile: f })}
          onRemove={() => removeBatch(b.id)}
          canRemove={batches.length > 1}
        />
      ))}

      <button onClick={addBatch} style={{ ...ghostBtnStyle(T), marginBottom: 24 }}>
        + Add Another PDF Pair
      </button>

      {error && (
        <div style={cardStyle(T, { borderColor: T.err, marginBottom: 16 })}>
          <p style={{ color: T.err, margin: 0 }}>{error}</p>
        </div>
      )}

      <div style={{ display: \"flex\", gap: 10 }}>
        <button
          data-testid=\"create-job-btn\"
          onClick={submitAll}
          disabled={submitting}
          style={{ ...btnStyle(T), opacity: submitting ? 0.6 : 1 }}
        >
          {submitting ? \"Creating...\" : `Create ${batches.filter(b => b.qpFile && b.title.trim()).length || batches.length} Job(s)`}
        </button>
        <button onClick={() => nav(\"/\")} style={ghostBtnStyle(T)}>Cancel</button>
      </div>
    </div>
  );
}

function BatchCard({ b, idx, T, onUpdate, onQpFile, onSolFile, onRemove, canRemove }) {
  return (
    <div style={cardStyle(T, { marginBottom: 20 })}>
      <div style={{ display: \"flex\", alignItems: \"center\", marginBottom: 12 }}>
        <h3 style={{ margin: 0, color: T.text, fontSize: 16 }}>Batch {idx + 1}</h3>
        {canRemove && (
          <button onClick={onRemove} style={{ marginLeft: \"auto\", ...ghostBtnStyle(T), color: T.err, border: \"none\", fontSize: 13 }}>
            Remove
          </button>
        )}
      </div>

      {/* Files */}
      <div style={{ display: \"flex\", gap: 16, flexWrap: \"wrap\", marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label style={labelStyle(T)}>Question Paper PDF (required)</label>
          <input type=\"file\" accept=\".pdf\" data-testid={`qp-file-${idx}`}
            onChange={e => onQpFile(e.target.files?.[0] || null)}
            style={fileInputStyle(T)} />
          {b.qpFile && <div style={{ color: T.ok, fontSize: 11, marginTop: 3 }}>✓ {b.qpFile.name}</div>}
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label style={labelStyle(T)}>Solutions PDF (optional)</label>
          <input type=\"file\" accept=\".pdf\" data-testid={`sol-file-${idx}`}
            onChange={e => onSolFile(e.target.files?.[0] || null)}
            style={fileInputStyle(T)} />
          {b.solFile && <div style={{ color: T.ok, fontSize: 11, marginTop: 3 }}>✓ {b.solFile.name}</div>}
        </div>
      </div>

      {/* Title + Year + Institute */}
      <div style={{ display: \"flex\", gap: 12, flexWrap: \"wrap\", marginBottom: 12 }}>
        <FieldInput label=\"Title *\" value={b.title} onChange={v => onUpdate({ title: v })}
          placeholder=\"Auto-filled from filename\" T={T} style={{ flex: 2, minWidth: 250 }} />
        <FieldInput label=\"Launch Year\" value={b.launchYear} onChange={v => onUpdate({ launchYear: v })}
          T={T} style={{ width: 120 }} type=\"number\" />
      </div>

      <div style={{ display: \"flex\", gap: 12, flexWrap: \"wrap\", marginBottom: 12 }}>
        <FieldInput label=\"Institute\" value={b.institute} onChange={v => onUpdate({ institute: v })}
          placeholder=\"Forum IAS\" T={T} style={{ flex: 1, minWidth: 180 }} />
        <FieldInput label=\"Program ID\" value={b.programId} onChange={v => onUpdate({ programId: v })}
          placeholder=\"gs-simulator\" T={T} style={{ flex: 1, minWidth: 160 }} />
        <FieldInput label=\"Program Name\" value={b.programName} onChange={v => onUpdate({ programName: v })}
          placeholder=\"GS Simulator\" T={T} style={{ flex: 1, minWidth: 160 }} />
      </div>

      <div style={{ display: \"flex\", gap: 12, flexWrap: \"wrap\", marginBottom: 12 }}>
        <FieldInput label=\"Series\" value={b.series} onChange={v => onUpdate({ series: v })} T={T} style={{ flex: 1, minWidth: 160 }} />
        <FieldSelect label=\"Level\" value={b.level} onChange={v => onUpdate({ level: v })}
          options={LEVELS.map(x => ({ value: x, label: x }))} T={T} style={{ flex: 1, minWidth: 140 }} />
        <FieldSelect label=\"Paper Type\" value={b.paperType} onChange={v => onUpdate({ paperType: v })}
          options={PAPER_TYPES.map(x => ({ value: x, label: x }))} T={T} style={{ flex: 1, minWidth: 140 }} />
        <FieldInput label=\"Minutes\" value={b.defaultMinutes} onChange={v => onUpdate({ defaultMinutes: v })}
          T={T} style={{ width: 100 }} type=\"number\" />
      </div>

      {/* Exam Frame */}
      <div style={{ ...cardStyle(T, { backgroundColor: T.surfaceAlt, padding: 14 }), marginTop: 8 }}>
        <div style={{ color: T.textMuted, fontSize: 11, fontWeight: 600, textTransform: \"uppercase\", letterSpacing: 0.5, marginBottom: 10 }}>
          Exam Frame
        </div>
        <div style={{ display: \"flex\", gap: 12, flexWrap: \"wrap\" }}>
          <FieldSelect label=\"Exam Category\" value={b.examCategory} onChange={v => onUpdate({ examCategory: v })}
            options={EXAM_CATEGORIES} T={T} style={{ flex: 1, minWidth: 180 }} />
          <FieldSelect label=\"Stage\" value={b.stage} onChange={v => onUpdate({ stage: v })}
            options={STAGES.map(x => ({ value: x, label: x }))} T={T} style={{ width: 130 }} />
          <FieldSelect label=\"Paper\" value={b.paper} onChange={v => onUpdate({ paper: v })}
            options={PAPERS.map(x => ({ value: x, label: x }))} T={T} style={{ flex: 1, minWidth: 160 }} />
        </div>
      </div>
    </div>
  );
}

// ─────────── JobDetailPage ─────────────────────────────────────────────────────
function JobDetailPage({ T }) {
  const { id } = useParams();
  const nav = useNavigate();
  const [tab, setTab] = useState(\"preview\");
  const [job, setJob] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.getJob(id);
      setJob(r.job);
      setQuestions(r.questions || []);
      setBatches(r.batches || []);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  const SC = STATUS_COLORS(T);

  if (loading) return <div style={{ padding: 48, textAlign: \"center\", color: T.textMuted }}>Loading...</div>;
  if (err || !job) return (
    <div style={{ padding: 28 }}>
      <p style={{ color: T.err }}>{err || \"Job not found\"}</p>
      <button onClick={() => nav(\"/\")} style={ghostBtnStyle(T)}>← Back</button>
    </div>
  );

  return (
    <div style={{ padding: \"20px 24px\", maxWidth: 1280, margin: \"0 auto\" }}>
      <button onClick={() => nav(\"/\")} style={{ ...ghostBtnStyle(T), marginBottom: 12 }}>← All jobs</button>
      <div style={{ display: \"flex\", alignItems: \"center\", gap: 16, marginBottom: 6 }}>
        <h1 style={{ flex: 1, margin: 0, color: T.text, fontSize: 22 }}>{job.title}</h1>
        <span style={badgeStyle(T, { borderColor: SC[job.status] || T.border, color: SC[job.status] || T.textMuted })}>
          {job.status}
        </span>
      </div>
      <p style={{ color: T.textMuted, fontSize: 13, margin: \"0 0 20px\" }}>
        ID: {job.metadata?.id} · {job.metadata?.institute || \"—\"} · {questions.length} parsed / {job.total_questions} total
      </p>

      {/* Tabs */}
      <div style={{ display: \"flex\", gap: 6, marginBottom: 20, flexWrap: \"wrap\" }}>
        {[\"preview\",\"prompts\",\"review\",\"export\"].map(t => (
          <button
            key={t}
            data-testid={`tab-${t}`}
            onClick={() => setTab(t)}
            style={{
              padding: \"9px 18px\", borderRadius: 8, cursor: \"pointer\", fontWeight: 600, fontSize: 13,
              border: `1px solid ${tab === t ? T.primary : T.border}`,
              backgroundColor: tab === t ? T.surfaceAlt : T.surface,
              color: tab === t ? T.text : T.textMuted,
              transition: \"all 0.15s\",
            }}
          >
            {t === \"preview\" ? \"1 · Preview\" : t === \"prompts\" ? \"2 · Prompts\" : t === \"review\" ? \"3 · Review\" : \"4 · Export\"}
          </button>
        ))}
      </div>

      {tab === \"preview\" && <PreviewTab jobId={id} job={job} onAfter={refresh} T={T} />}
      {tab === \"prompts\" && <PromptsTab jobId={id} batches={batches} onAfter={refresh} T={T} />}
      {tab === \"review\" && <ReviewTab jobId={id} questions={questions} onAfter={refresh} T={T} />}
      {tab === \"export\" && <ExportTab jobId={id} job={job} questions={questions} T={T} />}
    </div>
  );
}

// ─────────── PreviewTab ────────────────────────────────────────────────────────
function PreviewTab({ jobId, job, onAfter, T }) {
  const [data, setData] = useState(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState(null);
  const [batchSize, setBatchSize] = useState(\"35\");
  const [extra, setExtra] = useState(\"\");
  const [genRunning, setGenRunning] = useState(false);
  const [genResult, setGenResult] = useState(null);

  const runPreview = async () => {
    setRunning(true); setErr(null);
    try { const r = await api.preview(jobId); setData(r); onAfter(); }
    catch (e) { setErr(e.message); }
    finally { setRunning(false); }
  };

  const generate = async () => {
    setGenRunning(true); setErr(null);
    try {
      const r = await api.generatePrompts(jobId, { batch_size: parseInt(batchSize,10)||35, subject_filter: [], extra_instructions: extra });
      setGenResult(r); onAfter();
    } catch (e) { setErr(e.message); }
    finally { setGenRunning(false); }
  };

  return (
    <div style={{ display: \"flex\", flexDirection: \"column\", gap: 16 }}>
      <div style={cardStyle(T)}>
        <h3 style={h3s(T)}>Step 1 · Extract & Sanity Check</h3>
        <p style={{ color: T.textMuted, fontSize: 13, margin: \"4px 0 12px\" }}>
          Run extraction on the uploaded PDFs to detect questions and surface QP↔SOL mismatches.
        </p>
        <button data-testid=\"run-preview-btn\" onClick={runPreview} disabled={running} style={{ ...btnStyle(T), opacity: running ? 0.6 : 1 }}>
          {running ? \"Extracting...\" : \"Run Extraction\"}
        </button>
        {err && <p style={{ color: T.err, margin: \"12px 0 0\", fontSize: 13 }}>{err}</p>}
      </div>

      {data && (
        <div style={cardStyle(T)}>
          <h3 style={h3s(T)}>Sanity Report</h3>
          <hr style={{ borderColor: T.border, margin: \"8px 0 12px\" }} />
          <div style={{ display: \"flex\", gap: 12, flexWrap: \"wrap\" }}>
            {[
              { label: \"QP pages\", value: data.qp_pages },
              { label: \"SOL pages\", value: data.sol_pages },
              { label: \"QP questions\", value: data.total_qp },
              { label: \"SOL questions\", value: data.total_sol },
              { label: \"Bundled\", value: data.items_count, hi: true },
            ].map(s => (
              <div key={s.label} style={{ ...cardStyle(T, { backgroundColor: T.surfaceAlt, padding: \"12px 16px\", minWidth: 110 }), borderColor: s.hi ? T.primary : T.border }}>
                <div style={{ color: T.textMuted, fontSize: 11, fontWeight: 600, textTransform: \"uppercase\", letterSpacing: 0.5 }}>{s.label}</div>
                <div style={{ color: s.hi ? T.primary : T.text, fontSize: 20, fontWeight: 700, marginTop: 2 }}>{s.value ?? \"—\"}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14, display: \"flex\", flexDirection: \"column\", gap: 4 }}>
            {data.qp_scanned && <p style={{ color: T.warn, margin: 0, fontSize: 13 }}>⚠ QP appears scanned. OCR not yet supported.</p>}
            {data.missing_in_qp?.length > 0 && <p style={{ color: T.warn, margin: 0, fontSize: 13 }}>⚠ Missing from QP: {data.missing_in_qp.join(\", \")}</p>}
            {data.missing_in_sol?.length > 0 && <p style={{ color: T.warn, margin: 0, fontSize: 13 }}>⚠ Missing from SOL: {data.missing_in_sol.join(\", \")}</p>}
          </div>
        </div>
      )}

      {data && (
        <div style={cardStyle(T)}>
          <h3 style={h3s(T)}>Step 2 · Generate Gemini Prompts</h3>
          <hr style={{ borderColor: T.border, margin: \"8px 0 12px\" }} />
          <div style={{ display: \"flex\", gap: 16, flexWrap: \"wrap\" }}>
            <div style={{ width: 130 }}>
              <label style={labelStyle(T)}>Batch Size</label>
              <input data-testid=\"batch-size-input\" value={batchSize} onChange={e => setBatchSize(e.target.value)}
                type=\"number\" style={inputStyle(T)} />
            </div>
            <div style={{ flex: 1, minWidth: 280 }}>
              <label style={labelStyle(T)}>Extra instructions (optional)</label>
              <textarea data-testid=\"extra-instructions-input\" value={extra} onChange={e => setExtra(e.target.value)}
                placeholder=\"e.g., be extra careful with PYQ years\" rows={3}
                style={{ ...inputStyle(T), resize: \"vertical\", width: \"100%\", minHeight: 60 }} />
            </div>
          </div>
          <button data-testid=\"generate-prompts-btn\" onClick={generate} disabled={genRunning}
            style={{ ...btnStyle(T), marginTop: 14, opacity: genRunning ? 0.6 : 1 }}>
            {genRunning ? \"Building...\" : \"Build Prompts\"}
          </button>
          {genResult && (
            <p style={{ color: T.ok, margin: \"12px 0 0\", fontSize: 13 }}>
              ✓ Generated {genResult.batch_count} batch(es) covering {genResult.total} questions. Switch to Prompts tab.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────── PromptsTab ────────────────────────────────────────────────────────
function PromptsTab({ jobId, batches, onAfter, T }) {
  const [active, setActive] = useState(0);
  const [text, setText] = useState(\"\");
  const [pasteback, setPasteback] = useState(\"\");
  const [parseRes, setParseRes] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (batches.length === 0) return;
    const idx = Math.min(active, batches.length - 1);
    setLoading(true);
    api.getPrompt(jobId, idx).then(r => setText(r.prompt_text)).finally(() => setLoading(false));
  }, [active, batches.length, jobId]);

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(text);
    alert(\"Prompt copied to clipboard. Paste into Gemini chat.\");
  };

  const downloadDocx = () => window.open(api.promptDocxUrl(jobId, active), \"_blank\");

  const submitPasteback = async () => {
    if (!pasteback.trim()) return;
    setParsing(true);
    try {
      const r = await api.parseOutput(jobId, { output_text: pasteback, batch_index: active });
      setParseRes(r); onAfter();
    } finally { setParsing(false); }
  };

  if (batches.length === 0) {
    return <div style={cardStyle(T, { textAlign: \"center\", padding: 40 })}>
      <h3 style={h3s(T)}>No prompts generated yet</h3>
      <p style={{ color: T.textMuted, fontSize: 13, margin: 0 }}>Go to Preview tab and click \"Build Prompts\" first.</p>
    </div>;
  }

  return (
    <div style={{ display: \"flex\", flexDirection: \"column\", gap: 16 }}>
      <div style={cardStyle(T)}>
        <h3 style={h3s(T)}>Batches</h3>
        <hr style={{ borderColor: T.border, margin: \"8px 0 12px\" }} />
        <div style={{ display: \"flex\", gap: 8, flexWrap: \"wrap\" }}>
          {batches.map(b => (
            <button
              key={b.id}
              data-testid={`batch-tab-${b.batch_index}`}
              onClick={() => setActive(b.batch_index)}
              style={{
                padding: \"7px 12px\", borderRadius: 8, cursor: \"pointer\", fontSize: 12, fontWeight: 600,
                border: `1px solid ${b.parsed ? T.ok : active === b.batch_index ? T.primary : T.border}`,
                backgroundColor: active === b.batch_index ? T.surfaceAlt : T.surface,
                color: b.parsed ? T.ok : active === b.batch_index ? T.text : T.textMuted,
              }}
            >
              Batch {b.batch_index + 1} ({b.question_numbers?.length} Qs){b.parsed ? \" ✓\" : \"\"}
            </button>
          ))}
        </div>
      </div>

      <div style={cardStyle(T)}>
        <div style={{ display: \"flex\", alignItems: \"center\", justifyContent: \"space-between\", marginBottom: 8 }}>
          <h3 style={{ ...h3s(T), margin: 0 }}>Prompt for Batch {active + 1}</h3>
          <div style={{ display: \"flex\", gap: 8 }}>
            <button data-testid=\"copy-prompt-btn\" onClick={copyPrompt} style={btnStyle(T)}>Copy</button>
            <button data-testid=\"download-docx-btn\" onClick={downloadDocx} style={ghostBtnStyle(T)}>Download .docx</button>
          </div>
        </div>
        <p style={{ color: T.textMuted, fontSize: 12, margin: \"0 0 8px\" }}>
          Paste this into your AI chat. Then paste the AI's reply below.
        </p>
        {loading ? <div style={{ color: T.textMuted }}>Loading...</div> : (
          <textarea
            data-testid=\"prompt-textarea\"
            value={text}
            readOnly
            rows={10}
            style={{ ...inputStyle(T), fontFamily: \"monospace\", fontSize: 11, width: \"100%\", resize: \"vertical\" }}
          />
        )}
      </div>

      <div style={cardStyle(T)}>
        <h3 style={h3s(T)}>Paste AI Output Here</h3>
        <p style={{ color: T.textMuted, fontSize: 12, margin: \"4px 0 8px\" }}>
          The parser expects `=== QUESTION N ===` blocks with marker lines.
        </p>
        <textarea
          data-testid=\"pasteback-textarea\"
          value={pasteback}
          onChange={e => setPasteback(e.target.value)}
          placeholder={\"=== QUESTION 1 ===\n[Subject: ...]\n...\"}
          rows={12}
          style={{ ...inputStyle(T), fontFamily: \"monospace\", fontSize: 11, width: \"100%\", resize: \"vertical\" }}
        />
        <button
          data-testid=\"submit-pasteback-btn\"
          onClick={submitPasteback}
          disabled={parsing}
          style={{ ...btnStyle(T), marginTop: 12, opacity: parsing ? 0.6 : 1 }}
        >
          {parsing ? \"Parsing...\" : \"Parse & Save\"}
        </button>
        {parseRes && (
          <div style={{ marginTop: 14 }}>
            <p style={{ color: T.ok, margin: 0, fontSize: 13 }}>✓ Saved {parseRes.saved} questions. Total: {parseRes.total_parsed_in_job}</p>
            {parseRes.errors?.length > 0 && (
              <>
                <p style={{ color: T.warn, margin: \"4px 0 0\", fontSize: 12 }}>⚠ {parseRes.errors.length} warnings:</p>
                {parseRes.errors.map((e, i) => <p key={i} style={{ color: T.warn, margin: 0, fontSize: 11 }}>Q{e.number}: {e.error}</p>)}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────── ReviewTab ─────────────────────────────────────────────────────────
function ReviewTab({ jobId, questions, onAfter, T }) {
  const [selectedNum, setSelectedNum] = useState(questions[0]?.question_number ?? null);
  const selected = useMemo(() => questions.find(q => q.question_number === selectedNum), [questions, selectedNum]);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(selected ? { ...selected } : null);
  }, [selected?.question_number]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await api.updateQuestion(jobId, draft.question_number, {
        subject: draft.subject,
        section_group: draft.section_group,
        microtopic: draft.microtopic,
        statement_lines: draft.statement_lines,
        options: draft.options,
        correct_answer: draft.correct_answer,
        explanation_markdown: draft.explanation_markdown,
        // PYQ fields
        pyq_source: draft.pyq_source,
        pyq_year: draft.pyq_year ? Number(draft.pyq_year) : null,
        is_pyq: Boolean(draft.is_pyq),
        is_ncert: Boolean(draft.is_ncert),
        pyq_exam_label: draft.pyq_exam_label || \"Prelims\",
        pyq_group: draft.pyq_group || \"\",
        source_attribution_label: draft.source_attribution_label || \"\",
        confidence: Number(draft.confidence) || 0,
      });
      onAfter();
    } finally { setSaving(false); }
  };

  // Auto-compute PYQ flags when group changes
  const setPyqGroup = (group) => {
    const g = (group || \"\").trim().toUpperCase();
    const is_upsc_cse = g === \"UPSC CSE\";
    const is_allied = g.startsWith(\"UPSC\") && g !== \"UPSC CSE\";
    const is_others = Boolean(g) && !g.startsWith(\"UPSC\");
    setDraft(d => ({
      ...d,
      pyq_group: group,
      is_upsc_cse, is_allied, is_others,
    }));
  };

  if (questions.length === 0) {
    return <div style={cardStyle(T, { textAlign: \"center\", padding: 40 })}>
      <h3 style={h3s(T)}>No questions parsed yet</h3>
      <p style={{ color: T.textMuted, fontSize: 13, margin: 0 }}>Go to Prompts tab and parse AI output.</p>
    </div>;
  }

  return (
    <div style={{ display: \"flex\", gap: 16, alignItems: \"flex-start\" }}>
      {/* Sidebar */}
      <div style={{ ...cardStyle(T), width: 230, flexShrink: 0 }}>
        <h4 style={{ margin: \"0 0 8px\", color: T.text, fontSize: 14 }}>Questions ({questions.length})</h4>
        <hr style={{ borderColor: T.border, margin: \"0 0 8px\" }} />
        <div style={{ maxHeight: 680, overflowY: \"auto\" }}>
          {questions.map(q => {
            const c = q.confidence || 0;
            const dot = c >= 80 ? T.ok : c >= 60 ? T.warn : T.err;
            return (
              <div
                key={q.question_number}
                data-testid={`q-row-${q.question_number}`}
                onClick={() => setSelectedNum(q.question_number)}
                style={{
                  display: \"flex\", alignItems: \"center\", gap: 8, padding: \"7px 8px\",
                  borderRadius: 6, cursor: \"pointer\", marginBottom: 2,
                  backgroundColor: selectedNum === q.question_number ? T.surfaceAlt : \"transparent\",
                  border: `1px solid ${selectedNum === q.question_number ? T.primary : \"transparent\"}`,
                }}
              >
                <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot, flexShrink: 0 }} />
                <span style={{ flex: 1, color: T.text, fontSize: 13, whiteSpace: \"nowrap\", overflow: \"hidden\", textOverflow: \"ellipsis\" }}>
                  Q{q.question_number} · {q.subject || \"—\"}
                </span>
                <span style={{ color: dot, fontSize: 11 }}>{c}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Edit form */}
      <div style={{ ...cardStyle(T), flex: 1 }}>
        {!draft ? <p style={{ color: T.textMuted }}>Select a question.</p> : (
          <div style={{ display: \"flex\", flexDirection: \"column\", gap: 12 }}>
            <div style={{ display: \"flex\", alignItems: \"center\", gap: 10, flexWrap: \"wrap\" }}>
              <h3 style={{ ...h3s(T), margin: 0 }}>Q{draft.question_number}</h3>
              <span style={badgeStyle(T, { borderColor: draft.microtopic_valid ? T.ok : T.warn, color: draft.microtopic_valid ? T.ok : T.warn })}>
                {draft.microtopic_valid ? \"Taxonomy ✓\" : \"Taxonomy mismatch\"}
              </span>
              {draft.inconsistency_flag && draft.inconsistency_flag !== \"none\" && (
                <span style={badgeStyle(T, { borderColor: T.err, color: T.err })}>{draft.inconsistency_flag}</span>
              )}
            </div>

            {/* Taxonomy */}
            <div style={{ display: \"flex\", gap: 12, flexWrap: \"wrap\" }}>
              <FieldInput label=\"Subject\" value={draft.subject||\"\"} onChange={v => setDraft({...draft, subject: v})} T={T} style={{ flex: 1, minWidth: 160 }} />
              <FieldInput label=\"Section Group\" value={draft.section_group||\"\"} onChange={v => setDraft({...draft, section_group: v})} T={T} style={{ flex: 1, minWidth: 200 }} />
              <FieldInput label=\"Microtopic\" value={draft.microtopic||\"\"} onChange={v => setDraft({...draft, microtopic: v})} T={T} style={{ flex: 1, minWidth: 200 }} />
              <FieldInput label=\"Confidence\" value={String(draft.confidence??0)} onChange={v => setDraft({...draft, confidence: v})} T={T} style={{ width: 90 }} type=\"number\" />
            </div>

            {/* Statement Lines */}
            <FieldTextarea label=\"Statement Lines (one per line)\"
              value={(draft.statement_lines||[]).join(\"\n\")}
              onChange={v => setDraft({...draft, statement_lines: v.split(\"\n\")})}
              T={T} rows={4} />

            {/* Options */}
            <div style={{ display: \"flex\", gap: 12, flexWrap: \"wrap\" }}>
              {[\"a\",\"b\",\"c\",\"d\"].map(k => (
                <FieldTextarea key={k} label={`Option ${k.toUpperCase()}`}
                  value={draft.options?.[k]||\"\"}
                  onChange={v => setDraft({...draft, options: {...(draft.options||{}), [k]: v}})}
                  T={T} rows={2} style={{ flex: 1, minWidth: \"45%\" }} />
              ))}
            </div>

            {/* Correct answer + basic PYQ source */}
            <div style={{ display: \"flex\", gap: 12, flexWrap: \"wrap\" }}>
              <FieldInput label=\"Correct Answer\" value={draft.correct_answer||\"\"} onChange={v => setDraft({...draft, correct_answer: v.toLowerCase().slice(0,1)})} T={T} style={{ width: 120 }} />
              <FieldInput label=\"PYQ Source (legacy)\" value={draft.pyq_source||\"\"} onChange={v => setDraft({...draft, pyq_source: v})} T={T} style={{ width: 180 }} placeholder=\"UPSC / BPSC\" />
              <FieldInput label=\"PYQ Year\" value={draft.pyq_year?String(draft.pyq_year):\"\"} onChange={v => setDraft({...draft, pyq_year: v})} T={T} style={{ width: 110 }} type=\"number\" />
            </div>

            {/* Full PYQ Info Block */}
            <div style={{ ...cardStyle(T, { backgroundColor: T.surfaceAlt, padding: 14, marginTop: 4 }) }}>
              <div style={{ color: T.textMuted, fontSize: 11, fontWeight: 600, textTransform: \"uppercase\", letterSpacing: 0.5, marginBottom: 12 }}>
                PYQ Details
              </div>
              <div style={{ display: \"flex\", gap: 12, flexWrap: \"wrap\", marginBottom: 10 }}>
                <label style={{ display: \"flex\", alignItems: \"center\", gap: 6, cursor: \"pointer\", color: T.text, fontSize: 13 }}>
                  <input type=\"checkbox\" checked={Boolean(draft.is_pyq)} onChange={e => setDraft({...draft, is_pyq: e.target.checked})} /> is PYQ
                </label>
                <label style={{ display: \"flex\", alignItems: \"center\", gap: 6, cursor: \"pointer\", color: T.text, fontSize: 13 }}>
                  <input type=\"checkbox\" checked={Boolean(draft.is_ncert)} onChange={e => setDraft({...draft, is_ncert: e.target.checked})} /> is NCERT
                </label>
              </div>
              <div style={{ display: \"flex\", gap: 12, flexWrap: \"wrap\", marginBottom: 10 }}>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <label style={labelStyle(T)}>Exam Group</label>
                  <input
                    list=\"pyq-groups-list\"
                    value={draft.pyq_group||\"\"}
                    onChange={e => setPyqGroup(e.target.value)}
                    placeholder=\"UPSC CSE / UPSC CDS / BPSC...\"
                    style={inputStyle(T)}
                  />
                  <datalist id=\"pyq-groups-list\">
                    {PYQ_GROUPS.map(g => <option key={g} value={g} />)}
                  </datalist>
                </div>
                <FieldSelect label=\"Exam Label\" value={draft.pyq_exam_label||\"Prelims\"}
                  onChange={v => setDraft({...draft, pyq_exam_label: v})}
                  options={[{value:\"Prelims\",label:\"Prelims\"},{value:\"Mains\",label:\"Mains\"},{value:\"Other\",label:\"Other\"}]}
                  T={T} style={{ width: 130 }} />
                <FieldInput label=\"Year\" value={draft.pyq_year?String(draft.pyq_year):\"\"} onChange={v => setDraft({...draft, pyq_year: v})} T={T} style={{ width: 100 }} type=\"number\" />
              </div>

              {/* Auto-computed flags */}
              <div style={{ display: \"flex\", gap: 10, flexWrap: \"wrap\", marginBottom: 10 }}>
                <FlagBadge label=\"UPSC CSE\" active={draft.is_upsc_cse} T={T} />
                <FlagBadge label=\"Allied (CDS/CAPF)\" active={draft.is_allied} T={T} />
                <FlagBadge label=\"Others (BPSC/UPPCS...)\" active={draft.is_others} T={T} />
              </div>

              <FieldInput label=\"Source Attribution Label (auto or manual)\"
                value={draft.source_attribution_label||\"\"}
                onChange={v => setDraft({...draft, source_attribution_label: v})}
                placeholder=\"UPSC CSE Prelims 2023\"
                T={T} />
            </div>

            <FieldTextarea label=\"Explanation (Markdown)\"
              value={draft.explanation_markdown||\"\"}
              onChange={v => setDraft({...draft, explanation_markdown: v})}
              T={T} rows={8} mono />

            <button
              data-testid=\"save-question-btn\"
              onClick={save}
              disabled={saving}
              style={{ ...btnStyle(T), opacity: saving ? 0.6 : 1, alignSelf: \"flex-start\" }}
            >
              {saving ? \"Saving...\" : \"Save Question\"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FlagBadge({ label, active, T }) {
  return (
    <div style={{
      padding: \"4px 10px\", borderRadius: 999, fontSize: 11, fontWeight: 600,
      border: `1px solid ${active ? T.ok : T.border}`,
      color: active ? T.ok : T.textDim,
      backgroundColor: active ? (T.bg === \"#f8fafc\" ? \"#dcfce7\" : \"#052e16\") : \"transparent\",
    }}>
      {label}: {active ? \"true\" : \"false\"}
    </div>
  );
}

// ─────────── ExportTab ─────────────────────────────────────────────────────────
function ExportTab({ jobId, job, questions, T }) {
  const [pdfOpts, setPdfOpts] = useState({
    font_family: \"sans\", font_size: 12, columns: 1, theme: \"modern\",
    paper_style: \"plain\", content_scope: \"q_options_expl\",
    answer_placement: \"inline\", visual_style: \"document\",
    qa_background_color: \"transparent\", show_toc: false,
    header_text: \"\", footer_text: \"\", watermark: \"\",
  });
  const [exporting, setExporting] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);

  const counts = useMemo(() => {
    let valid = 0, low = 0, flagged = 0;
    for (const q of questions) {
      if (q.microtopic_valid) valid++;
      if ((q.confidence || 0) < 60) low++;
      if (q.inconsistency_flag && q.inconsistency_flag !== \"none\") flagged++;
    }
    return { valid, low, flagged, total: questions.length };
  }, [questions]);

  const open = (url) => window.open(url, \"_blank\");

  const downloadPdf = async () => {
    setExporting(\"pdf\");
    try {
      const r = await api.exportPdf(jobId, pdfOpts);
      if (!r.ok) throw new Error(await r.text());
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement(\"a\");
      a.href = url;
      a.download = `${job.metadata?.id || \"job\"}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(\"PDF export failed: \" + e.message);
    } finally { setExporting(null); }
  };

  return (
    <div style={{ display: \"flex\", flexDirection: \"column\", gap: 16 }}>
      <div style={cardStyle(T)}>
        <h3 style={h3s(T)}>Export</h3>
        <p style={{ color: T.textMuted, fontSize: 13, margin: \"4px 0 8px\" }}>
          Download the final output in various formats. JSON is schema 2.0 compatible.
        </p>
        <hr style={{ borderColor: T.border, margin: \"0 0 12px\" }} />
        <div style={{ display: \"flex\", gap: 12, flexWrap: \"wrap\", marginBottom: 16 }}>
          {[
            { label: \"Total parsed\", value: counts.total, hi: true },
            { label: \"Taxonomy ✓\", value: counts.valid },
            { label: \"Confidence <60\", value: counts.low },
            { label: \"Inconsistencies\", value: counts.flagged },
          ].map(s => (
            <div key={s.label} style={{ ...cardStyle(T, { backgroundColor: T.surfaceAlt, padding: \"10px 14px\", minWidth: 100 }), borderColor: s.hi ? T.primary : T.border }}>
              <div style={{ color: T.textMuted, fontSize: 10, fontWeight: 600, textTransform: \"uppercase\" }}>{s.label}</div>
              <div style={{ color: s.hi ? T.primary : T.text, fontSize: 18, fontWeight: 700 }}>{s.value}</div>
            </div>
          ))}
        </div>
        <div style={{ display: \"flex\", gap: 10, flexWrap: \"wrap\" }}>
          <button data-testid=\"export-json-btn\" onClick={() => open(api.exportJsonUrl(jobId))} style={btnStyle(T)}>
            Download JSON
          </button>
          <button data-testid=\"export-md-btn\" onClick={() => open(api.exportMdUrl(jobId))} style={ghostBtnStyle(T)}>
            Download Markdown
          </button>
          <button data-testid=\"export-docx-btn\" onClick={() => open(api.exportDocxUrl(jobId))} style={ghostBtnStyle(T)}>
            Download DOCX
          </button>
        </div>
      </div>

      {/* PDF Export Options */}
      <div style={cardStyle(T)}>
        <h3 style={h3s(T)}>PDF Export — Customizable</h3>
        <p style={{ color: T.textMuted, fontSize: 13, margin: \"4px 0 12px\" }}>
          Configure the PDF output format before downloading.
        </p>
        <hr style={{ borderColor: T.border, margin: \"0 0 14px\" }} />
        <div style={{ display: \"flex\", gap: 14, flexWrap: \"wrap\", marginBottom: 14 }}>
          <FieldSelect label=\"Theme\" value={pdfOpts.theme} onChange={v => setPdfOpts(o => ({...o, theme: v}))}
            options={[
              {value:\"modern\",label:\"Modern\"},{value:\"classic\",label:\"Classic\"},
              {value:\"sepia\",label:\"Sepia\"},{value:\"historical\",label:\"Historical\"},{value:\"dark\",label:\"Dark\"},
            ]} T={T} style={{ width: 140 }} />
          <FieldSelect label=\"Visual Style\" value={pdfOpts.visual_style} onChange={v => setPdfOpts(o => ({...o, visual_style: v}))}
            options={[{value:\"document\",label:\"Document\"},{value:\"flashcard\",label:\"Flashcard (Q|A)\"}]} T={T} style={{ width: 180 }} />
          <FieldSelect label=\"Content\" value={pdfOpts.content_scope} onChange={v => setPdfOpts(o => ({...o, content_scope: v}))}
            options={[
              {value:\"q_only\",label:\"Questions Only\"},
              {value:\"q_options\",label:\"Q + Options\"},
              {value:\"q_options_expl\",label:\"Q + Options + Explanation\"},
            ]} T={T} style={{ width: 220 }} />
          <FieldSelect label=\"Answer Placement\" value={pdfOpts.answer_placement} onChange={v => setPdfOpts(o => ({...o, answer_placement: v}))}
            options={[{value:\"inline\",label:\"Inline (after each Q)\"},{value:\"end\",label:\"Answer Key at End\"}]}
            T={T} style={{ width: 200 }} />
        </div>
        <div style={{ display: \"flex\", gap: 14, flexWrap: \"wrap\", marginBottom: 14 }}>
          <FieldSelect label=\"Font\" value={pdfOpts.font_family} onChange={v => setPdfOpts(o => ({...o, font_family: v}))}
            options={[{value:\"sans\",label:\"Sans\"},{value:\"serif\",label:\"Serif\"},{value:\"mono\",label:\"Monospace\"}]}
            T={T} style={{ width: 130 }} />
          <FieldInput label=\"Font Size\" value={String(pdfOpts.font_size)} onChange={v => setPdfOpts(o => ({...o, font_size: parseInt(v)||12}))}
            T={T} style={{ width: 90 }} type=\"number\" />
          <FieldSelect label=\"Background\" value={pdfOpts.qa_background_color} onChange={v => setPdfOpts(o => ({...o, qa_background_color: v}))}
            options={[
              {value:\"transparent\",label:\"None\"},
              {value:\"#f8fafc\",label:\"Mist (light blue)\"},
              {value:\"#fefce8\",label:\"Cream\"},
              {value:\"#ecfeff\",label:\"Aqua\"},
              {value:\"#fdf2f8\",label:\"Blush (pink)\"},
              {value:\"#f0fdf4\",label:\"Mint\"},
            ]} T={T} style={{ width: 180 }} />
        </div>
        <button
          data-testid=\"export-pdf-btn\"
          onClick={downloadPdf}
          disabled={exporting === \"pdf\"}
          style={{ ...btnStyle(T), opacity: exporting === \"pdf\" ? 0.6 : 1 }}
        >
          {exporting === \"pdf\" ? \"Generating PDF...\" : \"Download PDF\"}
        </button>
      </div>

      {/* Preview link */}
      <div style={cardStyle(T)}>
        <h3 style={h3s(T)}>Preview Link</h3>
        <p style={{ color: T.textMuted, fontSize: 13, margin: \"4px 0 12px\" }}>
          Share a direct link to the JSON output:
        </p>
        <div style={{ display: \"flex\", gap: 10, alignItems: \"center\", flexWrap: \"wrap\" }}>
          <code style={{ ...inputStyle(T), fontSize: 12, fontFamily: \"monospace\", flex: 1, padding: \"8px 12px\", overflowX: \"auto\" }}>
            {api.exportJsonUrl(jobId)}
          </code>
          <button
            data-testid=\"copy-json-url-btn\"
            onClick={() => { navigator.clipboard.writeText(api.exportJsonUrl(jobId)); alert(\"URL copied!\"); }}
            style={ghostBtnStyle(T)}
          >
            Copy URL
          </button>
          <button
            data-testid=\"open-json-url-btn\"
            onClick={() => open(api.exportJsonUrl(jobId))}
            style={ghostBtnStyle(T)}
          >
            Open JSON
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────── Shared Form Components ───────────────────────────────────────────
function FieldInput({ label, value, onChange, placeholder, T, style, type = \"text\" }) {
  return (
    <div style={style}>
      <label style={labelStyle(T)}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={inputStyle(T)}
      />
    </div>
  );
}

function FieldSelect({ label, value, onChange, options, T, style }) {
  return (
    <div style={style}>
      <label style={labelStyle(T)}>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)} style={inputStyle(T)}>
        {options.map(o => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}
      </select>
    </div>
  );
}

function FieldTextarea({ label, value, onChange, T, rows = 3, mono = false, style }) {
  return (
    <div style={style}>
      <label style={labelStyle(T)}>{label}</label>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        style={{ ...inputStyle(T), fontFamily: mono ? \"monospace\" : \"inherit\", fontSize: mono ? 12 : 14, resize: \"vertical\", width: \"100%\" }}
      />
    </div>
  );
}

// ─────────── Style helpers ─────────────────────────────────────────────────────
function cardStyle(T, extra = {}) {
  return {
    backgroundColor: T.surface, borderRadius: 12, padding: 20,
    border: `1px solid ${T.border}`, ...extra,
    display: \"flex\", flexDirection: \"column\", gap: 0,
    ...(extra.display ? { display: extra.display } : {}),
  };
}

function btnStyle(T) {
  return {
    backgroundColor: T.primary, color: \"#fff\", border: \"none\",
    padding: \"9px 16px\", borderRadius: 8, cursor: \"pointer\",
    fontWeight: 600, fontSize: 14, display: \"inline-flex\", alignItems: \"center\", gap: 6,
  };
}

function ghostBtnStyle(T) {
  return {
    backgroundColor: \"transparent\", color: T.text,
    border: `1px solid ${T.border}`, padding: \"7px 14px\",
    borderRadius: 8, cursor: \"pointer\", fontWeight: 600, fontSize: 13,
  };
}

function labelStyle(T) {
  return { display: \"block\", color: T.textMuted, fontSize: 11, fontWeight: 600, textTransform: \"uppercase\", letterSpacing: 0.5, marginBottom: 5 };
}

function inputStyle(T) {
  return {
    backgroundColor: T.bg, color: T.text, border: `1px solid ${T.border}`,
    borderRadius: 8, padding: \"9px 12px\", fontSize: 14, outline: \"none\",
    width: \"100%\", boxSizing: \"border-box\",
  };
}

function fileInputStyle(T) {
  return {
    backgroundColor: T.bg, color: T.text, border: `1px solid ${T.border}`,
    borderRadius: 8, padding: 8, fontSize: 12, width: \"100%\",
  };
}

function badgeStyle(T, extra = {}) {
  return {
    padding: \"3px 10px\", borderRadius: 999, fontSize: 11, fontWeight: 600,
    backgroundColor: T.surfaceAlt, border: `1px solid ${T.border}`,
    ...extra,
  };
}

function h3s(T) {
  return { margin: 0, color: T.text, fontSize: 17, fontWeight: 700 };
}

export default App;
"
Observation: Overwrite successful: /app/frontend/src/App.js


Let me also update the CSS and restart services:
Created /app/frontend/src/App.css
May 10, 07:40 PM
	
 
Now let me also update the CSS and restart services:
Action: file_editor create /app/frontend/src/App.css --file-text "/* JSON Tool - Global styles */
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  transition: background-color 0.2s, color 0.2s;
}
input, textarea, select, button {
  font-family: inherit;
}
textarea {
  resize: vertical;
}
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #2a3a55; border-radius: 3px; }

/* Override scrollbar for light mode */
[data-theme=\"light\"] ::-webkit-scrollbar-thumb { background: #cbd5e1; }

/* Smooth transitions on interactive elements */
button { transition: opacity 0.15s, background-color 0.15s, border-color 0.15s; }
input, textarea, select { transition: border-color 0.15s; }
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: #7c5cff !important;
}
"
Observation: Overwrite successful: /app/frontend/src/App.css


$ sudo supervisorctl restart backend 2>&1 && sleep...
May 10, 07:40 PM
Backend is running. Let me check the frontend builds correctly:
$ tail -n 20 /var/log/supervisor/frontend.err.log ...
May 10, 07:40 PM
$ tail -n 5 /var/log/supervisor/frontend.out.log 2...
May 10, 07:40 PM


Loading...
Now let me build the complete App.js with routing and all pages:
Created /app/frontend/src/App.js
1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
May 10, 07:40 PM
Now let me also update the CSS and restart services:
Created /app/frontend/src/App.css
May 10, 07:40 PM
$ sudo supervisorctl restart backend 2>&1 && sleep...
May 10, 07:40 PM
Backend is running. Let me check the frontend builds correctly:
$ tail -n 20 /var/log/supervisor/frontend.err.log ...
May 10, 07:40 PM
$ tail -n 5 /var/log/supervisor/frontend.out.log 2...
May 10, 07:40 PM
Good, it compiled with only a warning. Let me take a screenshot to verify the app loads:
Took a screenshot
Screenshots
 
May 10, 07:41 PM
App is loading. Let me test the New Job page and theme toggle:
Took a screenshot
Screenshots
 
 
May 10, 07:41 PM
Looking great! Both themes work. Let me also check the q_splitter for the "joining" issue the user 


I need to update the prompt builder and parser to include PYQ group/label markers. Let me do that:
Edited /app/backend/services/prompt_builder.py

I need to update the prompt builder and parser to include PYQ group/label markers. Let me do that:
Action: file_editor str_replace /app/backend/services/prompt_builder.py --old-str "11. [Confidence] ∈ 0–100 integer. Lower if any flag set, OCR garble visible, or you had to guess heavily.
12. [PYQSource] / [PYQYear] empty if not detected. Sources e.g., UPSC, BPSC, UPPCS." --new-str "11. [Confidence] ∈ 0–100 integer. Lower if any flag set, OCR garble visible, or you had to guess heavily.
12. [PYQSource] / [PYQYear] empty if not detected. Sources e.g., UPSC, BPSC, UPPCS.
13. [PYQGroup] — the exam group this PYQ comes from. Must be one of: \"UPSC CSE\", \"UPSC CDS\", \"UPSC CAPF\", \"BPSC\", \"UPPCS\", \"MPPCS\", or empty. Auto-derive: if source is \"UPSC\" and stage is prelims/mains → \"UPSC CSE\"; if source is \"UPSC CDS\" → \"UPSC CDS\"; if source is \"BPSC\" → \"BPSC\"; etc.
14. [PYQExamLabel] — \"Prelims\" or \"Mains\". Empty if not PYQ.
15. [IsNCERT] — \"true\" if question is sourced/derived from NCERT content directly, else \"false\"."
Observation: Edit was successful.



Edited /app/backend/services/prompt_builder.py
May 10, 07:42 PM
V


Action: file_editor str_replace /app/backend/services/prompt_builder.py --old-str "FORMAT_EXAMPLE = \"\"\"=== QUESTION 1 ===
[Subject: Polity]
[SectionGroup: Institutions & Governance]
[Microtopic: Governance and Policies]
[PYQSource: ]
[PYQYear: ]
[Confidence: 95]
[InconsistencyFlag: none]
[InconsistencyReason: ]" --new-str "FORMAT_EXAMPLE = \"\"\"=== QUESTION 1 ===
[Subject: Polity]
[SectionGroup: Institutions & Governance]
[Microtopic: Governance and Policies]
[PYQSource: ]
[PYQYear: ]
[PYQGroup: ]
[PYQExamLabel: ]
[IsNCERT: false]
[Confidence: 95]
[InconsistencyFlag: none]
[InconsistencyReason: ]"
Observation: Edit was successful.

ow update the parser to extract the new fields:
Edited /app/backend/services/output_parser.py
May 10, 07:42 PM


Now update the parser to extract the new fields:
Action: file_editor str_replace /app/backend/services/output_parser.py --old-str "        q = {
            \"number\": n,
            \"subject\": markers.get(\"subject\", \"\").strip(),
            \"section_group\": markers.get(\"sectiongroup\", \"\").strip(),
            \"microtopic\": markers.get(\"microtopic\", \"\").strip(),
            \"pyq_source\": markers.get(\"pyqsource\", \"\").strip() or None,
            \"pyq_year\": pyq_year,
            \"confidence\": confidence,
            \"inconsistency_flag\": markers.get(\"inconsistencyflag\", \"none\").strip() or \"none\",
            \"inconsistency_reason\": markers.get(\"inconsistencyreason\", \"\").strip(),
            \"statement_lines\": statement_lines,
            \"question_text\": \" \".join(statement_lines),
            \"options\": options,
            \"correct_answer\": correct,
            \"explanation_markdown\": sections[\"EXPLANATION\"].strip(),
        }" --new-str "        pyq_source = markers.get(\"pyqsource\", \"\").strip() or None
        pyq_group = markers.get(\"pyqgroup\", \"\").strip()
        pyq_exam_label = markers.get(\"pyqexamlabel\", \"\").strip() or (\"Prelims\" if pyq_source else \"\")
        is_ncert_raw = markers.get(\"isncert\", \"false\").strip().lower()
        is_ncert = is_ncert_raw in (\"true\", \"1\", \"yes\")

        # Auto build source_attribution_label
        sal = \"\"
        if pyq_group and pyq_year:
            sal = f\"{pyq_group} {pyq_exam_label or 'Prelims'} {pyq_year}\"

        q = {
            \"number\": n,
            \"subject\": markers.get(\"subject\", \"\").strip(),
            \"section_group\": markers.get(\"sectiongroup\", \"\").strip(),
            \"microtopic\": markers.get(\"microtopic\", \"\").strip(),
            \"pyq_source\": pyq_source,
            \"pyq_year\": pyq_year,
            \"pyq_group\": pyq_group,
            \"pyq_exam_label\": pyq_exam_label,
            \"is_ncert\": is_ncert,
            \"source_attribution_label\": sal,
            \"confidence\": confidence,
            \"inconsistency_flag\": markers.get(\"inconsistencyflag\", \"none\").strip() or \"none\",
            \"inconsistency_reason\": markers.get(\"inconsistencyreason\", \"\").strip(),
            \"statement_lines\": statement_lines,
            \"question_text\": \" \".join(statement_lines),
            \"options\": options,
            \"correct_answer\": correct,
            \"explanation_markdown\": sections[\"EXPLANATION\"].strip(),
        }"
Observation: Edit was successful.

All tests pass. Let me fix the minor issues:
Edited /app/frontend/src/App.js
May 10, 07:45 PM
	
 
All tests pass. Let me fix the minor issues:
Action: file_editor str_replace /app/frontend/src/App.js --old-str "const PAPER_TYPES = [\"Full Length\", \"Full Length\", \"Sectional\", \"Topic-wise\", \"Question Bank\", \"Workbook\", \"test-paper\"];" --new-str "const PAPER_TYPES = [\"Full Length\", \"Sectional\", \"Topic-wise\", \"Question Bank\", \"Workbook\", \"test-paper\"];"
Observation: Edit was successful.

Also fix Pydantic v2 .dict() → .model_dump() in server.py:
Edited /app/backend/server.py


Also fix Pydantic v2 `.dict()` → `.model_dump()` in server.py:
Action: file_editor str_replace /app/backend/server.py --old-str "    update = {k: v for k, v in body.dict(exclude_unset=True).items() if v is not None}" --new-str "    update = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}"
Observation: Edit was successful.
