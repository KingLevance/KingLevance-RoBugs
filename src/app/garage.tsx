import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type HostInstance,
} from 'react-native';

import { PartCell } from '@/components/part-cell';
import { Button, Meter, Panel } from '@/components/ui';
import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';
import { computeStats, MAX_MASS, resolve, usage, validateBuild } from '@/game/build';
import { autoPlace, movePart, partAt, removeAt } from '@/game/editor';
import { getMove, MOVE_SLOTS } from '@/game/moves';
import { getPart, PARTS, RARITY_COLOR, type PartDef } from '@/game/parts';
import { GarageRenderer, type Cell, type ViewName } from '@/render/garage-scene';
import { useGame } from '@/state/game-store';

const CATALOG_ORDER = new Map(PARTS.map((p, i) => [p.id, i]));
const DRAG_SLOP = 8;
const VIEW_BUTTONS: [ViewName, string][] = [
  ['angle', 'Angle'],
  ['top', 'Top'],
  ['side', 'Side'],
  ['front', 'Front'],
];

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
    <View style={{ gap: 2, flex: 1 }}>
      <Text style={[styles.partName, { color: RARITY_COLOR[part.rarity] }]}>
        {part.name} <Text style={styles.dim}>· {part.rarity} {part.category}</Text>
      </Text>
      <Text style={styles.dim}>{part.description}</Text>
      <Text style={styles.statsLine}>{lines.join('  ·  ')}</Text>
    </View>
  );
}

type Touch = {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** Part under the finger at touch start; null means the touch spins the view. */
  cell: Cell | null;
  dragging: boolean;
  last: { cell: Cell | null; inside: boolean };
};

