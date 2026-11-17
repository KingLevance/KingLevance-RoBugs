import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { useIsFocused } from 'expo-router';
import { useEffect, useRef } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import type { Placement } from '@/game/build';
import { ShowcaseRenderer } from '@/render/showcase';

/** The bug turning on a lit pedestal (3D). Pauses while its screen is hidden. */
export function BugShowcase({ placements, background, style }: { placements: Placement[]; background: string; style?: StyleProp<ViewStyle> }) {
  const renderer = useRef<ShowcaseRenderer | null>(null);
  const raf = useRef(0);
  const focused = useIsFocused();
  const live = useRef(focused);

  useEffect(() => {
    live.current = focused;
  }, [focused]);

  useEffect(() => {
    renderer.current?.setPlacements(placements);
  }, [placements]);

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      renderer.current?.dispose();
      renderer.current = null;
    },
    [],
  );

  function onContextCreate(gl: ExpoWebGLRenderingContext) {
    const r = new ShowcaseRenderer(gl, background);
    r.setPlacements(placements);
    renderer.current = r;
    let last = performance.now();
    const tick = (now: number) => {
      if (live.current) r.render(Math.min(0.1, (now - last) / 1000));
      last = now;
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }

  return (
    <View style={style} pointerEvents="none">
      <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
    </View>
  );
}
