import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';

export function Button({
  label,
  onPress,
  disabled,
  variant = 'primary',
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.primary,
        variant === 'secondary' && styles.secondary,
        variant === 'danger' && styles.danger,
        disabled && styles.disabled,
        pressed && { opacity: 0.75 },
        style,
      ]}>
      <Text style={[styles.buttonText, variant === 'primary' && { color: Colors.bg }]}>{label}</Text>
    </Pressable>
  );
}

export function Panel({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.panel, style]}>{children}</View>;
}

export function Meter({
  label,
  value,
  max,
  color,
  display,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
  display?: string;
}) {
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <View style={styles.meter}>
      <View style={styles.meterRow}>
        <Text style={styles.meterLabel}>{label}</Text>
        <Text style={styles.meterValue}>{display ?? `${Math.round(value)} / ${Math.round(max)}`}</Text>
      </View>
      <View style={styles.meterTrack}>
        <View style={[styles.meterFill, { width: `${frac * 100}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  primary: { backgroundColor: Colors.accent },
  secondary: { backgroundColor: Colors.panelHi, borderColor: Colors.border },
  danger: { backgroundColor: '#4A1F22', borderColor: Colors.bad },
  disabled: { opacity: 0.4 },
  buttonText: { color: Colors.text, fontWeight: '700', fontSize: 16 },
  panel: {
    backgroundColor: Colors.panel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
  },
  meter: { gap: 4 },
  meterRow: { flexDirection: 'row', justifyContent: 'space-between' },
  meterLabel: { color: Colors.textDim, fontSize: 12, fontWeight: '600' },
  meterValue: { color: Colors.text, fontSize: 12, fontVariant: ['tabular-nums'] },
  meterTrack: { height: 6, borderRadius: 3, backgroundColor: Colors.bg, overflow: 'hidden' },
  meterFill: { height: '100%', borderRadius: 3 },
});
