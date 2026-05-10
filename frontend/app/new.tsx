import { useState } from "react";
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
import { createJob } from "../src/api";

const EXAM_CATEGORIES = ["cse", "state_psc", "bpsc", "uppcs", "mppsc", "other"];
const STAGES = ["prelims", "mains"];
const PAPERS = ["pre_gs1", "pre_csat", "mains_gs1", "mains_gs2", "mains_gs3", "mains_gs4", "mains_essay", "other"];
const LEVELS = ["Full Test", "Sectional Test", "Subject Test", "PYQ"];
const PAPER_TYPES = ["Full Length", "Sectional", "Topic-wise"];

type FileLike = File | null;

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
  const [title, setTitle] = useState("");
  const [institute, setInstitute] = useState("");
  const [programId, setProgramId] = useState("");
  const [programName, setProgramName] = useState("");
  const [series, setSeries] = useState("Test Series");
  const [level, setLevel] = useState("Full Test");
  const [paperType, setPaperType] = useState("Full Length");
  const [defaultMinutes, setDefaultMinutes] = useState("120");
  const [launchYear, setLaunchYear] = useState("2026");
  const [examCategory, setExamCategory] = useState("cse");
  const [stage, setStage] = useState("prelims");
  const [paper, setPaper] = useState("pre_gs1");
  const [qpFile, setQpFile] = useState<FileLike>(null);
  const [solFile, setSolFile] = useState<FileLike>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    if (!qpFile) {
      setError("Question Paper PDF is required");
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append("title", title.trim());
      fd.append(
        "metadata_json",
        JSON.stringify({
          title: title.trim(),
          launch_year: parseInt(launchYear, 10) || null,
          institute: institute.trim(),
          program_id: programId.trim(),
          program_name: programName.trim(),
          series: series.trim(),
          level,
          paperType,
          defaultMinutes: parseInt(defaultMinutes, 10) || null,
          sourceMode: "docx-inline",
          schema_version: "2.0",
          institute_id: programId.trim() ? `${institute.trim().toLowerCase()}-${programId.trim()}` : null,
          institute_name: institute.trim() || null,
          exam_frame: { exam_category: examCategory, specific_exam: null, stage, paper },
        })
      );
      fd.append("qp_pdf", qpFile);
      if (solFile) fd.append("sol_pdf", solFile);
      const r = await createJob(fd);
      router.replace({ pathname: "/jobs/[id]", params: { id: r.id } });
    } catch (e: any) {
      setError(e.message || "Submission failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView style={S.page} contentContainerStyle={{ paddingBottom: 60 }}>
      <View style={[S.container, { maxWidth: 880 }]}>
        <Pressable onPress={() => router.back()} style={[S.buttonGhost, { alignSelf: "flex-start", marginBottom: 16 }]}>
          <Text style={S.buttonGhostText}>← Back</Text>
        </Pressable>
        <Text style={S.h1}>New Job</Text>
        <Text style={[S.pSm, { marginTop: 4, marginBottom: 24 }]}>
          Upload the Question Paper PDF (and optional Solutions PDF) and fill in the test metadata.
        </Text>

        <View style={[S.card, { marginBottom: 16 }]}>
          <Text style={S.h2}>1 · Files</Text>
          <View style={[S.divider, { marginTop: 8 }]} />
          <View style={{ gap: 14 }}>
            <View>
              <Text style={S.label}>Question Paper PDF (required)</Text>
              <View style={{ marginTop: 6 }}>{pickPdf(setQpFile, "qp-file-input")}</View>
              {qpFile ? <Text style={[S.pSm, { marginTop: 4 }]}>✓ {qpFile.name} ({Math.round(qpFile.size / 1024)} KB)</Text> : null}
            </View>
            <View>
              <Text style={S.label}>Solutions PDF (optional)</Text>
              <View style={{ marginTop: 6 }}>{pickPdf(setSolFile, "sol-file-input")}</View>
              {solFile ? <Text style={[S.pSm, { marginTop: 4 }]}>✓ {solFile.name} ({Math.round(solFile.size / 1024)} KB)</Text> : null}
            </View>
          </View>
        </View>

        <View style={[S.card, { marginBottom: 16 }]}>
          <Text style={S.h2}>2 · Test Metadata</Text>
          <View style={[S.divider, { marginTop: 8 }]} />
          <View style={{ gap: 14 }}>
            <Field label="Title *">
              <TextInput
                testID="title-input"
                value={title}
                onChangeText={setTitle}
                placeholder="e.g., Test 1 - GS Simulator 2026 - Forum IAS"
                placeholderTextColor={T.textDim}
                style={S.input}
              />
            </Field>
            <View style={[S.rowGap]}>
              <Field label="Institute" style={{ flex: 1, minWidth: 220 }}>
                <TextInput
                  testID="institute-input"
                  value={institute}
                  onChangeText={setInstitute}
                  placeholder="Forum IAS"
                  placeholderTextColor={T.textDim}
                  style={S.input}
                />
              </Field>
              <Field label="Launch Year" style={{ width: 140 }}>
                <TextInput
                  testID="year-input"
                  value={launchYear}
                  onChangeText={setLaunchYear}
                  keyboardType="number-pad"
                  placeholderTextColor={T.textDim}
                  style={S.input}
                />
              </Field>
            </View>
            <View style={[S.rowGap]}>
              <Field label="Program ID" style={{ flex: 1, minWidth: 200 }}>
                <TextInput value={programId} onChangeText={setProgramId} placeholder="gs-simulator" placeholderTextColor={T.textDim} style={S.input} />
              </Field>
              <Field label="Program Name" style={{ flex: 1, minWidth: 200 }}>
                <TextInput value={programName} onChangeText={setProgramName} placeholder="GS Simulator" placeholderTextColor={T.textDim} style={S.input} />
              </Field>
            </View>
            <View style={[S.rowGap]}>
              <Field label="Series" style={{ flex: 1, minWidth: 200 }}>
                <TextInput value={series} onChangeText={setSeries} placeholderTextColor={T.textDim} style={S.input} />
              </Field>
              <Field label="Default Minutes" style={{ width: 140 }}>
                <TextInput value={defaultMinutes} onChangeText={setDefaultMinutes} keyboardType="number-pad" placeholderTextColor={T.textDim} style={S.input} />
              </Field>
            </View>
            <View style={[S.rowGap]}>
              <Field label="Level" style={{ flex: 1, minWidth: 180 }}>
                <Picker value={level} onChange={setLevel} options={LEVELS} testID="level-picker" />
              </Field>
              <Field label="Paper Type" style={{ flex: 1, minWidth: 180 }}>
                <Picker value={paperType} onChange={setPaperType} options={PAPER_TYPES} testID="paper-type-picker" />
              </Field>
            </View>
          </View>
        </View>

        <View style={[S.card, { marginBottom: 24 }]}>
          <Text style={S.h2}>3 · Exam Frame</Text>
          <View style={[S.divider, { marginTop: 8 }]} />
          <View style={[S.rowGap]}>
            <Field label="Exam Category" style={{ flex: 1, minWidth: 180 }}>
              <Picker value={examCategory} onChange={setExamCategory} options={EXAM_CATEGORIES} testID="exam-category-picker" />
            </Field>
            <Field label="Stage" style={{ flex: 1, minWidth: 140 }}>
              <Picker value={stage} onChange={setStage} options={STAGES} testID="stage-picker" />
            </Field>
            <Field label="Paper" style={{ flex: 1, minWidth: 180 }}>
              <Picker value={paper} onChange={setPaper} options={PAPERS} testID="paper-picker" />
            </Field>
          </View>
        </View>

        {error ? (
          <View style={[S.card, { borderColor: T.err, marginBottom: 16 }]}>
            <Text style={[S.p, { color: T.err }]} testID="form-error">{error}</Text>
          </View>
        ) : null}

        <View style={[S.row, { gap: 10 }]}>
          <Pressable
            testID="create-job-btn"
            style={[S.button, submitting && { opacity: 0.6 }]}
            onPress={submit}
            disabled={submitting}
          >
            {submitting ? <ActivityIndicator color="#fff" size="small" /> : null}
            <Text style={S.buttonText}>{submitting ? "Creating..." : "Create Job & Continue"}</Text>
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

function Picker({ value, onChange, options, testID }: { value: string; onChange: (v: string) => void; options: string[]; testID?: string }) {
  if (Platform.OS === "web") {
    return (
      <select
        data-testid={testID}
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
  // Mobile fallback: cycle on press
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

const styles = StyleSheet.create({});
