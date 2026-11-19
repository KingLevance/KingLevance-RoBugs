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

import { sfx, useMusic } from '@/audio/audio';
import { PartCell } from '@/components/part-cell';
import { Button, Meter, Panel } from '@/components/ui';
import { Colors, Fonts, MaxContentWidth, Spacing } from '@/constants/theme';
import {
  availableFor,
  bugReady,
  computeStats,
  connectedKeys,
  FACING_NAMES,
  facingsFor,
  fitToParts,
  MAX_MASS,
  resolve,
  shortParts,
  usage,
  validateBuild,
  type BugStats,
  type Placement,
} from '@/game/build';
import { autoBuild, autoPlace, dropLayer, flipLayer, movePart, partAt, rankSlots, removeAt, rotatePart, sameSlot, type Slot } from '@/game/editor';
import { GROUPS, GUIDE } from '@/game/guide';
import { getMove, meetsRequirement, MOVE_SLOTS, type MoveId } from '@/game/moves';
import { getPart, PARTS, RARITY_COLOR, type Category, type PartDef } from '@/game/parts';
import { CRIT, dodgeCooldown, maxPoise, reflex } from '@/game/sim';
import { GarageRenderer, type Cell, type ViewName } from '@/render/garage-scene';
import { MAX_BUGS, MAX_SAVED, useGame } from '@/state/game-store';

const CATALOG_ORDER = new Map(PARTS.map((p, i) => [p.id, i]));
const DRAG_SLOP = 8;
const VIEW_BUTTONS: [ViewName, string][] = [
  ['angle', 'Angle'],
  ['top', 'Top'],
  ['side', 'Side'],
  ['front', 'Front'],
];

function PartDetails({ part, onRemove }: { part: PartDef; onRemove: () => void }) {
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
  const g = GUIDE[part.category];
  return (
    <View style={{ gap: Spacing.sm }}>
      <View style={styles.detailRow}>
        <PartCell part={part} size={52} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.partName, { color: RARITY_COLOR[part.rarity] }]}>{part.name}</Text>
          <Text style={styles.dim}>
            {g.label} · <Text style={{ color: RARITY_COLOR[part.rarity], fontWeight: '700' }}>{part.rarity}</Text>
          </Text>
        </View>
        <Button label="Remove" variant="danger" onPress={onRemove} />
      </View>
      <Text style={styles.guideLine}>
        <Text style={styles.guideKey}>WHAT IT DOES  </Text>
        {g.does}
      </Text>
      <Text style={styles.guideLine}>
        <Text style={[styles.guideKey, { color: Colors.good }]}>WHERE IT GOES  </Text>
        {g.where} Green tiles on the grid show good spots.
      </Text>
      <Text style={styles.statsLine}>{lines.join('  ·  ')}</Text>
    </View>
  );
}

type Check = { label: string; short: string; ok: boolean; optional?: boolean };

/** The things a bug needs, as ticks: clearer than a list of errors. */
function buildChecks(placements: Placement[], stats: BugStats): Check[] {
  const parts = resolve(placements);
  const count = (c: Category) => parts.filter((p) => p.part.category === c).length;
  const linked = connectedKeys(parts).size === parts.length;
  const weapons = parts.filter((p) => p.part.weapon).length;
  return [
    { label: count('head') > 1 ? 'Only 1 head' : 'Head', short: count('head') > 1 ? 'Only 1 head' : 'A head', ok: count('head') === 1 },
    { label: 'Middle body (thorax)', short: 'A thorax', ok: count('thorax') >= 1 },
    { label: 'Power core', short: 'A power core', ok: count('core') >= 1 },
    { label: 'Legs or wings', short: 'Legs or wings', ok: stats.thrust > 0 },
    { label: 'All parts touching', short: 'All parts touching', ok: linked },
    { label: `Power ${stats.powerDraw}/${stats.powerSupply}`, short: `Less power (${stats.powerDraw}/${stats.powerSupply})`, ok: stats.powerDraw <= stats.powerSupply },
    { label: `Weight ${stats.mass}/${MAX_MASS}`, short: `Less weight (${stats.mass}/${MAX_MASS})`, ok: stats.mass <= MAX_MASS },
    { label: 'A weapon', short: 'A weapon', ok: weapons > 0, optional: true },
    { label: 'Even legs', short: 'Even legs', ok: Math.abs(stats.thrustBias) <= 0.05, optional: true },
  ];
}

