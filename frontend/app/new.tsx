import { useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { sharedStyles as S, T } from "../src/theme";
import { createJob, api } from "../src/api";

const EXAM_CATEGORIES = ["cse", "state_psc", "bpsc", "uppcs", "mppsc", "other"];
const STAGES = ["prelims", "mains"];
const PAPERS = ["pre_gs1", "pre_csat", "mains_gs1", "mains_gs2", "mains_gs3", "mains_gs4", "mains_essay", "other"];
const LEVELS = ["Full Test", "Sectional Test", "Subject Test", "PYQ"];
const PAPER_TYPES = ["Full Length", "Sectional", "Topic-wise"];

type FileLike = File | null;

interface BatchEntry {
  id: string;
  title: string;
  institute: string;
  programId: string;
  programName: string;
  series: string;
  level: string;
  paperType: string;
  defaultMinutes: string;
  launchYear: string;
  examCategory: string;
  stage: string;
  paper: string;
  qpFile: FileLike;
  solFile: FileLike;
}

interface SubmitResult {
  ok: boolean;
  id?: string;
  title: string;
  error?: string;
}

function createEmptyBatch(): BatchEntry {
  return {
    id: Math.random().toString(36).substring(7),
    title: "",
    institute: "",
    programId: "",
    programName: "",
    series: "Test Series",
    level: "Full Test",
    paperType: "Full Length",
    defaultMinutes: "120",
    launchYear: "2026",
    examCategory: "cse",
    stage: "prelims",
    paper: "pre_gs1",
    qpFile: null,
    solFile: null,
  };
}

function pickPdf(setter: (f: FileLike) => void, testID: string) {
  if (Platform.OS !== "web") {
    return null;
  }
  return (
    <input
      type="file"
      accept="application/pdf,.pdf"
      data-testid={testID}
      onChange={(e: any) => {
        const f = e.target.files?.[0] || null;
        setter(f);
      }}
      style={{
        backgroundColor: T.bg,
        color: T.text,
        border: `1px solid ${T.border}`,
        borderRadius: 8,
        padding: 10,
        fontSize: 13,
        fontFamily: "inherit",
        width: "100%",
      }}
    />
  );
}

export default function NewJobScreen() {
  const router = useRouter();
  const [batches, setBatches] = useState<BatchEntry[]>([createEmptyBatch()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SubmitResult[]>([]);

  const addBatch = () => setBatches((curr) => [...curr, createEmptyBatch()]);
  const removeBatch = (id: string) => setBatches((curr) => curr.filter((b) => b.id !== id));
  const updateBatch = (id: string, patch: Partial<BatchEntry>) => {
    setBatches((curr) => curr.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  };

  const handleQpFile = async (id: string, file: FileLike) => {
    if (!file) {
      updateBatch(id, { qpFile: null });
      return;
    }
    // Immediate set
    updateBatch(id, { qpFile: file });
    
    // Trigger auto-fill heuristic from filename
    try {
      const hints = await api.filenameHints(file.name);
      const patch: Partial<BatchEntry> = {};
      if (hints.title_suggestion) patch.title = hints.title_suggestion;
      if (hints.institute) patch.institute = hints.institute;
      if (hints.program_id) patch.programId = hints.program_id;
      if (hints.program_name) patch.programName = hints.program_name;
      updateBatch(id, patch);
    } catch (err) {
      // Silently continue if hints fail
    }
  };

  const submitAll = async () => {
    setError(null);
    const valid = batches.filter(b => b.title.trim() && b.qpFile);
    if (valid.length === 0) {
      setError("Please ensure at least one batch has a valid Title and Question Paper PDF.");
      return;
    }
    setSubmitting(true);
    const runResults: SubmitResult[] = [];

    for (const b of valid) {
      try {
        const fd = new FormData();
        fd.append("title", b.title.trim());
        fd.append(
          "metadata_json",
          JSON.stringify({
            title: b.title.trim(),
            launch_year: parseInt(b.launchYear, 10) || null,
            institute: b.institute.trim(),
            program_id: b.programId.trim(),
            program_name: b.programName.trim(),
            series: b.series.trim(),
            level: b.level,
            paperType: b.paperType,
            defaultMinutes: parseInt(b.defaultMinutes, 10) || null,
            sourceMode: "docx-inline",
            schema_version: "2.0",
            institute_id: b.programId.trim() ? `${b.institute.trim().toLowerCase()}-${b.programId.trim()}` : null,
            institute_name: b.institute.trim() || null,
            exam_frame: { 
              exam_category: b.examCategory, 
              specific_exam: null, 
              stage: b.stage, 
              paper: b.paper 
            },
          })
        );
        fd.append("qp_pdf", b.qpFile as any);
        if (b.solFile) fd.append("sol_pdf", b.solFile as any);
        
        const r = await createJob(fd);
        runResults.push({ ok: true, id: r.id, title: b.title.trim() });
      } catch (e: any) {
        runResults.push({ ok: false, title: b.title.trim(), error: e.message || "Submission failure" });
      }
    }
    
    setResults(runResults);
    setSubmitting(false);

    // User experience shorthand: if only ONE single successful job was created, shortcut right into it
    if (runResults.length === 1 && runResults[0].ok) {
      router.replace({ pathname: "/jobs/[id]", params: { id: runResults[0].id } });
    }
  };

  // Results View overlay or inline
  if (results.length > 0) {
    return (
      <ScrollView style={S.page} contentContainerStyle={{ paddingBottom: 60 }}>
        <View style={[S.container, { maxWidth: 800 }]}>
          <Text style={S.h1}>Batch Upload Results</Text>
          <Text style={[S.pSm, { marginTop: 4, marginBottom: 24 }]}>Results from {results.length} job process iterations.</Text>
          <View style={{ gap: 12, marginBottom: 24 }}>
            {results.map((res, i) => (
              <View key={i} style={[S.card, { borderColor: res.ok ? T.ok : T.err, borderWidth: 1.5 }]}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={[S.p, { fontWeight: "600", color: res.ok ? T.text : T.err }]}>
                    {res.ok ? "✅ Success" : "❌ Failed"} — {res.title}
                  </Text>
                  {res.ok && (
                    <Pressable style={[S.button, { paddingVertical: 8, paddingHorizontal: 12 }]} onPress={() => router.push({ pathname: "/jobs/[id]", params: { id: res.id } })}>
                      <Text style={S.buttonText}>Open Job →</Text>
                    </Pressable>
                  )}
                </View>
                {!res.ok && <Text style={[S.pSm, { color: T.err, marginTop: 4 }]}>{res.error}</Text>}
              </View>
            ))}
          </View>
          <Pressable style={S.buttonGhost} onPress={() => router.replace("/")}>
            <Text style={S.buttonGhostText}>Back to Job Dashboard</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={S.page} contentContainerStyle={{ paddingBottom: 80 }}>
      <View style={[S.container, { maxWidth: 880 }]}>
        <Pressable onPress={() => router.back()} style={[S.buttonGhost, { alignSelf: "flex-start", marginBottom: 16 }]}>
          <Text style={S.buttonGhostText}>← Back</Text>
        </Pressable>
        <Text style={S.h1}>New Batch Job Upload</Text>
        <Text style={[S.pSm, { marginTop: 4, marginBottom: 24 }]}>
          Add test pairs. Title and metadata will attempt to auto-fill based on the PDF file name.
        </Text>

        {batches.map((batch, index) => (
          <View key={batch.id} style={[S.card, { marginBottom: 20, borderLeftWidth: 4, borderLeftColor: T.accent }]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <Text style={[S.h2, { color: T.accent }]}>Batch Pair #{index + 1}</Text>
              {batches.length > 1 && (
                <Pressable onPress={() => removeBatch(batch.id)} style={{ padding: 4 }}>
                  <Text style={{ color: T.err, fontSize: 13, fontWeight: "600" }}>Remove</Text>
                </Pressable>
              )}
            </View>
            
            {/* Row 1: File Input */}
            <View style={[S.rowGap, { marginBottom: 16 }]}>
              <View style={{ flex: 1 }}>
                <Text style={S.label}>Question Paper (Required)</Text>
                <View style={{ marginTop: 6 }}>
                  {pickPdf((f) => handleQpFile(batch.id, f), `qp-input-${index}`)}
                </View>
                {batch.qpFile && (
                  <Text style={[S.pSm, { marginTop: 4, color: T.ok }]}>✓ {batch.qpFile.name}</Text>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={S.label}>Solutions PDF (Optional)</Text>
                <View style={{ marginTop: 6 }}>
                  {pickPdf((f) => updateBatch(batch.id, { solFile: f }), `sol-input-${index}`)}
                </View>
                {batch.solFile && (
                  <Text style={[S.pSm, { marginTop: 4, color: T.ok }]}>✓ {batch.solFile.name}</Text>
                )}
              </View>
            </View>

            <View style={[S.divider, { marginBottom: 16 }]} />

            {/* Row 2: Base Meta */}
            <View style={[S.rowGap, { marginBottom: 12 }]}>
              <Field label="Job Title *" style={{ flex: 2 }}>
                <TextInput
                  value={batch.title}
                  onChangeText={(v) => updateBatch(batch.id, { title: v })}
                  placeholder="e.g., Test 1 - GS Simulator 2026"
                  placeholderTextColor={T.textDim}
                  style={S.input}
                />
              </Field>
              <Field label="Launch Year" style={{ width: 120 }}>
                <TextInput
                  value={batch.launchYear}
                  onChangeText={(v) => updateBatch(batch.id, { launchYear: v })}
                  keyboardType="number-pad"
                  style={S.input}
                />
              </Field>
            </View>

            {/* Row 3: Org Data */}
            <View style={[S.rowGap, { marginBottom: 12 }]}>
              <Field label="Institute" style={{ flex: 1 }}>
                <TextInput
                  value={batch.institute}
                  onChangeText={(v) => updateBatch(batch.id, { institute: v })}
                  placeholder="Forum IAS"
                  placeholderTextColor={T.textDim}
                  style={S.input}
                />
              </Field>
              <Field label="Program ID" style={{ flex: 1 }}>
                <TextInput
                  value={batch.programId}
                  onChangeText={(v) => updateBatch(batch.id, { programId: v })}
                  placeholder="gs-simulator"
                  placeholderTextColor={T.textDim}
                  style={S.input}
                />
              </Field>
              <Field label="Program Name" style={{ flex: 1 }}>
                <TextInput
                  value={batch.programName}
                  onChangeText={(v) => updateBatch(batch.id, { programName: v })}
                  placeholder="GS Simulator"
                  placeholderTextColor={T.textDim}
                  style={S.input}
                />
              </Field>
            </View>

            {/* Row 4: Sub-descriptors */}
            <View style={[S.rowGap, { marginBottom: 12 }]}>
              <Field label="Series" style={{ flex: 1 }}>
                <TextInput
                  value={batch.series}
                  onChangeText={(v) => updateBatch(batch.id, { series: v })}
                  style={S.input}
                />
              </Field>
              <Field label="Level" style={{ flex: 1 }}>
                <Picker value={batch.level} onChange={(v) => updateBatch(batch.id, { level: v })} options={LEVELS} />
              </Field>
              <Field label="Paper Type" style={{ flex: 1 }}>
                <Picker value={batch.paperType} onChange={(v) => updateBatch(batch.id, { paperType: v })} options={PAPER_TYPES} />
              </Field>
            </View>

            {/* Frame subcard */}
            <View style={{ backgroundColor: T.surfaceAlt, borderRadius: 8, padding: 12, marginTop: 6 }}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: T.textDim, marginBottom: 8, letterSpacing: 0.5 }}>EXAM FRAME</Text>
              <View style={[S.rowGap]}>
                <Field label="Category" style={{ flex: 1 }}>
                  <Picker value={batch.examCategory} onChange={(v) => updateBatch(batch.id, { examCategory: v })} options={EXAM_CATEGORIES} />
                </Field>
                <Field label="Stage" style={{ flex: 1 }}>
                  <Picker value={batch.stage} onChange={(v) => updateBatch(batch.id, { stage: v })} options={STAGES} />
                </Field>
                <Field label="Paper" style={{ flex: 1 }}>
                  <Picker value={batch.paper} onChange={(v) => updateBatch(batch.id, { paper: v })} options={PAPERS} />
                </Field>
              </View>
            </View>

          </View>
        ))}

        <Pressable 
          style={[S.card, { borderStyle: "dashed", borderWidth: 2, borderColor: T.border, paddingVertical: 20, alignItems: "center", marginBottom: 24, opacity: 0.8 }]}
          onPress={addBatch}
        >
          <Text style={{ color: T.accent, fontWeight: "600" }}>+ Add Another PDF Pair</Text>
        </Pressable>

        {error ? (
          <View style={[S.card, { borderColor: T.err, marginBottom: 16, borderWidth: 1 }]}>
            <Text style={[S.p, { color: T.err }]}>{error}</Text>
          </View>
        ) : null}

        <View style={[S.row, { gap: 12 }]}>
          <Pressable
            style={[S.button, submitting && { opacity: 0.6 }, { paddingHorizontal: 24 }]}
            onPress={submitAll}
            disabled={submitting}
          >
            {submitting ? <ActivityIndicator color="#fff" size="small" style={{ marginRight: 8 }} /> : null}
            <Text style={S.buttonText}>
              {submitting ? "Processing Requests..." : `Create ${batches.filter(b => b.title.trim() && b.qpFile).length || 1} Job(s)`}
            </Text>
          </Pressable>
          <Pressable style={S.buttonGhost} onPress={() => router.back()}>
            <Text style={S.buttonGhostText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

function Field({ label, style, children }: any) {
  return (
    <View style={style}>
      <Text style={[S.label, { marginBottom: 6 }]}>{label}</Text>
      {children}
    </View>
  );
}

function Picker({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  if (Platform.OS === "web") {
    return (
      <select
        value={value}
        onChange={(e: any) => onChange(e.target.value)}
        style={{
          backgroundColor: T.bg,
          color: T.text,
          border: `1px solid ${T.border}`,
          borderRadius: 8,
          padding: 10,
          fontSize: 14,
          fontFamily: "inherit",
          width: "100%",
        }}
      >
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }
  const idx = options.indexOf(value);
  return (
    <Pressable
      onPress={() => onChange(options[(idx + 1) % options.length])}
      style={S.input}
    >
      <Text style={[S.p, { color: T.text }]}>{value}</Text>
    </Pressable>
  );
}
