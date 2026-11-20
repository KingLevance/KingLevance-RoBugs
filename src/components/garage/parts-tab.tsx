/**
 * Garage parts drawer: filter chips plus a grid of part cards.
 * Tap a card to pick the part up (then tap a glowing spot on the bug);
 * press and hold a card to drag it straight onto the bug.
 */
import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';

import { sfx } from '@/audio/audio';
import { PartCell } from '@/components/part-cell';
import { Colors, Fonts, Spacing } from '@/constants/theme';
import { getMove } from '@/game/moves';
import { getPart, PARTS, RARITY_COLOR, type Category, type PartDef } from '@/game/parts';

export type FilterId = 'all' | 'body' | 'legs' | 'wings' | 'weapons' | 'armor' | 'core' | 'sensor' | 'moves';

export const FILTERS: { id: FilterId; label: string; cats?: Category[] }[] = [
  { id: 'all', label: 'All' },
  { id: 'body', label: 'Body', cats: ['head', 'thorax', 'abdomen'] },
  { id: 'legs', label: 'Legs', cats: ['legs'] },
  { id: 'wings', label: 'Wings', cats: ['wings'] },
  { id: 'weapons', label: 'Weapons', cats: ['mandibles', 'pincers', 'stinger', 'horn'] },
  { id: 'armor', label: 'Armor', cats: ['armor'] },
  { id: 'core', label: 'Cores', cats: ['core'] },
  { id: 'sensor', label: 'Sensors', cats: ['sensor'] },
  { id: 'moves', label: '★ Moves' },
];

const CAT_ORDER: Category[] = ['head', 'thorax', 'abdomen', 'legs', 'wings', 'mandibles', 'pincers', 'stinger', 'horn', 'armor', 'core', 'sensor'];
const RARITY_RANK = { common: 0, uncommon: 1, rare: 2, epic: 3 } as const;
const CATALOG = new Map(PARTS.map((p, i) => [p.id, i]));

export function matchesFilter(part: PartDef, f: FilterId) {
  if (f === 'all') return true;
  if (f === 'moves') return !!part.move;
  return FILTERS.find((x) => x.id === f)?.cats?.includes(part.category) ?? false;
}

export type BinDrag = {
  start: (id: string, x: number, y: number) => void;
  move: (x: number, y: number) => void;
  end: (x: number, y: number) => void;
  cancel: () => void;
};

const HOLD_MS = 240;
const SLOP = 9;

