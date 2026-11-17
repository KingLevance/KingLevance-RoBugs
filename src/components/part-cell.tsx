import { Image, StyleSheet, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { CATEGORY_COLOR, RARITY_COLOR, type PartDef, type Rarity } from '@/game/parts';

import { PART_ICONS } from './part-icons';

const PIPS: Record<Rarity, number> = { common: 1, uncommon: 2, rare: 3, epic: 4 };

/**
 * Tile for a part: a render of its 3D model on a dark tile, framed in its
 * rarity colour, with rarity pips in the corner (1 common … 4 epic).
 * Below 24 px it falls back to a flat category-coloured square (bug previews).
 */
export function PartCell({ part, size, dim }: { part: PartDef; size: number; dim?: boolean }) {
  const rarity = RARITY_COLOR[part.rarity];
  if (size < 24) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.22,
          backgroundColor: CATEGORY_COLOR[part.category],
          borderColor: rarity,
          borderWidth: Math.max(1.5, size * 0.07),
          opacity: dim ? 0.35 : 1,
        }}
      />
    );
  }
  const pip = Math.max(3, size * 0.09);
  return (
    <View
      style={[
        styles.tile,
        { width: size, height: size, borderRadius: size * 0.2, borderColor: rarity, borderWidth: Math.max(1.5, size * 0.045), opacity: dim ? 0.4 : 1 },
      ]}>
      <Image source={PART_ICONS[part.id]} style={{ width: size * 0.86, height: size * 0.86 }} resizeMode="contain" />
      {size >= 40 && (
        <View style={[styles.pips, { gap: pip * 0.5, left: pip, bottom: pip * 0.8 }]}>
          {Array.from({ length: PIPS[part.rarity] }).map((_, i) => (
            <View key={i} style={{ width: pip, height: pip, borderRadius: pip / 2, backgroundColor: rarity }} />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.panelHi, overflow: 'hidden' },
  pips: { position: 'absolute', flexDirection: 'row' },
});
