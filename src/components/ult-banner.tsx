import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { getMove, ULT_SECONDS } from '@/game/moves';

/**
 * Cutscene overlay for an ultimate: letterbox bars slide in, the move name
 * slams in from the right on a skewed stripe, drifts, then flies out left.
 * Runs on its own Animated clock (native driver). Remount with a new `key` per cast.
 */
export function UltBanner({ moveId, casterName, isPlayer }: { moveId: string; casterName: string; isPlayer: boolean }) {
  const { width, height } = useWindowDimensions();
  const [bars] = useState(() => new Animated.Value(0));
  const [x] = useState(() => new Animated.Value(0));
  const move = getMove(moveId);
  const total = ULT_SECONDS * 1000;
  const barH = height * 0.13;

  useEffect(() => {
    Animated.parallel([
      Animated.sequence([
        Animated.timing(bars, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.delay(total - 360),
        Animated.timing(bars, { toValue: 0, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.delay(120),
        // Slam in from the right…
        Animated.timing(x, { toValue: 1, duration: 170, easing: Easing.out(Easing.back(1.6)), useNativeDriver: true }),
        // …drift…
        Animated.timing(x, { toValue: 1.15, duration: total - 520, easing: Easing.linear, useNativeDriver: true }),
        // …and fly out left.
        Animated.timing(x, { toValue: 2, duration: 230, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      ]),
    ]).start();
  }, [bars, x, total]);

  const translateX = x.interpolate({ inputRange: [0, 1, 1.15, 2], outputRange: [width, 0, -24, -width * 1.3] });

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View
        style={[styles.bar, { top: 0, height: barH, transform: [{ translateY: bars.interpolate({ inputRange: [0, 1], outputRange: [-barH, 0] }) }] }]}
      />
      <Animated.View
        style={[styles.bar, { bottom: 0, height: barH, transform: [{ translateY: bars.interpolate({ inputRange: [0, 1], outputRange: [barH, 0] }) }] }]}
      />
      <Animated.View style={[styles.stripeWrap, { top: height * 0.62, transform: [{ translateX }] }]}>
        <View style={[styles.stripe, { backgroundColor: move.color }]}>
          <Text style={styles.caster}>{isPlayer ? 'YOUR BUG' : casterName.toUpperCase()}</Text>
          <Text style={[styles.name, { fontSize: Math.min(38, (width - 100) / (move.name.length * 0.62)) }]} numberOfLines={1}>
            {move.name.toUpperCase()}
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', left: 0, right: 0, backgroundColor: '#000' },
  stripeWrap: { position: 'absolute', left: -20, right: -20 },
  stripe: {
    paddingVertical: 10,
    paddingHorizontal: 40,
    transform: [{ skewX: '-14deg' }],
    borderTopWidth: 3,
    borderBottomWidth: 3,
    borderColor: '#111318',
  },
  caster: { color: 'rgba(0,0,0,0.6)', fontWeight: '900', fontSize: 12, letterSpacing: 3, fontStyle: 'italic' },
  name: { color: '#FFFFFF', fontWeight: '900', fontSize: 38, fontStyle: 'italic', letterSpacing: 1, textShadowColor: '#111318', textShadowOffset: { width: 3, height: 3 }, textShadowRadius: 0 },
});