function Checklist({ items }: { items: Check[] }) {
  return (
    <View style={styles.checklist}>
      {items.map((it) => {
        const color = it.ok ? Colors.good : it.optional ? Colors.accent : Colors.bad;
        return (
          <View key={it.label} style={[styles.check, { borderColor: color }]}>
            <Text style={[styles.checkText, { color }]}>
              {it.ok ? '✓' : it.optional ? '!' : '✗'} {it.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

type Touch = {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** Part under the finger at touch start; null means the touch spins the view. */
  cell: Slot | null;
  dragging: boolean;
  last: { cell: Cell | null; inside: boolean };
};

/** One line per part another bug is using, or one line per bug when that bug holds several. */
function sharedNotes(short: Record<string, number>, holder: (id: string) => string): string[] {
  const byHolder = new Map<string, [string, number][]>();
  for (const [id, n] of Object.entries(short)) byHolder.set(holder(id), [...(byHolder.get(holder(id)) ?? []), [id, n]]);
  const out: string[] = [];
  for (const [who, list] of byHolder) {
    const total = list.reduce((a, [, n]) => a + n, 0);
    if (list.length > 2) out.push(`${total} parts are on ${who}`);
    else for (const [id, n] of list) out.push(`${n > 1 ? `${n}× ` : ''}${getPart(id).name} ${n > 1 ? 'are' : 'is'} on ${who}`);
  }
  return out;
}

const UNDO_STEPS = 40;
type Snapshot = { placements: Placement[]; equipped: MoveId[] };
/** Same parts (in any order) and the same moves. */
function sameLoadout(b: Snapshot, placements: Placement[], equipped: MoveId[]) {
  const key = (ps: Placement[]) => ps.map((p) => `${p.partId}@${p.x},${p.y},${p.z ?? 0},${p.r ?? 0}`).sort().join('|');
  return key(b.placements) === key(placements) && [...b.equipped].sort().join() === [...equipped].sort().join();
}

export default function Garage() {
  const game = useGame();
  useMusic('garage');
  const { width, height } = useWindowDimensions();
  const [selected, setSelected] = useState<Slot | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Saved build waiting for a second tap to delete it. */
  const [confirmSaved, setConfirmSaved] = useState<number | null>(null);
  /** Undo history for the bug being edited (cleared when you switch, add or scrap bugs). */
  const [history, setHistory] = useState<{ bug: number; stack: Snapshot[] }>({ bug: -1, stack: [] });
  const [dragHint, setDragHint] = useState<'move' | 'remove' | null>(null);
  const renderer = useRef<GarageRenderer | null>(null);
  const raf = useRef(0);
  const box = useRef({ x: 0, y: 0, w: 1, h: 1 });
  const viewRef = useRef<HostInstance>(null);
  const touch = useRef<Touch | null>(null);

  const placements = game.build.placements;
  const undoStack = history.bug === game.active ? history.stack : [];
  /** Remember the current parts + moves so the next change can be undone. */
  const remember = () =>
    setHistory({ bug: game.active, stack: [...undoStack, { placements, equipped: game.equipped }].slice(-UNDO_STEPS) });
  const forgetHistory = () => setHistory({ bug: -1, stack: [] });
  /** Apply an edit to the build with a click: snap on, pop off, or turn. */
  const edit = (next: Placement[]) => {
    if (JSON.stringify(next) === JSON.stringify(placements)) return;
    remember();
    sfx(next.length < placements.length ? 'unsnap' : 'snap', { rate: next.length === placements.length ? 1.25 : 1 });
    game.setPlacements(next);
  };
  const toggleMove = (id: MoveId) => {
    remember();
    game.toggleEquip(id);
  };
  const undo = () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setHistory({ bug: game.active, stack: undoStack.slice(0, -1) });
    sfx('unsnap', { rate: 0.85 });
    game.setLoadout(last.placements, last.equipped);
    setSelected(null);
    setToast(undoStack.length > 1 ? `Undone · ${undoStack.length - 1} more step${undoStack.length > 2 ? 's' : ''} back` : 'Undone');
  };
  const saveCurrent = () => {
    if (!placements.length) {
      setToast('Nothing to save yet: add some parts first');
      return;
    }
    const base = game.build.name || 'Build';
    const taken = new Set(game.saved.map((b) => b.name));
    let name = base;
    for (let k = 2; taken.has(name); k++) name = `${base} ${k}`;
    if (!game.saved.some((b) => sameLoadout(b, placements, game.equipped)) && !game.saveBuild(name)) {
      setToast(`Saved builds are full (${MAX_SAVED}). Remove one below first.`);
      return;
    }
    sfx('star', { gap: 0 });
    setToast(`Saved "${name}" · load it from Saved builds below`);
  };
  const loadSaved = (i: number) => {
    const b = game.saved[i];
    if (!b) return;
    remember();
    sfx('snap', { gap: 0 });
    // Only parts this bug can have: anything your other bugs are using stays on them.
    const { kept, dropped } = fitToParts(b.placements, availableFor(game.inventory, game.bugs, game.active));
    game.setLoadout(kept, b.equipped.filter((m) => game.moves.includes(m)));
    setSelected(null);
    setConfirmSaved(null);
    setToast(dropped ? `Loaded "${b.name}" minus ${dropped} part${dropped > 1 ? 's' : ''} your other bugs are using` : `Loaded "${b.name}" · ↶ to go back`);
  };
  const used = usage(placements);
  /** Parts this bug may use: what you own minus what your other bugs use. */
  const avail = availableFor(game.inventory, game.bugs, game.active);
  const short = shortParts(game.inventory, game.bugs, game.active);
  const holder = (id: string) => game.bugs.find((b, i) => i !== game.active && b.placements.some((p) => p.partId === id))?.name || 'another bug';
  const stats = computeStats(resolve(placements));
  const errors = validateBuild(placements);
  /** Ready to fight: a valid build with no parts that another bug is using. */
  const blocked = errors.length > 0 || Object.keys(short).length > 0;
  const checks = buildChecks(placements, stats);
  // The power line is redundant while there's no core at all (adding one fixes both).
  const noCore = !checks[2].ok;
  const missing = [
    ...checks.filter((c) => !c.ok && !c.optional && !(noCore && c.short.startsWith('Less power'))),
    // Parts that are also on another bug: one of them has to give it up.
    ...sharedNotes(short, holder).map((text) => ({ label: text, short: text, ok: false })),
  ];
  const tips = checks.filter((c) => !c.ok && c.optional);
  const editorW = Math.min(width, MaxContentWidth);
  const editorH = Math.min(editorW * 1.05, height * 0.44);
  const selPart = selected ? partAt(placements, selected.x, selected.y, selected.z) : undefined;
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

  // Light up the best slots for the selected part (as if it were lifted off the bug).
  useEffect(() => {
    const r = renderer.current;
    if (!r) return;
    if (!selected || !selPart) {
      r.setHints([]);
      return;
    }
    const others = selected.z ? removeAt(placements, selected) : placements.filter((p) => p !== selPart);
    r.setHints(
      rankSlots(others, selPart.partId)
        .slice(0, 3)
        .filter((c) => !sameSlot(c, selected)),
    );
  }, [selected, selPart, placements]);

  // While dragging, tell the renderer which layer a drop on a cell would land in.
  useEffect(() => {
    renderer.current?.setStackTest((cell) => {
      const t = touch.current;
      if (!t?.cell) return 0;
      const moving = partAt(placements, t.cell.x, t.cell.y, t.cell.z);
      const base = partAt(placements, cell.x, cell.y, 0);
      if (!moving || !base || base === moving) return 0;
      return dropLayer(
        placements.filter((p) => p !== moving),
        moving.partId,
        cell.x,
        cell.y,
      ) ?? 0;
    });
  }, [placements]);

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
      cell: cell && partAt(placements, cell.x, cell.y, cell.z) ? cell : null,
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
      const same = t.cell && selected && sameSlot(t.cell, selected);
      setSelected(t.cell && !same ? t.cell : null);
      return;
    }
    renderer.current?.endDrag();
    const from = t.cell!;
    const moving = partAt(placements, from.x, from.y, from.z);
    if (t.last.inside && t.last.cell) {
      const res = movePart(placements, from, t.last.cell);
      if (!res) {
        setToast("Can't drop that there");
        return;
      }
      edit(res.placements);
      setSelected(res.at);
      if (res.at.z && moving) setToast(`${getPart(moving.partId).name} ${res.at.z === 1 ? 'stacked on top' : 'slung underneath'}`);
    } else {
      edit(removeAt(placements, from));
      setSelected(null);
      if (moving) setToast(`${getPart(moving.partId).name} back in the bin`);
    }
  }

  function addPart(id: string) {
    const free = (avail[id] ?? 0) - (used[id] ?? 0);
    const part = getPart(id);
    if (free <= 0) {
      const elsewhere = (game.inventory[id] ?? 0) - Math.max(0, avail[id] ?? 0);
      setToast(elsewhere > 0 ? `No ${part.name} left: ${holder(id)} is using it` : `All your ${part.name} are already on the bug`);
      return;
    }
    const spot = autoPlace(placements, id);
    if (!spot) {
      setToast('No free slot touching the bug');
      return;
    }
    edit([...placements, spot]);
    setSelected({ x: spot.x, y: spot.y, z: spot.z ?? 0 });
    setToast(
      spot.z === 1
        ? `${part.name} stacked on top. Drag it to move it.`
        : spot.z === -1
          ? `${part.name} slung underneath, safe from weapons. Drag it to move it.`
          : `${part.name} attached. Drag it to move it.`,
    );
  }

  function flipSelected() {
    if (!selected) return;
    const res = flipLayer(placements, selected);
    if (!res) {
      setToast('The other side is taken');
      return;
    }
    edit(res.placements);
    setSelected(res.at);
  }

  function rotateSelected() {
    if (!selected) return;
    const next = rotatePart(placements, selected);
    if (!next) return;
    edit(next); // (the selected chip shows the new facing)
  }

  function removeSelected() {
    if (!selected || !selPart) return;
    edit(removeAt(placements, selected));
    setToast(`${getPart(selPart.partId).name} back in the bin`);
    setSelected(null);
  }

  return (
    <View style={styles.root}>
      <View style={[styles.top, { width: editorW }]}>
        {/* Your bugs: tap to switch, + to add, ⧉ to copy, 🗑 to scrap. */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bugTabs}>
          {game.bugs.map((b, i) => {
            const on = i === game.active;
            const ready = bugReady(game.inventory, game.bugs, i);
            const squad = game.squad.includes(i);
            return (
              <Pressable
                key={i}
                onPress={() => {
                  if (on) return;
                  game.selectBug(i);
                  setSelected(null);
                  setConfirmDelete(false);
                  forgetHistory();
                }}
                style={[styles.bugTab, on && styles.bugTabOn]}>
                <View style={[styles.bugDot, { backgroundColor: ready ? Colors.good : Colors.bad }]} />
                <Text style={[styles.bugTabText, on && { color: Colors.bg }]} numberOfLines={1}>
                  {b.name || 'Unnamed'}
                </Text>
                {squad && <Text style={[styles.bugTabTag, on && { color: Colors.bg }]}>SQUAD</Text>}
              </Pressable>
            );
          })}
          {game.bugs.length < MAX_BUGS && (
            <Pressable
              onPress={() => {
                game.addBug();
                forgetHistory();
                setSelected(null);
                setToast('New bug: tap parts in the bin or Auto-build');
              }}
              style={[styles.bugTab, styles.bugTabAdd]}>
              <Text style={[styles.bugTabText, { color: Colors.accent }]}>＋ New bug</Text>
            </Pressable>
          )}
        </ScrollView>
        <View style={styles.nameRow}>
          <TextInput
            value={game.build.name}
            onChangeText={(t) => game.setBugName(t.slice(0, 18))}
            style={[styles.nameInput, { flex: 1 }]}
            placeholder="Name your bug"
            placeholderTextColor={Colors.textDim}
          />
          {game.bugs.length < MAX_BUGS && (
            <Pressable
              accessibilityLabel="Copy this bug"
              onPress={() => {
                // The copy only gets parts you have spare: parts sit on one bug at a time.
                const { dropped } = fitToParts(placements, availableFor(game.inventory, [...game.bugs, { placements: [] }], game.bugs.length));
                game.addBug(game.active);
                forgetHistory();
                setSelected(null);
                setToast(dropped ? `Copied without ${dropped} part${dropped > 1 ? 's' : ''} you don't have spare` : 'Copied. Tweak away!');
              }}
              style={styles.iconBtn}>
              <Text style={styles.iconBtnText}>⧉</Text>
            </Pressable>
          )}
          {game.bugs.length > 1 && (
            <Pressable
              accessibilityLabel="Scrap this bug"
              onPress={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                game.deleteBug(game.active);
                setConfirmDelete(false);
                forgetHistory();
                setSelected(null);
              }}
              style={[styles.iconBtn, confirmDelete && { borderColor: Colors.bad, backgroundColor: '#3A1A1D', paddingHorizontal: 10 }]}>
              <Text style={[styles.iconBtnText, confirmDelete && { color: Colors.bad, fontSize: 13, fontWeight: '800' }]}>
                {confirmDelete ? 'Scrap it?' : '🗑'}
              </Text>
            </Pressable>
          )}
        </View>
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
          <View pointerEvents="box-none" style={styles.editorTools}>
            <Pressable
              accessibilityLabel="Undo"
              disabled={!undoStack.length}
              onPress={undo}
              style={[styles.toolBtn, !undoStack.length && { opacity: 0.35 }]}>
              <Text style={styles.toolBtnText}>↶</Text>
              {undoStack.length > 0 && <Text style={styles.toolBtnLabel}>UNDO</Text>}
            </Pressable>
            <Pressable accessibilityLabel="Save this build" onPress={saveCurrent} style={styles.toolBtn}>
              <Text style={styles.toolBtnText}>💾</Text>
              <Text style={styles.toolBtnLabel}>SAVE</Text>
            </Pressable>
          </View>
          <View pointerEvents="box-none" style={styles.editorOverlay}>
            <View style={styles.views} pointerEvents="box-none">
              {VIEW_BUTTONS.map(([name, label]) => (
                <Pressable key={name} onPress={() => renderer.current?.setView(name)} style={styles.viewBtn}>
                  <Text style={styles.viewBtnText}>{label}</Text>
                </Pressable>
              ))}
            </View>
            {selPart && !dragHint && !toast ? (
              <View style={styles.selChip}>
                <PartCell part={getPart(selPart.partId)} size={34} />
                <View style={{ flexShrink: 1 }}>
                  <Text style={styles.selLabel}>SELECTED</Text>
                  <Text style={styles.selName} numberOfLines={1}>
                    {getPart(selPart.partId).name}
                  </Text>
                </View>
                {facingsFor(getPart(selPart.partId).category).length > 1 && (
                  <Pressable onPress={rotateSelected} style={[styles.selBtn, { borderColor: Colors.accent }]}>
                    <Text style={[styles.selBtnText, { color: Colors.accent }]}>↻ {FACING_NAMES[selPart.r ?? 0]}</Text>
                  </Pressable>
                )}
                <Pressable onPress={removeSelected} style={[styles.selBtn, { borderColor: Colors.bad }]}>
                  <Text style={[styles.selBtnText, { color: Colors.bad }]}>Remove</Text>
                </Pressable>
                <Pressable accessibilityLabel="Deselect" onPress={() => setSelected(null)} style={styles.selBtn}>
                  <Text style={styles.selBtnText}>✕</Text>
                </Pressable>
              </View>
            ) : (
              <Text pointerEvents="none" style={[styles.hint, dragHint === 'remove' && { color: Colors.bad }]}>
                {dragHint === 'remove'
                  ? 'Release to put it back in the bin'
                  : dragHint === 'move'
                    ? 'Release to drop it here (swaps if taken)'
                    : toast ?? 'Tap a part to select it · drag to move · drag empty space to spin'}
              </Text>
            )}
          </View>
        </View>
        {/* Always-visible build status, so what's missing never scrolls away. */}
        {missing.length > 0 ? (
          <View style={[styles.status, styles.statusBad]}>
            <Text style={[styles.statusTitle, { color: Colors.bad }]}>STILL NEEDS</Text>
            <View style={styles.statusItems}>
              {missing.map((c) => (
                <Text key={c.label} style={[styles.statusItem, { color: Colors.text, borderColor: Colors.bad }]}>
                  {c.short}
                </Text>
              ))}
            </View>
          </View>
        ) : (
          <View style={[styles.status, styles.statusGood]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.statusTitle, { color: Colors.good }]}>✓ READY TO FIGHT</Text>
              {tips.length > 0 && <Text style={styles.statusTip}>Tip: {tips.map((c) => c.short.toLowerCase()).join(', ')} would help</Text>}
            </View>
            <Button label="Fight" size="sm" variant="go" onPress={() => router.dismissTo('/campaign')} />
          </View>
        )}
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {selPart && (
          <Panel>
            <PartDetails part={getPart(selPart.partId)} onRemove={removeSelected} />
            {selected && selected.z !== 0 && getPart(selPart.partId).category === 'core' && (
              <View style={{ marginTop: Spacing.sm, gap: 4 }}>
                <Text style={styles.dim}>
                  {selected.z === -1
                    ? 'Slung underneath: weapons can’t reach it while the part above survives, but acid and crash landings hit it first.'
                    : 'On top: easy to see, and easy to hit (especially from above).'}
                </Text>
                <Button label={selected.z === -1 ? 'Move on top' : 'Move underneath'} variant="secondary" onPress={flipSelected} />
              </View>
            )}
          </Panel>
        )}

        <Panel style={{ gap: Spacing.sm }}>
          <Text style={styles.section}>{blocked ? 'YOUR BUG STILL NEEDS' : 'READY TO FIGHT'}</Text>
          <Checklist items={checks} />
          {!selPart && <Text style={styles.dim}>Tap a part on the bug to see what it does and where it goes.</Text>}
        </Panel>

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
            <Text style={styles.stat}>Crit {Math.round((CRIT.base + stats.crit) * 100)}%</Text>
            <Text style={styles.stat}>
              Dodge {Math.round(reflex(stats) * 100)}% · {dodgeCooldown(stats).toFixed(1)}s
            </Text>
            <Text style={styles.stat}>Poise {Math.round(maxPoise(stats))}</Text>
            {Math.abs(stats.thrustBias) > 0.05 && (
              <Text style={[styles.stat, { color: Colors.bad }]}>Pulls {stats.thrustBias > 0 ? 'left' : 'right'}</Text>
            )}
          </View>
        </Panel>

        <Text style={styles.section}>PARTS BIN · TAP A PART TO ATTACH IT</Text>
        {GROUPS.map((group) => {
          const items = owned.filter(([id]) => GUIDE[getPart(id).category].group === group.id);
          if (items.length === 0) return null;
          return (
            <View key={group.id} style={{ gap: Spacing.sm }}>
              <View>
                <Text style={styles.groupTitle}>{group.title}</Text>
                <Text style={styles.dim}>{group.blurb}</Text>
              </View>
              <View style={styles.bin}>
                {items.map(([id, count]) => {
                  const part = getPart(id);
                  const free = Math.max(0, (avail[id] ?? 0) - (used[id] ?? 0));
                  const onOthers = count - Math.max(0, avail[id] ?? 0);
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
                      <Text style={styles.binType}>{GUIDE[part.category].label}</Text>
                      <Text style={styles.binName} numberOfLines={2}>
                        {part.name}
                      </Text>
                      <Text style={[styles.binRarity, { color: RARITY_COLOR[part.rarity] }]}>{part.rarity.toUpperCase()}</Text>
                      {onOthers > 0 && <Text style={styles.binOther}>{onOthers} on other bugs</Text>}
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        })}

        <Text style={styles.section}>
          SIGNATURE MOVES · {game.equipped.length}/{MOVE_SLOTS} EQUIPPED
        </Text>
        <View style={{ gap: Spacing.sm }}>
          {game.moves.map((id) => {
            const m = getMove(id);
            const on = game.equipped.includes(id);
            const hasParts = meetsRequirement(m, placements.map((p) => getPart(p.partId)));
            return (
              <Pressable
                key={id}
                onPress={() => toggleMove(id)}
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
                  {on && !hasParts && <Text style={styles.error}>⚠ Your build needs {m.requires.label} for this move to fire.</Text>}
                </View>
              </Pressable>
            );
          })}
        </View>

        <View style={{ gap: Spacing.sm }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <Text style={styles.section}>SAVED BUILDS</Text>
            <Text style={styles.dim}>
              {game.saved.length}/{MAX_SAVED}
            </Text>
          </View>
          {game.saved.length === 0 ? (
            <Text style={styles.dim}>{"Tap 💾 on the editor to save this bug's parts and moves. Load a saved build onto any bug later."}</Text>
          ) : (
            game.saved.map((b, i) => {
              const ok = validateBuild(b.placements).length === 0;
              const current = sameLoadout(b, placements, game.equipped);
              return (
                <View key={`${b.name}-${i}`} style={[styles.savedRow, current && { borderColor: Colors.accent }]}>
                  <Pressable onPress={() => loadSaved(i)} style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.savedName} numberOfLines={1}>
                      {b.name}
                      {current ? <Text style={{ color: Colors.accent }}> · on this bug</Text> : null}
                    </Text>
                    <Text style={styles.dim} numberOfLines={1}>
                      {b.placements.length} parts · {b.equipped.map((m) => getMove(m).name).join(', ') || 'no moves'}
                      {ok ? '' : ' · unfinished'}
                    </Text>
                  </Pressable>
                  {!current && <Button label="Load" size="sm" variant="secondary" onPress={() => loadSaved(i)} />}
                  <Pressable
                    accessibilityLabel="Remove saved build"
                    onPress={() => {
                      if (confirmSaved !== i) {
                        setConfirmSaved(i);
                        return;
                      }
                      game.deleteSaved(i);
                      setConfirmSaved(null);
                    }}
                    style={[styles.iconBtn, confirmSaved === i && { borderColor: Colors.bad, backgroundColor: '#3A1A1D', paddingHorizontal: 10 }]}>
                    <Text style={[styles.iconBtnText, confirmSaved === i && { color: Colors.bad, fontSize: 13, fontWeight: '800' }]}>
                      {confirmSaved === i ? 'Remove?' : '✕'}
                    </Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </View>

        <View style={styles.actions}>
          <Button label="Clear" variant="secondary" onPress={() => edit([])} style={{ flex: 0.8, paddingHorizontal: 4 }} />
          <Button
            label="Auto-build"
            variant="secondary"
            onPress={() => {
              // Only from parts your other bugs aren't using.
              edit(autoBuild(Object.fromEntries(Object.entries(avail).map(([id, n]) => [id, Math.max(0, n)]))));
              setSelected(null);
              setToast('Built from your best parts. Drag things around to tweak it.');
            }}
            style={{ flex: 1.3, paddingHorizontal: 4 }}
          />
          <Button label="Campaign" disabled={blocked} onPress={() => router.dismissTo('/campaign')} style={{ flex: 1.3, paddingHorizontal: 4 }} />
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
  bugTabs: { gap: 6, paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm },
  bugTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.panel,
    borderColor: Colors.border,
    borderWidth: 1.5,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    maxWidth: 170,
  },
  bugTabOn: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  bugTabAdd: { borderStyle: 'dashed', borderColor: Colors.accent, backgroundColor: 'transparent' },
  bugTabText: { color: Colors.text, fontFamily: Fonts.display, fontSize: 14 },
  bugTabTag: { color: '#58C7FF', fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  bugDot: { width: 8, height: 8, borderRadius: 4 },
  nameRow: { flexDirection: 'row', alignItems: 'center', paddingRight: Spacing.lg, gap: 6 },
  iconBtn: {
    minWidth: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.panel,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  iconBtnText: { color: Colors.text, fontSize: 17 },
  nameInput: {
    color: Colors.text,
    fontFamily: Fonts.display,
    fontSize: 26,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  selChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: 'rgba(12,14,18,0.9)',
    borderColor: Colors.accent,
    borderWidth: 1.5,
    borderRadius: 16,
    paddingVertical: 5,
    paddingHorizontal: 8,
    marginHorizontal: Spacing.md,
  },
  selLabel: { color: Colors.accent, fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  selName: { color: Colors.text, fontFamily: Fonts.display, fontSize: 16 },
  selBtn: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  selBtnText: { color: Colors.text, fontSize: 12, fontWeight: '800' },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.xs,
    paddingVertical: 7,
    paddingHorizontal: Spacing.md,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  statusBad: { borderColor: Colors.bad, backgroundColor: '#2A1719', flexWrap: 'wrap' },
  statusGood: { borderColor: Colors.good, backgroundColor: '#13261E' },
  statusTitle: { fontSize: 11, fontWeight: '900', letterSpacing: 1.4 },
  statusItems: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, flexShrink: 1 },
  statusItem: { fontSize: 12, fontWeight: '800', borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  statusTip: { color: Colors.textDim, fontSize: 11, marginTop: 1 },
  editorTools: { position: 'absolute', left: Spacing.sm, top: 48, gap: 8, zIndex: 3 },
  toolBtn: {
    width: 48,
    paddingVertical: 5,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: 'rgba(15,18,24,0.85)',
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  toolBtnText: { color: Colors.text, fontSize: 20, lineHeight: 24 },
  toolBtnLabel: { color: Colors.textDim, fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  binOther: { color: Colors.textDim, fontSize: 10, fontWeight: '700' },
  savedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.panel,
  },
  savedName: { color: Colors.text, fontSize: 15, fontWeight: '800' },
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
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  stat: {
    color: Colors.text,
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    backgroundColor: Colors.panelHi,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
  },
  error: { color: Colors.bad, fontSize: 13 },
  partName: { fontSize: 16, fontWeight: '800' },
  dim: { color: Colors.textDim, fontSize: 13, fontWeight: '400' },
  statsLine: { color: Colors.text, fontSize: 12, marginTop: 2 },
  section: { color: Colors.accent, fontSize: 11, fontWeight: '900', letterSpacing: 1.6 },
  bin: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  binItem: {
    alignItems: 'center',
    gap: 3,
    paddingVertical: Spacing.sm,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    borderTopColor: Colors.panelEdge,
    backgroundColor: Colors.panel,
  },
  binSelected: { borderColor: Colors.accent, backgroundColor: Colors.panelHi },
  binName: { color: Colors.textDim, fontSize: 10, textAlign: 'center', minHeight: 26, paddingHorizontal: 2 },
  binRarity: { fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  binType: { color: Colors.text, fontSize: 11, fontWeight: '800' },
  groupTitle: { color: Colors.text, fontFamily: Fonts.display, fontSize: 18, letterSpacing: 0.4 },
  guideLine: { color: Colors.text, fontSize: 13, lineHeight: 18 },
  guideKey: { color: Colors.accent, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  checklist: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  check: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  checkText: { fontSize: 12, fontWeight: '700' },
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
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.panel,
  },
  moveDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, marginTop: 2 },
});
