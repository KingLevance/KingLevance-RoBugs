import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { Fonts } from '@/constants/theme';

export type Floater = { id: number; x: number; y: number; text: string; color: string; size: number };

function FloatText({ item, onDone }: { item: Floater; onDone: (id: number) => void }) {
  const [t] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(t, { toValue: 1, duration: 800, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(() => onDone(item.id));
  }, [t, item.id, onDone]);

  return (
    <Animated.Text
      style={[
        styles.text,
        {
          left: item.x - 110,
          top: item.y - item.size,
          color: item.color,
          fontSize: item.size,
          opacity: t.interpolate({ inputRange: [0, 0.65, 1], outputRange: [1, 1, 0] }),
          transform: [
            { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, -48] }) },
            { scale: t.interpolate({ inputRange: [0, 0.12, 0.3, 1], outputRange: [0.5, 1.35, 1, 1] }) },
          ],
        },
      ]}>
      {item.text}
    </Animated.Text>
  );
}

/** Floating combat text: pops in at a screen position, drifts up and fades. */
export function DamageNumbers({ items, onDone }: { items: Floater[]; onDone: (id: number) => void }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {items.map((it) => (
        <FloatText key={it.id} item={it} onDone={onDone} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  text: {
    position: 'absolute',
    width: 220,
    textAlign: 'center',
    fontFamily: Fonts.display,
    fontStyle: 'italic',
    textShadowColor: '#111318',
    textShadowOffset: { width: 1.5, height: 1.5 },
    textShadowRadius: 1,
  },
});
