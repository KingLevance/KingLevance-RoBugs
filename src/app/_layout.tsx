import { LilitaOne_400Regular, useFonts } from '@expo-google-fonts/lilita-one';
import { DarkTheme, ThemeProvider } from 'expo-router';
import Stack from 'expo-router/stack';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';

import { UpdateBanner } from '@/components/update-banner';
import { Colors, Fonts } from '@/constants/theme';
import { GameProvider } from '@/state/game-store';
import { useBackgroundUpdates } from '@/updates';

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: Colors.bg, card: Colors.bg, primary: Colors.accent, text: Colors.text, border: Colors.border },
};

export default function RootLayout() {
  useBackgroundUpdates();
  const [loaded, error] = useFonts({ LilitaOne_400Regular });
  // Hold a blank screen for the moment the font takes to load (fall back to the system font if it fails).
  if (!loaded && !error) return <View style={{ flex: 1, backgroundColor: Colors.bg }} />;
  return (
    <ThemeProvider value={theme}>
      <GameProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: Colors.bg },
            headerShadowVisible: false,
            headerTintColor: Colors.text,
            headerTitleStyle: { fontFamily: Fonts.display, fontSize: 22 },
            contentStyle: { backgroundColor: Colors.bg },
          }}>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="garage" options={{ headerShown: false }} />
          <Stack.Screen name="campaign" options={{ title: 'Campaign' }} />
          <Stack.Screen name="arena" options={{ headerShown: false, gestureEnabled: false, animation: 'fade' }} />
          <Stack.Screen name="rewards" options={{ headerShown: false, gestureEnabled: false, animation: 'fade' }} />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        </Stack>
        <UpdateBanner />
      </GameProvider>
    </ThemeProvider>
  );
}
