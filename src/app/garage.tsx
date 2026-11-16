import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';

import { PartCell } from '@/components/part-cell';
import { Button, Meter, Panel } from '@/components/ui';
import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';
import { computeStats, GRID_H, GRID_W, MAX_MASS, resolve, usage, validateBuild, type Placement } from '@/game/build';
import { getPart, PARTS, RARITY_COLOR, type PartDef } from '@/game/parts';
import { useGame } from '@/state/game-store';

const CATALOG_ORDER = new Map(PARTS.map((p, i) => [p.id, i]));

function PartDetails({ part }: { part: PartDef }) {
  const lines: string[] = [`HP ${part.hp}`, `Mass ${part.mass}`];
  lines.push(part.power < 0 ? `Supplies ${-part.power} power` : `Power ${part.power}`);
  if (part.thrust) lines.push(`Thrust ${part.thrust}`);
  if (part.grip) lines.push(`Grip +${part.grip}`);
  if (part.lift) lines.push(`Lift ${part.lift}`);
  if (part.weapon) {
    const w = part.weapon;
    lines.push(`Dmg ${w.damage} / ${w.cooldown}s`, `Reach ${w.range}`);
    if (w.ramBonus) lines.push('Ram bonus');
  }
  return (
    <View style={{ gap: 2 }}>
      <Text style={[styles.partName, { color: RARITY_COLOR[part.rarity] }]}>
        {part.name} <Text style={styles.dim}>· {part.rarity} {part.category}</Text>
      </Text>
      <Text style={styles.dim}>{part.description}</Text>
      <Text style={styles.statsLine}>{lines.join('  ·  ')}</Text>
    </View>
  );
}

