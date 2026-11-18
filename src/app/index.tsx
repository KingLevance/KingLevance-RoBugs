import { router } from 'expo-router';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMusic } from '@/audio/audio';
import { BUG_PORTRAITS } from '@/components/bug-portraits';
import { BugShowcase } from '@/components/bug-showcase';
import { PART_ICONS } from '@/components/part-icons';
import { Button, Label, Panel, Pill } from '@/components/ui';
import { Colors, Fonts, MaxContentWidth, Spacing } from '@/constants/theme';
import { validateBuild } from '@/game/build';
import { ARENA_NAMES, fightSize, getOpponent, OPPONENTS } from '@/game/opponents';
import { useGame } from '@/state/game-store';

const STEPS: [string, string, string][] = [
  ['🔧', 'Build', 'Snap parts onto your bug in the Garage.'],
  ['⚡', 'Equip', 'Pick up to two signature moves.'],
  ['🏟', 'Watch', 'It fights on its own. Smash parts off to win.'],
];

export default function Hub() {
  const game = useGame();
  useMusic('hub');
  const errors = validateBuild(game.build.placements);
  const next = getOpponent(game.selected);
  const totalParts = Object.values(game.inventory).reduce((a, n) => a + n, 0);
  const allClear = game.cleared.length >= OPPONENTS.length;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <Text style={styles.logo}>
              Ro<Text style={{ color: Colors.text }}>Bugs</Text>
            </Text>
            <Text style={styles.tagline}>BUILD A BUG · BREAK A BUG</Text>
          </View>
          <Pressable accessibilityLabel="Settings" onPress={() => router.push('/settings')} style={styles.gear}>
            <Text style={{ fontSize: 20 }}>⚙️</Text>
          </Pressable>
        </View>

        {/* Hero: your bug on its pedestal. */}
        <Pressable onPress={() => router.push('/garage')} style={styles.hero}>
          <BugShowcase placements={game.build.placements} background={Colors.bgDeep} style={StyleSheet.absoluteFill} />
          <View style={styles.heroTop} pointerEvents="none">
            <Label color={Colors.textDim}>YOUR BUG</Label>
            <Text style={styles.heroName}>{game.build.name || 'Unnamed bug'}</Text>
          </View>
          <View style={styles.heroBottom} pointerEvents="box-none">
            <View style={styles.statRow} pointerEvents="none">
              <Stat value={`${game.wins}`} label="WINS" color={Colors.good} />
              <Stat value={`${game.losses}`} label="LOSSES" color={Colors.bad} />
              <Stat value={`${totalParts}`} label="PARTS" color={Colors.accent} />
              <Stat value={`${game.moves.length}`} label="MOVES" color="#7FB3FF" />
            </View>
          </View>
        </Pressable>
        {errors.length > 0 && (
          <Panel style={styles.warn}>
            <Text style={styles.warnText}>⚠ {errors[0]}</Text>
          </Panel>
        )}

        {/* Next fight. */}
        <Panel style={styles.next}>
          <View style={styles.nextRow}>
            <View style={styles.portraitRing}>
              <Image source={BUG_PORTRAITS[next.id]} style={styles.portrait} />
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <Label>{allClear ? 'REMATCH' : 'NEXT FIGHT'}</Label>
              <Text style={styles.nextName}>{next.name}</Text>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                {next.boss && <Pill label={next.optional ? 'OPTIONAL BOSS' : 'BOSS'} color={next.optional ? '#C77DFF' : Colors.bad} filled />}
                {fightSize(next) !== '1v1' && <Pill label={fightSize(next)} color="#58C7FF" filled />}
                <Pill label={ARENA_NAMES[next.arena]} />
              </View>
            </View>
          </View>
          <Text style={styles.blurb}>{next.blurb}</Text>
          <Button label="To the campaign" size="lg" onPress={() => router.push('/campaign')} />
        </Panel>

        <View style={styles.tiles}>
          <Tile icon={PART_ICONS['pinc-vise']} title="Garage" sub="Build & equip" onPress={() => router.push('/garage')} />
          <Tile
            icon={BUG_PORTRAITS[OPPONENTS[OPPONENTS.length - 1].id]}
            title="Campaign"
            sub={`${game.cleared.length}/${OPPONENTS.length} beaten`}
            onPress={() => router.push('/campaign')}
          />
        </View>

        {game.wins === 0 && (
          <Panel style={{ gap: Spacing.sm }}>
            <Label>HOW IT WORKS</Label>
            {STEPS.map(([icon, title, text]) => (
              <View key={title} style={styles.step}>
                <View style={styles.stepIcon}>
                  <Text style={{ fontSize: 18 }}>{icon}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.stepTitle}>{title}</Text>
                  <Text style={styles.blurb}>{text}</Text>
                </View>
              </View>
            ))}
          </Panel>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Tile({ icon, title, sub, onPress }: { icon: Parameters<typeof Image>[0]['source']; title: string; sub: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.tile, pressed && { transform: [{ scale: 0.97 }] }]}>
      <Image source={icon} style={styles.tileIcon} />
      <Text style={styles.tileTitle}>{title}</Text>
      <Text style={styles.tileSub}>{sub}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.lg, gap: Spacing.lg, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center', paddingBottom: Spacing.xl * 2 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  logo: { fontFamily: Fonts.display, fontSize: 44, color: Colors.accent, letterSpacing: 0.5, lineHeight: 50 },
  tagline: { color: Colors.textDim, fontSize: 11, fontWeight: '900', letterSpacing: 2.2 },
  gear: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.panel,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  hero: {
    height: 300,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: Colors.bgDeep,
    borderWidth: 1,
    borderColor: Colors.border,
    justifyContent: 'space-between',
  },
  heroTop: { padding: Spacing.md + 2, gap: 2 },
  heroName: { fontFamily: Fonts.display, fontSize: 30, color: Colors.text, textShadowColor: '#000', textShadowRadius: 8 },
  heroBottom: { padding: Spacing.md },
  statRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(12,14,18,0.78)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 8,
  },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { fontFamily: Fonts.display, fontSize: 22 },
  statLabel: { color: Colors.textDim, fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  warn: { borderColor: Colors.bad, backgroundColor: '#2A1719', paddingVertical: Spacing.sm },
  warnText: { color: Colors.bad, fontSize: 13, fontWeight: '700' },
  next: { gap: Spacing.md },
  nextRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  portraitRing: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: Colors.bgDeep,
    borderWidth: 2,
    borderColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  portrait: { width: 96, height: 96 },
  nextName: { fontFamily: Fonts.display, fontSize: 28, color: Colors.text },
  blurb: { color: Colors.textDim, fontSize: 13, lineHeight: 18 },
  tiles: { flexDirection: 'row', gap: Spacing.md },
  tile: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.md,
    borderRadius: 18,
    backgroundColor: Colors.panel,
    borderWidth: 1,
    borderColor: Colors.border,
    borderTopColor: Colors.panelEdge,
    gap: 2,
  },
  tileIcon: { width: 72, height: 72 },
  tileTitle: { fontFamily: Fonts.display, fontSize: 20, color: Colors.text },
  tileSub: { color: Colors.textDim, fontSize: 12, fontWeight: '600' },
  step: { flexDirection: 'row', gap: Spacing.md, alignItems: 'center' },
  stepIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: Colors.panelHi,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepTitle: { fontFamily: Fonts.display, fontSize: 17, color: Colors.text },
});
