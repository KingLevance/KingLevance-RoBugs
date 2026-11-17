import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors, Spacing } from '@/constants/theme';
import { applyUpdate, useUpdateReady } from '@/updates';

/** Small floating "Update ready" pill. Renders nothing until an OTA update is downloaded. */
export function UpdateBanner() {
  const ready = useUpdateReady();
  const insets = useSafeAreaInsets();
  if (!ready) return null;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + Spacing.lg }]}>
      <View style={styles.pill}>
        <Text style={styles.text}>Update ready</Text>
        <Pressable onPress={() => void applyUpdate()} style={styles.button}>
          <Text style={styles.buttonText}>Restart</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.panelHi,
    borderColor: Colors.accent,
    borderWidth: 1.5,
    borderRadius: 999,
    paddingLeft: Spacing.lg,
    paddingRight: Spacing.xs,
    paddingVertical: Spacing.xs,
  },
  text: { color: Colors.text, fontWeight: '700' },
  button: { backgroundColor: Colors.accent, borderRadius: 999, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm },
  buttonText: { color: Colors.bg, fontWeight: '800' },
});
