// Centralised API helper.
const BASE = process.env.EXPO_PUBLIC_BACKEND_URL || "";

async function jsonFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
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
  health: () => jsonFetch("/api/"),
  taxonomy: () => jsonFetch<{ entries: Array<{ subject: string; sectionGroup: string; microTopic: string }> }>("/api/taxonomy"),
  filenameHints: (filename: string) => jsonFetch<any>(`/api/filename-hints?filename=${encodeURIComponent(filename)}`),
  listJobs: () => jsonFetch<{ items: any[] }>("/api/jobs"),
  getJob: (id: string) => jsonFetch<{ job: any; questions: any[]; batches: any[] }>(`/api/jobs/${id}`),
  deleteJob: (id: string) => jsonFetch(`/api/jobs/${id}`, { method: "DELETE" }),
  preview: (id: string) => jsonFetch<any>(`/api/jobs/${id}/preview`),
  generatePrompts: (id: string, body: { batch_size: number; subject_filter: string[]; extra_instructions: string }) =>
    jsonFetch<any>(`/api/jobs/${id}/prompts`, { method: "POST", body: JSON.stringify(body) }),
  getPrompt: (id: string, idx: number) => jsonFetch<any>(`/api/jobs/${id}/prompts/${idx}`),
  promptDocxUrl: (id: string, idx: number) => `${BASE}/api/jobs/${id}/prompts/${idx}/docx`,
  parseOutput: (id: string, body: { output_text: string; batch_index?: number }) =>
    jsonFetch<any>(`/api/jobs/${id}/parse-output`, { method: "POST", body: JSON.stringify(body) }),
  updateQuestion: (id: string, qNum: number, body: any) =>
    jsonFetch<any>(`/api/jobs/${id}/questions/${qNum}`, { method: "PATCH", body: JSON.stringify(body) }),
  exportJsonUrl: (id: string) => `${BASE}/api/jobs/${id}/export?format=json`,
  exportMdUrl: (id: string) => `${BASE}/api/jobs/${id}/export?format=md`,
  exportDocxUrl: (id: string) => `${BASE}/api/jobs/${id}/export?format=docx`,
  exportPdf: (id: string, opts: any) => fetch(`${BASE}/api/jobs/${id}/export/pdf`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts) }),
  pageImageUrl: (id: string, page: number, source: "qp" | "sol" = "qp") =>
    `${BASE}/api/jobs/${id}/page-image/${page}?source=${source}`,
  reverifyPrompt: (id: string, threshold: number) =>
    jsonFetch<any>(`/api/jobs/${id}/reverify-prompt?threshold=${threshold}`, { method: "POST" }),
};

export async function createJob(form: FormData) {
  const r = await fetch(`${BASE}/api/jobs`, { method: "POST", body: form });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${r.status}: ${t}`);
  }
  return r.json();
}
