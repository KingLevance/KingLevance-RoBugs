import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Modal,
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { sfx, useMusic } from '@/audio/audio';
import { FILTERS, PartsTab, type BinDrag, type FilterId } from '@/components/garage/parts-tab';
import { buildChecks, Inspector, MovesTab, SavedTab, spareMoves, StatsTab, type InspectorAction } from '@/components/garage/panels';
import { PartCell } from '@/components/part-cell';
import { Button } from '@/components/ui';
import { Colors, Fonts, MaxContentWidth, Spacing } from '@/constants/theme';
import { availableFor, bugReady, computeStats, FACING_NAMES, facingsFor, fitToParts, MAX_MASS, resolve, shortParts, usage, type Placement } from '@/game/build';
import {
  autoBuild,
  candidateSlots,
  dropLayer,
  flipLayer,
  movePart,
  partAt,
  placeNew,
  removeAt,
  rotatePart,
  sameSlot,
  slotOnCell,
  type Candidate,
  type Slot,
} from '@/game/editor';
import { movesOf } from '@/game/moves';
import { getPart } from '@/game/parts';
import { GarageRenderer, type Cell, type ViewName } from '@/render/garage-scene';
import { MAX_BUGS, MAX_SAVED, useGame } from '@/state/game-store';

const DRAG_SLOP = 8;
const VIEWS: [ViewName, string][] = [
  ['angle', 'Angle'],
  ['top', 'Top'],
  ['side', 'Side'],
  ['front', 'Front'],
];
const UNDO_STEPS = 40;
type Tab = 'parts' | 'moves' | 'stats' | 'saved';

/** A part in your hand: new from the bin, or lifted off the bug (`from`). */
type Held = { partId: string; from?: Slot };

/** What the current finger on the 3D editor is doing. */
type Touch = {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  mode: 'orbit' | 'part' | 'held';
  /** Part under the finger at touch start ('part' mode). */
  cell: Slot | null;
  dragging: boolean;
  last: { cell: Cell | null; inside: boolean };
  /** Where the held part would go now ('held' mode). */
  target: Candidate | null;
};

const loadoutKey = (ps: Placement[]) =>
  ps
    .map((p) => `${p.partId}@${p.x},${p.y},${p.z ?? 0},${p.r ?? 0}`)
    .sort()
    .join('|');

