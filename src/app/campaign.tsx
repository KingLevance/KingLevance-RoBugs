import { router } from 'expo-router';
import { Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { BUG_PORTRAITS } from '@/components/bug-portraits';
import { RewardChip } from '@/components/reward-chip';
import { Button, Label, Panel, Pill } from '@/components/ui';
import { Colors, Fonts, MaxContentWidth, Spacing } from '@/constants/theme';
import { validateBuild } from '@/game/build';
import { getMove } from '@/game/moves';
import { ARENA_NAMES, getOpponent, isUnlocked, OPPONENTS, type Opponent } from '@/game/opponents';
import { useGame } from '@/state/game-store';

const ARENA_TINT = { pit: '#7CE654', foundry: '#FF8A3D', hive: '#F2C14E' } as const;

function Link({ a, b, w, h, lit }: { a: Opponent; b: Opponent; w: number; h: number; lit: boolean }) {
  const x1 = a.map.x * w;
  const y1 = a.map.y * h;
  const x2 = b.map.x * w;
  const y2 = b.map.y * h;
  const len = Math.hypot(x2 - x1, y2 - y1);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const dots = Math.max(2, Math.floor(len / 14));
  return (
    <View
      style={{
        position: 'absolute',
        left: (x1 + x2) / 2 - len / 2,
        top: (y1 + y2) / 2 - 4,
        width: len,
        height: 8,
        flexDirection: 'row',
        justifyContent: 'space-evenly',
        alignItems: 'center',
        transform: [{ rotate: `${angle}rad` }],
      }}>
      {Array.from({ length: dots }).map((_, i) => (
        <View key={i} style={{ width: lit ? 7 : 5, height: lit ? 7 : 5, borderRadius: 4, backgroundColor: lit ? Colors.accent : Colors.border }} />
      ))}
    </View>
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
          const size = o.boss ? 82 : 66;
          const ring = selected ? Colors.accent : cleared ? Colors.good : o.boss ? Colors.bad : Colors.border;
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
                  borderColor: ring,
                  borderWidth: selected ? 4 : 3,
                },
                selected && styles.nodeSelected,
              ]}>
              <View style={[styles.nodeInner, { borderRadius: size / 2 }]}>
                <Image
                  source={BUG_PORTRAITS[o.id]}
                  style={{ width: size * 1.15, height: size * 1.15, opacity: unlocked ? 1 : 0.9, tintColor: unlocked ? undefined : '#0B0D11' }}
                />
              </View>
              {!unlocked && <Text style={styles.lock}>🔒</Text>}
              {cleared && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>✓</Text>
                </View>
              )}
              {o.boss && <Text style={[styles.crown, { left: size / 2 - 13 }]}>👑</Text>}
              <View style={[styles.nodeLabel, { left: (size - 120) / 2 }]}>
                <Text style={[styles.nodeLabelText, selected && { color: Colors.accent }]} numberOfLines={1}>
                  {unlocked ? o.name : '???'}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      <Panel style={{ gap: Spacing.md }}>
        <View style={styles.row}>
          <View style={[styles.bigPortrait, { borderColor: sel.boss ? Colors.bad : Colors.accent }]}>
            <Image source={BUG_PORTRAITS[sel.id]} style={{ width: 110, height: 110, tintColor: selUnlocked ? undefined : '#0B0D11' }} />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.h2}>{selUnlocked ? sel.name : '???'}</Text>
            <View style={styles.pills}>
              {sel.boss && <Pill label="BOSS" color={Colors.bad} filled />}
              <Pill label={ARENA_NAMES[sel.arena]} color={ARENA_TINT[sel.arena]} />
              {game.cleared.includes(sel.id) && <Pill label="BEATEN" color={Colors.good} />}
            </View>
            <Text style={styles.dim}>{selUnlocked ? sel.blurb : `Beat ${sel.unlockedBy.map((id) => getOpponent(id).name).join(' or ')} to unlock.`}</Text>
            {selUnlocked && sel.moves.length > 0 && <Text style={styles.dim}>Moves: {sel.moves.map((m) => getMove(m).name).join(', ')}</Text>}
          </View>
        </View>

        {selUnlocked && (
          <>
            <Label>{firstClear ? 'FIRST-CLEAR REWARD (GUARANTEED)' : 'FIRST CLEAR ✓ CLAIMED'}</Label>
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
          label={errors.length ? 'Fix your build first' : selUnlocked ? `Fight ${sel.name}!` : 'Locked'}
          size="lg"
          variant={sel.boss ? 'danger' : 'primary'}
          disabled={errors.length > 0 || !selUnlocked}
          onPress={() => router.push('/arena')}
        />
      </Panel>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.lg, gap: Spacing.lg, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center', paddingBottom: Spacing.xl * 2 },
  map: {
    backgroundColor: Colors.bgDeep,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  node: {
    position: 'absolute',
    backgroundColor: Colors.panel,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nodeSelected: { shadowColor: Colors.accent, shadowOpacity: 0.7, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } },
  nodeInner: { ...StyleSheet.absoluteFill, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  lock: { fontSize: 20 },
  badge: {
    position: 'absolute',
    right: -4,
    bottom: 2,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.good,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.bgDeep,
  },
  badgeText: { color: Colors.bgDeep, fontSize: 12, fontWeight: '900' },
  crown: { position: 'absolute', top: -20, fontSize: 22 },
  nodeLabel: { position: 'absolute', bottom: -24, width: 120, alignItems: 'center' },
  nodeLabelText: {
    color: Colors.text,
    fontFamily: Fonts.display,
    fontSize: 13,
    backgroundColor: 'rgba(12,14,18,0.85)',
    paddingHorizontal: 8,
    paddingVertical: 1,
    borderRadius: 999,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  bigPortrait: {
    width: 96,
    height: 96,
    borderRadius: 20,
    borderWidth: 2,
    backgroundColor: Colors.bgDeep,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  h2: { fontFamily: Fonts.display, color: Colors.text, fontSize: 26 },
  dim: { color: Colors.textDim, fontSize: 13, lineHeight: 18 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
});
