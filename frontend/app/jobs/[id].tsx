import { useEffect, useMemo, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  Linking,
  Platform,
  Image,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { sharedStyles as S, T } from "../../src/theme";
import { api } from "../../src/api";

type Tab = "preview" | "prompts" | "review" | "low_confidence" | "export";

export default function JobDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("preview");
  const [job, setJob] = useState<any>(null);
  const [questions, setQuestions] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [columns, setColumns] = useState(1);
  const [useOcr, setUseOcr] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.getJob(id);
      setJob(r.job);
      setQuestions(r.questions || []);
      setBatches(r.batches || []);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  if (loading) {
    return (
      <View style={[S.page, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={T.primary} />
      </View>
    );
  }
  if (err || !job) {
    return (
      <View style={S.page}>
        <View style={S.container}>
          <Text style={[S.p, { color: T.err }]}>{err || "Job not found"}</Text>
          <Pressable onPress={() => router.replace("/")} style={[S.buttonGhost, { marginTop: 16, alignSelf: "flex-start" }]}>
            <Text style={S.buttonGhostText}>← Back to jobs</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={S.page} contentContainerStyle={{ paddingBottom: 80 }}>
      <View style={S.container}>
        <Pressable onPress={() => router.replace("/")} style={[S.buttonGhost, { alignSelf: "flex-start", marginBottom: 12 }]}>
          <Text style={S.buttonGhostText}>← All jobs</Text>
        </Pressable>
        <View style={[S.row, { gap: 16, marginBottom: 6 }]}>
          <Text style={[S.h1, { flex: 1 }]} numberOfLines={2}>{job.title}</Text>
          <View style={[S.badge, { backgroundColor: T.surfaceAlt }]}>
            <Text style={S.badgeText}>{job.status}</Text>
          </View>
        </View>
        <Text style={[S.pSm, { marginBottom: 24 }]}>
          ID: {job.metadata?.id} · {job.metadata?.institute || "—"} · {questions.length} parsed Qs / {job.total_questions} total
        </Text>

        <View style={styles.tabs}>
          {(["preview", "prompts", "review", "low_confidence", "export"] as Tab[]).map((t) => (
            <Pressable
              key={t}
              testID={`tab-${t}`}
              onPress={() => setTab(t)}
              style={[styles.tab, tab === t && styles.tabActive]}
            >
              <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                {t === "preview" ? "1 · Preview" :
                 t === "prompts" ? "2 · Prompts" : 
                 t === "review" ? "3 · Review" : 
                 t === "low_confidence" ? "⚠️ Low Conf" : "4 · Export"}
              </Text>
            </Pressable>
          ))}
        </View>

        {tab === "preview" && <PreviewTab jobId={id!} job={job} onAfter={refresh} columns={columns} setColumns={setColumns} useOcr={useOcr} setUseOcr={setUseOcr} />}
        {tab === "prompts" && <PromptsTab jobId={id!} job={job} batches={batches} onAfter={refresh} columns={columns} useOcr={useOcr} />}
        {tab === "review" && <ReviewTab jobId={id!} questions={questions} onAfter={refresh} columns={columns} />}
        {tab === "low_confidence" && <LowConfidenceTab jobId={id!} questions={questions} onAfter={refresh} />}
        {tab === "export" && <ExportTab jobId={id!} job={job} questions={questions} />}
      </View>
    </ScrollView>
  );
}

// ─────────────── PREVIEW TAB ──────────────────
function PreviewTab({ jobId, job, onAfter, columns, setColumns, useOcr, setUseOcr }: any) {
  const [data, setData] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [batchSize, setBatchSize] = useState("35");
  const [extra, setExtra] = useState("");
  const [genRunning, setGenRunning] = useState(false);
  const [genResult, setGenResult] = useState<any>(null);
  const [allSubjects, setAllSubjects] = useState<string[]>([]);
  const [selectedSubjects, setSelectedSubjects] = useState<string[]>([]);

  useEffect(() => {
    api.taxonomy().then((r) => {
      const unique = Array.from(new Set((r.entries || []).map(e => e.subject))).filter(Boolean).sort();
      setAllSubjects(unique);
    }).catch(console.error);
  }, []);

  const runPreview = async () => {
    setRunning(true);
    setErr(null);
    try {
      const r = await api.preview(jobId, useOcr, columns);
      setData(r);
      onAfter();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setRunning(false);
    }
  };

  const generate = async () => {
    setGenRunning(true);
    setErr(null);
    try {
      const r = await api.generatePrompts(jobId, {
        batch_size: parseInt(batchSize, 10) || 35,
        subject_filter: selectedSubjects,
        extra_instructions: extra,
        use_ocr: useOcr,
        columns: columns
      });
      setGenResult(r);
      onAfter();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setGenRunning(false);
    }
  };

  return (
    <View style={{ gap: 16 }}>
      <View style={S.card}>
        <Text style={S.h2}>Step 1 · Extract & Sanity Check</Text>
        <Text style={[S.pSm, { marginTop: 4, marginBottom: 12 }]}>
          Run extraction on the uploaded PDFs to detect questions and surface any QP↔SOL mismatches.
        </Text>

        <View style={[S.rowGap, { marginBottom: 16, gap: 16 }]}>
          <View style={{ flex: 1 }}>
            <Text style={[S.label, { marginBottom: 6 }]}>Layout Mode</Text>
            <View style={[S.row, { gap: 8 }]}>
              {[1, 2].map(c => (
                <Pressable 
                  key={c} 
                  onPress={() => setColumns(c)}
                  style={[S.buttonGhost, { paddingVertical: 6, paddingHorizontal: 12 }, columns === c && { borderColor: T.primary, backgroundColor: T.surfaceAlt }]}
                >
                  <Text style={[S.buttonGhostText, columns === c && { color: T.primary }]}>{c} Col{c>1?'s':''}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={{ flex: 1 }}>
             <Text style={[S.label, { marginBottom: 6 }]}>Extraction Layer</Text>
             <Pressable onPress={() => setUseOcr(!useOcr)} style={[S.row, { gap: 8, paddingVertical: 8 }]}>
                <View style={{ width: 18, height: 18, borderWidth: 1, borderColor: T.border, borderRadius: 4, backgroundColor: useOcr ? T.primary : "transparent", alignItems: "center", justifyContent: "center" }}>
                   {useOcr && <Text style={{ color: "#fff", fontSize: 10, fontWeight: "bold" }}>✓</Text>}
                </View>
                <Text style={S.p}>Attempt OCR (Scanned PDFs)</Text>
             </Pressable>
          </View>
        </View>

        <Pressable testID="run-preview-btn" style={[S.button, running && { opacity: 0.6 }]} onPress={runPreview} disabled={running}>
          {running ? <ActivityIndicator color="#fff" size="small" /> : null}
          <Text style={S.buttonText}>{running ? "Extracting..." : "Run Extraction"}</Text>
        </Pressable>
        {err ? <Text style={[S.p, { color: T.err, marginTop: 12 }]}>{err}</Text> : null}
      </View>

      {data ? (
        <View style={S.card}>
          <Text style={S.h2}>Sanity Report</Text>
          <View style={[S.divider, { marginTop: 8 }]} />
          <View style={[S.rowGap, { marginTop: 4 }]}>
            <Stat label="QP pages" value={data.qp_pages} />
            <Stat label="SOL pages" value={data.sol_pages} />
            <Stat label="QP questions" value={data.total_qp} />
            <Stat label="SOL questions" value={data.total_sol} />
            <Stat label="Bundled" value={data.items_count} highlight />
          </View>
          <View style={{ marginTop: 14, gap: 4 }}>
            {data.qp_scanned ? <Text style={[S.p, { color: T.warn }]}>⚠ QP appears scanned (low text density). OCR is Phase-2; expect garbled output.</Text> : null}
            {data.sol_scanned ? <Text style={[S.p, { color: T.warn }]}>⚠ SOL appears scanned.</Text> : null}
            {data.missing_in_qp?.length > 0 ? (
              <Text style={[S.p, { color: T.warn }]}>⚠ Numbers found in SOL but missing from QP: {data.missing_in_qp.join(", ")}</Text>
            ) : null}
            {data.missing_in_sol?.length > 0 ? (
              <Text style={[S.p, { color: T.warn }]}>⚠ Numbers found in QP but missing from SOL: {data.missing_in_sol.join(", ")}</Text>
            ) : null}
            {data.qp_numbers?.length > 0 ? (
              <Text style={[S.pSm, { marginTop: 6 }]}>QP range: {data.qp_numbers[0]} – {data.qp_numbers[data.qp_numbers.length - 1]}</Text>
            ) : null}
          </View>
        </View>
      ) : null}

      {data ? (
        <View style={S.card}>
          <Text style={S.h2}>Step 2 · Generate Gemini Prompts</Text>
          <View style={[S.divider, { marginTop: 8 }]} />
          <View style={[S.rowGap, { marginTop: 4 }]}>
            <View style={{ width: 140 }}>
              <Text style={[S.label, { marginBottom: 6 }]}>Batch Size</Text>
              <TextInput
                testID="batch-size-input"
                value={batchSize}
                onChangeText={setBatchSize}
                keyboardType="number-pad"
                style={S.input}
              />
            </View>
            <View style={{ flex: 1, minWidth: 280 }}>
              <Text style={[S.label, { marginBottom: 6 }]}>Extra instructions (optional)</Text>
              <TextInput
                testID="extra-instructions-input"
                value={extra}
                onChangeText={setExtra}
                placeholder="e.g., be extra careful with PYQ years"
                placeholderTextColor={T.textDim}
                multiline
                style={[S.input, { minHeight: 60 }]}
              />
            </View>
          </View>

          <View style={{ marginTop: 12 }}>
            <Text style={[S.label, { marginBottom: 8 }]}>Subject Scope Filter (Optional)</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {allSubjects.map(sub => {
                const isSel = selectedSubjects.includes(sub);
                return (
                  <Pressable
                    key={sub}
                    onPress={() => {
                      setSelectedSubjects(prev => 
                        prev.includes(sub) ? prev.filter(p => p !== sub) : [...prev, sub]
                      );
                    }}
                    style={[
                      { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: T.border },
                      isSel && { backgroundColor: T.primary, borderColor: T.primary }
                    ]}
                  >
                    <Text style={[S.pSm, { fontSize: 12 }, isSel && { color: "#fff", fontWeight: "600" }]}>{sub}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={[S.pSm, { fontSize: 11, color: T.textDim, marginTop: 4 }]}>
              Leave empty to extract all detected subjects.
            </Text>
          </View>

          <View style={{ marginTop: 16 }}>
            <Pressable testID="generate-prompts-btn" style={[S.button, genRunning && { opacity: 0.6 }]} onPress={generate} disabled={genRunning}>
              {genRunning ? <ActivityIndicator color="#fff" size="small" /> : null}
              <Text style={S.buttonText}>{genRunning ? "Building..." : "Build Prompts"}</Text>
            </Pressable>
          </View>
          {genResult ? (
            <Text style={[S.p, { color: T.ok, marginTop: 12 }]}>
              ✓ Generated {genResult.batch_count} batch{genResult.batch_count > 1 ? "es" : ""} covering {genResult.total} questions. Switch to the Prompts tab.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Stat({ label, value, highlight }: any) {
  return (
    <View style={[S.cardAlt, { paddingVertical: 12, paddingHorizontal: 16, minWidth: 120 }, highlight && { borderColor: T.primary }]}>
      <Text style={S.label}>{label}</Text>
      <Text style={[S.h2, { marginTop: 2 }, highlight && { color: T.primary }]}>{value ?? "—"}</Text>
    </View>
  );
}

// ─────────────── PROMPTS TAB ──────────────────
function PromptsTab({ jobId, job, batches, onAfter, columns, useOcr }: any) {
  const [active, setActive] = useState<number>(0);
  const [text, setText] = useState<string>("");
  const [pasteback, setPasteback] = useState("");
  const [parseRes, setParseRes] = useState<any>(null);
  const [parsing, setParsing] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (batches.length === 0) return;
    if (active >= batches.length) setActive(0);
    setLoading(true);
    api.getPrompt(jobId, active).then((r) => setText(r.prompt_text)).finally(() => setLoading(false));
  }, [active, batches.length, jobId]);

  const copyPrompt = async () => {
    if (Platform.OS === "web" && (navigator as any)?.clipboard) {
      await (navigator as any).clipboard.writeText(text);
      alert("Prompt copied to clipboard. Paste into Gemini chat.");
    }
  };

  const downloadDocx = () => {
    const url = api.promptDocxUrl(jobId, active);
    if (Platform.OS === "web") window.open(url, "_blank");
    else Linking.openURL(url);
  };

  const submitPasteback = async () => {
    if (!pasteback.trim()) return;
    setParsing(true);
    try {
      const r = await api.parseOutput(jobId, { output_text: pasteback, batch_index: active });
      setParseRes(r);
      onAfter();
    } finally {
      setParsing(false);
    }
  };

  if (batches.length === 0) {
    return (
      <View style={[S.card, { alignItems: "center", padding: 40 }]}>
        <Text style={S.h3}>No prompts generated yet</Text>
        <Text style={[S.pSm, { marginTop: 6 }]}>Go to the Preview tab and click "Build Prompts" first.</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 16 }}>
      <View style={S.card}>
        <Text style={S.h2}>Batches</Text>
        <View style={[S.divider, { marginTop: 8 }]} />
        <View style={[styles.tabs, { marginTop: 4, marginBottom: 0, flexWrap: "wrap" }]}>
          {batches.map((b: any) => (
            <Pressable
              key={b.id}
              testID={`batch-tab-${b.batch_index}`}
              onPress={() => setActive(b.batch_index)}
              style={[styles.tabSm, active === b.batch_index && styles.tabActive, b.parsed && { borderColor: T.ok }]}
            >
              <Text style={[styles.tabText, active === b.batch_index && styles.tabTextActive, b.parsed && { color: T.ok }]}>
                Batch {b.batch_index + 1} ({b.question_numbers?.length} Qs){b.parsed ? " ✓" : ""}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={S.card}>
        <View style={[S.row, { justifyContent: "space-between", marginBottom: 8 }]}>
          <Text style={S.h2}>Prompt for Batch {active + 1}</Text>
          <View style={[S.row, { gap: 8 }]}>
            <Pressable testID="copy-prompt-btn" style={S.button} onPress={copyPrompt}>
              <Text style={S.buttonText}>Copy</Text>
            </Pressable>
            <Pressable testID="download-docx-btn" style={S.buttonGhost} onPress={downloadDocx}>
              <Text style={S.buttonGhostText}>Download .docx</Text>
            </Pressable>
          </View>
        </View>
        <Text style={[S.pSm, { marginBottom: 8 }]}>
          Paste this whole text into Gemini 3 Pro chat (or upload the .docx). Then paste Gemini's reply below.
        </Text>
        {loading ? <ActivityIndicator color={T.primary} /> : (
          <TextInput
            testID="prompt-textarea"
            value={text}
            multiline
            editable={false}
            style={[S.input, styles.code, { minHeight: 220 }]}
          />
        )}
      </View>

      <View style={S.card}>
        <Text style={S.h2}>Paste Gemini Output Here</Text>
        <Text style={[S.pSm, { marginTop: 4, marginBottom: 8 }]}>
          The parser expects the marker format with `=== QUESTION N ===` blocks. Submit when you have the full reply for this batch.
        </Text>
        <TextInput
          testID="pasteback-textarea"
          value={pasteback}
          onChangeText={setPasteback}
          multiline
          placeholder="=== QUESTION 1 ===&#10;[Subject: ...]&#10;..."
          placeholderTextColor={T.textDim}
          style={[S.input, styles.code, { minHeight: 240 }]}
        />
        <View style={[S.row, { marginTop: 12 }]}>
          <Pressable testID="submit-pasteback-btn" style={[S.button, parsing && { opacity: 0.6 }]} onPress={submitPasteback} disabled={parsing}>
            {parsing ? <ActivityIndicator color="#fff" size="small" /> : null}
            <Text style={S.buttonText}>{parsing ? "Parsing..." : "Parse & Save"}</Text>
          </Pressable>
        </View>
        {parseRes ? (
          <View style={{ marginTop: 14, gap: 4 }}>
            <Text style={[S.p, { color: T.ok }]}>✓ Saved {parseRes.saved} questions. Total parsed in job: {parseRes.total_parsed_in_job}</Text>
            {parseRes.errors?.length > 0 ? (
              <Text style={[S.p, { color: T.warn }]}>⚠ {parseRes.errors.length} parse warnings:</Text>
            ) : null}
            {parseRes.errors?.map((e: any, i: number) => (
              <Text key={i} style={[S.pSm, { color: T.warn }]}>  Q{e.number}: {e.error}</Text>
            ))}
            {parseRes.skipped?.length > 0 ? (
              <Text style={[S.pSm, { color: T.textMuted }]}>Skipped: {parseRes.skipped.length} (filtered out)</Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ─────────────── REVIEW TAB ──────────────────
function ReviewTab({ jobId, questions, onAfter, columns }: any) {
  const [selectedNum, setSelectedNum] = useState<number | null>(questions[0]?.question_number ?? null);
  const selected = useMemo(() => questions.find((q: any) => q.question_number === selectedNum), [questions, selectedNum]);
  const [draft, setDraft] = useState<any | null>(null);
  const [saving, setSaving] = useState(false);
  const [pageMap, setPageMap] = useState<Record<string, number>>({});
  const [showHist, setShowHist] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [checked, setChecked] = useState<number[]>([]);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkUp, setBulkUp] = useState({ subject: "", section_group: "", microtopic: "" });

  useEffect(() => {
    api.getPageMap(jobId, columns).then(setPageMap).catch(console.error);
  }, [jobId, columns]);

  useEffect(() => {
    setDraft(selected ? { ...selected } : null);
    setShowHist(false);
  }, [selected?.question_number]);

  const activePageIdx = selectedNum !== null ? pageMap[selectedNum.toString()] : null;

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
        pyq_source: draft.pyq_source,
        pyq_year: draft.pyq_year ? Number(draft.pyq_year) : null,
        confidence: Number(draft.confidence) || 0,
      });
      onAfter();
    } finally {
      setSaving(false);
    }
  };

  const loadHistory = async () => {
    setShowHist(true);
    setHistLoading(true);
    try {
      const r = await api.getHistory(jobId, selectedNum!);
      setHistory(r.revisions || []);
    } catch (e: any) {
      alert("Failed: " + e.message);
    } finally {
      setHistLoading(false);
    }
  };

  const restoreRev = async (rid: string) => {
    if (!confirm("Restore question to this previous snapshot? Current unsaved edits will be lost.")) return;
    try {
      await api.restoreRevision(jobId, selectedNum!, rid);
      setShowHist(false);
      onAfter();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const runBulk = async () => {
    if (checked.length === 0) return;
    const updates: any = {};
    if (bulkUp.subject) updates.subject = bulkUp.subject;
    if (bulkUp.section_group) updates.section_group = bulkUp.section_group;
    if (bulkUp.microtopic) updates.microtopic = bulkUp.microtopic;

    if (Object.keys(updates).length === 0) {
      alert("Enter at least one field to update!");
      return;
    }
    
    setBulkRunning(true);
    try {
      const r = await api.bulkUpdateQuestions(jobId, checked, updates);
      alert(`Updated ${r.updated} questions successfully.`);
      setChecked([]);
      onAfter();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBulkRunning(false);
    }
  };

  if (questions.length === 0) {
    return (
      <View style={[S.card, { alignItems: "center", padding: 40 }]}>
        <Text style={S.h3}>No questions parsed yet</Text>
        <Text style={[S.pSm, { marginTop: 6 }]}>Go to the Prompts tab and parse Gemini's output.</Text>
      </View>
    );
  }

  return (
    <View style={[S.row, { alignItems: "flex-start", gap: 16, height: 720 }]}>
      {/* 1. Sidebar */}
      <View style={[S.card, { width: 260, height: "100%" }]}>
        <View style={[S.row, { justifyContent: "space-between" }]}>
          <Text style={S.h3}>Questions ({questions.length})</Text>
          {checked.length > 0 && (
            <Pressable onPress={() => setChecked([])}><Text style={[S.pSm, { color: T.primary }]}>Clear</Text></Pressable>
          )}
        </View>
        <View style={[S.divider, { marginTop: 8 }]} />
        <ScrollView style={{ flex: 1 }}>
          {questions.map((q: any) => {
            const c = q.confidence || 0;
            const dot = c >= 80 ? T.ok : c >= 60 ? T.warn : T.err;
            const flagged = q.inconsistency_flag && q.inconsistency_flag !== "none";
            const isChecked = checked.includes(q.question_number);
            return (
              <View key={q.question_number} style={[S.row, { gap: 4 }]}>
                <Pressable
                  onPress={() => setChecked(prev => isChecked ? prev.filter(c => c !== q.question_number) : [...prev, q.question_number])}
                  style={{ padding: 4 }}
                >
                  <View style={{ width: 16, height: 16, borderWidth: 1, borderColor: T.border, borderRadius: 3, backgroundColor: isChecked ? T.primary : "transparent", alignItems: "center", justifyContent: "center" }}>
                    {isChecked && <Text style={{ color: "#fff", fontSize: 10, fontWeight: "bold" }}>✓</Text>}
                  </View>
                </Pressable>
                <Pressable
                  testID={`q-row-${q.question_number}`}
                  onPress={() => setSelectedNum(q.question_number)}
                  style={[styles.qRow, { flex: 1 }, selectedNum === q.question_number && { backgroundColor: T.surfaceAlt, borderColor: T.primary }]}
                >
                  <View style={[styles.dot, { backgroundColor: flagged ? T.err : dot }]} />
                  <Text style={[S.p, { flex: 1, fontSize: 13 }]} numberOfLines={1}>Q{q.question_number} · {q.subject || "—"}</Text>
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      </View>

      {/* 2. PDF Preview Panel */}
      <View style={[S.card, { flex: 1.2, height: "100%", overflow: "hidden", padding: 0 }]}>
        <View style={{ padding: 12, borderBottomWidth: 1, borderBottomColor: T.border }}>
          <Text style={S.h3}>PDF Context</Text>
          <Text style={[S.pSm, { fontSize: 11 }]}>
            {activePageIdx !== null && activePageIdx !== undefined ? `Showing Page ${activePageIdx + 1}` : "Locating page..."}
          </Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: 8 }}>
          {activePageIdx !== null && activePageIdx !== undefined ? (
            <Image
              source={{ uri: api.pageImageUrl(jobId, activePageIdx) }}
              style={{ width: "100%", height: 800, resizeMode: "contain" }}
            />
          ) : (
            <View style={{ padding: 20, alignItems: "center" }}>
              <Text style={S.pSm}>No associated page mapping found.</Text>
            </View>
          )}
        </ScrollView>
      </View>

      {/* 3. Edit Panel */}
      <View style={[S.card, { flex: 1, height: "100%" }]}>
        {checked.length > 0 ? (
          <View style={{ gap: 12 }}>
            <View style={[S.row, { justifyContent: "space-between" }]}>
              <Text style={S.h2}>Bulk Edit ({checked.length} items)</Text>
              <Pressable onPress={() => setChecked([])}><Text style={{ color: T.accent }}>Cancel</Text></Pressable>
            </View>
            <Text style={S.pSm}>Specify fields to apply to all {checked.length} selected items. Leave fields blank to keep existing values.</Text>
            <View style={[S.divider, { marginVertical: 8 }]} />
            <Field label="New Subject">
              <TextInput value={bulkUp.subject} onChangeText={(v) => setBulkUp({ ...bulkUp, subject: v })} style={S.input} placeholder="Enter new subject..." />
            </Field>
            <Field label="New Section Group">
              <TextInput value={bulkUp.section_group} onChangeText={(v) => setBulkUp({ ...bulkUp, section_group: v })} style={S.input} />
            </Field>
            <Field label="New Microtopic">
              <TextInput value={bulkUp.microtopic} onChangeText={(v) => setBulkUp({ ...bulkUp, microtopic: v })} style={S.input} />
            </Field>
            <View style={[S.divider, { marginVertical: 12 }]} />
            <Pressable style={[S.button, { alignSelf: "flex-end" }, bulkRunning && { opacity: 0.6 }]} onPress={runBulk} disabled={bulkRunning}>
              {bulkRunning && <ActivityIndicator color="#fff" size="small" />}
              <Text style={S.buttonText}>{bulkRunning ? "Applying..." : "Apply to Selection"}</Text>
            </Pressable>
          </View>
        ) : !draft ? <Text style={S.pSm}>Select a question.</Text> : (
          <View style={{ gap: 12 }}>
            <View style={S.row}>
              <Text style={S.h2}>Q{draft.question_number}</Text>
              <View style={[S.badge, { borderColor: draft.microtopic_valid ? T.ok : T.warn }]}>
                <Text style={[S.badgeText, { color: draft.microtopic_valid ? T.ok : T.warn }]}>
                  {draft.microtopic_valid ? "Taxonomy ✓" : "Taxonomy mismatch"}
                </Text>
              </View>
              {draft.inconsistency_flag && draft.inconsistency_flag !== "none" ? (
                <View style={[S.badge, { borderColor: T.err }]}>
                  <Text style={[S.badgeText, { color: T.err }]}>{draft.inconsistency_flag}</Text>
                </View>
              ) : null}
            </View>

            <View style={[S.rowGap]}>
              <Field label="Subject" w={180}><TextInput value={draft.subject || ""} onChangeText={(v) => setDraft({ ...draft, subject: v })} style={S.input} /></Field>
              <Field label="Section Group" w={220}><TextInput value={draft.section_group || ""} onChangeText={(v) => setDraft({ ...draft, section_group: v })} style={S.input} /></Field>
              <Field label="Microtopic" w={260}><TextInput value={draft.microtopic || ""} onChangeText={(v) => setDraft({ ...draft, microtopic: v })} style={S.input} /></Field>
              <Field label="Confidence" w={100}><TextInput value={String(draft.confidence ?? 0)} onChangeText={(v) => setDraft({ ...draft, confidence: v })} keyboardType="number-pad" style={S.input} /></Field>
            </View>

            <Field label="Statement Lines (one per line)">
              <TextInput
                value={(draft.statement_lines || []).join("\n")}
                onChangeText={(v) => setDraft({ ...draft, statement_lines: v.split("\n") })}
                multiline
                style={[S.input, { minHeight: 100 }]}
              />
            </Field>

            <View style={[S.rowGap]}>
              {(["a", "b", "c", "d"] as const).map((k) => (
                <Field key={k} label={`Option ${k.toUpperCase()}`} w={"50%" as any}>
                  <TextInput
                    value={draft.options?.[k] || ""}
                    onChangeText={(v) => setDraft({ ...draft, options: { ...(draft.options || {}), [k]: v } })}
                    style={[S.input, { minHeight: 40 }]}
                    multiline
                  />
                </Field>
              ))}
            </View>

            <View style={[S.rowGap]}>
              <Field label="Correct Answer" w={140}>
                <TextInput
                  value={draft.correct_answer || ""}
                  onChangeText={(v) => setDraft({ ...draft, correct_answer: v.toLowerCase().slice(0, 1) })}
                  style={S.input}
                />
              </Field>
              <Field label="PYQ Source" w={160}><TextInput value={draft.pyq_source || ""} onChangeText={(v) => setDraft({ ...draft, pyq_source: v })} style={S.input} placeholder="UPSC / BPSC / —" placeholderTextColor={T.textDim} /></Field>
              <Field label="PYQ Year" w={120}><TextInput value={draft.pyq_year ? String(draft.pyq_year) : ""} onChangeText={(v) => setDraft({ ...draft, pyq_year: v })} keyboardType="number-pad" style={S.input} /></Field>
            </View>

            <Field label="Explanation (Markdown)">
              <TextInput
                value={draft.explanation_markdown || ""}
                onChangeText={(v) => setDraft({ ...draft, explanation_markdown: v })}
                multiline
                style={[S.input, styles.code, { minHeight: 220 }]}
              />
            </Field>

            <View style={[S.row, { gap: 10 }]}>
              <Pressable testID="save-question-btn" style={[S.button, saving && { opacity: 0.6 }]} onPress={save} disabled={saving}>
                <Text style={S.buttonText}>{saving ? "Saving..." : "Save Question"}</Text>
              </Pressable>
              <Pressable style={[S.buttonGhost, showHist && { borderColor: T.primary }]} onPress={showHist ? () => setShowHist(false) : loadHistory}>
                <Text style={S.buttonGhostText}>🕘 {showHist ? "Hide History" : "History"}</Text>
              </Pressable>
            </View>

            {showHist && (
              <View style={[S.cardAlt, { marginTop: 8, maxHeight: 280 }]}>
                <Text style={S.label}>Edit History (Newest first)</Text>
                <View style={[S.divider, { marginVertical: 6 }]} />
                {histLoading ? <ActivityIndicator color={T.primary} /> : (
                  <ScrollView nestedScrollEnabled>
                    {history.length === 0 ? <Text style={S.pSm}>No history revisions found.</Text> : null}
                    {history.map((rev) => (
                      <View key={rev.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: T.border, flexDirection: "row", alignItems: "center" }}>
                        <View style={{ flex: 1 }}>
                          <Text style={[S.pSm, { fontWeight: "bold" }]}>{new Date(rev.created_at).toLocaleString()}</Text>
                          <Text style={[S.pSm, { fontSize: 11, color: T.textDim }]}>Source: {rev.source}</Text>
                        </View>
                        <Pressable style={[S.buttonGhost, { paddingVertical: 4, paddingHorizontal: 8 }]} onPress={() => restoreRev(rev.id)}>
                          <Text style={[S.buttonGhostText, { fontSize: 12 }]}>Restore</Text>
                        </Pressable>
                      </View>
                    ))}
                  </ScrollView>
                )}
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

function Field({ label, w, children }: any) {
  return (
    <View style={{ minWidth: typeof w === "number" ? w : undefined, flex: typeof w === "number" ? 0 : 1, width: typeof w === "string" ? w : undefined } as any}>
      <Text style={[S.label, { marginBottom: 6 }]}>{label}</Text>
      {children}
    </View>
  );
}

// ─────────────── EXPORT TAB ──────────────────
function ExportTab({ jobId, job, questions }: any) {
  const [pdfOpts, setPdfOpts] = useState({
    theme: "modern",
    visual_style: "document",
    content_scope: "q_options",
    answer_placement: "inline",
    font_family: "sans",
    font_size: 12,
    show_toc: true,
  });
  const [pdfExporting, setPdfExporting] = useState(false);
  const [expandPdfOpts, setExpandPdfOpts] = useState(false);

  const open = (url: string) => { if (Platform.OS === "web") window.open(url, "_blank"); else Linking.openURL(url); };
  const counts = useMemo(() => {
    let valid = 0, low = 0, flagged = 0;
    for (const q of questions) {
      if (q.microtopic_valid) valid++;
      if ((q.confidence || 0) < 60) low++;
      if (q.inconsistency_flag && q.inconsistency_flag !== "none") flagged++;
    }
    return { valid, low, flagged, total: questions.length };
  }, [questions]);

  const exportPdf = async () => {
    setPdfExporting(true);
    try {
      const res = await api.exportPdf(jobId, pdfOpts);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (Platform.OS === "web") {
        const a = document.createElement("a");
        a.href = url;
        a.download = `export-${jobId}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } else {
        Linking.openURL(url);
      }
    } catch (e: any) {
      alert("PDF export failed: " + e.message);
    } finally {
      setPdfExporting(false);
    }
  };

  return (
    <View style={{ gap: 16 }}>
      <View style={S.card}>
        <Text style={S.h2}>Export</Text>
        <Text style={[S.pSm, { marginTop: 4 }]}>Final downloads in schema 2.0. The JSON is directly compatible with the Pilot Pro quiz engine.</Text>
        <View style={[S.divider, { marginTop: 8 }]} />
        <View style={[S.rowGap, { marginTop: 8 }]}>
          <Stat label="Total parsed" value={counts.total} highlight />
          <Stat label="Taxonomy ✓" value={counts.valid} />
          <Stat label="Confidence <60" value={counts.low} />
          <Stat label="Inconsistencies" value={counts.flagged} />
        </View>
        <View style={[S.row, { gap: 12, marginTop: 18, flexWrap: "wrap" }]}>
          <Pressable testID="export-json-btn" style={S.button} onPress={() => open(api.exportJsonUrl(jobId))}>
            <Text style={S.buttonText}>📄 JSON</Text>
          </Pressable>
          <Pressable testID="export-md-btn" style={S.buttonGhost} onPress={() => open(api.exportMdUrl(jobId))}>
            <Text style={S.buttonGhostText}>📝 Markdown</Text>
          </Pressable>
          <Pressable testID="export-docx-btn" style={S.buttonGhost} onPress={() => open(api.exportDocxUrl(jobId))}>
            <Text style={S.buttonGhostText}>📋 DOCX</Text>
          </Pressable>
          <Pressable testID="export-pdf-toggle" style={[S.buttonGhost, expandPdfOpts && { borderColor: T.accent }]} onPress={() => setExpandPdfOpts(!expandPdfOpts)}>
            <Text style={S.buttonGhostText}>📕 PDF {expandPdfOpts ? "▲" : "▼"}</Text>
          </Pressable>
        </View>
      </View>

      {expandPdfOpts && (
        <View style={S.card}>
          <Text style={S.h3}>PDF Export Options</Text>
          <View style={[S.divider, { marginTop: 8, marginBottom: 12 }]} />
          
          <View style={[S.rowGap, { marginTop: 16, gap: 24 }]}>
            <Field label="Theme" w={260}>
              <View style={[S.row, { flexWrap: "wrap", gap: 6 }]}>
                {["modern", "classic", "sepia", "historical", "dark"].map((t) => (
                  <Pressable
                    key={t}
                    onPress={() => setPdfOpts({ ...pdfOpts, theme: t })}
                    style={[
                      { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1 },
                      pdfOpts.theme === t
                        ? { backgroundColor: T.accent, borderColor: T.accent }
                        : { backgroundColor: T.surface, borderColor: T.border }
                    ]}
                  >
                    <Text style={[S.pSm, { color: pdfOpts.theme === t ? T.bg : T.text }]}>{t}</Text>
                  </Pressable>
                ))}
              </View>
            </Field>

            <Field label="Visual Style" w={220}>
              <View style={[S.row, { gap: 6 }]}>
                {["document", "flashcard"].map((v) => (
                  <Pressable
                    key={v}
                    onPress={() => setPdfOpts({ ...pdfOpts, visual_style: v })}
                    style={[
                      { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, flex: 1 },
                      pdfOpts.visual_style === v
                        ? { backgroundColor: T.accent, borderColor: T.accent }
                        : { backgroundColor: T.surface, borderColor: T.border }
                    ]}
                  >
                    <Text style={[S.pSm, { color: pdfOpts.visual_style === v ? T.bg : T.text, textAlign: "center" }]}>{v}</Text>
                  </Pressable>
                ))}
              </View>
            </Field>

            <Field label="Content Scope" w={340}>
              <View style={[S.row, { gap: 6 }]}>
                {["q_only", "q_options", "q_options_expl"].map((c) => (
                  <Pressable
                    key={c}
                    onPress={() => setPdfOpts({ ...pdfOpts, content_scope: c })}
                    style={[
                      { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6, borderWidth: 1, flex: 1 },
                      pdfOpts.content_scope === c
                        ? { backgroundColor: T.accent, borderColor: T.accent }
                        : { backgroundColor: T.surface, borderColor: T.border }
                    ]}
                  >
                    <Text style={[S.pSm, { color: pdfOpts.content_scope === c ? T.bg : T.text, textAlign: "center", fontSize: 11 }]}>{c.replace(/_/g, "+")}</Text>
                  </Pressable>
                ))}
              </View>
            </Field>

            <Field label="Answers" w={180}>
              <View style={[S.row, { gap: 6 }]}>
                {["inline", "end"].map((a) => (
                  <Pressable
                    key={a}
                    onPress={() => setPdfOpts({ ...pdfOpts, answer_placement: a })}
                    style={[
                      { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, flex: 1 },
                      pdfOpts.answer_placement === a
                        ? { backgroundColor: T.accent, borderColor: T.accent }
                        : { backgroundColor: T.surface, borderColor: T.border }
                    ]}
                  >
                    <Text style={[S.pSm, { color: pdfOpts.answer_placement === a ? T.bg : T.text, textAlign: "center" }]}>{a}</Text>
                  </Pressable>
                ))}
              </View>
            </Field>

            <Field label="Font" w={240}>
              <View style={[S.row, { gap: 6 }]}>
                {["sans", "serif", "mono"].map((f) => (
                  <Pressable
                    key={f}
                    onPress={() => setPdfOpts({ ...pdfOpts, font_family: f })}
                    style={[
                      { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, flex: 1 },
                      pdfOpts.font_family === f
                        ? { backgroundColor: T.accent, borderColor: T.accent }
                        : { backgroundColor: T.surface, borderColor: T.border }
                    ]}
                  >
                    <Text style={[S.pSm, { color: pdfOpts.font_family === f ? T.bg : T.text, textAlign: "center" }]}>{f}</Text>
                  </Pressable>
                ))}
              </View>
            </Field>

            <Field label="Font Size" w={100}>
              <TextInput
                value={String(pdfOpts.font_size)}
                onChangeText={(v) => setPdfOpts({ ...pdfOpts, font_size: parseInt(v) || 12 })}
                keyboardType="number-pad"
                style={S.input}
              />
            </Field>
          </View>

          <Pressable
            testID="export-pdf-btn"
            style={[S.button, pdfExporting && { opacity: 0.6 }]}
            onPress={exportPdf}
            disabled={pdfExporting}
          >
            <Text style={S.buttonText}>{pdfExporting ? "Generating PDF..." : "Generate & Download PDF"}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", gap: 6, marginBottom: 16, flexWrap: "wrap" },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surface,
  },
  tabSm: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surface,
  },
  tabActive: { backgroundColor: T.surfaceAlt, borderColor: T.primary },
  tabText: { color: T.textMuted, fontWeight: "600", fontSize: 13 },
  tabTextActive: { color: T.text },
  qRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "transparent",
    marginVertical: 2,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  code: {
    fontFamily: Platform.select({ web: "ui-monospace, SFMono-Regular, Menlo, monospace", default: "monospace" }),
    fontSize: 12,
    lineHeight: 18,
  },
});

function LowConfidenceTab({ jobId, questions, onAfter }: any) {
  const lowConf = questions.filter((q: any) => (q.confidence || 0) < 80);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [pasteback, setPasteback] = useState("");
  const [parsing, setParsing] = useState(false);

  const generateReverify = async () => {
    setLoading(true);
    try {
      const r = await api.reverifyPrompt(jobId, 80);
      setPrompt(r.prompt_text || r.prompt || "");
    } catch (e: any) {
      alert("Failed: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const submitFixes = async () => {
    if (!pasteback.trim()) return;
    setParsing(true);
    try {
      await api.parseOutput(jobId, { output_text: pasteback });
      alert("Successfully integrated corrections!");
      setPasteback("");
      onAfter();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setParsing(false);
    }
  };

  return (
    <View style={{ gap: 16 }}>
      <View style={S.card}>
        <View style={[S.row, { justifyContent: "space-between" }]}>
          <View>
            <Text style={S.h2}>Low Confidence Queue ({"<"}80)</Text>
            <Text style={[S.pSm, { marginTop: 4 }]}>{lowConf.length} questions need manual verification or prompt re-run.</Text>
          </View>
          <Pressable style={S.button} onPress={generateReverify} disabled={loading || lowConf.length === 0}>
            <Text style={S.buttonText}>{loading ? "Generating..." : "Build Re-verify Prompt"}</Text>
          </Pressable>
        </View>
      </View>

      <View style={[S.row, { alignItems: "flex-start", gap: 16 }]}>
        <View style={[S.card, { flex: 1, maxHeight: 600 }]}>
          <Text style={S.h3}>Suspect List</Text>
          <View style={[S.divider, { marginVertical: 8 }]} />
          <ScrollView style={{ flex: 1 }}>
            {lowConf.map((q: any) => (
              <View key={q.question_number} style={[styles.qRow, { backgroundColor: T.bg, marginBottom: 4 }]}>
                <View style={[styles.dot, { backgroundColor: T.err }]} />
                <Text style={[S.p, { flex: 1 }]}>Q{q.question_number} · {q.subject || "Untitled"}</Text>
                <Text style={[S.p, { fontWeight: "bold", color: T.err }]}>{q.confidence || 0}%</Text>
              </View>
            ))}
            {lowConf.length === 0 && <Text style={S.pSm}>No low-confidence items found! 🎉</Text>}
          </ScrollView>
        </View>

        <View style={[S.card, { flex: 2, minHeight: 400 }]}>
          <Text style={S.h3}>Re-verify Prompt & Corrections</Text>
          <View style={[S.divider, { marginVertical: 8 }]} />
          {prompt ? (
            <>
              <Text style={[S.label, { marginBottom: 4 }]}>Step 1: Copy Prompt for Gemini</Text>
              <TextInput
                value={prompt}
                editable={false}
                multiline
                style={[S.input, styles.code, { minHeight: 120, backgroundColor: T.surfaceAlt, fontSize: 11 }]}
              />
              <Pressable style={[S.buttonGhost, { alignSelf: "flex-end", marginTop: 6 }]} onPress={() => {
                if (Platform.OS === "web") navigator.clipboard.writeText(prompt);
                alert("Copied!");
              }}>
                <Text style={S.buttonGhostText}>📋 Copy Prompt</Text>
              </Pressable>

              <View style={[S.divider, { marginVertical: 16 }]} />

              <Text style={[S.label, { marginBottom: 4 }]}>Step 2: Paste Fixed Output Here</Text>
              <TextInput
                multiline
                value={pasteback}
                onChangeText={setPasteback}
                placeholder="Paste the JSON corrections block back..."
                style={[S.input, { minHeight: 160 }]}
              />
              <Pressable style={[S.button, { marginTop: 12, alignSelf: "flex-end" }]} onPress={submitFixes} disabled={parsing}>
                {parsing && <ActivityIndicator color="#fff" size="small" />}
                <Text style={S.buttonText}>{parsing ? "Parsing..." : "Inject Corrections"}</Text>
              </Pressable>
            </>
          ) : (
            <View style={{ alignItems: "center", padding: 40 }}>
              <Text style={S.pSm}>Generate prompt to start re-verifying.</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}
