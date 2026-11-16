import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Joystick } from '@/components/joystick';
import { PartCell } from '@/components/part-cell';
import { Button, Panel } from '@/components/ui';
import { Colors, Spacing } from '@/constants/theme';
import { OPPONENTS } from '@/game/opponents';
import { getPart, RARITY_COLOR } from '@/game/parts';
import { aiInput, ARENA_SIZE, CELL, createSim, forfeit, MATCH_SECONDS, snapshot, step, type BugView, type Input } from '@/game/sim';
import { useGame } from '@/state/game-store';

const DT = 1 / 60;

type Result = { winner: 0 | 1 | null; rewards: string[] };

function BugSprite({ bug, scale, tint }: { bug: BugView; scale: number; tint: string }) {
  const c = CELL * scale;
  return (
    <View
      style={{
        position: 'absolute',
        left: bug.x * scale,
        top: bug.y * scale,
        width: 0,
        height: 0,
        transform: [{ rotate: `${bug.rot}rad` }],
        opacity: bug.dead ? 0.4 : 1,
      }}>
      <View
        style={{
          position: 'absolute',
          left: -c * 0.3,
          top: -c * 0.3,
          width: c * 0.6,
          height: c * 0.6,
          borderRadius: c,
          backgroundColor: tint,
          opacity: 0.35,
        }}
      />
      {bug.parts.map((p, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: p.lx * scale - c / 2,
            top: p.ly * scale - c / 2,
            width: c,
            height: c,
            borderRadius: c * 0.25,
            backgroundColor: p.flash ? '#FFFFFF' : p.color,
            borderWidth: 1.5,
            borderColor: tint,
            opacity: 0.45 + 0.55 * p.hp,
          }}
        />
      ))}
    </View>
  );
}

function HpBar({ name, hp, color, align }: { name: string; hp: number; color: string; align: 'left' | 'right' }) {
  return (
    <View style={{ flex: 1, gap: 4, alignItems: align === 'left' ? 'flex-start' : 'flex-end' }}>
      <Text style={[styles.hudName, { color }]} numberOfLines={1}>
        {name}
      </Text>
      <View style={styles.hpTrack}>
        <View
          style={[styles.hpFill, { width: `${Math.max(0, hp) * 100}%`, backgroundColor: color }, align === 'right' && { alignSelf: 'flex-end' }]}
        />
      </View>
    </View>
  );
}

