/**
 * Garage drawer panels: the part inspector (held or selected part), and the
 * Moves, Stats and Saved tabs.
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { PartCell } from '@/components/part-cell';
import { Button, Meter } from '@/components/ui';
import { Colors, Fonts, Spacing } from '@/constants/theme';
import { connectedKeys, MAX_MASS, resolve, validateBuild, type BugStats, type Placement } from '@/game/build';
import { GUIDE } from '@/game/guide';
import { getMove, isUltimate, movesOf, procChance, type MoveId } from '@/game/moves';
import { getPart, PARTS, RARITY_COLOR, type Category, type PartDef } from '@/game/parts';
import { CRIT, dodgeCooldown, maxPoise, reflex } from '@/game/sim';
import type { SavedBug } from '@/state/game-store';

// ---------------------------------------------------------------- inspector

function statLine(part: PartDef) {
  const out: string[] = [`HP ${part.hp}`, `Mass ${part.mass}`, part.power < 0 ? `+${-part.power} power` : `Power ${part.power}`];
  if (part.thrust) out.push(`Thrust ${part.thrust}`);
  if (part.lift) out.push(`Lift ${part.lift}`);
  if (part.grip) out.push(`Grip +${part.grip}`);
  if (part.weapon) out.push(`Dmg ${part.weapon.damage} / ${part.weapon.cooldown}s`, `Reach ${part.weapon.range}`);
  return out.join(' · ');
}

export type InspectorAction = { label: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'go' };

/** What a part is, what it does, its move, and what you can do with it right now. */
export function Inspector({
  part,
  title,
  hint,
  actions,
  onClose,
}: {
  part: PartDef;
  /** e.g. "PLACING" or "ON YOUR BUG". */
  title: string;
  hint?: string;
  actions: InspectorAction[];
  onClose: () => void;
}) {
  const g = GUIDE[part.category];
  const move = part.move ? getMove(part.move) : null;
  return (
    <ScrollView contentContainerStyle={styles.inspector}>
      <View style={styles.inspTop}>
        <PartCell part={part} size={58} />
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={styles.inspTitle}>{title}</Text>
          <Text style={[styles.inspName, { color: RARITY_COLOR[part.rarity] }]} numberOfLines={1}>
            {part.name}
          </Text>
          <Text style={styles.dim}>
            {g.label} · <Text style={{ color: RARITY_COLOR[part.rarity], fontWeight: '800' }}>{part.rarity}</Text>
          </Text>
        </View>
        <Pressable accessibilityLabel="Close" onPress={onClose} style={styles.close}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>
      {hint && <Text style={styles.hint}>{hint}</Text>}
      <View style={styles.actions}>
        {actions.map((a) => (
          <Button key={a.label} label={a.label} size="sm" variant={a.variant ?? 'secondary'} onPress={a.onPress} style={{ flexGrow: 1 }} />
        ))}
      </View>
      {move && (
        <View style={[styles.moveBox, { borderColor: move.color }]}>
          <Text style={[styles.moveName, { color: move.color }]}>
            ★ {move.name}
            <Text style={styles.dim}> · {isUltimate(move.id) ? 'ultimate' : 'quick move'}</Text>
          </Text>
          <Text style={styles.body}>{move.description}</Text>
        </View>
      )}
      <Text style={styles.body}>
        <Text style={styles.key}>DOES </Text>
        {part.description || g.does}
      </Text>
      <Text style={styles.body}>
        <Text style={[styles.key, { color: Colors.good }]}>GOES </Text>
        {g.where}
      </Text>
      <Text style={styles.stats}>{statLine(part)}</Text>
    </ScrollView>
  );
}

// ---------------------------------------------------------------- moves

