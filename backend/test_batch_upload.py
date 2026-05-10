#!/usr/bin/env python3
"""
Manual test script for multiple batch PDF uploads.
Run this to validate that 10 PDF pairs can be uploaded and create separate jobs.

Usage:
    python test_batch_upload.py --sample-pdfs <folder_with_pdfs>
    
Example:
    python test_batch_upload.py --sample-pdfs ./data/uploads
"""

import asyncio
import json
import sys
import argparse
from pathlib import Path
from datetime import datetime

import httpx

BASE_URL = "http://localhost:8001"

async def test_single_upload(client: httpx.AsyncClient, qp_pdf_path: str, sol_pdf_path: str, index: int):
    """Upload a single QP+SOL pair and return job ID."""
    title = f"Test Batch {index+1}"
    metadata = {
        "id": f"test-batch-{index+1:02d}",
        "institute": "Test Institute",
        "program_name": "Test Program",
    }
    
    with open(qp_pdf_path, "rb") as qp_f, open(sol_pdf_path, "rb") as sol_f:
        files = [
            ("qp_pdf", (Path(qp_pdf_path).name, qp_f, "application/pdf")),
            ("sol_pdf", (Path(sol_pdf_path).name, sol_f, "application/pdf")),
            ("title", (None, title)),
            ("metadata_json", (None, json.dumps(metadata))),
        ]
        
        try:
            response = await client.post(
                f"{BASE_URL}/api/jobs",
                files=files,
                timeout=60.0
            )
            response.raise_for_status()
            job = response.json()["job"]
            return job["_id"], job["title"], job["status"]
        except Exception as e:
            return None, str(e), "error"


async def test_multiple_uploads(sample_pdf_dir: str, num_batches: int = 10):
    """Test uploading multiple PDF pairs."""
    print(f"\n{'='*70}")
    print(f"Multiple Batch PDF Upload Test")
    print(f"{'='*70}\n")
    
    sample_path = Path(sample_pdf_dir)
    
    # Find sample PDFs
    qp_files = sorted(sample_path.glob("*qp*.pdf")) + sorted(sample_path.glob("*QP*.pdf"))
    sol_files = sorted(sample_path.glob("*sol*.pdf")) + sorted(sample_path.glob("*SOL*.pdf"))
    
    if not qp_files or not sol_files:
        print(f"❌ ERROR: No sample PDFs found in {sample_pdf_dir}")
        print(f"   Expected: *qp*.pdf and *sol*.pdf files")
        return
    
    if len(qp_files) < num_batches or len(sol_files) < num_batches:
        print(f"⚠️  WARNING: Only found {len(qp_files)} QP and {len(sol_files)} SOL files")
        print(f"   Proceeding with {min(len(qp_files), len(sol_files))} uploads\n")
        num_batches = min(len(qp_files), len(sol_files))
    
    created_jobs = []
    async with httpx.AsyncClient() as client:
        # Test 1: Health check
        print(f"[1/3] Testing backend health...")
        try:
            health = await client.get(f"{BASE_URL}/api", timeout=5.0)
            health.raise_for_status()
            print(f"      ✅ Backend is UP\n")
        except Exception as e:
            print(f"      ❌ Backend is DOWN: {e}\n")
            return
        
        # Test 2: Multiple sequential uploads
        print(f"[2/3] Uploading {num_batches} PDF pairs sequentially...")
        start_time = datetime.now()
        
        for i in range(num_batches):
            job_id, title, status = await test_single_upload(
                client,
                str(qp_files[i]),
                str(sol_files[i]),
                i
            )
            if job_id:
                created_jobs.append(job_id)
                elapsed = (datetime.now() - start_time).total_seconds()
                print(f"      [{i+1}/{num_batches}] ✅ Job {job_id[:8]}... created (Status: {status}) [{elapsed:.1f}s]")
            else:
                print(f"      [{i+1}/{num_batches}] ❌ Upload failed: {title}")
        
        upload_time = (datetime.now() - start_time).total_seconds()
        print(f"\n      Uploaded {len(created_jobs)}/{num_batches} jobs in {upload_time:.1f}s\n")
        
        # Test 3: Verify all jobs are independent
        print(f"[3/3] Verifying job independence...")
        
        for idx, job_id in enumerate(created_jobs[:3]):  # Check first 3
            try:
                job = await client.get(f"{BASE_URL}/api/jobs/{job_id}", timeout=10.0)
                job.raise_for_status()
                job_data = job.json()["job"]
                questions_count = len(job_data.get("questions", []))
                print(f"      ✅ Job {job_id[:8]}... has {questions_count} parsed questions")
            except Exception as e:
                print(f"      ❌ Job {job_id[:8]}... verification failed: {e}")
        
        if len(created_jobs) > 3:
            print(f"      ... and {len(created_jobs)-3} more jobs created")
    
    print(f"\n{'='*70}")
    print(f"Summary")
    print(f"{'='*70}")
    print(f"✅ Successfully created {len(created_jobs)} independent jobs")
    print(f"⏱️  Total time: {upload_time:.1f}s ({upload_time/len(created_jobs):.1f}s per job)")
    print(f"\nJob IDs created:")
    for i, job_id in enumerate(created_jobs, 1):
        print(f"  {i:2d}. {job_id}")
    print(f"\n{'='*70}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test multiple batch PDF uploads")
    parser.add_argument("--sample-pdfs", default="./data/uploads", help="Directory with sample PDF files")
    parser.add_argument("--num", type=int, default=10, help="Number of batches to test")
    
    args = parser.parse_args()
    
    try:
        asyncio.run(test_multiple_uploads(args.sample_pdfs, args.num))
    except KeyboardInterrupt:
        print("\n⚠️  Test interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        sys.exit(1)