/** One part in the bin. Tap picks it up; press-and-hold then drag drops it on the bug. */
function BinCard({
  part,
  free,
  owned,
  onOthers,
  width,
  held,
  onPick,
  drag,
}: {
  part: PartDef;
  free: number;
  owned: number;
  onOthers: number;
  width: number;
  held: boolean;
  onPick: (id: string) => void;
  drag: BinDrag;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragging = useRef(false);
  const moved = useRef(false);
  const start = useRef({ x: 0, y: 0 });
  const [pressed, setPressed] = useState(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const page = (e: GestureResponderEvent) => ({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY });
  const move = part.move ? getMove(part.move) : null;
  return (
    <View
      onStartShouldSetResponder={() => true}
      onResponderTerminationRequest={() => !dragging.current}
      onResponderGrant={(e) => {
        start.current = page(e);
        moved.current = false;
        setPressed(true);
        clear();
        if (free > 0)
          timer.current = setTimeout(() => {
            dragging.current = true;
            sfx('tap', { rate: 1.3 });
            drag.start(part.id, start.current.x, start.current.y);
          }, HOLD_MS);
      }}
      onResponderMove={(e) => {
        const p = page(e);
        if (dragging.current) {
          drag.move(p.x, p.y);
          return;
        }
        if (Math.hypot(p.x - start.current.x, p.y - start.current.y) > SLOP) {
          moved.current = true;
          clear();
          setPressed(false);
        }
      }}
      onResponderRelease={(e) => {
        clear();
        setPressed(false);
        if (dragging.current) {
          dragging.current = false;
          const p = page(e);
          drag.end(p.x, p.y);
        } else if (!moved.current) {
          onPick(part.id);
        }
      }}
      onResponderTerminate={() => {
        clear();
        setPressed(false);
        if (dragging.current) drag.cancel();
        dragging.current = false;
      }}
      style={[styles.card, { width }, pressed && styles.cardPressed, held && styles.cardHeld]}>
      <View>
        <PartCell part={part} size={width - 14} dim={free <= 0} />
        <View style={[styles.badge, free <= 0 && { backgroundColor: Colors.border }]}>
          <Text style={styles.badgeText}>×{free}</Text>
        </View>
      </View>
      <Text style={[styles.name, free <= 0 && { color: Colors.textDim }]} numberOfLines={2}>
        {part.name}
      </Text>
      {move ? (
        <Text style={[styles.move, { color: move.color }]} numberOfLines={1}>
          ★ {move.name}
        </Text>
      ) : (
        <Text style={[styles.rarity, { color: RARITY_COLOR[part.rarity] }]}>{part.rarity}</Text>
      )}
      {onOthers > 0 && free <= 0 && owned > 0 && <Text style={styles.other}>on other bugs</Text>}
    </View>
  );
}

export function PartsTab({
  inventory,
  free,
  onOthers,
  filter,
  setFilter,
  needs,
  heldId,
  width,
  onPick,
  drag,
  scrollEnabled,
  onAutoBuild,
}: {
  inventory: Record<string, number>;
  /** Copies this bug can still add, by part id. */
  free: (id: string) => number;
  onOthers: (id: string) => number;
  filter: FilterId;
  setFilter: (f: FilterId) => void;
  /** Filters with something the bug still needs (they get a red dot). */
  needs: FilterId[];
  heldId: string | null;
  width: number;
  onPick: (id: string) => void;
  drag: BinDrag;
  scrollEnabled: boolean;
  onAutoBuild: () => void;
}) {
  const owned = Object.entries(inventory)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => ({ part: getPart(id), n }));
  const shown = owned
    .filter(({ part }) => matchesFilter(part, filter))
    .sort((a, b) => {
      const fa = free(a.part.id) > 0 ? 0 : 1;
      const fb = free(b.part.id) > 0 ? 0 : 1;
      return (
        fa - fb ||
        CAT_ORDER.indexOf(a.part.category) - CAT_ORDER.indexOf(b.part.category) ||
        RARITY_RANK[b.part.rarity] - RARITY_RANK[a.part.rarity] ||
        (CATALOG.get(a.part.id) ?? 0) - (CATALOG.get(b.part.id) ?? 0)
      );
    });
  const cols = width > 460 ? 5 : 4;
  const cardW = Math.floor((width - Spacing.md * 2 - Spacing.sm * (cols - 1)) / cols);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.chipBar}>
        {FILTERS.map((f) => {
          const on = f.id === filter;
          const count = owned.filter(({ part }) => matchesFilter(part, f.id)).length;
          if (f.id !== 'all' && count === 0) return null;
          return (
            <Pressable
              key={f.id}
              onPress={() => {
                sfx('tap');
                setFilter(f.id);
              }}
              style={[styles.chip, on && styles.chipOn]}>
              <Text style={[styles.chipText, on && { color: Colors.bg }]}>
                {f.label} <Text style={{ opacity: 0.6 }}>{count}</Text>
              </Text>
              {needs.includes(f.id) && <View style={styles.needDot} />}
            </Pressable>
          );
        })}
      </ScrollView>
      <ScrollView scrollEnabled={scrollEnabled} contentContainerStyle={styles.grid}>
        {shown.map(({ part, n }) => (
          <BinCard
            key={part.id}
            part={part}
            owned={n}
            free={free(part.id)}
            onOthers={onOthers(part.id)}
            width={cardW}
            held={heldId === part.id}
            onPick={onPick}
            drag={drag}
          />
        ))}
        {shown.length === 0 && <Text style={styles.empty}>No parts of this kind yet. Win fights to collect more.</Text>}
        <Pressable onPress={onAutoBuild} style={[styles.auto, { width: width - Spacing.md * 2 }]}>
          <Text style={styles.autoText}>⚡ Auto-build from my best spare parts</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  chipBar: { flexGrow: 0, flexShrink: 0, minHeight: 48 },
  chips: { gap: 6, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, alignItems: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.panel,
  },
  chipOn: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  chipText: { color: Colors.text, fontSize: 13, fontWeight: '800' },
  needDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Colors.bad, marginLeft: 5 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, paddingHorizontal: Spacing.md, paddingBottom: Spacing.xl * 2 },
  card: {
    alignItems: 'center',
    gap: 2,
    paddingTop: 7,
    paddingBottom: 6,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.panel,
  },
  cardPressed: { transform: [{ scale: 0.95 }], borderColor: Colors.accentDim },
  cardHeld: { borderColor: Colors.accent, backgroundColor: Colors.panelHi },
  badge: {
    position: 'absolute',
    top: -4,
    right: -5,
    backgroundColor: Colors.accent,
    borderRadius: 999,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderWidth: 1.5,
    borderColor: Colors.panel,
  },
  badgeText: { color: Colors.bg, fontSize: 10, fontWeight: '900', fontVariant: ['tabular-nums'] },
  name: { color: Colors.text, fontSize: 10.5, fontWeight: '700', textAlign: 'center', minHeight: 27, paddingHorizontal: 3, lineHeight: 13 },
  move: { fontSize: 9.5, fontWeight: '900', paddingHorizontal: 3 },
  rarity: { fontSize: 9, fontWeight: '900', letterSpacing: 0.8, textTransform: 'uppercase' },
  other: { color: Colors.textDim, fontSize: 9, fontWeight: '700' },
  empty: { color: Colors.textDim, fontSize: 13, padding: Spacing.md },
  auto: {
    marginTop: Spacing.sm,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: Colors.accentDim,
  },
  autoText: { color: Colors.accent, fontFamily: Fonts.display, fontSize: 15 },
});
