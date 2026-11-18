import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { sfx } from '@/audio/audio';
import { Colors, Fonts, Spacing } from '@/constants/theme';

type Variant = 'primary' | 'secondary' | 'danger' | 'go';

const FACE: Record<Variant, { bg: string; lip: string; text: string; border: string }> = {
  primary: { bg: Colors.accent, lip: Colors.accentLip, text: '#2A1A05', border: '#FFC86B' },
  go: { bg: Colors.good, lip: Colors.goodLip, text: '#062A1A', border: '#7DF0BE' },
  secondary: { bg: Colors.panelHi, lip: Colors.slateLip, text: Colors.text, border: Colors.panelEdge },
  danger: { bg: '#5A2226', lip: Colors.badLip, text: '#FFD9D9', border: Colors.bad },
};

/** Chunky game button with a raised lip that presses down. */
export function Button({
  label,
  onPress,
  disabled,
  variant = 'primary',
  size = 'md',
  icon,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const f = FACE[variant];
  const lip = size === 'lg' ? 5 : 4;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={() => {
        sfx('tap');
        onPress();
      }}
      style={[{ opacity: disabled ? 0.45 : 1 }, style]}>
      {({ pressed }) => (
        <View style={[styles.lip, { backgroundColor: f.lip, paddingBottom: pressed ? 1 : lip, marginTop: pressed ? lip - 1 : 0 }]}>
          <View
            style={[
              styles.face,
              size === 'sm' && styles.faceSm,
              size === 'lg' && styles.faceLg,
              { backgroundColor: f.bg, borderTopColor: f.border },
            ]}>
            {icon}
            <Text style={[styles.label, size === 'sm' && { fontSize: 14 }, size === 'lg' && { fontSize: 22 }, { color: f.text }]} numberOfLines={1}>
              {label}
            </Text>
          </View>
        </View>
      )}
    </Pressable>
  );
}

export function Panel({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.panel, style]}>{children}</View>;
}

/** Small caps section heading. */
export function Label({ children, color = Colors.accent, style }: { children: ReactNode; color?: string; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.sectionLabel, { color }, style]}>{children}</Text>;
}

/** Big display-font heading. */
export function Title({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.title, style]}>{children}</Text>;
}

/** Rounded pill tag. */
export function Pill({ label, color = Colors.textDim, filled }: { label: string; color?: string; filled?: boolean }) {
  return (
    <View style={[styles.pill, { borderColor: color }, filled && { backgroundColor: color }]}>
      <Text style={[styles.pillText, { color: filled ? Colors.bg : color }]}>{label}</Text>
    </View>
  );
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
        <View style={[styles.meterFill, { width: `${frac * 100}%`, backgroundColor: color }]}>
          <View style={styles.meterShine} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  lip: { borderRadius: 14 },
  face: {
    flexDirection: 'row',
    gap: Spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    paddingHorizontal: Spacing.lg,
    borderRadius: 14,
    borderTopWidth: 1.5,
  },
  faceSm: { paddingVertical: 7, paddingHorizontal: Spacing.md, borderRadius: 12 },
  faceLg: { paddingVertical: 15 },
  label: { fontFamily: Fonts.display, fontSize: 18, letterSpacing: 0.5 },
  panel: {
    backgroundColor: Colors.panel,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Colors.border,
    borderTopColor: Colors.panelEdge,
    padding: Spacing.md + 2,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  sectionLabel: { fontSize: 11, fontWeight: '900', letterSpacing: 1.6 },
  title: { fontFamily: Fonts.display, color: Colors.text, fontSize: 24, letterSpacing: 0.4 },
  pill: { borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  pillText: { fontSize: 11, fontWeight: '800' },
  meter: { gap: 5 },
  meterRow: { flexDirection: 'row', justifyContent: 'space-between' },
  meterLabel: { color: Colors.textDim, fontSize: 11, fontWeight: '900', letterSpacing: 1.2 },
  meterValue: { color: Colors.text, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  meterTrack: { height: 10, borderRadius: 5, backgroundColor: Colors.bgDeep, overflow: 'hidden', borderWidth: 1, borderColor: Colors.border },
  meterFill: { height: '100%', borderRadius: 5, overflow: 'hidden' },
  meterShine: { position: 'absolute', left: 0, right: 0, top: 0, height: '45%', backgroundColor: 'rgba(255,255,255,0.28)' },
});