export default function Garage() {
  const game = useGame();
  const { width, height } = useWindowDimensions();
  const [selected, setSelected] = useState<Cell | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dragHint, setDragHint] = useState<'move' | 'remove' | null>(null);
  const renderer = useRef<GarageRenderer | null>(null);
  const raf = useRef(0);
  const box = useRef({ x: 0, y: 0, w: 1, h: 1 });
  const viewRef = useRef<HostInstance>(null);
  const touch = useRef<Touch | null>(null);

  const placements = game.build.placements;
  const used = usage(placements);
  const stats = computeStats(resolve(placements));
  const errors = validateBuild(placements);
  const editorW = Math.min(width, MaxContentWidth);
  const editorH = Math.min(editorW * 1.05, height * 0.48);
  const selPart = selected ? partAt(placements, selected.x, selected.y) : undefined;
  const binW = Math.floor((editorW - Spacing.lg * 2 - Spacing.sm * 3) / 4);

  const owned = Object.entries(game.inventory)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (CATALOG_ORDER.get(a) ?? 0) - (CATALOG_ORDER.get(b) ?? 0));

  useEffect(() => {
    renderer.current?.setPlacements(placements);
  }, [placements]);

  useEffect(() => {
    renderer.current?.setSelected(selPart ? selected : null);
  }, [selected, selPart]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      renderer.current?.dispose();
      renderer.current = null;
    },
    [],
  );

  function onContextCreate(gl: ExpoWebGLRenderingContext) {
    const r = new GarageRenderer(gl);
    r.setPlacements(game.build.placements);
    renderer.current = r;
    let last = performance.now();
    const tick = (now: number) => {
      r.render(Math.min(0.1, (now - last) / 1000));
      last = now;
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }

  function measure() {
    viewRef.current?.measureInWindow((x, y, w, h) => {
      box.current = { x, y, w: w || 1, h: h || 1 };
    });
  }

  const norm = (e: GestureResponderEvent) => ({
    nx: (e.nativeEvent.pageX - box.current.x) / box.current.w,
    ny: (e.nativeEvent.pageY - box.current.y) / box.current.h,
  });

  function onGrant(e: GestureResponderEvent) {
    const { nx, ny } = norm(e);
    measure();
    const cell = renderer.current?.pick(nx, ny).cell ?? null;
    touch.current = {
      startX: e.nativeEvent.pageX,
      startY: e.nativeEvent.pageY,
      lastX: e.nativeEvent.pageX,
      lastY: e.nativeEvent.pageY,
      cell: cell && partAt(placements, cell.x, cell.y) ? cell : null,
      dragging: false,
      last: { cell, inside: !!cell },
    };
  }

  function onMove(e: GestureResponderEvent) {
    const t = touch.current;
    const r = renderer.current;
    if (!t || !r) return;
    const { pageX, pageY } = e.nativeEvent;
    if (!t.cell) {
      // Empty space: spin the view.
      r.orbit(pageX - t.lastX, pageY - t.lastY);
      t.lastX = pageX;
      t.lastY = pageY;
      if (Math.hypot(pageX - t.startX, pageY - t.startY) >= DRAG_SLOP) t.dragging = true;
      return;
    }
    if (!t.dragging) {
      const moved = Math.hypot(pageX - t.startX, pageY - t.startY);
      if (moved < DRAG_SLOP) return;
      t.dragging = r.startDrag(t.cell);
      setSelected(t.cell);
    }
    const { nx, ny } = norm(e);
    t.last = r.dragTo(nx, ny);
    setDragHint(t.last.inside ? 'move' : 'remove');
  }

  function onRelease() {
    const t = touch.current;
    touch.current = null;
    setDragHint(null);
    if (!t) return;
    if (!t.cell && t.dragging) return; // finished spinning the view
    if (!t.dragging) {
      // Tap: select / deselect a part.
      const same = t.cell && selected && t.cell.x === selected.x && t.cell.y === selected.y;
      setSelected(t.cell && !same ? t.cell : null);
      return;
    }
    renderer.current?.endDrag();
    const from = t.cell!;
    const moving = partAt(placements, from.x, from.y);
    if (t.last.inside && t.last.cell) {
      game.setPlacements(movePart(placements, from, t.last.cell));
      setSelected(t.last.cell);
    } else {
      game.setPlacements(removeAt(placements, from.x, from.y));
      setSelected(null);
      if (moving) setToast(`${getPart(moving.partId).name} back in the bin`);
    }
  }

  function addPart(id: string) {
    const free = (game.inventory[id] ?? 0) - (used[id] ?? 0);
    const part = getPart(id);
    if (free <= 0) {
      setToast(`All your ${part.name} are already on the bug`);
      return;
    }
    const spot = autoPlace(placements, id);
    if (!spot) {
      setToast('No free slot touching the bug');
      return;
    }
    game.setPlacements([...placements, spot]);
    setSelected({ x: spot.x, y: spot.y });
    setToast(`${part.name} attached. Drag it to move it.`);
  }

  function removeSelected() {
    if (!selected || !selPart) return;
    game.setPlacements(removeAt(placements, selected.x, selected.y));
    setToast(`${getPart(selPart.partId).name} back in the bin`);
    setSelected(null);
  }

  return (
    <View style={styles.root}>
      <View style={[styles.top, { width: editorW }]}>
        <TextInput
          value={game.build.name}
          onChangeText={(t) => game.setBugName(t.slice(0, 18))}
          style={styles.nameInput}
          placeholder="Name your bug"
          placeholderTextColor={Colors.textDim}
        />
        <View ref={viewRef} onLayout={measure} style={{ width: editorW, height: editorH }}>
          <GLView
            style={StyleSheet.absoluteFill}
            onContextCreate={onContextCreate}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderTerminationRequest={() => false}
            onResponderGrant={onGrant}
            onResponderMove={onMove}
            onResponderRelease={onRelease}
            onResponderTerminate={onRelease}
          />
          <View pointerEvents="box-none" style={styles.editorOverlay}>
            <View style={styles.views} pointerEvents="box-none">
              {VIEW_BUTTONS.map(([name, label]) => (
                <Pressable key={name} onPress={() => renderer.current?.setView(name)} style={styles.viewBtn}>
                  <Text style={styles.viewBtnText}>{label}</Text>
                </Pressable>
              ))}
            </View>
            <Text pointerEvents="none" style={[styles.hint, dragHint === 'remove' && { color: Colors.bad }]}>
              {dragHint === 'remove'
                ? 'Release to put it back in the bin'
                : dragHint === 'move'
                  ? 'Release to drop it here (swaps if taken)'
                  : toast ?? 'Drag a part to move it · drag empty space to spin the view'}
            </Text>
          </View>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {selPart && (
          <Panel style={styles.detailRow}>
            <PartCell part={getPart(selPart.partId)} size={52} />
            <PartDetails part={getPart(selPart.partId)} />
            <Button label="Remove" variant="danger" onPress={removeSelected} />
          </Panel>
        )}

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
            {Math.abs(stats.thrustBias) > 0.05 && (
              <Text style={[styles.stat, { color: Colors.bad }]}>Pulls {stats.thrustBias > 0 ? 'left' : 'right'}</Text>
            )}
          </View>
          {errors.map((e) => (
            <Text key={e} style={styles.error}>
              ⚠ {e}
            </Text>
          ))}
        </Panel>

        <Text style={styles.section}>PARTS BIN · TAP TO ATTACH</Text>
        <View style={styles.bin}>
          {owned.map(([id, count]) => {
            const part = getPart(id);
            const free = count - (used[id] ?? 0);
            return (
              <Pressable
                key={id}
                onPress={() => addPart(id)}
                style={({ pressed }) => [styles.binItem, { width: binW }, pressed && styles.binSelected]}>
                <View>
                  <PartCell part={part} size={binW - 16} dim={free <= 0} />
                  <View style={[styles.countBadge, free <= 0 && { backgroundColor: Colors.border }]}>
                    <Text style={styles.countText}>
                      {free}/{count}
                    </Text>
                  </View>
                </View>
                <Text style={styles.binName} numberOfLines={2}>
                  {part.name}
                </Text>
                <Text style={[styles.binRarity, { color: RARITY_COLOR[part.rarity] }]}>{part.rarity.toUpperCase()}</Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.section}>
          SIGNATURE MOVES · {game.equipped.length}/{MOVE_SLOTS} EQUIPPED
        </Text>
        <View style={{ gap: Spacing.sm }}>
          {game.moves.map((id) => {
            const m = getMove(id);
            const on = game.equipped.includes(id);
            const hasParts = placements.filter((p) => getPart(p.partId).category === m.requires.category).length >= m.requires.count;
            return (
              <Pressable
                key={id}
                onPress={() => game.toggleEquip(id)}
                style={[styles.moveRow, on && { borderColor: m.color, backgroundColor: Colors.panelHi }]}>
                <View style={[styles.moveDot, { backgroundColor: on ? m.color : Colors.bg, borderColor: m.color }]} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[styles.partName, { color: m.color, fontSize: 15 }]}>
                    {m.name}{' '}
                    <Text style={styles.dim}>
                      · {m.cost} PP · {m.cooldown}s cd{m.ultimate ? ' · ultimate' : ''}
                    </Text>
                  </Text>
                  <Text style={styles.dim}>{m.description}</Text>
                  {on && !hasParts && <Text style={styles.error}>⚠ Your build has no {m.requires.category}, so this move can never fire.</Text>}
                </View>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.actions}>
          <Button label="Clear" variant="secondary" onPress={() => game.setPlacements([])} style={{ flex: 1 }} />
          <Button label="Campaign map" disabled={errors.length > 0} onPress={() => router.dismissTo('/campaign')} style={{ flex: 2 }} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  top: { alignSelf: 'center' },
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
    fontSize: 20,
    fontWeight: '800',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  editorOverlay: { ...StyleSheet.absoluteFill, justifyContent: 'space-between', alignItems: 'center', paddingVertical: Spacing.sm },
  views: { flexDirection: 'row', gap: 6 },
  viewBtn: {
    backgroundColor: 'rgba(20,23,28,0.8)',
    borderColor: Colors.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  viewBtnText: { color: Colors.text, fontSize: 12, fontWeight: '700' },
  hint: {
    color: Colors.text,
    fontSize: 12,
    textAlign: 'center',
    backgroundColor: 'rgba(20,23,28,0.75)',
    paddingHorizontal: Spacing.md,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
  },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  stat: { color: Colors.text, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  error: { color: Colors.bad, fontSize: 13 },
  partName: { fontSize: 16, fontWeight: '800' },
  dim: { color: Colors.textDim, fontSize: 13, fontWeight: '400' },
  statsLine: { color: Colors.text, fontSize: 12, marginTop: 2 },
  section: { color: Colors.accent, fontSize: 12, fontWeight: '800', letterSpacing: 1.5 },
  bin: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  binItem: {
    alignItems: 'center',
    gap: 3,
    paddingVertical: Spacing.sm,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.panel,
  },
  binSelected: { borderColor: Colors.accent, backgroundColor: Colors.panelHi },
  binName: { color: Colors.text, fontSize: 11, fontWeight: '600', textAlign: 'center', minHeight: 28, paddingHorizontal: 2 },
  binRarity: { fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  countBadge: {
    position: 'absolute',
    top: -5,
    right: -7,
    backgroundColor: Colors.accent,
    borderRadius: 999,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderWidth: 1.5,
    borderColor: Colors.panel,
  },
  countText: { color: Colors.bg, fontSize: 10, fontWeight: '900', fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: Spacing.sm },
  moveRow: {
    flexDirection: 'row',
    gap: Spacing.md,
    alignItems: 'flex-start',
    padding: Spacing.md,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.panel,
  },
  moveDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, marginTop: 2 },
});
