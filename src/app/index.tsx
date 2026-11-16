import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BugPreview } from '@/components/bug-preview';
import { Button, Panel } from '@/components/ui';
import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';
import { validateBuild } from '@/game/build';
import { OPPONENTS } from '@/game/opponents';
import { RARITY_COLOR } from '@/game/parts';
import { useGame } from '@/state/game-store';

const ARENA_NAMES = { pit: 'The Acid Pit', foundry: 'Stomper Foundry', hive: 'The Hive Ring' } as const;

export default function Hub() {
  const game = useGame();
  const errors = validateBuild(game.build.placements);
  const next = OPPONENTS[game.ladder];
  const totalParts = Object.values(game.inventory).reduce((a, n) => a + n, 0);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>RoBugs</Text>
        <Text style={styles.subtitle}>Build a bug. Break a bug.</Text>

        <Panel style={styles.row}>
          <BugPreview placements={game.build.placements} cell={20} />
          <View style={{ flex: 1, gap: Spacing.xs }}>
            <Text style={styles.h2}>{game.build.name}</Text>
            <Text style={styles.dim}>
              Record {game.wins}W – {game.losses}L · {totalParts} parts owned
            </Text>
            {errors.length > 0 && <Text style={styles.bad}>⚠ {errors[0]}</Text>}
            <Button label="Open Garage" variant="secondary" onPress={() => router.push('/garage')} />
          </View>
        </Panel>

        <Panel style={{ gap: Spacing.sm }}>
          <Text style={styles.label}>NEXT CHALLENGER</Text>
          <View style={styles.row}>
            <BugPreview placements={next.build.placements} cell={16} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.h2}>{next.name}</Text>
              <Text style={styles.dim}>{next.blurb}</Text>
              <Text style={styles.dim}>
                Arena: {ARENA_NAMES[next.arena]} · Drops up to{' '}
                <Text style={{ color: RARITY_COLOR[next.rewardTier], fontWeight: '700' }}>{next.rewardTier}</Text>
              </Text>
            </View>
          </View>
          <Button label={errors.length ? 'Fix your build first' : 'Fight!'} disabled={errors.length > 0} onPress={() => router.push('/arena')} />
        </Panel>

        <Panel style={{ gap: Spacing.sm }}>
          <Text style={styles.label}>LADDER</Text>
          {OPPONENTS.map((o, i) => {
            const locked = i > game.cleared + 1;
            const selected = i === game.ladder;
            return (
              <Pressable
                key={o.name}
                disabled={locked}
                onPress={() => game.selectOpponent(i)}
                style={[styles.ladderRow, selected && styles.ladderSelected, locked && { opacity: 0.4 }]}>
                <Text style={styles.ladderText}>
                  {i + 1}. {locked ? '???' : o.name}
                </Text>
                <Text style={styles.dim}>{i <= game.cleared ? '✓ beaten' : locked ? 'locked' : 'open'}</Text>
              </Pressable>
            );
          })}
        </Panel>

        <Text style={styles.howto}>
          How to play: snap parts onto the grid in the Garage, stay inside the power and weight budget, then drag the
          joystick in the Arena. Weapons fire on their own when an enemy is in front of them. Knock off parts — lose
          every core or thorax and you&apos;re out.
        </Text>
        <Button label="Reset save" variant="danger" onPress={game.resetSave} style={{ alignSelf: 'center' }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.lg, gap: Spacing.lg, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  title: { color: Colors.accent, fontSize: 44, fontWeight: '900', letterSpacing: 1, textAlign: 'center', marginTop: Spacing.lg },
  subtitle: { color: Colors.textDim, textAlign: 'center', marginTop: -Spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.lg },
  h2: { color: Colors.text, fontSize: 20, fontWeight: '800' },
  label: { color: Colors.accent, fontSize: 12, fontWeight: '800', letterSpacing: 1.5 },
  dim: { color: Colors.textDim, fontSize: 13 },
  bad: { color: Colors.bad, fontSize: 13 },
  ladderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: Spacing.sm,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  ladderSelected: { borderColor: Colors.accent, backgroundColor: Colors.panelHi },
  ladderText: { color: Colors.text, fontWeight: '700' },
  howto: { color: Colors.textDim, fontSize: 13, lineHeight: 19 },
});
