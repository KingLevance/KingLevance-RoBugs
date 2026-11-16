import { StyleSheet, Text, View } from 'react-native';

import { CATEGORY_COLOR, CATEGORY_GLYPH, RARITY_COLOR, type PartDef } from '@/game/parts';

/** Square sprite for a part: category color, glyph, rarity-colored border. */
export function PartCell({ part, size, dim }: { part: PartDef; size: number; dim?: boolean }) {
  return (
    <View
      style={[
        styles.cell,
        {
          width: size,
          height: size,
          borderRadius: size * 0.22,
          backgroundColor: CATEGORY_COLOR[part.category],
          borderColor: RARITY_COLOR[part.rarity],
          borderWidth: Math.max(1.5, size * 0.07),
          opacity: dim ? 0.35 : 1,
        },
      ]}>
      {size >= 18 && (
        <Text style={[styles.glyph, { fontSize: size * 0.34 }]} numberOfLines={1}>
          {CATEGORY_GLYPH[part.category]}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  cell: { alignItems: 'center', justifyContent: 'center' },
  glyph: { color: 'rgba(0,0,0,0.65)', fontWeight: '800' },
});
