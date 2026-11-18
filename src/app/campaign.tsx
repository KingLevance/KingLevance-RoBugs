import { router } from 'expo-router';
import { useEffect, useRef, type ComponentRef } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BUG_PORTRAITS } from '@/components/bug-portraits';
import { Stars } from '@/components/stars';
import { RewardChip } from '@/components/reward-chip';
import { Button, Label, Pill } from '@/components/ui';
import { Colors, Fonts, MaxContentWidth, Spacing } from '@/constants/theme';
import { validateBuild } from '@/game/build';
import { getMove } from '@/game/moves';
import {
  alliesFor,
  allySlots,
  ARENA_NAMES,
  fightSize,
  getOpponent,
  isUnlocked,
  OPPONENTS,
  pathOpen,
  starGate,
  ZONES as GAME_ZONES,
  type Opponent,
  type ZoneId,
} from '@/game/opponents';
import { MAX_STARS, starGoals } from '@/game/stars';
import { useGame } from '@/state/game-store';

const ARENA_TINT = { pit: '#7CE654', foundry: '#FF8A3D', hive: '#F2C14E' } as const;
const OPTIONAL = '#C77DFF';
/** Map height as a multiple of its width (the map scrolls). */
const MAP_ASPECT = 3.3;
/** Campaign zones, as bands of the map (y from, y to). */
const ZONES: { id: ZoneId; name: string; from: number; to: number; tint: string }[] = [
  { id: 'hive', name: 'THE DEEP HIVE', from: 0.09, to: 0.545, tint: '#F2C14E' },
  { id: 'undergrowth', name: 'THE UNDERGROWTH', from: 0.545, to: 0.785, tint: '#7CE654' },
  { id: 'scrapyard', name: 'THE SCRAPYARD', from: 0.785, to: 1, tint: '#FF8A3D' },
];

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
  const { width, height } = useWindowDimensions();
  const mapW = Math.min(width, MaxContentWidth) - Spacing.lg * 2;
  const mapH = mapW * MAP_ASPECT;
  const sel = getOpponent(game.selected);
  const errors = validateBuild(game.build.placements);
  const selUnlocked = isUnlocked(sel, game.cleared, game.stars);
  const selGate = starGate(sel, game.stars);
  const gateBlocks = !selUnlocked && pathOpen(sel, game.cleared) && selGate && !selGate.met;
  const firstClear = !game.cleared.includes(sel.id);
  const size = fightSize(sel);
  const totalStars = OPPONENTS.reduce((a, o) => a + (game.stars[o.id] ?? 0), 0);
  const best = game.stars[sel.id] ?? 0;
  // Team fights: your squad bugs (valid ones, in order), then borrowed opponents for any gaps.
  const slots = allySlots(sel);
  const readySquad = game.squad.filter((i) => game.bugs[i] && validateBuild(game.bugs[i].placements).length === 0);
  const { borrowed } = alliesFor(
    sel,
    readySquad.map((i) => ({ build: game.bugs[i], moves: game.bugs[i].equipped, aggression: 0.7 })),
  );
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  // Open the map on the selected fight.
  const startY = Math.max(0, sel.map.y * mapH - height * 0.22);
  useEffect(() => {
    const t = setTimeout(() => scroll.current?.scrollTo({ y: startY, animated: false }), 0);
    return () => clearTimeout(t);
    // Only on first show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SafeAreaView style={styles.root} edges={['bottom']}>
      <View style={styles.totalBadge} pointerEvents="none">
        <Text style={styles.total}>
          <Text style={{ color: '#FFD23F' }}>★</Text> {totalStars}/{OPPONENTS.length * MAX_STARS}
        </Text>
      </View>
      <ScrollView ref={scroll} contentContainerStyle={styles.content} contentOffset={{ x: 0, y: startY }}>
        <View style={[styles.map, { width: mapW, height: mapH }]}>
          {ZONES.map((z) => {
            const gz = GAME_ZONES.findIndex((g) => g.id === z.id);
            const prev = GAME_ZONES[gz - 1];
            const have = prev ? prev.stops.reduce((a, id) => a + (game.stars[id] ?? 0), 0) : 0;
            const need = GAME_ZONES[gz].starsToEnter;
            return (
              <View key={z.name} style={[styles.zone, { top: z.from * mapH, height: (z.to - z.from) * mapH, borderTopColor: z.tint }]}>
                <Text style={[styles.zoneName, { color: z.tint }]}>{z.name}</Text>
                {prev && (
                  <Text style={[styles.zoneGate, { color: have >= need ? Colors.good : '#FFD23F' }]}>
                    {have >= need ? `✓ ★${need} TO ENTER` : `★${have}/${need} TO ENTER`}
                  </Text>
                )}
              </View>
            );
          })}
          {OPPONENTS.flatMap((o) =>
            o.unlockedBy.map((from) => (
              <Link key={`${from}-${o.id}`} a={getOpponent(from)} b={o} w={mapW} h={mapH} lit={game.cleared.includes(from)} />
            )),
          )}
          {OPPONENTS.map((o) => {
            const unlocked = isUnlocked(o, game.cleared, game.stars);
            const gate = starGate(o, game.stars);
            const starLocked = !unlocked && pathOpen(o, game.cleared) && gate && !gate.met;
            const cleared = game.cleared.includes(o.id);
            const selected = o.id === sel.id;
            const node = o.optional ? 68 : o.boss ? 82 : 66;
            const ring = selected ? Colors.accent : cleared ? Colors.good : o.optional ? OPTIONAL : o.boss ? Colors.bad : Colors.border;
            const team = fightSize(o);
            return (
              <Pressable
                key={o.id}
                onPress={() => game.selectOpponent(o.id)}
                style={[
                  styles.node,
                  {
                    left: o.map.x * mapW - node / 2,
                    top: o.map.y * mapH - node / 2,
                    width: node,
                    height: node,
                    borderRadius: node / 2,
                    borderColor: ring,
                    borderWidth: selected ? 4 : 3,
                    borderStyle: o.optional && !cleared && !selected ? 'dashed' : 'solid',
                  },
                  selected && styles.nodeSelected,
                ]}>
                <View style={[styles.nodeInner, { borderRadius: node / 2 }]}>
                  <Image
                    source={BUG_PORTRAITS[o.id]}
                    style={{ width: node * 1.15, height: node * 1.15, opacity: unlocked ? 1 : 0.9, tintColor: unlocked ? undefined : '#0B0D11' }}
                  />
                </View>
                {!unlocked && !starLocked && <Text style={styles.lock}>🔒</Text>}
                {starLocked && (
                  <Text style={styles.gateText}>
                    🔒{'\n'}★{gate.have}/{gate.need}
                  </Text>
                )}
                {cleared && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>✓</Text>
                  </View>
                )}
                {team !== '1v1' && (
                  <View style={styles.teamBadge}>
                    <Text style={styles.teamBadgeText}>{team}</Text>
                  </View>
                )}
                {o.boss && <Text style={[styles.crown, { left: node / 2 - 13 }]}>{o.optional ? '💀' : '👑'}</Text>}
                <View style={[styles.nodeLabel, { left: (node - 130) / 2 }]}>
                  <Text style={[styles.nodeLabelText, selected && { color: Colors.accent }]} numberOfLines={1}>
                    {unlocked ? o.name : '???'}
                  </Text>
                  {cleared && <Stars n={game.stars[o.id] ?? 1} size={12} />}
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      {/* The selected fight stays pinned under the map. */}
      <View style={styles.sheet}>
        <View style={styles.row}>
          <View style={[styles.bigPortrait, { borderColor: sel.optional ? OPTIONAL : sel.boss ? Colors.bad : Colors.accent }]}>
            <Image source={BUG_PORTRAITS[sel.id]} style={{ width: 84, height: 84, tintColor: selUnlocked ? undefined : '#0B0D11' }} />
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.h2} numberOfLines={1}>
              {selUnlocked ? sel.name : '???'}
            </Text>
            <View style={styles.pills}>
              {sel.optional ? <Pill label="OPTIONAL BOSS" color={OPTIONAL} filled /> : sel.boss && <Pill label="BOSS" color={Colors.bad} filled />}
              {size !== '1v1' && <Pill label={size} color="#58C7FF" filled />}
              <Pill label={ARENA_NAMES[sel.arena]} color={ARENA_TINT[sel.arena]} />
              {game.cleared.includes(sel.id) && <Pill label="BEATEN" color={Colors.good} />}
            </View>
          </View>
        </View>
        <Text style={styles.dim} numberOfLines={3}>
          {selUnlocked
            ? sel.blurb
            : gateBlocks
              ? `Earn ★${selGate.need} in ${selGate.prev.name} to enter ${selGate.zone.name} (you have ★${selGate.have}). Replay fights there for more stars.`
              : `Beat ${sel.unlockedBy.map((id) => getOpponent(id).name).join(' or ')} to unlock.`}
        </Text>
        {selUnlocked && slots > 0 && (
          <View style={{ gap: 6 }}>
            <Text style={styles.alliesLabel}>
              YOUR SQUAD · {game.build.name} + {slots} MORE {slots > 1 ? '(TAP UP TO 2)' : '(TAP 1)'}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.allies}>
              {game.bugs.map((b, i) => {
                if (i === game.active) return null;
                const ready = validateBuild(b.placements).length === 0;
                const pos = readySquad.indexOf(i);
                const fighting = pos >= 0 && pos < slots;
                return (
                  <Pressable
                    key={i}
                    disabled={!ready}
                    onPress={() => game.toggleSquad(i)}
                    style={[styles.ally, fighting && styles.allyOn, !ready && { opacity: 0.45 }]}>
                    <Text style={[styles.allyName, fighting && { color: Colors.bg }]}>
                      {fighting ? '✓ ' : ''}
                      {b.name}
                    </Text>
                    {!ready && <Text style={styles.allyNote}>needs work</Text>}
                  </Pressable>
                );
              })}
              {borrowed.map((id) => (
                <View key={id} style={[styles.ally, styles.allyBorrowed]}>
                  <Image source={BUG_PORTRAITS[id]} style={styles.allyPortrait} />
                  <Text style={styles.allyName}>{getOpponent(id).name}</Text>
                  <Text style={styles.allyNote}>borrowed</Text>
                </View>
              ))}
            </ScrollView>
            {game.bugs.length < 2 && <Text style={styles.dim}>Build more bugs in the Garage (＋ New bug) to bring your own squad.</Text>}
          </View>
        )}
        {selUnlocked && (
          <View style={styles.goals}>
            <Stars n={best} size={16} />
            {starGoals(sel).map((g, i) => (
              <Text key={g} style={[styles.goal, i < best && { color: '#FFD23F', borderColor: '#FFD23F' }]}>
                ★ {g}
              </Text>
            ))}
          </View>
        )}
        {selUnlocked && sel.moves.length > 0 && (
          <Text style={styles.dim} numberOfLines={1}>
            Moves: {sel.moves.map((m) => getMove(m).name).join(', ')}
          </Text>
        )}
        {selUnlocked && (
          <>
            <Label>
              {firstClear
                ? 'FIRST-CLEAR REWARD (GUARANTEED)'
                : `EVERY WIN: ${sel.boss ? 3 : 2} LOOT ROLLS · MORE STARS = RARER${best < 3 ? ' · FIRST 3★: BONUS RARE' : ''}`}
            </Label>
            {firstClear && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                {sel.guaranteed.map((r, i) => (
                  <RewardChip key={i} reward={r} />
                ))}
              </ScrollView>
            )}
          </>
        )}
        <Button
          label={errors.length ? 'Fix your build first' : selUnlocked ? `Fight ${sel.name}!` : gateBlocks ? `Need ★${selGate.need} · have ${selGate.have}` : 'Locked'}
          size="lg"
          variant={sel.boss ? 'danger' : 'primary'}
          disabled={errors.length > 0 || !selUnlocked}
          onPress={() => router.push('/arena')}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.lg, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  map: {
    backgroundColor: Colors.bgDeep,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  totalBadge: {
    position: 'absolute',
    top: Spacing.sm,
    right: Spacing.md,
    zIndex: 5,
    backgroundColor: 'rgba(10,14,20,0.85)',
    borderColor: '#FFD23F',
    borderWidth: 1.5,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  total: { fontFamily: Fonts.display, fontSize: 18, color: Colors.text },
  goals: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5 },
  goal: { color: Colors.textDim, fontSize: 11, fontWeight: '800', borderWidth: 1, borderColor: Colors.border, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' },
  zone: { position: 'absolute', left: 0, right: 0, borderTopWidth: 2, opacity: 0.9 },
  zoneName: { fontSize: 10, fontWeight: '900', letterSpacing: 2, margin: 10, opacity: 0.85 },
  node: {
    position: 'absolute',
    backgroundColor: Colors.panel,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nodeSelected: { shadowColor: Colors.accent, shadowOpacity: 0.7, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } },
  nodeInner: { ...StyleSheet.absoluteFill, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  lock: { fontSize: 20 },
  gateText: { fontFamily: Fonts.display, fontSize: 13, lineHeight: 17, color: '#FFD23F', textAlign: 'center' },
  zoneGate: { fontSize: 10, fontWeight: '900', letterSpacing: 1, marginLeft: 10, marginTop: -6 },
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
  teamBadge: {
    position: 'absolute',
    left: -8,
    top: -2,
    backgroundColor: '#58C7FF',
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderWidth: 2,
    borderColor: Colors.bgDeep,
  },
  teamBadgeText: { color: Colors.bgDeep, fontFamily: Fonts.display, fontSize: 11 },
  crown: { position: 'absolute', top: -20, fontSize: 22 },
  nodeLabel: { position: 'absolute', top: '100%', marginTop: 4, width: 130, alignItems: 'center', gap: 1 },
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
  sheet: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.sm,
    padding: Spacing.md + 2,
    backgroundColor: Colors.panel,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: Colors.panelEdge,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  bigPortrait: {
    width: 72,
    height: 72,
    borderRadius: 18,
    borderWidth: 2,
    backgroundColor: Colors.bgDeep,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  h2: { fontFamily: Fonts.display, color: Colors.text, fontSize: 24 },
  dim: { color: Colors.textDim, fontSize: 13, lineHeight: 18 },
  allies: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flexWrap: 'wrap' },
  alliesLabel: { color: '#58C7FF', fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  ally: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.bgDeep,
    borderColor: '#58C7FF',
    borderWidth: 1.5,
    borderRadius: 999,
    paddingLeft: 10,
    paddingRight: 10,
    minHeight: 32,
    overflow: 'hidden',
  },
  allyOn: { backgroundColor: '#58C7FF', borderColor: '#58C7FF' },
  allyBorrowed: { borderStyle: 'dashed', borderColor: Colors.border },
  allyNote: { color: Colors.textDim, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  allyPortrait: { width: 30, height: 30 },
  allyName: { color: Colors.text, fontFamily: Fonts.display, fontSize: 13 },
  chips: { flexDirection: 'row', gap: Spacing.sm },
});
