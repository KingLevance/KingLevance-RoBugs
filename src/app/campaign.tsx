import { router, Stack } from 'expo-router';
import { useEffect, useRef, type ComponentRef } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { sfx, useMusic } from '@/audio/audio';
import { BUG_PORTRAITS } from '@/components/bug-portraits';
import { Stars } from '@/components/stars';
import { RewardChip } from '@/components/reward-chip';
import { Button, Label, Pill } from '@/components/ui';
import { Colors, Fonts, MaxContentWidth, Spacing } from '@/constants/theme';
import { bugProblems, bugReady } from '@/game/build';
import { getMove, movesOf } from '@/game/moves';
import { getPart } from '@/game/parts';
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

const ARENA_TINT = { pit: '#7CE654', foundry: '#FF8A3D', hive: '#F2C14E', meadow: '#A6E35B', pond: '#6FB7FF' } as const;
const OPTIONAL = '#C77DFF';
const ZONE_TINT: Record<ZoneId, string> = { scrapyard: '#FF8A3D', undergrowth: '#7CE654', hive: '#F2C14E' };
/**
 * Map spacing, as fractions of the map's width. Zones stack bottom-up; each
 * starts at a boundary line (its name chip sits on it, with no fights nearby),
 * then its rows of fights.
 */
const GAP = {
  /** Map bottom → first boundary line. */
  bottom: 0.08,
  /** Boundary line → a zone's first row (room for that row's labels and stars). */
  entry: 0.27,
  /** Row to row. */
  row: 0.4,
  /** A zone's top row → the next boundary line (room for a boss crown). */
  top: 0.25,
  /** Top row of the last zone → map top. */
  topPad: 0.2,
};

/** Pixel positions of every fight and zone band for a map `w` wide. */
function mapLayout(w: number) {
  const up = new Map<string, number>();
  const bands: { id: ZoneId; name: string; index: number; from: number; to: number }[] = [];
  let line = GAP.bottom * w;
  GAME_ZONES.forEach((z, i) => {
    const rows = Math.max(...z.stops.map((id) => getOpponent(id).map.row));
    for (const id of z.stops) up.set(id, line + (GAP.entry + getOpponent(id).map.row * GAP.row) * w);
    const top = line + (GAP.entry + rows * GAP.row) * w;
    const next = top + (i < GAME_ZONES.length - 1 ? GAP.top : GAP.topPad) * w;
    bands.push({ id: z.id, name: z.name.toUpperCase(), index: i, from: line, to: next });
    line = next;
  });
  const h = line;
  return {
    w,
    h,
    pos: (o: Opponent) => ({ x: o.map.x * w, y: h - (up.get(o.id) ?? 0) }),
    /** Bands from the top of the map: `top`..`line` (its boundary line at the bottom). */
    zones: bands.map((b) => ({ ...b, top: h - b.to, line: h - b.from })),
  };
}

/** Node size on the map. */
const nodeSize = (o: Opponent) => (o.optional ? 68 : o.boss ? 82 : 66);

/** A screen-space box that path dots must stay out of. */
type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * Everything a path must not cross: each fight's circle, its crown/skull and
 * badges, and (when shown) its name + stars label. Sizes are generous estimates.
 */
function keepOut(layout: ReturnType<typeof mapLayout>, labelled: (o: Opponent) => { name: boolean; stars: boolean }): Box[] {
  const boxes: Box[] = [];
  for (const o of OPPONENTS) {
    const { x, y } = layout.pos(o);
    const r = nodeSize(o) / 2 + 4;
    boxes.push({ x0: x - r, y0: y - r - (o.boss ? 20 : 0), x1: x + r, y1: y + r });
    const l = labelled(o);
    if (l.name) {
      const w = Math.min(130, o.name.length * 7.6 + 18) / 2;
      boxes.push({ x0: x - w, y0: y + r - 2, x1: x + w, y1: y + r + (l.stars ? 36 : 22) });
    }
  }
  // Zone name chips, centred on their boundary lines.
  for (const z of layout.zones) {
    const w = (z.name.length * 9 + 80) / 2;
    boxes.push({ x0: layout.w / 2 - w, y0: z.line - 13, x1: layout.w / 2 + w, y1: z.line + 13 });
  }
  return boxes;
}

