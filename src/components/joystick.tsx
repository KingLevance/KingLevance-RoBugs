import { useState } from 'react';
import { StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { Colors } from '@/constants/theme';

/**
 * Virtual thumbstick. Reports a vector with magnitude 0..1 in screen space
 * (x right, y down). Built on the core responder system — no extra deps.
 */
export function Joystick({ size = 140, onChange }: { size?: number; onChange: (v: { x: number; y: number }) => void }) {
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const r = size / 2;

  function handle(e: GestureResponderEvent) {
    const dx = e.nativeEvent.locationX - r;
    const dy = e.nativeEvent.locationY - r;
    const len = Math.hypot(dx, dy);
    const max = r * 0.8;
    const k = len > max ? max / len : 1;
    const v = { x: (dx * k) / max, y: (dy * k) / max };
    setKnob({ x: dx * k, y: dy * k });
    onChange(v);
  }

  function release() {
    setKnob({ x: 0, y: 0 });
    onChange({ x: 0, y: 0 });
  }

  return (
    <View
      style={[styles.base, { width: size, height: size, borderRadius: r }]}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={handle}
      onResponderMove={handle}
      onResponderRelease={release}
      onResponderTerminate={release}>
      <View
        pointerEvents="none"
        style={[
          styles.knob,
          { width: r, height: r, borderRadius: r / 2, transform: [{ translateX: knob.x }, { translateY: knob.y }] },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: Colors.panel,
    borderWidth: 2,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  knob: { backgroundColor: Colors.accent, opacity: 0.9 },
});
