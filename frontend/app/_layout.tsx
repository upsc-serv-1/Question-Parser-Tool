import { useState, useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Platform, View, Pressable, Text } from "react-native";
import { DARK, LIGHT } from "../src/theme";

export default function RootLayout() {
  const [isDark, setIsDark] = useState(() => {
    if (Platform.OS !== "web") return true;
    return localStorage.getItem("jt_theme") !== "light";
  });

  const theme = isDark ? DARK : LIGHT;

  useEffect(() => {
    localStorage.setItem("jt_theme", isDark ? "dark" : "light");
    if (Platform.OS === "web") {
      document.body.style.backgroundColor = theme.bg;
      document.body.style.color = theme.text;
    }
  }, [isDark, theme]);

  const headerRight = () => (
    <Pressable
      onPress={() => setIsDark(!isDark)}
      style={{ paddingRight: 16, justifyContent: "center", alignItems: "center" }}
    >
      <Text style={{ fontSize: 18, color: theme.text }}>{isDark ? "☀️" : "🌙"}</Text>
    </Pressable>
  );

  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.surface },
          headerTintColor: theme.text,
          headerTitleStyle: { fontWeight: "700", color: theme.text },
          contentStyle: { backgroundColor: theme.bg },
          headerRight,
        }}
      >
        <Stack.Screen name="index" options={{ title: "JSON Tool · Jobs" }} />
        <Stack.Screen name="new" options={{ title: "New Job" }} />
        <Stack.Screen name="jobs/[id]" options={{ title: "Job" }} />
      </Stack>
    </>
  );
}
