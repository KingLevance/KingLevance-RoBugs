import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { UltBanner } from '@/components/ult-banner';
import { Colors, Spacing } from '@/constants/theme';
import { getMove, PROC } from '@/game/moves';
import { getOpponent } from '@/game/opponents';
import { aiInput, createSim, forfeit, hud, MATCH_SECONDS, step, STEP, type HudBug } from '@/game/sim';
import { ArenaRenderer } from '@/render/scene';
import { useGame } from '@/state/game-store';

function BugHud({ bug, color, align }: { bug: HudBug; color: string; align: 'left' | 'right' }) {
  const end = align === 'right';
  return (
    <View style={{ flex: 1, gap: 3, alignItems: end ? 'flex-end' : 'flex-start' }}>
      <Text style={[styles.hudName, { color }]} numberOfLines={1}>
        {bug.name}
        {bug.shield ? ' 🛡' : ''}
      </Text>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.max(0, bug.hp) * 100}%`, backgroundColor: color }, end && { alignSelf: 'flex-end' }]} />
      </View>
      <View style={[styles.track, { height: 5 }]}>
        <View
          style={[styles.fill, { width: `${(bug.proc / PROC.max) * 100}%`, backgroundColor: '#C77DFF' }, end && { alignSelf: 'flex-end' }]}
        />
      </View>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {bug.moves.map((m) => {
          const def = getMove(m.id);
          return (
            <View key={m.id} style={[styles.moveChip, { borderColor: def.color, opacity: m.cd > 0 ? 0.4 : 1 }, m.ready && { backgroundColor: def.color }]}>
              <Text style={styles.moveChipText}>
                {def.name.split(' ')[0]} {def.cost}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export default function Arena() {
  const game = useGame();
  const [opponent] = useState(() => getOpponent(game.selected));
  const [sim] = useState(() =>
    createSim(
      { build: game.build, moves: game.equipped },
      { build: opponent.build, moves: opponent.moves },
      opponent.arena,
      (Math.random() * 2 ** 31) | 0,
    ),
  );
  const [view, setView] = useState(() => hud(sim));
  const [fast, setFast] = useState(false);
  const speed = useRef(1);
  const loop = useRef<{ raf: number; renderer: ArenaRenderer | null; timer: ReturnType<typeof setTimeout> | null }>({
    raf: 0,
    renderer: null,
    timer: null,
  });
  const recordRef = useRef(game.recordResult);

  useEffect(() => {
    recordRef.current = game.recordResult;
  });

  useEffect(() => {
    const l = loop.current;
    return () => {
      cancelAnimationFrame(l.raf);
      if (l.timer) clearTimeout(l.timer);
      l.renderer?.dispose();
    };
  }, []);

  function onContextCreate(gl: ExpoWebGLRenderingContext) {
    const renderer = new ArenaRenderer(gl, sim);
    // Dev-only hook so browser tests can inspect the sim.
    if (__DEV__ && Platform.OS === 'web') (globalThis as { __robugsSim?: unknown }).__robugsSim = sim;
    loop.current.renderer = renderer;
    let last = performance.now();
    let acc = 0;
    let frame = 0;
    let finished = false;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      acc += dt * speed.current;
      while (acc >= STEP) {
        // Both bugs fight autonomously; the player's AI plays to its build.
        step(sim, STEP, [aiInput(sim, 0, 0.7), aiInput(sim, 1, opponent.aggression)]);
        acc -= STEP;
      }
      renderer.render(sim, dt);
      frame++;
      if (frame % 3 === 0 || sim.over) setView(hud(sim));
      if (sim.over && !finished) {
        finished = true;
        recordRef.current(opponent.id, sim.winner);
        loop.current.timer = setTimeout(() => router.replace('/rewards'), 1600);
      }
      loop.current.raf = requestAnimationFrame(tick);
    };
    loop.current.raf = requestAnimationFrame(tick);
  }

  const [me, foe] = view.bugs;
  const remaining = Math.max(0, Math.ceil(MATCH_SECONDS - view.time));
  const cutscene = !!view.ult;

  return (
    <View style={styles.root}>
      <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />

      {view.flash > 0 && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#fff', opacity: view.flash * 0.85 }]} />}

      {view.ult && (
        <UltBanner
          key={`${view.ult.id}-${view.ult.caster}-${view.time.toFixed(3)}`}
          moveId={view.ult.id}
          casterName={view.bugs[view.ult.caster].name}
          isPlayer={view.ult.caster === 0}
        />
      )}

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        {!cutscene && (
          <View style={styles.hud}>
            <BugHud bug={me} color={Colors.good} align="left" />
            <Text style={styles.timer}>{remaining}</Text>
            <BugHud bug={foe} color={Colors.bad} align="right" />
          </View>
        )}

        {!cutscene && (
          <View style={styles.log} pointerEvents="none">
            {view.log.map((l, i) => (
              <Text key={`${i}-${l}`} style={styles.logLine} numberOfLines={1}>
                {l}
              </Text>
            ))}
          </View>
        )}

        {view.over && (
          <View style={styles.finish} pointerEvents="none">
            <Text style={[styles.finishText, { color: view.winner === 0 ? Colors.good : view.winner === 1 ? Colors.bad : Colors.accent }]}>
              {view.winner === 0 ? 'VICTORY' : view.winner === 1 ? 'DEFEAT' : 'DRAW'}
            </Text>
          </View>
        )}

        <View style={[styles.controls, cutscene && { opacity: 0 }]} pointerEvents="box-none">
          <Pressable
            onPress={() => {
              speed.current = fast ? 1 : 2;
              setFast(!fast);
            }}
            style={[styles.forfeit, styles.speed]}>
            <Text style={styles.forfeitText}>{fast ? '2× speed' : '1× speed'}</Text>
          </Pressable>
          <View style={{ alignItems: 'flex-end', gap: Spacing.sm }}>
            <Text style={styles.tip}>Your bug fights on its own, driven by its build.</Text>
            <Pressable onPress={() => forfeit(sim, 0)} style={styles.forfeit}>
              <Text style={styles.forfeitText}>Forfeit</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  overlay: { ...StyleSheet.absoluteFill, justifyContent: 'space-between' },
  hud: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md, padding: Spacing.md, backgroundColor: 'rgba(20,23,28,0.55)' },
  hudName: { fontWeight: '900', fontSize: 14 },
  track: { height: 9, alignSelf: 'stretch', backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4 },
  moveChip: { borderWidth: 1.5, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  moveChipText: { color: Colors.text, fontSize: 10, fontWeight: '800' },
  timer: { color: Colors.text, fontSize: 24, fontWeight: '900', fontVariant: ['tabular-nums'], minWidth: 40, textAlign: 'center' },
  log: { flex: 1, justifyContent: 'flex-end', paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
  logLine: { color: Colors.text, fontSize: 12, textShadowColor: '#000', textShadowRadius: 3, textShadowOffset: { width: 0, height: 1 } },
  finish: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  finishText: { fontSize: 54, fontWeight: '900', fontStyle: 'italic', textShadowColor: '#000', textShadowRadius: 0, textShadowOffset: { width: 4, height: 4 } },
  controls: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', padding: Spacing.lg },
  tip: { color: Colors.textDim, fontSize: 11, width: 130, textAlign: 'right' },
  forfeit: { backgroundColor: '#4A1F22', borderColor: Colors.bad, borderWidth: 1, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  forfeitText: { color: Colors.text, fontWeight: '700' },
  speed: { backgroundColor: Colors.panelHi, borderColor: Colors.border },
});
