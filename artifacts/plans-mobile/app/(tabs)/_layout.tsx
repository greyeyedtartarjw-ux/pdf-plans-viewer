import { Stack } from 'expo-router';

/**
 * This group contains the main app navigation (documents list + viewer).
 * We use a Stack here — no tab bar needed for this workflow-focused app.
 */
export default function AppLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen
        name="viewer/[id]"
        options={{ headerShown: false, animation: 'slide_from_right' }}
      />
    </Stack>
  );
}
