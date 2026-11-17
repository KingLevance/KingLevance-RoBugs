import { StyleSheet, Text, View } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';
import { GUIDE } from '@/game/guide';
import { getMove } from '@/game/moves';
import type { Reward } from '@/game/opponents';
import { getPart, RARITY_COLOR } from '@/game/parts';

import { PartCell } from './part-cell';

/** A part or move reward, as a small labelled chip. */
export function RewardChip({ reward, dim, note }: { reward: Reward; dim?: boolean; note?: string }) {
  if (reward.kind === 'move') {
    const m = getMove(reward.id);
    return (
      <View style={[styles.chip, { borderColor: m.color, opacity: dim ? 0.45 : 1 }]}>
        <View style={[styles.moveIcon, { backgroundColor: m.color }]}>
          <Text style={styles.moveIconText}>★</Text>
        </View>
        <View>
          <Text style={[styles.name, { color: m.color }]}>{m.name}</Text>
          <Text style={styles.sub}>{note ?? 'signature move'}</Text>
        </View>
      </View>
    );
  }
  const p = getPart(reward.id);
  return (
    <View style={[styles.chip, { borderColor: RARITY_COLOR[p.rarity], opacity: dim ? 0.45 : 1 }]}>
      <PartCell part={p} size={40} />
      <View>
        <Text style={[styles.name, { color: RARITY_COLOR[p.rarity] }]}>{p.name}</Text>
        <Text style={styles.sub}>{note ?? `${GUIDE[p.category].label} · ${p.rarity}`}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderWidth: 1.5,
    borderRadius: 10,
    paddingVertical: 4,
    paddingHorizontal: Spacing.sm,
    backgroundColor: Colors.bg,
  },
  moveIcon: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  moveIconText: { color: '#fff', fontWeight: '900' },
  name: { fontWeight: '800', fontSize: 13 },
  sub: { color: Colors.textDim, fontSize: 11 },
});
