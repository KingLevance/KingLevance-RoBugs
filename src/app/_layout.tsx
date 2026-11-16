import { DarkTheme, ThemeProvider } from 'expo-router';
import Stack from 'expo-router/stack';
import { StatusBar } from 'expo-status-bar';

import { Colors } from '@/constants/theme';
import { GameProvider } from '@/state/game-store';

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: Colors.bg, card: Colors.panel, primary: Colors.accent, text: Colors.text },
};

export default function RootLayout() {
  return (
    <ThemeProvider value={theme}>
      <GameProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: Colors.panel },
            headerTintColor: Colors.text,
            contentStyle: { backgroundColor: Colors.bg },
          }}>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="garage" options={{ title: 'Garage' }} />
          <Stack.Screen name="arena" options={{ headerShown: false, gestureEnabled: false }} />
        </Stack>
      </GameProvider>
    </ThemeProvider>
  );
}