/** A dotted path between two fights, skipping any dot that would land on a box. */
function Link({ a, b, lit, avoid }: { a: { x: number; y: number }; b: { x: number; y: number }; lit: boolean; avoid: Box[] }) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(2, Math.floor(len / 14));
  const size = lit ? 7 : 5;
  const dots: { x: number; y: number }[] = [];
  for (let i = 1; i < n; i++) {
    const x = a.x + ((b.x - a.x) * i) / n;
    const y = a.y + ((b.y - a.y) * i) / n;
    if (avoid.some((k) => x > k.x0 - 3 && x < k.x1 + 3 && y > k.y0 - 3 && y < k.y1 + 3)) continue;
    dots.push({ x, y });
  }
  return (
    <>
      {dots.map((d, i) => (
        <View
          key={i}
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: d.x - size / 2,
            top: d.y - size / 2,
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: lit ? Colors.accent : Colors.border,
          }}
        />
      ))}
    </>
  );
}

export default function Campaign() {
  const game = useGame();
  useMusic('hub');
  const { width, height } = useWindowDimensions();
  const mapW = Math.min(width, MaxContentWidth) - Spacing.lg * 2;
  const layout = mapLayout(mapW);
  const mapH = layout.h;
  const avoid = keepOut(layout, (o) => ({ name: isUnlocked(o, game.cleared, game.stars), stars: game.cleared.includes(o.id) }));
  const sel = getOpponent(game.selected);
  const errors = bugProblems(game.inventory, game.bugs, game.active, game.active);
  const selUnlocked = isUnlocked(sel, game.cleared, game.stars);
  const selGate = starGate(sel, game.stars);
  const gateBlocks = !selUnlocked && pathOpen(sel, game.cleared) && selGate && !selGate.met;
  const firstClear = !game.cleared.includes(sel.id);
  const size = fightSize(sel);
  /** The moves the opponent's own parts carry. */
  const selMoves = movesOf(sel.build.placements.map((p) => getPart(p.partId)));
  const totalStars = OPPONENTS.reduce((a, o) => a + (game.stars[o.id] ?? 0), 0);
  const best = game.stars[sel.id] ?? 0;
  // Team fights: your squad bugs (valid ones, in order), then borrowed opponents for any gaps.
  const slots = allySlots(sel);
  const readySquad = game.squad.filter((i) => bugReady(game.inventory, game.bugs, i, game.active));
  const { borrowed } = alliesFor(
    sel,
    readySquad.map((i) => ({ build: game.bugs[i], aggression: 0.7 })),
  );
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  // Open the map on the selected fight.
  const startY = Math.max(0, layout.pos(sel).y - height * 0.22);
  useEffect(() => {
    const t = setTimeout(() => scroll.current?.scrollTo({ y: startY, animated: false }), 0);
    return () => clearTimeout(t);
    // Only on first show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SafeAreaView style={styles.root} edges={['bottom']}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Text style={styles.total}>
              <Text style={{ color: '#FFD23F' }}>★</Text> {totalStars}/{OPPONENTS.length * MAX_STARS}
            </Text>
          ),
        }}
      />
      <ScrollView ref={scroll} contentContainerStyle={styles.content} contentOffset={{ x: 0, y: startY }}>
        <View style={[styles.map, { width: mapW, height: mapH }]}>
          {layout.zones.map((z) => {
            const tint = ZONE_TINT[z.id];
            const prev = GAME_ZONES[z.index - 1];
            const have = prev ? prev.stops.reduce((a, id) => a + (game.stars[id] ?? 0), 0) : 0;
            const need = GAME_ZONES[z.index].starsToEnter;
            return (
              <View key={z.id} pointerEvents="none" style={[styles.zone, { top: z.top, height: z.line - z.top, backgroundColor: `${tint}08` }]}>
                <View style={[styles.zoneLine, { backgroundColor: tint }]} />
                <View style={[styles.zoneChip, { borderColor: tint }]}>
                  <Text style={[styles.zoneName, { color: tint }]}>{z.name}</Text>
                  {prev && (
                    <Text style={[styles.zoneGate, { color: have >= need ? Colors.good : '#FFD23F' }]}>
                      {have >= need ? '✓' : `★${have}/${need}`}
                    </Text>
                  )}
                </View>
              </View>
            );
          })}
          {OPPONENTS.flatMap((o) =>
            o.unlockedBy.map((from) => (
              <Link key={`${from}-${o.id}`} a={layout.pos(getOpponent(from))} b={layout.pos(o)} lit={game.cleared.includes(from)} avoid={avoid} />
            )),
          )}
          {OPPONENTS.map((o) => {
            const unlocked = isUnlocked(o, game.cleared, game.stars);
            const gate = starGate(o, game.stars);
            const starLocked = !unlocked && pathOpen(o, game.cleared) && gate && !gate.met;
            const cleared = game.cleared.includes(o.id);
            const selected = o.id === sel.id;
            const node = nodeSize(o);
            const ring = selected ? Colors.accent : cleared ? Colors.good : o.optional ? OPTIONAL : o.boss ? Colors.bad : Colors.border;
            const team = fightSize(o);
            return (
              <Pressable
                key={o.id}
                onPress={() => {
                  sfx('tap');
                  game.selectOpponent(o.id);
                }}
                style={[
                  styles.node,
                  {
                    left: layout.pos(o).x - node / 2,
                    top: layout.pos(o).y - node / 2,
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
                {unlocked && (
                  <View pointerEvents="none" style={[styles.nodeLabel, { left: (node - 130) / 2 }]}>
                    <View style={styles.labelPill}>
                      <Text style={[styles.nodeLabelText, selected && { color: Colors.accent }]} numberOfLines={1}>
                        {o.name}
                      </Text>
                      {cleared && <Stars n={game.stars[o.id] ?? 1} size={12} />}
                    </View>
                  </View>
                )}
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
              YOUR SQUAD · YOUR LEAD + {slots} MORE {slots > 1 ? '(TAP UP TO 2)' : '(TAP 1)'}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.allies}>
              {/* Your lead (the bug you're editing in the Garage) always fights. */}
              <Pressable onPress={() => router.push('/garage')} style={[styles.ally, styles.allyLead]}>
                <Text style={[styles.allyName, { color: Colors.bg }]}>★ {game.build.name || 'Unnamed'}</Text>
                <Text style={[styles.allyNote, { color: Colors.bg }]}>LEAD</Text>
              </Pressable>
              {game.bugs.map((b, i) => {
                if (i === game.active) return null;
                const ready = bugReady(game.inventory, game.bugs, i, game.active);
                const pos = readySquad.indexOf(i);
                const fighting = pos >= 0 && pos < slots;
                // Not ready: say why, and tap to go and fix it (that makes it the bug you're editing).
                const why = ready ? '' : (bugProblems(game.inventory, game.bugs, i, game.active)[0] ?? 'needs work');
                return (
                  <Pressable
                    key={i}
                    onPress={() => {
                      if (ready) {
                        game.toggleSquad(i);
                        return;
                      }
                      game.selectBug(i);
                      router.push('/garage');
                    }}
                    style={[styles.ally, fighting && styles.allyOn, !ready && styles.allyBlocked]}>
                    <Text style={[styles.allyName, fighting && { color: Colors.bg }]}>
                      {fighting ? '✓ ' : ''}
                      {b.name}
                    </Text>
                    {!ready && (
                      <Text style={[styles.allyNote, { color: Colors.bad, maxWidth: 150 }]} numberOfLines={2}>
                        {why} · tap to fix
                      </Text>
                    )}
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
        {selUnlocked && selMoves.length > 0 && (
          <Text style={styles.dim} numberOfLines={2}>
            Moves (from its parts): {selMoves.map((m) => getMove(m.id).name).join(', ')}
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
  total: { fontFamily: Fonts.display, fontSize: 18, color: Colors.text, marginRight: Spacing.sm },
  goals: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5 },
  goal: { color: Colors.textDim, fontSize: 11, fontWeight: '800', borderWidth: 1, borderColor: Colors.border, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' },
  zone: { position: 'absolute', left: 0, right: 0 },
  zoneLine: { position: 'absolute', left: 0, right: 0, bottom: -1, height: 2, opacity: 0.55 },
  zoneChip: {
    position: 'absolute',
    bottom: -12,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 24,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1.5,
    backgroundColor: Colors.bgDeep,
  },
  zoneName: { fontSize: 10, fontWeight: '900', letterSpacing: 2 },
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
  zoneGate: { fontSize: 11, fontWeight: '900', letterSpacing: 0.5 },
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
  nodeLabel: { position: 'absolute', top: '100%', marginTop: 3, width: 130, alignItems: 'center' },
  // A dark backing so the path dots pass behind names and stars.
  labelPill: { alignItems: 'center', gap: 1, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, backgroundColor: 'rgba(11,13,17,0.82)', maxWidth: 130 },
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
  allyLead: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  allyBlocked: { borderColor: Colors.bad, borderStyle: 'dashed' },
  allyBorrowed: { borderStyle: 'dashed', borderColor: Colors.border },
  allyNote: { color: Colors.textDim, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  allyPortrait: { width: 30, height: 30 },
  allyName: { color: Colors.text, fontFamily: Fonts.display, fontSize: 13 },
  chips: { flexDirection: 'row', gap: Spacing.sm },
});
