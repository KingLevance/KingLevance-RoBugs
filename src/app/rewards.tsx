import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { RewardChip } from '@/components/reward-chip';
import { Button, Panel } from '@/components/ui';
import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';
import { getOpponent } from '@/game/opponents';
import { useGame } from '@/state/game-store';

export default function Rewards() {
  const game = useGame();
  const r = game.lastResult;
  if (!r) {
    return (
      <View style={styles.empty}>
        <Button label="Back to the campaign" onPress={() => router.replace('/campaign')} />
      </View>
    );
  }
  const opp = getOpponent(r.opponentId);
  const won = r.winner === 0;
  const title = won ? 'VICTORY' : r.winner === 1 ? 'DEFEAT' : 'DRAW';
  const color = won ? Colors.good : r.winner === 1 ? Colors.bad : Colors.accent;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={[styles.title, { color }]}>{title}</Text>
      <Text style={styles.dim}>
        {won ? `You took ${opp.name} apart!` : `${opp.name} got the better of you. You salvaged some scrap.`}
      </Text>

      {r.rewards.guaranteed.length > 0 && (
        <Panel style={{ gap: Spacing.sm }}>
          <Text style={styles.label}>FIRST CLEAR — GUARANTEED</Text>
          {r.rewards.guaranteed.map((rw, i) => (
            <RewardChip key={i} reward={rw} />
          ))}
        </Panel>
      )}

      <Panel style={{ gap: Spacing.sm }}>
        <Text style={styles.label}>{won ? (opp.boss ? 'BOSS LOOT ROLLS' : 'LOOT ROLLS') : 'SALVAGE'}</Text>
        {r.rewards.rolled.map((rw, i) => (
          <RewardChip key={i} reward={rw} />
        ))}
      </Panel>

      {won && opp.boss && <Text style={styles.dim}>Bosses can be re-fought for more rolls on their loot table.</Text>}

      <View style={styles.actions}>
        <Button label="Campaign" variant="secondary" onPress={() => router.dismissTo('/campaign')} style={{ flex: 1 }} />
        <Button label="Garage" onPress={() => router.replace('/garage')} style={{ flex: 1 }} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.lg, gap: Spacing.lg, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },
  title: { fontSize: 48, fontWeight: '900', fontStyle: 'italic', textAlign: 'center', marginTop: Spacing.xl },
  dim: { color: Colors.textDim, fontSize: 14, textAlign: 'center' },
  label: { color: Colors.accent, fontSize: 12, fontWeight: '800', letterSpacing: 1.5 },
  actions: { flexDirection: 'row', gap: Spacing.sm },
});
