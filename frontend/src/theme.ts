import { StyleSheet } from "react-native";

export const DARK = {
  // Surface
  bg: "#0a0e1a",
  surface: "#0f1626",
  surfaceAlt: "#131b2c",
  surfaceHover: "#19243a",
  border: "#1f2a3f",
  borderStrong: "#2a3a55",
  // Text
  text: "#e6edf7",
  textMuted: "#8893ab",
  textDim: "#5e6a82",
  // Accent
  primary: "#7c5cff",
  primaryHover: "#9275ff",
  accent: "#22d3ee",
  // States
  ok: "#22c55e",
  warn: "#f59e0b",
  err: "#ef4444",
  info: "#38bdf8",
};

export const LIGHT = {
  // Surface
  bg: "#f8fafc",
  surface: "#ffffff",
  surfaceAlt: "#f1f5f9",
  surfaceHover: "#e2e8f0",
  border: "#e2e8f0",
  borderStrong: "#cbd5e1",
  // Text
  text: "#0f172a",
  textMuted: "#475569",
  textDim: "#94a3b8",
  // Accent
  primary: "#6d28d9",
  primaryHover: "#5b21b6",
  accent: "#0891b2",
  // States
  ok: "#16a34a",
  warn: "#d97706",
  err: "#dc2626",
  info: "#0284c7",
};

export const STATUS_COLORS = (T: any) => ({
  created: T.textMuted,
  extracted: T.info,
  prompts_generated: T.warn,
  partially_parsed: T.warn,
  reviewed: T.ok,
  exported: T.primary,
});

export const sharedStyles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#0a0e1a", padding: 24 },
  container: {
    flex: 1,
    width: "100%",
    maxWidth: 1280,
    alignSelf: "center",
  },
  card: {
    backgroundColor: "#0f1626",
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: "#1f2a3f",
  },
  cardAlt: {
    backgroundColor: "#131b2c",
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: "#1f2a3f",
  },
  h1: { color: "#e6edf7", fontSize: 28, fontWeight: "700", letterSpacing: -0.3 },
  h2: { color: "#e6edf7", fontSize: 20, fontWeight: "700" },
  h3: { color: "#e6edf7", fontSize: 16, fontWeight: "600" },
  pSm: { color: "#8893ab", fontSize: 13, lineHeight: 19 },
  p: { color: "#e6edf7", fontSize: 14, lineHeight: 21 },
  label: { color: "#8893ab", fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 },
  input: {
    backgroundColor: "#0a0e1a",
    color: "#e6edf7",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "#1f2a3f",
    fontSize: 14,
  },
  button: {
    backgroundColor: "#7c5cff",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  buttonGhost: {
    backgroundColor: "transparent",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#1f2a3f",
  },
  buttonGhostText: { color: "#e6edf7", fontWeight: "600", fontSize: 13 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  rowGap: { flexDirection: "row", gap: 16, flexWrap: "wrap" },
  divider: { height: 1, backgroundColor: "#1f2a3f", marginVertical: 12 },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "#131b2c",
    borderWidth: 1,
    borderColor: "#1f2a3f",
  },
  badgeText: { color: "#8893ab", fontSize: 11, fontWeight: "600" },
});
export const T = DARK;
