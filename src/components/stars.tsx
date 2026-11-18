import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { sfx } from '@/audio/audio';
import { MAX_STARS } from '@/game/stars';

const GOLD = '#FFD23F';
const EMPTY = '#3A4250';

/** A row of 1–3 stars. `animate` pops the earned ones in one by one (results screen). */
export function Stars({ n, size = 14, animate = false }: { n: number; size?: number; animate?: boolean }) {
  return (
    <View style={styles.row}>
      {Array.from({ length: MAX_STARS }).map((_, i) =>
        animate && i < n ? (
          <PopStar key={i} index={i} size={size} delay={350 + i * 380} />
        ) : (
          <Text key={i} style={[styles.star, { fontSize: size, color: i < n ? GOLD : EMPTY }]}>
            ★
          </Text>
        ),
      )}
    </View>
  );
}

function PopStar({ index, size, delay }: { index: number; size: number; delay: number }) {
  const [t] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(t, { toValue: 1, duration: 420, delay, easing: Easing.out(Easing.back(2.5)), useNativeDriver: true }).start();
    // Each star dings a little higher.
    const ding = setTimeout(() => sfx('star', { gap: 0, rate: 1 + index * 0.12 }), delay + 140);
    return () => clearTimeout(ding);
  }, [t, delay, index]);
  return (
    <View>
      <Text style={[styles.star, { fontSize: size, color: EMPTY }]}>★</Text>
      <Animated.Text
        style={[
          styles.star,
          styles.over,
          {
            fontSize: size,
            color: GOLD,
            opacity: t,
            transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [2.4, 1] }) }, { rotate: t.interpolate({ inputRange: [0, 1], outputRange: ['-40deg', '0deg'] }) }],
          },
        ]}>
        ★
      </Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 1 },
  star: { textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3, textShadowOffset: { width: 0, height: 1 } },
  over: { position: 'absolute', left: 0, top: 0 },
});
