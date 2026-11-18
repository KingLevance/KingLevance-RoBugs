import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Animated, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BUG_PORTRAITS } from '@/components/bug-portraits';
import { RewardChip } from '@/components/reward-chip';
import { Stars } from '@/components/stars';
import { Button, Label, Panel } from '@/components/ui';
import { Colors, Fonts, MaxContentWidth, Spacing } from '@/constants/theme';
import { getOpponent } from '@/game/opponents';
import { useGame } from '@/state/game-store';

export default function Rewards() {
  const game = useGame();
  const r = game.lastResult;
  const [pop] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.spring(pop, { toValue: 1, friction: 5, tension: 120, useNativeDriver: true }).start();
  }, [pop]);
  if (!r) {
    return (
      <View style={styles.empty}>
        <Button label="Back to the campaign" onPress={() => router.replace('/campaign')} />
      </View>
    );
  }
  const opp = getOpponent(r.opponentId);
  const won = r.winner === 0;
  const title = won ? 'VICTORY' : r.forfeited ? 'FORFEIT' : r.winner === 1 ? 'DEFEAT' : 'DRAW';
  const color = won ? Colors.good : r.winner === 1 ? Colors.bad : Colors.accent;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }}>
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.banner}>
        <View style={[styles.portrait, { borderColor: color }]}>
          <Image source={BUG_PORTRAITS[opp.id]} style={{ width: 120, height: 120, opacity: won ? 0.55 : 1 }} />
          {won && <Text style={styles.ko}>KO</Text>}
        </View>
        <Animated.Text
          style={[
            styles.title,
            { color, transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }, { rotate: '-3deg' }], opacity: pop },
          ]}>
          {title}
        </Animated.Text>
        <Text style={styles.vs}>vs {opp.name}</Text>
        {won && (r.stars ?? 0) > 0 && (
          <View style={{ alignItems: 'center', gap: 6, marginTop: 4 }}>
            <Stars n={r.stars} size={46} animate />
            <View style={styles.checks}>
              {(r.checks ?? []).map((c) => (
                <Text key={c.label} style={[styles.check, c.ok ? styles.checkOk : styles.checkMiss]}>
                  {c.ok ? '★' : '☆'} {c.label}
                </Text>
              ))}
            </View>
            {r.stars > (r.prevBest ?? 0) && r.prevBest > 0 && <Text style={styles.newBest}>NEW BEST!</Text>}
          </View>
        )}
      </View>
      <Text style={styles.dim}>
        {won
          ? `You took ${opp.name} apart!`
          : r.forfeited
            ? 'You forfeited the match. No salvage for walking away.'
            : `${opp.name} got the better of you. You salvaged some scrap.`}
      </Text>

      {r.rewards.guaranteed.length > 0 && (
        <Panel style={{ gap: Spacing.sm }}>
          <Label>FIRST CLEAR · GUARANTEED</Label>
          {r.rewards.guaranteed.map((rw, i) => (
            <RewardChip key={i} reward={rw} />
          ))}
        </Panel>
      )}

      {(r.rewards.bonus?.length ?? 0) > 0 && (
        <Panel style={{ gap: Spacing.sm, borderColor: '#FFD23F' }}>
          <Label color="#FFD23F">FIRST ★★★ BONUS · RARE OR BETTER</Label>
          {r.rewards.bonus.map((rw, i) => (
            <RewardChip key={i} reward={rw} />
          ))}
        </Panel>
      )}

      {r.rewards.rolled.length > 0 && (
        <Panel style={{ gap: Spacing.sm }}>
          <Label>
            {won ? `${opp.boss ? 'BOSS LOOT ROLLS' : 'LOOT ROLLS'}${(r.stars ?? 1) > 1 ? ` · ${'★'.repeat(r.stars)} LUCK` : ''}` : 'SALVAGE'}
          </Label>
          {r.rewards.rolled.map((rw, i) => (
            <RewardChip key={i} reward={rw} />
          ))}
        </Panel>
      )}

      {won && opp.boss && <Text style={styles.dim}>Bosses can be re-fought for more rolls on their loot table.</Text>}

      <View style={styles.actions}>
        <Button label="Campaign" variant="secondary" onPress={() => router.dismissTo('/campaign')} style={{ flex: 1 }} />
        <Button label="Garage" onPress={() => router.replace('/garage')} style={{ flex: 1 }} />
      </View>
    </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.lg, gap: Spacing.lg, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },
  banner: { alignItems: 'center', gap: Spacing.xs, marginTop: Spacing.lg },
  portrait: {
    width: 104,
    height: 104,
    borderRadius: 52,
    borderWidth: 3,
    backgroundColor: Colors.bgDeep,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  ko: { position: 'absolute', fontFamily: Fonts.display, fontSize: 40, color: Colors.bad, transform: [{ rotate: '-12deg' }], textShadowColor: '#000', textShadowRadius: 6 },
  title: { fontFamily: Fonts.display, fontSize: 56, textAlign: 'center', letterSpacing: 1, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 10, textShadowOffset: { width: 0, height: 4 } },
  vs: { fontFamily: Fonts.display, fontSize: 18, color: Colors.textDim },
  dim: { color: Colors.textDim, fontSize: 14, textAlign: 'center' },
  checks: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 },
  check: { fontSize: 12, fontWeight: '800', borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, overflow: 'hidden' },
  checkOk: { color: '#FFD23F', borderColor: '#FFD23F' },
  checkMiss: { color: Colors.textDim, borderColor: Colors.border },
  newBest: { fontFamily: Fonts.display, color: '#FFD23F', fontSize: 16, letterSpacing: 1 },
  actions: { flexDirection: 'row', gap: Spacing.sm },
});
