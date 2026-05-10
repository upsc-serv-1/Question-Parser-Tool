import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { api } from "../src/api";
import { sharedStyles as S, T } from "../src/theme";

type Job = {
  id: string;
  title: string;
  status: string;
  total_questions: number;
  metadata: any;
  created_at: string;
};

const STATUS_COLORS: Record<string, string> = {
  created: T.textMuted,
  extracted: T.info,
  prompts_generated: T.warn,
  partially_parsed: T.warn,
  reviewed: T.ok,
  exported: T.primary,
};

export default function HomeIndex() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listJobs();
      setJobs(r.items || []);
    } catch (e: any) {
      setError(e.message || "Failed to load jobs");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  const handleDelete = (id: string) => {
    const confirm = (typeof window !== "undefined" && window.confirm)
      ? window.confirm("Delete this job and all its data?")
      : true;
    if (!confirm) return;
    api.deleteJob(id).then(refresh).catch((e) => Alert.alert("Delete failed", e.message));
  };

  return (
    <ScrollView
      style={S.page}
      contentContainerStyle={{ paddingBottom: 60 }}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={T.primary} />}
    >
      <View style={S.container}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={S.h1}>JSON Tool</Text>
            <Text style={[S.pSm, { marginTop: 4 }]}>
              PDF → Quiz JSON Extractor · Gemini-assisted · Schema 2.0
            </Text>
          </View>
          <Pressable
            testID="new-job-btn"
            style={S.button}
            onPress={() => router.push("/new")}
          >
            <Text style={S.buttonText}>+ New Job</Text>
          </Pressable>
        </View>

        {error ? (
          <View style={[S.card, { borderColor: T.err, marginBottom: 16 }]}>
            <Text style={[S.p, { color: T.err }]}>Error: {error}</Text>
          </View>
        ) : null}

        {loading && jobs.length === 0 ? (
          <View style={[S.card, styles.center]}>
            <ActivityIndicator color={T.primary} />
            <Text style={[S.pSm, { marginTop: 8 }]}>Loading jobs...</Text>
          </View>
        ) : jobs.length === 0 ? (
          <View style={[S.card, styles.empty]}>
            <Text style={S.h2}>No jobs yet</Text>
            <Text style={[S.pSm, { marginTop: 6, textAlign: "center" }]}>
              Create a new job by uploading a Question Paper PDF (and optional Solutions PDF) and filling
              in the test metadata. The tool will split, prompt-build for Gemini, and parse back the
              structured output.
            </Text>
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            {jobs.map((j) => (
              <Pressable
                key={j.id}
                testID={`job-row-${j.id}`}
                style={({ hovered }: any) => [
                  styles.jobRow,
                  hovered && { borderColor: T.borderStrong, backgroundColor: T.surfaceAlt },
                ]}
                onPress={() => router.push({ pathname: "/jobs/[id]", params: { id: j.id } })}
              >
                <View style={{ flex: 1 }}>
                  <Text style={S.h3} numberOfLines={1}>{j.title}</Text>
                  <Text style={[S.pSm, { marginTop: 2 }]} numberOfLines={1}>
                    {j.metadata?.institute || "—"} · {j.metadata?.program_name || "—"} ·
                    {" "}{new Date(j.created_at).toLocaleString()}
                  </Text>
                </View>
                <View style={[S.badge, { borderColor: STATUS_COLORS[j.status] || T.border }]}>
                  <Text style={[S.badgeText, { color: STATUS_COLORS[j.status] || T.textMuted }]}>
                    {j.status}
                  </Text>
                </View>
                <Text style={[S.pSm, { width: 80, textAlign: "right" }]}>
                  {j.total_questions} Qs
                </Text>
                <Pressable
                  testID={`delete-job-${j.id}`}
                  onPress={() => handleDelete(j.id)}
                  style={[S.buttonGhost, { paddingHorizontal: 10, paddingVertical: 6 }]}
                >
                  <Text style={[S.buttonGhostText, { color: T.err }]}>Delete</Text>
                </Pressable>
              </Pressable>
            ))}
          </View>
        )}

        <View style={{ marginTop: 28 }}>
          <Text style={[S.pSm, { textAlign: "center" }]} testID="footer-tag">
            Pilot Pro · branch pilot-pro-v2.3 · v0.1.0
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", marginBottom: 24, gap: 12 },
  center: { alignItems: "center", justifyContent: "center", padding: 40 },
  empty: { alignItems: "center", padding: 48 },
  jobRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 16,
    borderRadius: 12,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.border,
  },
});
