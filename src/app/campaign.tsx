import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { BugPreview } from '@/components/bug-preview';
import { RewardChip } from '@/components/reward-chip';
import { Button, Panel } from '@/components/ui';
import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';
import { validateBuild } from '@/game/build';
import { getMove } from '@/game/moves';
import { ARENA_NAMES, getOpponent, isUnlocked, OPPONENTS, type Opponent } from '@/game/opponents';
import { useGame } from '@/state/game-store';



function Link({ a, b, w, h, lit }: { a: Opponent; b: Opponent; w: number; h: number; lit: boolean }) {
  const x1 = a.map.x * w;
  const y1 = a.map.y * h;
  const x2 = b.map.x * w;
  const y2 = b.map.y * h;
  const len = Math.hypot(x2 - x1, y2 - y1);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  return (
    <View
      style={{
        position: 'absolute',
        left: (x1 + x2) / 2 - len / 2,
        top: (y1 + y2) / 2 - 3,
        width: len,
        height: 6,
        borderRadius: 3,
        backgroundColor: lit ? Colors.accent : Colors.border,
        transform: [{ rotate: `${angle}rad` }],
      }}
    />
  );
}

export default function Campaign() {
  const game = useGame();
  const { width } = useWindowDimensions();
  const mapW = Math.min(width, MaxContentWidth) - Spacing.lg * 2;
  const mapH = mapW * 1.05;
  const sel = getOpponent(game.selected);
  const errors = validateBuild(game.build.placements);
  const selUnlocked = isUnlocked(sel, game.cleared);
  const firstClear = !game.cleared.includes(sel.id);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={[styles.map, { width: mapW, height: mapH }]}>
        {OPPONENTS.flatMap((o) =>
          o.unlockedBy.map((from) => (
            <Link key={`${from}-${o.id}`} a={getOpponent(from)} b={o} w={mapW} h={mapH} lit={game.cleared.includes(from)} />
          )),
        )}
        {OPPONENTS.map((o) => {
          const unlocked = isUnlocked(o, game.cleared);
          const cleared = game.cleared.includes(o.id);
          const selected = o.id === sel.id;
          const size = o.boss ? 64 : 52;
          return (
            <Pressable
              key={o.id}
              onPress={() => game.selectOpponent(o.id)}
              style={[
                styles.node,
                {
                  left: o.map.x * mapW - size / 2,
                  top: o.map.y * mapH - size / 2,
                  width: size,
                  height: size,
                  borderRadius: size / 2,
                  borderColor: selected ? Colors.accent : cleared ? Colors.good : o.boss ? Colors.bad : Colors.border,
                  opacity: unlocked ? 1 : 0.45,
                },
              ]}>
              <Text style={styles.nodeIcon}>{!unlocked ? '🔒' : o.boss ? '👑' : cleared ? '✓' : '⚔'}</Text>
              <Text style={styles.nodeLabel} numberOfLines={1}>
                {unlocked ? o.name : '???'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Panel style={{ gap: Spacing.sm }}>
        <View style={styles.row}>
          <BugPreview placements={sel.build.placements} cell={16} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.h2}>
              {selUnlocked ? sel.name : '???'} {sel.boss && <Text style={styles.boss}>BOSS</Text>}
            </Text>
            <Text style={styles.dim}>{selUnlocked ? sel.blurb : `Beat ${sel.unlockedBy.map((id) => getOpponent(id).name).join(' or ')} to unlock.`}</Text>
            <Text style={styles.dim}>Arena: {ARENA_NAMES[sel.arena]}</Text>
            {sel.moves.length > 0 && <Text style={styles.dim}>Moves: {sel.moves.map((m) => getMove(m).name).join(', ')}</Text>}
          </View>
        </View>

        {selUnlocked && (
          <>
            <Text style={styles.label}>{firstClear ? 'FIRST-CLEAR REWARD (GUARANTEED)' : 'FIRST CLEAR ✓ CLAIMED'}</Text>
            <View style={styles.chips}>
              {sel.guaranteed.map((r, i) => (
                <RewardChip key={i} reward={r} dim={!firstClear} />
              ))}
            </View>
            <Text style={styles.dim}>
              Every win: {sel.boss ? '3' : '2'} rolls on the loot table{sel.boss ? ', including signature drops. Farm it!' : '.'}
            </Text>
          </>
        )}
        <Button
          label={errors.length ? 'Fix your build first' : selUnlocked ? `Fight ${sel.name}` : 'Locked'}
          disabled={errors.length > 0 || !selUnlocked}
          onPress={() => router.push('/arena')}
        />
      </Panel>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.lg, gap: Spacing.lg, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  map: { backgroundColor: Colors.panel, borderRadius: 16, borderWidth: 1, borderColor: Colors.border },
  node: {
    position: 'absolute',
    backgroundColor: Colors.panelHi,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nodeIcon: { fontSize: 18, color: Colors.text },
  nodeLabel: { position: 'absolute', bottom: -18, width: 110, textAlign: 'center', color: Colors.text, fontSize: 11, fontWeight: '800' },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.lg },
  h2: { color: Colors.text, fontSize: 20, fontWeight: '800' },
  boss: { color: Colors.bad, fontSize: 12, fontWeight: '900' },
  dim: { color: Colors.textDim, fontSize: 13 },
  label: { color: Colors.accent, fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
});