export function MovesTab({
  placements,
  spareMoveParts,
  onPick,
}: {
  placements: Placement[];
  /** ★ parts you could still add, by move. */
  spareMoveParts: { id: MoveId; parts: PartDef[] }[];
  onPick: (partId: string) => void;
}) {
  const mine = movesOf(placements.map((p) => getPart(p.partId)));
  return (
    <ScrollView contentContainerStyle={styles.tab}>
      <Text style={styles.lead}>
        Moves live on parts. Fit a ★ part and the bug has its move; it fires on its own when the moment is right. Two parts with the same move fire it
        more often. Lose the part in a fight and the move goes with it.
      </Text>
      <Text style={styles.section}>ON THIS BUG · {mine.length}</Text>
      {mine.length === 0 && <Text style={styles.dim}>No moves yet.</Text>}
      {mine.map(({ id, carriers }) => {
        const m = getMove(id);
        const from = placements.map((p) => getPart(p.partId)).filter((p) => p.move === id);
        return (
          <View key={id} style={[styles.moveRow, { borderColor: m.color }]}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 6 }}>
              <Text style={[styles.moveName, { color: m.color }]}>{m.name}</Text>
              <Text style={styles.dim}>
                {Math.round(procChance(id, carriers) * 100)}% · {m.cooldown}s{m.ultimate ? ` · ultimate, ${m.cost} charge` : ''}
              </Text>
            </View>
            <Text style={styles.body}>{m.description}</Text>
            <View style={styles.fromRow}>
              {from.map((p, i) => (
                <PartCell key={i} part={p} size={26} />
              ))}
              <Text style={styles.dim}>
                {' '}
                from {[...new Set(from.map((p) => p.name))].join(', ')}
                {carriers > 1 ? ` (×${carriers})` : ''}
              </Text>
            </View>
          </View>
        );
      })}
      {spareMoveParts.length > 0 && <Text style={[styles.section, { marginTop: Spacing.sm }]}>MORE MOVES IN YOUR BIN · TAP TO ADD</Text>}
      {spareMoveParts.map(({ id, parts }) => {
        const m = getMove(id);
        return (
          <View key={id} style={[styles.moveRow, { borderColor: Colors.border }]}>
            <Text style={[styles.moveName, { color: m.color }]}>{m.name}</Text>
            <Text style={styles.body}>{m.description}</Text>
            <View style={styles.fromRow}>
              {parts.map((p) => (
                <Pressable key={p.id} onPress={() => onPick(p.id)} style={styles.spare}>
                  <PartCell part={p} size={30} />
                  <Text style={styles.spareText}>{p.name}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

// ---------------------------------------------------------------- stats

export type Check = { label: string; short: string; ok: boolean; optional?: boolean; filter?: string };

/** The things a bug needs, as ticks. */
export function buildChecks(placements: Placement[], stats: BugStats): Check[] {
  const parts = resolve(placements);
  const count = (c: Category) => parts.filter((p) => p.part.category === c).length;
  const linked = connectedKeys(parts).size === parts.length;
  const weapons = parts.filter((p) => p.part.weapon).length;
  return [
    { label: count('head') > 1 ? 'Only 1 head' : 'Head', short: count('head') > 1 ? 'Only 1 head' : 'A head', ok: count('head') === 1, filter: 'body' },
    { label: 'Middle body (thorax)', short: 'A thorax', ok: count('thorax') >= 1, filter: 'body' },
    { label: 'Power core', short: 'A power core', ok: count('core') >= 1, filter: 'core' },
    { label: 'Legs or wings', short: 'Legs or wings', ok: stats.thrust > 0, filter: 'legs' },
    { label: 'All parts touching', short: 'All parts touching', ok: linked },
    {
      label: `Power ${stats.powerDraw}/${stats.powerSupply}`,
      short: `Less power (${stats.powerDraw}/${stats.powerSupply})`,
      ok: stats.powerDraw <= stats.powerSupply,
      filter: 'core',
    },
    { label: `Weight ${stats.mass}/${MAX_MASS}`, short: `Less weight (${stats.mass}/${MAX_MASS})`, ok: stats.mass <= MAX_MASS },
    { label: 'A weapon', short: 'A weapon', ok: weapons > 0, optional: true, filter: 'weapons' },
    { label: 'Even legs', short: 'Even legs', ok: Math.abs(stats.thrustBias) <= 0.05, optional: true },
  ];
}

export function StatsTab({ stats, checks }: { stats: BugStats; checks: Check[] }) {
  return (
    <ScrollView contentContainerStyle={styles.tab}>
      <View style={styles.checklist}>
        {checks.map((it) => {
          const color = it.ok ? Colors.good : it.optional ? Colors.accent : Colors.bad;
          return (
            <View key={it.label} style={[styles.check, { borderColor: color }]}>
              <Text style={[styles.checkText, { color }]}>
                {it.ok ? '✓' : it.optional ? '!' : '✗'} {it.label}
              </Text>
            </View>
          );
        })}
      </View>
      <Meter
        label="POWER"
        value={stats.powerDraw}
        max={Math.max(stats.powerSupply, 1)}
        color={stats.powerDraw > stats.powerSupply ? Colors.bad : Colors.good}
        display={`${stats.powerDraw} / ${stats.powerSupply}`}
      />
      <Meter label="WEIGHT" value={stats.mass} max={MAX_MASS} color={stats.mass > MAX_MASS ? Colors.bad : Colors.accent} />
      <View style={styles.statGrid}>
        <Stat k="Speed" v={`${Math.round(stats.topSpeed)}`} />
        <Stat k="Turn" v={stats.turnRate.toFixed(1)} />
        <Stat k="HP" v={`${stats.totalHp}`} />
        <Stat k="DPS" v={stats.dps.toFixed(1)} />
        <Stat k="Reach" v={`×${stats.reach.toFixed(1)}`} />
        <Stat k="Crit" v={`${Math.round((CRIT.base + stats.crit) * 100)}%`} />
        <Stat k="Dodge" v={`${Math.round(reflex(stats) * 100)}%`} />
        <Stat k="Dodge every" v={`${dodgeCooldown(stats).toFixed(1)}s`} />
        <Stat k="Poise" v={`${Math.round(maxPoise(stats))}`} />
        {stats.maxAlt > 0 && <Stat k="Flies" v="yes" />}
      </View>
      {Math.abs(stats.thrustBias) > 0.05 && (
        <Text style={[styles.body, { color: Colors.bad }]}>Uneven legs: the bug pulls to the {stats.thrustBias > 0 ? 'left' : 'right'}.</Text>
      )}
    </ScrollView>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statV}>{v}</Text>
      <Text style={styles.statK}>{k}</Text>
    </View>
  );
}

// ---------------------------------------------------------------- saved

export function SavedTab({
  saved,
  max,
  isCurrent,
  confirm,
  onSave,
  onLoad,
  onDelete,
}: {
  saved: SavedBug[];
  max: number;
  isCurrent: (b: SavedBug) => boolean;
  /** Index waiting for a second tap to delete. */
  confirm: number | null;
  onSave: () => void;
  onLoad: (i: number) => void;
  onDelete: (i: number) => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.tab}>
      <Button label={`💾 Save this build (${saved.length}/${max})`} variant="secondary" onPress={onSave} />
      {saved.length === 0 && <Text style={styles.dim}>Saved builds can be loaded onto any of your bugs later.</Text>}
      {saved.map((b, i) => {
        const ok = validateBuild(b.placements).length === 0;
        const current = isCurrent(b);
        const moves = movesOf(b.placements.map((p) => getPart(p.partId)));
        return (
          <View key={`${b.name}-${i}`} style={[styles.savedRow, current && { borderColor: Colors.accent }]}>
            <Pressable onPress={() => onLoad(i)} style={{ flex: 1, gap: 2 }}>
              <Text style={styles.savedName} numberOfLines={1}>
                {b.name}
                {current ? <Text style={{ color: Colors.accent }}> · on this bug</Text> : null}
              </Text>
              <Text style={styles.dim} numberOfLines={1}>
                {b.placements.length} parts · {moves.length} move{moves.length === 1 ? '' : 's'}
                {ok ? '' : ' · unfinished'}
              </Text>
            </Pressable>
            {!current && <Button label="Load" size="sm" variant="secondary" onPress={() => onLoad(i)} />}
            <Pressable
              accessibilityLabel="Remove saved build"
              onPress={() => onDelete(i)}
              style={[styles.iconBtn, confirm === i && styles.iconBtnWarn]}>
              <Text style={[styles.iconText, confirm === i && { color: Colors.bad, fontSize: 12, fontWeight: '800' }]}>{confirm === i ? 'Delete?' : '✕'}</Text>
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

/** Moves you could add from parts you have spare (not on this bug yet). */
export function spareMoves(placements: Placement[], free: (id: string) => number) {
  const have = new Set(movesOf(placements.map((p) => getPart(p.partId))).map((m) => m.id));
  const out = new Map<MoveId, PartDef[]>();
  for (const p of PARTS) {
    if (!p.move || have.has(p.move) || free(p.id) <= 0) continue;
    out.set(p.move, [...(out.get(p.move) ?? []), p]);
  }
  return [...out].map(([id, parts]) => ({ id, parts }));
}

const styles = StyleSheet.create({
  inspector: { padding: Spacing.md, gap: Spacing.sm, paddingBottom: Spacing.xl * 2 },
  inspTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  inspTitle: { color: Colors.accent, fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  inspName: { fontFamily: Fonts.display, fontSize: 21 },
  close: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.panelHi,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  closeText: { color: Colors.text, fontSize: 16, fontWeight: '800' },
  hint: { color: Colors.good, fontSize: 13, fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  moveBox: { borderWidth: 1.5, borderRadius: 12, padding: Spacing.sm, gap: 2, backgroundColor: Colors.panelHi },
  moveName: { fontSize: 15, fontWeight: '900' },
  body: { color: Colors.text, fontSize: 13, lineHeight: 18 },
  key: { color: Colors.accent, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  stats: { color: Colors.textDim, fontSize: 12, fontVariant: ['tabular-nums'] },
  dim: { color: Colors.textDim, fontSize: 12.5 },
  tab: { padding: Spacing.md, gap: Spacing.sm, paddingBottom: Spacing.xl * 2 },
  lead: { color: Colors.textDim, fontSize: 12.5, lineHeight: 17 },
  section: { color: Colors.accent, fontSize: 11, fontWeight: '900', letterSpacing: 1.4 },
  moveRow: { borderWidth: 1.5, borderRadius: 14, padding: Spacing.sm + 2, gap: 4, backgroundColor: Colors.panel },
  fromRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 },
  spare: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingRight: 10,
    paddingLeft: 3,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: Colors.accentDim,
    backgroundColor: Colors.panelHi,
  },
  spareText: { color: Colors.text, fontSize: 12, fontWeight: '800' },
  checklist: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  check: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  checkText: { fontSize: 12, fontWeight: '700' },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  stat: { backgroundColor: Colors.panelHi, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5, minWidth: 72, alignItems: 'center' },
  statV: { color: Colors.text, fontFamily: Fonts.display, fontSize: 17 },
  statK: { color: Colors.textDim, fontSize: 9.5, fontWeight: '900', letterSpacing: 0.8, textTransform: 'uppercase' },
  savedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.panel,
  },
  savedName: { color: Colors.text, fontSize: 15, fontWeight: '800' },
  iconBtn: {
    minWidth: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.panelHi,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 6,
  },
  iconBtnWarn: { borderColor: Colors.bad, backgroundColor: '#3A1A1D' },
  iconText: { color: Colors.text, fontSize: 15 },
});
