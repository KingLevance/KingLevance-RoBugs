import { useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { Button, Panel } from '@/components/ui';
import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';
import { useGame } from '@/state/game-store';
import { applyUpdate, checkForUpdate, runningVersion, updatesActive, useUpdateReady } from '@/updates';

const MESSAGES = {
  disabled: 'Updates only work in the installed app (not web or dev).',
  none: 'You are up to date.',
  downloaded: 'Update downloaded. Restart to apply it.',
  error: 'Could not reach the update server. Try again later.',
} as const;

export default function Settings() {
  const game = useGame();
  const ready = useUpdateReady();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setStatus('Checking…');
    const res = await checkForUpdate(true);
    setStatus(MESSAGES[res]);
    setBusy(false);
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Panel style={{ gap: Spacing.sm }}>
        <Text style={styles.label}>APP VERSION</Text>
        <Text style={styles.text}>{runningVersion()}</Text>
        {ready ? (
          <Button label="Restart to update" onPress={() => void applyUpdate()} />
        ) : (
          <Button label={busy ? 'Checking…' : 'Check for updates'} variant="secondary" disabled={busy || !updatesActive} onPress={() => void check()} />
        )}
        {status && <Text style={styles.dim}>{status}</Text>}
        {!updatesActive && <Text style={styles.dim}>{MESSAGES.disabled}</Text>}
      </Panel>

      <Panel style={{ gap: Spacing.sm }}>
        <Text style={styles.label}>SAVE DATA</Text>
        <Text style={styles.dim}>
          {game.wins}W – {game.losses}L · {game.cleared.length} opponents beaten
        </Text>
        <Button label="Reset save" variant="danger" onPress={game.resetSave} />
      </Panel>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.lg, gap: Spacing.lg, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  label: { color: Colors.accent, fontSize: 12, fontWeight: '800', letterSpacing: 1.5 },
  text: { color: Colors.text, fontSize: 15, fontWeight: '600' },
  dim: { color: Colors.textDim, fontSize: 13 },
});
