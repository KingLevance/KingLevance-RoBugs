import { View } from 'react-native';

import { GRID_H, GRID_W, type Placement } from '@/game/build';
import { getPart } from '@/game/parts';

import { PartCell } from './part-cell';

/** Compact read-only render of a build, cropped to its occupied rows/cols. */
export function BugPreview({ placements, cell = 18 }: { placements: Placement[]; cell?: number }) {
  if (placements.length === 0) return <View style={{ width: cell * 3, height: cell * 3 }} />;
  const minX = Math.min(GRID_W, ...placements.map((p) => p.x));
  const maxX = Math.max(0, ...placements.map((p) => p.x));
  const minY = Math.min(GRID_H, ...placements.map((p) => p.y));
  const maxY = Math.max(0, ...placements.map((p) => p.y));
  return (
    <View style={{ width: (maxX - minX + 1) * cell, height: (maxY - minY + 1) * cell }}>
      {placements.map((p) => (
        <View key={`${p.x},${p.y}`} style={{ position: 'absolute', left: (p.x - minX) * cell, top: (p.y - minY) * cell }}>
          <PartCell part={getPart(p.partId)} size={cell - 2} />
        </View>
      ))}
    </View>
  );
}