export default function Arena() {
  const game = useGame();
  const { width, height } = useWindowDimensions();
  const [opponent] = useState(() => OPPONENTS[game.ladder]);
  const [sim] = useState(() => createSim(game.build, opponent.build, opponent.arena));
  const [view, setView] = useState(() => snapshot(sim));
  const [result, setResult] = useState<Result | null>(null);
  const input = useRef<Input>({ x: 0, y: 0 });
  const recordRef = useRef(game.recordResult);

  useEffect(() => {
    recordRef.current = game.recordResult;
  });

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let finished = false;
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (acc >= DT && !sim.over) {
        step(sim, DT, [input.current, aiInput(sim, 1, opponent.aggression)]);
        acc -= DT;
      }
      setView(snapshot(sim));
      if (sim.over && !finished) {
        finished = true;
        const rewards = recordRef.current(sim.winner === 0);
        setResult({ winner: sim.winner, rewards });
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sim, opponent]);

  const size = Math.min(width - Spacing.lg * 2, height * 0.6);
  const scale = size / ARENA_SIZE;
  const [me, foe] = view.bugs;
  const remaining = Math.max(0, Math.ceil(MATCH_SECONDS - view.time));

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.hud}>
        <HpBar name={me.name} hp={me.hp} color={Colors.good} align="left" />
        <Text style={styles.timer}>{remaining}</Text>
        <HpBar name={foe.name} hp={foe.hp} color={Colors.bad} align="right" />
      </View>

      <View
        style={[
          styles.arena,
          { width: size, height: size, borderColor: sim.spikedWalls ? '#8A3B2E' : Colors.border },
        ]}>
        {view.hazards.map((h, i) => (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: (h.x - h.r) * scale,
              top: (h.y - h.r) * scale,
              width: h.r * 2 * scale,
              height: h.r * 2 * scale,
              borderRadius: h.r * scale,
              backgroundColor: h.kind === 'acid' ? Colors.acid : h.warn ? Colors.stomperWarn : Colors.stomper,
              borderWidth: h.kind === 'stomper' ? 2 : 0,
              borderColor: '#FF8A3D',
              borderStyle: 'dashed',
            }}
          />
        ))}
        <BugSprite bug={foe} scale={scale} tint={Colors.bad} />
        <BugSprite bug={me} scale={scale} tint={Colors.good} />
        {view.projectiles.map((p, i) => (
          <View key={i} style={[styles.dart, { left: p.x * scale - 3, top: p.y * scale - 3 }]} />
        ))}
        {view.effects.map((e, i) => {
          const s = e.size * scale;
          return (
            <View
              key={i}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: e.x * scale - s / 2,
                top: e.y * scale - s / 2,
                width: s,
                height: s,
                borderRadius: s / 2,
                backgroundColor: e.color,
                opacity: Math.min(0.8, e.ttl * 2),
              }}
            />
          );
        })}
      </View>

      <View style={styles.log}>
        {view.log.map((l, i) => (
          <Text key={`${i}-${l}`} style={[styles.logLine, { opacity: 0.5 + (i / 3) * 0.5 }]} numberOfLines={1}>
            {l}
          </Text>
        ))}
      </View>

      <View style={styles.controls}>
        <Button label="Forfeit" variant="danger" onPress={() => forfeit(sim, 0)} />
        <Joystick
          size={Math.min(150, height * 0.2)}
          onChange={(v) => {
            input.current = v;
          }}
        />
        <Text style={styles.tip}>Weapons auto-fire when facing the enemy</Text>
      </View>

      {result && (
        <View style={styles.overlay}>
          <Panel style={styles.resultPanel}>
            <Text
              style={[
                styles.resultTitle,
                { color: result.winner === 0 ? Colors.good : result.winner === 1 ? Colors.bad : Colors.accent },
              ]}>
              {result.winner === 0 ? 'VICTORY' : result.winner === 1 ? 'DEFEAT' : 'DRAW'}
            </Text>
            <Text style={styles.dim}>
              {result.winner === 0 ? `You took ${opponent.name} apart!` : 'You salvaged some scrap from the wreck.'}
            </Text>
            <Text style={styles.rewardHeader}>PARTS EARNED</Text>
            {result.rewards.map((id, i) => {
              const part = getPart(id);
              return (
                <View key={i} style={styles.rewardRow}>
                  <PartCell part={part} size={30} />
                  <Text style={[styles.rewardName, { color: RARITY_COLOR[part.rarity] }]}>{part.name}</Text>
                  <Text style={styles.dim}>{part.rarity}</Text>
                </View>
              );
            })}
            <View style={{ flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm }}>
              <Button label="Hub" variant="secondary" onPress={() => router.back()} style={{ flex: 1 }} />
              <Button label="Garage" onPress={() => router.replace('/garage')} style={{ flex: 1 }} />
            </View>
          </Panel>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center' },
  hud: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, padding: Spacing.md, alignSelf: 'stretch' },
  hudName: { fontWeight: '800', fontSize: 14 },
  hpTrack: { height: 8, alignSelf: 'stretch', backgroundColor: Colors.panel, borderRadius: 4, overflow: 'hidden' },
  hpFill: { height: '100%', borderRadius: 4 },
  timer: { color: Colors.text, fontSize: 22, fontWeight: '900', fontVariant: ['tabular-nums'], minWidth: 40, textAlign: 'center' },
  arena: { backgroundColor: Colors.arenaFloor, borderWidth: 4, borderRadius: 8, overflow: 'hidden' },
  dart: { position: 'absolute', width: 6, height: 6, borderRadius: 3, backgroundColor: '#E07BFF' },
  log: { height: 54, justifyContent: 'flex-end', paddingHorizontal: Spacing.lg, alignSelf: 'stretch', marginTop: Spacing.xs },
  logLine: { color: Colors.textDim, fontSize: 12 },
  controls: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    paddingHorizontal: Spacing.lg,
    gap: Spacing.md,
  },
  tip: { color: Colors.textDim, fontSize: 11, width: 80 },
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.lg,
  },
  resultPanel: { width: '100%', maxWidth: 380, gap: Spacing.sm },
  resultTitle: { fontSize: 36, fontWeight: '900', textAlign: 'center', letterSpacing: 2 },
  dim: { color: Colors.textDim, fontSize: 13, textAlign: 'center' },
  rewardHeader: { color: Colors.accent, fontWeight: '800', fontSize: 12, letterSpacing: 1.5, marginTop: Spacing.sm },
  rewardRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  rewardName: { flex: 1, fontWeight: '700' },
});