export default function Garage() {
  const game = useGame();
  const { width } = useWindowDimensions();
  const [selected, setSelected] = useState<string | null>(null);
  const [inspect, setInspect] = useState<string | null>(null);

  const placements = game.build.placements;
  const used = usage(placements);
  const stats = computeStats(resolve(placements));
  const errors = validateBuild(placements);
  const cell = Math.min(58, Math.floor((Math.min(width, MaxContentWidth) - Spacing.lg * 2) / GRID_W));

  const owned = Object.entries(game.inventory)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (CATALOG_ORDER.get(a) ?? 0) - (CATALOG_ORDER.get(b) ?? 0));

  const at = (x: number, y: number) => placements.find((p) => p.x === x && p.y === y);

  function tapCell(x: number, y: number) {
    const existing = at(x, y);
    const rest = placements.filter((p) => !(p.x === x && p.y === y));
    if (existing && (!selected || existing.partId === selected)) {
      game.setPlacements(rest);
      setInspect(existing.partId);
      return;
    }
    if (!selected) return;
    const free = (game.inventory[selected] ?? 0) - (used[selected] ?? 0) + (existing?.partId === selected ? 1 : 0);
    if (free <= 0) return;
    const next: Placement[] = [...rest, { x, y, partId: selected }];
    game.setPlacements(next);
  }

  const detailId = selected ?? inspect;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <TextInput
        value={game.build.name}
        onChangeText={(t) => game.setBugName(t.slice(0, 18))}
        style={styles.nameInput}
        placeholder="Name your bug"
        placeholderTextColor={Colors.textDim}
      />

      <View style={{ alignItems: 'center', gap: Spacing.xs }}>
        <Text style={styles.front}>▲ FRONT</Text>
        <View style={[styles.grid, { width: cell * GRID_W + 4, height: cell * GRID_H + 4 }]}>
          {Array.from({ length: GRID_H }).map((_, y) =>
            Array.from({ length: GRID_W }).map((__, x) => {
              const p = at(x, y);
              return (
                <Pressable
                  key={`${x},${y}`}
                  onPress={() => tapCell(x, y)}
                  style={[styles.slot, { left: x * cell + 2, top: y * cell + 2, width: cell, height: cell }]}>
                  {p ? <PartCell part={getPart(p.partId)} size={cell - 4} /> : <View style={styles.empty} />}
                </Pressable>
              );
            }),
          )}
        </View>
        <Text style={styles.hint}>
          {selected ? 'Tap a slot to place · tap the same part again to remove' : 'Pick a part below, then tap a slot. Tap a placed part to remove it.'}
        </Text>
      </View>

      <Panel style={{ gap: Spacing.sm }}>
        <Meter
          label="POWER"
          value={stats.powerDraw}
          max={Math.max(stats.powerSupply, 1)}
          color={stats.powerDraw > stats.powerSupply ? Colors.bad : Colors.good}
          display={`${stats.powerDraw} / ${stats.powerSupply}`}
        />
        <Meter label="WEIGHT" value={stats.mass} max={MAX_MASS} color={stats.mass > MAX_MASS ? Colors.bad : Colors.accent} />
        <View style={styles.statGrid}>
          <Text style={styles.stat}>Speed {Math.round(stats.topSpeed)}</Text>
          <Text style={styles.stat}>Turn {stats.turnRate.toFixed(1)}</Text>
          <Text style={styles.stat}>HP {stats.totalHp}</Text>
          <Text style={styles.stat}>DPS {stats.dps.toFixed(1)}</Text>
          <Text style={styles.stat}>Reach ×{stats.reach.toFixed(1)}</Text>
          {Math.abs(stats.thrustBias) > 0.05 && <Text style={[styles.stat, { color: Colors.bad }]}>Pulls {stats.thrustBias > 0 ? 'left' : 'right'}</Text>}
        </View>
        {errors.map((e) => (
          <Text key={e} style={styles.error}>
            ⚠ {e}
          </Text>
        ))}
      </Panel>

      {detailId && (
        <Panel>
          <PartDetails part={getPart(detailId)} />
        </Panel>
      )}

      <Text style={styles.section}>PARTS BIN</Text>
      <View style={styles.bin}>
        {owned.map(([id, count]) => {
          const part = getPart(id);
          const free = count - (used[id] ?? 0);
          const isSel = selected === id;
          return (
            <Pressable
              key={id}
              onPress={() => setSelected(isSel ? null : id)}
              style={[styles.binItem, isSel && styles.binSelected]}>
              <PartCell part={part} size={34} dim={free <= 0} />
              <Text style={styles.binName} numberOfLines={2}>
                {part.name}
              </Text>
              <Text style={styles.binCount}>
                {free}/{count}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.actions}>
        <Button label="Clear" variant="secondary" onPress={() => game.setPlacements([])} style={{ flex: 1 }} />
        <Button label="To the Arena" disabled={errors.length > 0} onPress={() => router.replace('/arena')} style={{ flex: 2 }} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.lg,
    gap: Spacing.lg,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingBottom: Spacing.xl * 2,
  },
  nameInput: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: '800',
    borderBottomWidth: 1,
    borderColor: Colors.border,
    paddingVertical: Spacing.xs,
  },
  front: { color: Colors.accent, fontWeight: '800', fontSize: 12, letterSpacing: 2 },
  grid: { backgroundColor: Colors.panel, borderRadius: 12, borderWidth: 1, borderColor: Colors.border },
  slot: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  empty: {
    width: '84%',
    height: '84%',
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: Colors.border,
  },
  hint: { color: Colors.textDim, fontSize: 12, textAlign: 'center' },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  stat: { color: Colors.text, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  error: { color: Colors.bad, fontSize: 13 },
  partName: { fontSize: 16, fontWeight: '800' },
  dim: { color: Colors.textDim, fontSize: 13, fontWeight: '400' },
  statsLine: { color: Colors.text, fontSize: 12, marginTop: 2 },
  section: { color: Colors.accent, fontSize: 12, fontWeight: '800', letterSpacing: 1.5 },
  bin: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  binItem: {
    width: 76,
    alignItems: 'center',
    gap: 2,
    padding: Spacing.xs,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.panel,
  },
  binSelected: { borderColor: Colors.accent, backgroundColor: Colors.panelHi },
  binName: { color: Colors.text, fontSize: 10, textAlign: 'center', minHeight: 26 },
  binCount: { color: Colors.textDim, fontSize: 11, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: Spacing.sm },
});