export default function Garage() {
  const game = useGame();
  useMusic('garage');
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [selected, setSelected] = useState<Slot | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const [tab, setTab] = useState<Tab>('parts');
  const [filter, setFilter] = useState<FilterId>('all');
  const [toast, setToast] = useState<string | null>(null);
  const [view, setView] = useState(0);
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmSaved, setConfirmSaved] = useState<number | null>(null);
  /** Undo/redo for the bug being edited (cleared when you switch, add or scrap bugs). */
  const [history, setHistory] = useState<{ bug: number; undo: Placement[][]; redo: Placement[][] }>({ bug: -1, undo: [], redo: [] });
  const [dragHint, setDragHint] = useState<'move' | 'remove' | null>(null);
  /** A part being dragged out of the bin (follows the finger). */
  const [binDrag, setBinDrag] = useState<{ partId: string; x: number; y: number; over: boolean } | null>(null);
  const renderer = useRef<GarageRenderer | null>(null);
  const raf = useRef(0);
  const box = useRef({ x: 0, y: 0, w: 1, h: 1 });
  const viewRef = useRef<HostInstance>(null);
  const touch = useRef<Touch | null>(null);
  const binTarget = useRef<Candidate | null>(null);
  const binId = useRef<string | null>(null);

  const placements = game.build.placements;
  const mine = history.bug === game.active ? history : { bug: game.active, undo: [], redo: [] };
  const forgetHistory = () => setHistory({ bug: -1, undo: [], redo: [] });

  /** Apply an edit to the build with a click: snap on, pop off, or turn. */
  const edit = (next: Placement[]) => {
    if (loadoutKey(next) === loadoutKey(placements)) return;
    setHistory({ bug: game.active, undo: [...mine.undo, placements].slice(-UNDO_STEPS), redo: [] });
    sfx(next.length < placements.length ? 'unsnap' : 'snap', { rate: next.length === placements.length ? 1.25 : 1 });
    game.setPlacements(next);
  };
  const undo = () => {
    const last = mine.undo[mine.undo.length - 1];
    if (!last) return;
    setHistory({ bug: game.active, undo: mine.undo.slice(0, -1), redo: [...mine.redo, placements] });
    sfx('unsnap', { rate: 0.85 });
    game.setLoadout(last);
    setSelected(null);
    setHeld(null);
  };
  const redo = () => {
    const next = mine.redo[mine.redo.length - 1];
    if (!next) return;
    setHistory({ bug: game.active, undo: [...mine.undo, placements], redo: mine.redo.slice(0, -1) });
    sfx('snap', { rate: 1.1 });
    game.setLoadout(next);
    setSelected(null);
    setHeld(null);
  };

  const used = usage(placements);
  /** Parts this bug may use: what you own minus what your other bugs use. */
  const avail = availableFor(game.inventory, game.bugs, game.active);
  const free = (id: string) => Math.max(0, (avail[id] ?? 0) - (used[id] ?? 0));
  const onOthers = (id: string) => (game.inventory[id] ?? 0) - Math.max(0, avail[id] ?? 0);
  const short = shortParts(game.inventory, game.bugs, game.active);
  const holder = (id: string) => game.bugs.find((b, i) => i !== game.active && b.placements.some((p) => p.partId === id))?.name || 'another bug';
  const sharedWith = [...new Set(Object.keys(short).map(holder))];
  const stats = computeStats(resolve(placements));
  const checks = buildChecks(placements, stats);
  // The power line is redundant while there's no core at all (adding one fixes both).
  const noCore = !checks[2].ok;
  const missing = checks.filter((c) => !c.ok && !c.optional && !(noCore && c.short.startsWith('Less power')));
  const tips = checks.filter((c) => !c.ok && c.optional);
  const needs = [...new Set(missing.map((c) => c.filter).filter((f): f is FilterId => !!f && FILTERS.some((x) => x.id === f)))];
  const bugMoves = movesOf(placements.map((p) => getPart(p.partId)));

  const editorW = Math.min(width, MaxContentWidth);
  const editorH = Math.round(Math.max(230, Math.min(editorW * 0.95, (height - insets.top) * 0.43)));
  const selPart = selected ? partAt(placements, selected.x, selected.y, selected.z) : undefined;

  /** Where the held part can go. Moving a part: the build without it. */
  const heldBase = held?.from ? removeAt(placements, held.from) : placements;
  const cands: Candidate[] = held
    ? candidateSlots(heldBase, held.partId).filter((c) => !held.from || !(c.x === held.from.x && c.y === held.from.y && c.z === held.from.z))
        .map((c, i) => (i === 0 ? { ...c, tier: 0 as const } : c))
    : [];
  const heldPartId = held?.partId ?? null;

  // --- renderer sync
  useEffect(() => {
    renderer.current?.setPlacements(placements);
  }, [placements]);
  useEffect(() => {
    renderer.current?.setSelected(selPart && !held ? selected : null);
  }, [selected, selPart, held]);
  useEffect(() => {
    const r = renderer.current;
    if (!r) return;
    r.setHints(held ? cands : []);
    r.setLifted(held?.from ?? null);
    r.setGhost(heldPartId, held ? (cands[0] ?? null) : null);
    // (cands is derived from held + placements)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held, placements]);
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
    const t = setTimeout(() => setToast(null), 2300);
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
  const toNorm = (pageX: number, pageY: number) => ({ nx: (pageX - box.current.x) / box.current.w, ny: (pageY - box.current.y) / box.current.h });
  const insideEditor = (pageX: number, pageY: number) => {
    const { nx, ny } = toNorm(pageX, pageY);
    return nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;
  };

  /** The slot under a screen point for the held part (null if it can't go there). */
  function heldSlotAt(nx: number, ny: number, list: Candidate[], base: Placement[]): Candidate | null {
    const hit = renderer.current?.pick(nx, ny).cell;
    if (!hit) return null;
    return slotOnCell(list, base, hit, hit.z);
  }

  // --- placing
  function pickUp(partId: string) {
    if (free(partId) <= 0) {
      const part = getPart(partId);
      setToast(onOthers(partId) > 0 ? `No ${part.name} spare: ${holder(partId)} is using it` : `All your ${part.name} are on the bug`);
      return;
    }
    if (held && !held.from && held.partId === partId) {
      setHeld(null);
      return;
    }
    sfx('tap', { rate: 1.2 });
    setSelected(null);
    setHeld({ partId });
    if (!candidateSlots(placements, partId).length) setToast('No free spot touching the bug');
  }

  function placeAt(slot: Candidate | null, h: Held | null = held) {
    if (!h) return;
    if (!slot) {
      setToast('Pick a glowing spot');
      return;
    }
    const part = getPart(h.partId);
    if (h.from) {
      const res = movePart(placements, h.from, slot);
      if (!res) {
        setToast("Can't move it there");
        return;
      }
      edit(res.placements);
      setHeld(null);
      setSelected(res.at);
      renderer.current?.burst(res.at);
      return;
    }
    const next = placeNew(placements, h.partId, slot);
    if (!next) {
      setToast("Can't put it there");
      return;
    }
    edit(next);
    renderer.current?.burst(slot);
    setHeld(null);
    setSelected({ x: slot.x, y: slot.y, z: slot.z });
    setToast(
      slot.z === 1
        ? `${part.name} stacked on top`
        : slot.z === -1
          ? `${part.name} slung underneath, safe from weapons`
          : `${part.name} attached`,
    );
  }

  // --- bin drag (press-and-hold a card, drag it onto the bug)
  const drag: BinDrag = {
    start: (partId, x, y) => {
      measure();
      // (Don't switch the drawer to the inspector mid-drag: the card holding the touch must stay mounted.)
      setSelected(null);
      setHeld(null);
      binTarget.current = null;
      const list = candidateSlots(placements, partId);
      renderer.current?.setHints(list);
      renderer.current?.setGhost(partId, list[0] ?? null);
      binId.current = partId;
      setBinDrag({ partId, x, y, over: false });
    },
    move: (x, y) => {
      const over = insideEditor(x, y);
      setBinDrag((d) => (d ? { ...d, x, y, over } : d));
      const id = binId.current;
      if (!id) return;
      const list = candidateSlots(placements, id);
      const { nx, ny } = toNorm(x, y);
      const slot = over ? heldSlotAt(nx, ny, list, placements) : null;
      binTarget.current = slot;
      const r = renderer.current;
      if (!r) return;
      if (over) {
        const hit = r.pick(nx, ny).cell;
        r.setGhost(id, slot ?? (hit ? { ...hit } : null), !!slot);
      } else {
        r.setGhost(id, list[0] ?? null);
      }
    },
    end: (x, y) => {
      const id = binId.current;
      binId.current = null;
      setBinDrag(null);
      if (!id) return;
      const slot = insideEditor(x, y) ? binTarget.current : null;
      if (slot) placeAt(slot, { partId: id });
      else {
        // Missed (or dropped back on the drawer): keep holding it, so a tap on a spot places it.
        if (insideEditor(x, y)) setToast('Drop it on a glowing spot');
        setHeld({ partId: id });
        renderer.current?.setGhost(id, candidateSlots(placements, id)[0] ?? null);
      }
    },
    cancel: () => {
      binId.current = null;
      setBinDrag(null);
      renderer.current?.setHints([]);
      renderer.current?.setGhost(null);
    },
  };

  // --- editor touches
  function onGrant(e: GestureResponderEvent) {
    measure();
    const { pageX, pageY } = e.nativeEvent;
    const { nx, ny } = toNorm(pageX, pageY);
    const hit = renderer.current?.pick(nx, ny).cell ?? null;
    let mode: Touch['mode'] = 'orbit';
    let target: Candidate | null = null;
    if (held) {
      target = hit ? slotOnCell(cands, heldBase, hit, hit.z) : null;
      if (target) mode = 'held';
    }
    const onPart = hit && partAt(placements, hit.x, hit.y, hit.z) ? hit : null;
    if (mode === 'orbit' && onPart && !held) mode = 'part';
    touch.current = { startX: pageX, startY: pageY, lastX: pageX, lastY: pageY, mode, cell: onPart, dragging: false, last: { cell: hit, inside: !!hit }, target };
    if (mode === 'held') renderer.current?.setGhost(held!.partId, target, true);
  }

  function onMove(e: GestureResponderEvent) {
    const t = touch.current;
    const r = renderer.current;
    if (!t || !r) return;
    const { pageX, pageY } = e.nativeEvent;
    const far = Math.hypot(pageX - t.startX, pageY - t.startY) >= DRAG_SLOP;
    if (t.mode === 'orbit') {
      r.orbit(pageX - t.lastX, pageY - t.lastY);
      t.lastX = pageX;
      t.lastY = pageY;
      if (far) t.dragging = true;
      return;
    }
    const { nx, ny } = toNorm(pageX, pageY);
    if (t.mode === 'held') {
      if (far) t.dragging = true;
      t.target = heldSlotAt(nx, ny, cands, heldBase);
      const hit = r.pick(nx, ny).cell;
      r.setGhost(held!.partId, t.target ?? (hit ? { ...hit } : null), !!t.target);
      return;
    }
    // Dragging a part already on the bug.
    if (!t.dragging) {
      if (!far) return;
      t.dragging = r.startDrag(t.cell!);
      setSelected(t.cell);
      const moving = partAt(placements, t.cell!.x, t.cell!.y, t.cell!.z);
      if (moving) r.setHints(candidateSlots(removeAt(placements, t.cell!), moving.partId).map((c) => ({ ...c, tier: c.tier === 0 ? 1 : c.tier })));
    }
    t.last = r.dragTo(nx, ny);
    setDragHint(t.last.inside ? 'move' : 'remove');
  }

  function onRelease() {
    const t = touch.current;
    touch.current = null;
    setDragHint(null);
    if (!t) return;
    if (t.mode === 'held') {
      if (t.target) placeAt(t.target);
      else {
        setToast('Pick a glowing spot');
        renderer.current?.setGhost(heldPartId, cands[0] ?? null);
      }
      return;
    }
    if (t.mode === 'orbit') {
      if (!t.dragging) {
        // Tap on empty space: let go of whatever's selected.
        if (selected) setSelected(null);
        else if (held) setToast('Tap a glowing spot to place it, or ✕ to put it back');
      }
      return;
    }
    if (!t.dragging) {
      const same = t.cell && selected && sameSlot(t.cell, selected);
      setSelected(t.cell && !same ? t.cell : null);
      if (t.cell && !same) sfx('tap');
      return;
    }
    const r = renderer.current;
    r?.endDrag();
    r?.setHints([]);
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
      if (!sameSlot(res.at, from)) r?.burst(res.at);
      if (res.at.z && moving) setToast(`${getPart(moving.partId).name} ${res.at.z === 1 ? 'stacked on top' : 'slung underneath'}`);
    } else {
      edit(removeAt(placements, from));
      setSelected(null);
      if (moving) setToast(`${getPart(moving.partId).name} back in the bin`);
    }
  }

  // --- selected part actions
  function removeSelected() {
    if (!selected || !selPart) return;
    edit(removeAt(placements, selected));
    setToast(`${getPart(selPart.partId).name} back in the bin`);
    setSelected(null);
  }
  function rotateSelected() {
    if (!selected) return;
    const next = rotatePart(placements, selected);
    if (next) edit(next);
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
  function autoBuildNow() {
    // Only from parts your other bugs aren't using.
    edit(autoBuild(Object.fromEntries(Object.entries(avail).map(([id, n]) => [id, Math.max(0, n)]))));
    setSelected(null);
    setHeld(null);
    setToast('Built from your best spare parts. Tweak away!');
  }

  // --- saved builds
  const saveCurrent = () => {
    if (!placements.length) {
      setToast('Nothing to save yet: add some parts first');
      return;
    }
    const base = game.build.name || 'Build';
    const taken = new Set(game.saved.map((b) => b.name));
    let name = base;
    for (let k = 2; taken.has(name); k++) name = `${base} ${k}`;
    if (game.saved.some((b) => loadoutKey(b.placements) === loadoutKey(placements))) {
      setToast('This build is already saved');
      return;
    }
    if (!game.saveBuild(name)) {
      setToast(`Saved builds are full (${MAX_SAVED}). Delete one first.`);
      return;
    }
    sfx('star', { gap: 0 });
    setToast(`Saved "${name}"`);
  };
  const loadSaved = (i: number) => {
    const b = game.saved[i];
    if (!b) return;
    setHistory({ bug: game.active, undo: [...mine.undo, placements].slice(-UNDO_STEPS), redo: [] });
    sfx('snap', { gap: 0 });
    // Only parts this bug can have: anything your other bugs are using stays on them.
    const { kept, dropped } = fitToParts(b.placements, availableFor(game.inventory, game.bugs, game.active));
    game.setLoadout(kept);
    setSelected(null);
    setHeld(null);
    setConfirmSaved(null);
    setToast(dropped ? `Loaded "${b.name}" minus ${dropped} part${dropped > 1 ? 's' : ''} your other bugs are using` : `Loaded "${b.name}" · ↶ to go back`);
  };

  const switchBug = (i: number) => {
    game.selectBug(i);
    setSelected(null);
    setHeld(null);
    setConfirmDelete(false);
    forgetHistory();
  };

  // --- drawer
  let drawer: ReactNode;
  if (held) {
    const part = getPart(held.partId);
    const best = cands[0] ?? null;
    drawer = (
      <Inspector
        part={part}
        title={held.from ? 'MOVING' : `PLACING · ${free(held.partId)} SPARE`}
        hint={cands.length ? 'Tap a glowing spot on the bug (the brightest is the best fit), or drag the ghost part around.' : 'No free spot touching the bug.'}
        actions={[
          ...(best ? [{ label: '✓ Best spot', variant: 'go' as const, onPress: () => placeAt(best) }] : []),
          { label: 'Cancel', onPress: () => setHeld(null) },
        ]}
        onClose={() => setHeld(null)}
      />
    );
  } else if (selected && selPart) {
    const part = getPart(selPart.partId);
    const facings = facingsFor(part.category);
    const actions: InspectorAction[] = [];
    if (facings.length > 1) actions.push({ label: `↻ Faces ${FACING_NAMES[selPart.r ?? 0]}`, onPress: rotateSelected });
    if (selected.z !== 0 && part.category === 'core') actions.push({ label: selected.z === -1 ? '⤒ Put on top' : '⤓ Sling under', onPress: flipSelected });
    actions.push({ label: '✥ Move', onPress: () => setHeld({ partId: selPart.partId, from: selected }) });
    if (free(part.id) > 0) actions.push({ label: '＋ Add another', onPress: () => pickUp(part.id) });
    actions.push({ label: 'Remove', variant: 'danger', onPress: removeSelected });
    drawer = (
      <Inspector
        part={part}
        title={selected.z === 1 ? 'ON YOUR BUG · STACKED ON TOP' : selected.z === -1 ? 'ON YOUR BUG · SLUNG UNDERNEATH' : 'ON YOUR BUG'}
        actions={actions}
        onClose={() => setSelected(null)}
      />
    );
  } else if (tab === 'parts') {
    drawer = (
      <PartsTab
        inventory={game.inventory}
        free={free}
        onOthers={onOthers}
        filter={filter}
        setFilter={setFilter}
        needs={needs}
        heldId={heldPartId}
        width={editorW}
        onPick={pickUp}
        drag={drag}
        scrollEnabled={!binDrag}
        onAutoBuild={autoBuildNow}
      />
    );
  } else if (tab === 'moves') {
    drawer = <MovesTab placements={placements} spareMoveParts={spareMoves(placements, free)} onPick={pickUp} />;
  } else if (tab === 'stats') {
    drawer = <StatsTab stats={stats} checks={checks} />;
  } else {
    drawer = (
      <SavedTab
        saved={game.saved}
        max={MAX_SAVED}
        isCurrent={(b) => loadoutKey(b.placements) === loadoutKey(placements)}
        confirm={confirmSaved}
        onSave={saveCurrent}
        onLoad={loadSaved}
        onDelete={(i) => {
          if (confirmSaved !== i) {
            setConfirmSaved(i);
            return;
          }
          game.deleteSaved(i);
          setConfirmSaved(null);
        }}
      />
    );
  }

  const hint =
    dragHint === 'remove'
      ? 'Let go to put it back in the bin'
      : dragHint === 'move'
        ? 'Let go to drop it here (swaps if taken)'
        : (toast ??
          (held
            ? 'Tap a glowing spot to place it'
            : placements.length === 0
              ? 'Empty bug: tap a part below to add it'
              : selected
                ? 'Drag it to move · drag it off the grid to remove'
                : 'Tap a part · drag to move · drag empty space to spin'));

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={[styles.column, { width: editorW }]}>
        {/* Header: back, your bugs (tap to switch, tap the current one for options), menu. */}
        <View style={styles.header}>
          <Pressable accessibilityLabel="Back" onPress={() => router.back()} style={styles.hBtn}>
            <Text style={styles.hBtnText}>‹</Text>
          </Pressable>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bugTabs} style={{ flex: 1 }}>
            {game.bugs.map((b, i) => {
              const on = i === game.active;
              const ready = bugReady(game.inventory, game.bugs, i, game.active);
              return (
                <Pressable key={i} onPress={() => (on ? setMenu(true) : switchBug(i))} style={[styles.bugTab, on && styles.bugTabOn]}>
                  <View style={[styles.bugDot, { backgroundColor: ready ? Colors.good : Colors.bad }]} />
                  <Text style={[styles.bugTabText, on && { color: Colors.bg }]} numberOfLines={1}>
                    {b.name || 'Unnamed'}
                  </Text>
                  {game.squad.includes(i) && <Text style={[styles.bugTag, on && { color: Colors.bg }]}>SQUAD</Text>}
                  {on && <Text style={[styles.bugTabText, { color: Colors.bg, fontSize: 11 }]}>▾</Text>}
                </Pressable>
              );
            })}
            {game.bugs.length < MAX_BUGS && (
              <Pressable
                onPress={() => {
                  game.addBug();
                  forgetHistory();
                  setSelected(null);
                  setHeld(null);
                  setToast('New bug: tap parts below, or Auto-build');
                }}
                style={[styles.bugTab, styles.bugTabAdd]}>
                <Text style={[styles.bugTabText, { color: Colors.accent }]}>＋</Text>
              </Pressable>
            )}
          </ScrollView>
          <Pressable accessibilityLabel="Bug options" onPress={() => setMenu(true)} style={styles.hBtn}>
            <Text style={[styles.hBtnText, { fontSize: 20 }]}>⋯</Text>
          </Pressable>
        </View>

        {/* The 3D editor. */}
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
          <View pointerEvents="box-none" style={styles.toolsLeft}>
            <ToolBtn icon="↶" label="UNDO" disabled={!mine.undo.length} onPress={undo} />
            <ToolBtn icon="↷" label="REDO" disabled={!mine.redo.length} onPress={redo} />
          </View>
          <View pointerEvents="box-none" style={styles.toolsRight}>
            <Pressable
              onPress={() => {
                const v = (view + 1) % VIEWS.length;
                setView(v);
                renderer.current?.setView(VIEWS[v][0]);
              }}
              style={styles.viewBtn}>
              <Text style={styles.viewBtnText}>👁 {VIEWS[view][1]}</Text>
            </Pressable>
            <MiniMeter label="⚡" value={stats.powerDraw} max={Math.max(1, stats.powerSupply)} bad={stats.powerDraw > stats.powerSupply} />
            <MiniMeter label="⚖" value={stats.mass} max={MAX_MASS} bad={stats.mass > MAX_MASS} />
          </View>
          <View pointerEvents="none" style={styles.hintWrap}>
            <Text style={[styles.hint, dragHint === 'remove' && { color: Colors.bad }, held && !toast && { color: Colors.good }]}>{hint}</Text>
          </View>
          {placements.length === 0 && !held && (
            <View pointerEvents="box-none" style={styles.emptyWrap}>
              <Button label="⚡ Auto-build" onPress={autoBuildNow} />
            </View>
          )}
        </View>

        {/* Always-visible build status, so what's missing never scrolls away. */}
        {missing.length > 0 ? (
          <View style={[styles.status, styles.statusBad]}>
            <Text style={[styles.statusTitle, { color: Colors.bad }]}>NEEDS</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.statusItems}>
              {missing.map((c) => (
                <Pressable
                  key={c.label}
                  onPress={() => {
                    if (c.filter && FILTERS.some((f) => f.id === c.filter)) {
                      setFilter(c.filter as FilterId);
                      setTab('parts');
                      setSelected(null);
                      setHeld(null);
                    }
                  }}>
                  <Text style={styles.statusItem}>{c.short}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : (
          <View style={[styles.status, styles.statusGood]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.statusTitle, { color: Colors.good }]}>✓ READY · {bugMoves.length} MOVE{bugMoves.length === 1 ? '' : 'S'}</Text>
              {sharedWith.length > 0 ? (
                <Text style={[styles.statusTip, { color: '#FFD23F' }]} numberOfLines={2}>
                  Shares parts with {sharedWith.join(' and ')}, so {sharedWith.length > 1 ? 'they' : 'it'} {"can't"} fight alongside this bug.
                </Text>
              ) : (
                tips.length > 0 && (
                  <Text style={styles.statusTip} numberOfLines={1}>
                    Tip: {tips.map((c) => c.short.toLowerCase()).join(', ')} would help
                  </Text>
                )
              )}
            </View>
            <Button label="Fight ▸" size="sm" variant="go" onPress={() => router.dismissTo('/campaign')} />
          </View>
        )}

        {/* Drawer tabs. */}
        <View style={styles.tabs}>
          {(
            [
              ['parts', 'Parts'],
              ['moves', `Moves ${bugMoves.length}`],
              ['stats', 'Stats'],
              ['saved', 'Saved'],
            ] as [Tab, string][]
          ).map(([id, label]) => {
            const on = tab === id && !held && !selPart;
            return (
              <Pressable
                key={id}
                onPress={() => {
                  sfx('tap');
                  setTab(id);
                  setSelected(null);
                  setHeld(null);
                }}
                style={[styles.tab, on && styles.tabOn]}>
                <Text style={[styles.tabText, on && { color: Colors.accent }]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <View style={[styles.drawer, { width: editorW, paddingBottom: insets.bottom }]}>{drawer}</View>

      {/* A part being dragged out of the bin. */}
      {binDrag && !binDrag.over && (
        <View pointerEvents="none" style={[styles.floating, { left: binDrag.x - 34, top: binDrag.y - 80 }]}>
          <PartCell part={getPart(binDrag.partId)} size={68} />
        </View>
      )}

      {/* Bug options. */}
      <Modal visible={menu} transparent animationType="fade" onRequestClose={() => setMenu(false)}>
        <Pressable style={styles.scrim} onPress={() => setMenu(false)}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + Spacing.lg }]} onPress={() => {}}>
            <Text style={styles.sheetLabel}>BUG NAME</Text>
            <TextInput
              value={game.build.name}
              onChangeText={(t) => game.setBugName(t.slice(0, 18))}
              style={styles.nameInput}
              placeholder="Name your bug"
              placeholderTextColor={Colors.textDim}
            />
            <View style={styles.sheetGrid}>
              <Button
                label="⚡ Auto-build"
                variant="secondary"
                onPress={() => {
                  autoBuildNow();
                  setMenu(false);
                }}
                style={styles.sheetBtn}
              />
              <Button
                label="💾 Save build"
                variant="secondary"
                onPress={() => {
                  saveCurrent();
                  setMenu(false);
                }}
                style={styles.sheetBtn}
              />
              {game.bugs.length < MAX_BUGS && (
                <Button
                  label="⧉ Copy bug"
                  variant="secondary"
                  onPress={() => {
                    const { dropped } = fitToParts(placements, availableFor(game.inventory, [...game.bugs, { placements: [] }], game.bugs.length));
                    game.addBug(game.active);
                    forgetHistory();
                    setSelected(null);
                    setMenu(false);
                    setToast(dropped ? `Copied without ${dropped} part${dropped > 1 ? 's' : ''} you don't have spare` : 'Copied. Tweak away!');
                  }}
                  style={styles.sheetBtn}
                />
              )}
              <Button
                label="Clear parts"
                variant="secondary"
                onPress={() => {
                  edit([]);
                  setSelected(null);
                  setMenu(false);
                }}
                style={styles.sheetBtn}
              />
              {game.bugs.length > 1 && (
                <Button
                  label={confirmDelete ? 'Tap again to scrap' : '🗑 Scrap bug'}
                  variant="danger"
                  onPress={() => {
                    if (!confirmDelete) {
                      setConfirmDelete(true);
                      return;
                    }
                    game.deleteBug(game.active);
                    setConfirmDelete(false);
                    forgetHistory();
                    setSelected(null);
                    setMenu(false);
                  }}
                  style={styles.sheetBtn}
                />
              )}
            </View>
            <Button label="Done" onPress={() => setMenu(false)} />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function ToolBtn({ icon, label, disabled, onPress }: { icon: string; label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[styles.toolBtn, disabled && { opacity: 0.3 }]}>
      <Text style={styles.toolBtnText}>{icon}</Text>
      <Text style={styles.toolBtnLabel}>{label}</Text>
    </Pressable>
  );
}

function MiniMeter({ label, value, max, bad }: { label: string; value: number; max: number; bad: boolean }) {
  return (
    <View style={styles.mini}>
      <Text style={styles.miniLabel}>{label}</Text>
      <View style={styles.miniTrack}>
        <View style={[styles.miniFill, { width: `${Math.min(1, value / max) * 100}%`, backgroundColor: bad ? Colors.bad : Colors.good }]} />
      </View>
      <Text style={[styles.miniText, bad && { color: Colors.bad }]}>
        {value}/{max}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center' },
  column: { alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: Spacing.sm, paddingVertical: 6 },
  hBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.panel,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  hBtnText: { color: Colors.text, fontSize: 26, lineHeight: 30, fontWeight: '700' },
  bugTabs: { gap: 6, alignItems: 'center', paddingRight: 4 },
  bugTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.panel,
    borderColor: Colors.border,
    borderWidth: 1.5,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    maxWidth: 190,
  },
  bugTabOn: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  bugTabAdd: { borderStyle: 'dashed', borderColor: Colors.accent, backgroundColor: 'transparent', paddingHorizontal: 14 },
  bugTabText: { color: Colors.text, fontFamily: Fonts.display, fontSize: 15 },
  bugTag: { color: '#58C7FF', fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  bugDot: { width: 8, height: 8, borderRadius: 4 },
  toolsLeft: { position: 'absolute', left: Spacing.sm, top: Spacing.sm, gap: 6 },
  toolsRight: { position: 'absolute', right: Spacing.sm, top: Spacing.sm, gap: 5, alignItems: 'flex-end' },
  toolBtn: {
    width: 46,
    paddingVertical: 4,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: 'rgba(15,18,24,0.85)',
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  toolBtnText: { color: Colors.text, fontSize: 19, lineHeight: 22 },
  toolBtnLabel: { color: Colors.textDim, fontSize: 8.5, fontWeight: '900', letterSpacing: 0.5 },
  viewBtn: {
    backgroundColor: 'rgba(15,18,24,0.85)',
    borderColor: Colors.border,
    borderWidth: 1.5,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  viewBtnText: { color: Colors.text, fontSize: 12, fontWeight: '800' },
  mini: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(15,18,24,0.8)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  miniLabel: { color: Colors.text, fontSize: 11 },
  miniTrack: { width: 44, height: 6, borderRadius: 3, backgroundColor: Colors.bgDeep, overflow: 'hidden' },
  miniFill: { height: '100%', borderRadius: 3 },
  miniText: { color: Colors.textDim, fontSize: 10.5, fontWeight: '800', fontVariant: ['tabular-nums'], minWidth: 42, textAlign: 'right' },
  hintWrap: { position: 'absolute', left: 0, right: 0, bottom: Spacing.sm, alignItems: 'center', paddingHorizontal: Spacing.md },
  hint: {
    color: Colors.text,
    fontSize: 12.5,
    fontWeight: '600',
    textAlign: 'center',
    backgroundColor: 'rgba(15,18,24,0.82)',
    paddingHorizontal: Spacing.md,
    paddingVertical: 5,
    borderRadius: 999,
    overflow: 'hidden',
  },
  emptyWrap: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.md,
    marginTop: 6,
    paddingVertical: 6,
    paddingHorizontal: Spacing.md,
    borderRadius: 14,
    borderWidth: 1.5,
    minHeight: 44,
  },
  statusBad: { borderColor: Colors.bad, backgroundColor: '#2A1719' },
  statusGood: { borderColor: Colors.good, backgroundColor: '#13261E' },
  statusTitle: { fontSize: 11, fontWeight: '900', letterSpacing: 1.3 },
  statusItems: { gap: 5, alignItems: 'center' },
  statusItem: {
    color: Colors.text,
    fontSize: 12,
    fontWeight: '800',
    borderWidth: 1,
    borderColor: Colors.bad,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  statusTip: { color: Colors.textDim, fontSize: 11, marginTop: 1 },
  tabs: { flexDirection: 'row', marginTop: 6, borderBottomWidth: 1, borderBottomColor: Colors.border, paddingHorizontal: Spacing.sm },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 9, borderBottomWidth: 2.5, borderBottomColor: 'transparent' },
  tabOn: { borderBottomColor: Colors.accent },
  tabText: { color: Colors.textDim, fontFamily: Fonts.display, fontSize: 15 },
  drawer: { flex: 1, backgroundColor: Colors.bgDeep },
  floating: { position: 'absolute', opacity: 0.92, transform: [{ scale: 1.05 }] },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.panel,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: Spacing.lg,
    gap: Spacing.md,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sheetLabel: { color: Colors.accent, fontSize: 11, fontWeight: '900', letterSpacing: 1.4 },
  nameInput: {
    color: Colors.text,
    fontFamily: Fonts.display,
    fontSize: 24,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.bgDeep,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sheetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  sheetBtn: { flexGrow: 1, minWidth: '45%' },
});
