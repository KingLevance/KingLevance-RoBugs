/**
 * RoBugs part catalog. All names and designs are original to RoBugs.
 *
 * Units are arbitrary "sim units": mass in grams-ish, hp in points,
 * thrust in sim-force, ranges in world pixels (1 grid cell = CELL px).
 */
import type { MoveId } from './moves';

export type Category =
  | 'head'
  | 'thorax'
  | 'abdomen'
  | 'legs'
  | 'wings'
  | 'mandibles'
  | 'stinger'
  | 'pincers'
  | 'horn'
  | 'armor'
  | 'core'
  | 'sensor';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic';

/** Body segments form the chassis spine; everything else attaches to them. */
export const BODY_CATEGORIES: readonly Category[] = ['head', 'thorax', 'abdomen'];
export const WEAPON_CATEGORIES: readonly Category[] = ['mandibles', 'stinger', 'pincers', 'horn'];

export type WeaponStats = {
  damage: number;
  /** Reach measured from the weapon cell to the nearest enemy part. */
  range: number;
  /** Seconds between strikes. */
  cooldown: number;
  /** Half-angle (radians) of the cone in front of the bug this weapon can hit. */
  arc: number;
  /** Ranged weapons fire a projectile instead of striking instantly. */
  projectileSpeed?: number;
  /** Horns: bonus damage per unit of closing speed when ramming. */
  ramBonus?: number;
  /** Lasers: the shot is a bolt of light (very fast; drawn as a beam). */
  beam?: boolean;
  /** Vampiric: this share of the damage dealt heals the attacker's most damaged parts. */
  drain?: number;
  /** Gripping claws: a hit pins the victim, so it can't dodge for this many seconds. */
  grip?: number;
};

/** Special hardware a signature move can need (see MoveDef.requires). */
export type PartTag = 'venom' | 'silk' | 'spider' | 'dig' | 'cloak' | 'laser' | 'shock' | 'drain' | 'scorpion' | 'grip' | 'storm';

export type PartDef = {
  id: string;
  name: string;
  category: Category;
  rarity: Rarity;
  description: string;
  hp: number;
  mass: number;
  /** Positive = consumes power. Cores have negative draw (they supply). */
  power: number;
  /** Legs / wings: forward drive force. */
  thrust?: number;
  /** Legs / sensors: turning responsiveness. */
  grip?: number;
  /** Wings: offsets carried mass (soft weight budget). */
  lift?: number;
  weapon?: WeaponStats;
  /** Extra critical-hit chance (0..1). */
  crit?: number;
  tag?: PartTag;
  /** The signature move this part carries: any bug with this part attached has the move. */
  move?: MoveId;
};

const deg = (d: number) => (d * Math.PI) / 180;

export const PARTS: readonly PartDef[] = [
  // ── Body segments ───────────────────────────────────────────────
  { id: 'head-scout', name: 'Scout Dome', category: 'head', rarity: 'common', description: 'Basic cockpit dome. Every bug needs exactly one head.', hp: 40, mass: 6, power: 1, grip: 0.4 },
  { id: 'head-visor', name: 'Prism Visor', category: 'head', rarity: 'rare', description: 'Faceted head with wide-angle optics. Better turning, tougher shell.', hp: 60, mass: 7, power: 2, grip: 0.9, move: 'mark-prey' },
  { id: 'head-octo', name: 'Octo-Eye Head', category: 'head', rarity: 'uncommon', description: 'Eight unblinking lenses. Spots weak points: +5% critical-hit chance.', hp: 50, mass: 6, power: 2, grip: 0.6, crit: 0.05 },
  { id: 'thorax-tin', name: 'Tinshell Thorax', category: 'thorax', rarity: 'common', description: 'Core frame segment. Lose all thoraxes and your bug falls apart.', hp: 70, mass: 10, power: 0 },
  { id: 'thorax-chitin', name: 'Burnished Thorax', category: 'thorax', rarity: 'uncommon', description: 'Heat-treated frame segment with extra plating.', hp: 100, mass: 12, power: 0 },
  { id: 'abdomen-tin', name: 'Coil Abdomen', category: 'abdomen', rarity: 'common', description: 'Rear segment. Extra mounting points.', hp: 50, mass: 7, power: 0 },
  { id: 'abdomen-spinner', name: 'Silk Spinneret', category: 'abdomen', rarity: 'uncommon', description: 'A silk gland with a nozzle at the back.', hp: 60, mass: 8, power: 1, tag: 'silk', move: 'web-snare' },
  { id: 'abdomen-tank', name: 'Ballast Abdomen', category: 'abdomen', rarity: 'uncommon', description: 'Dense rear segment that soaks hits.', hp: 90, mass: 12, power: 0 },

  // ── Locomotion ─────────────────────────────────────────────────
  { id: 'legs-spindle', name: 'Spindle Legs', category: 'legs', rarity: 'common', description: 'Thin wire legs. Light, quick, fragile.', hp: 25, mass: 3, power: 1, thrust: 26, grip: 0.5, move: 'skitter-dash' },
  { id: 'legs-strider', name: 'Piston Striders', category: 'legs', rarity: 'uncommon', description: 'Hydraulic legs with strong push.', hp: 40, mass: 5, power: 2, thrust: 38, grip: 0.6, move: 'skitter-dash' },
  { id: 'legs-crawler', name: 'Grapple Crawlers', category: 'legs', rarity: 'rare', description: 'Hooked feet that grip the floor for sharp turns.', hp: 50, mass: 6, power: 2, thrust: 34, grip: 1.1, move: 'anchor-grip' },
  { id: 'legs-weaver', name: 'Weaver Legs', category: 'legs', rarity: 'rare', description: 'Long, arched spider legs. Sure-footed, and webs barely slow them.', hp: 40, mass: 4, power: 2, thrust: 36, grip: 1.0, tag: 'spider' },
  { id: 'wings-foil', name: 'Foil Wings', category: 'wings', rarity: 'common', description: 'Buzzing film wings. Add lift and a burst of speed.', hp: 15, mass: 2, power: 2, thrust: 16, lift: 12, move: 'gale-flap' },
  { id: 'wings-glass', name: 'Glasswing Rotors', category: 'wings', rarity: 'epic', description: 'Shimmering rotor-wings. Huge lift, very fragile.', hp: 20, mass: 2, power: 3, thrust: 26, lift: 22, move: 'dive-bomb' },

  // ── Weapons ────────────────────────────────────────────────────
  { id: 'mand-gnash', name: 'Gnasher Jaws', category: 'mandibles', rarity: 'common', description: 'Chomping jaws. Short reach, steady damage.', hp: 35, mass: 4, power: 2, weapon: { damage: 9, range: 34, cooldown: 0.6, arc: deg(50) }, move: 'mandible-crusher' },
  { id: 'mand-shear', name: 'Shearfang Jaws', category: 'mandibles', rarity: 'rare', description: 'Serrated scissor jaws that bite deep.', hp: 45, mass: 5, power: 3, weapon: { damage: 16, range: 36, cooldown: 0.7, arc: deg(45) }, move: 'mandible-crusher' },
  { id: 'mand-proboscis', name: 'Siphon Proboscis', category: 'mandibles', rarity: 'rare', description: 'A mosquito needle. Every hit heals your bug for 60% of the damage.', hp: 30, mass: 3, power: 2, tag: 'drain', weapon: { damage: 11, range: 44, cooldown: 0.65, arc: deg(30), drain: 0.6 }, move: 'blood-siphon' },
  { id: 'sting-dart', name: 'Dart Stinger', category: 'stinger', rarity: 'uncommon', description: 'Fires corrosive darts at range.', hp: 25, mass: 3, power: 3, tag: 'venom', weapon: { damage: 10, range: 190, cooldown: 1.0, arc: deg(20), projectileSpeed: 320 }, move: 'venom-barrage' },
  { id: 'sting-lance', name: 'Arc Lance Stinger', category: 'stinger', rarity: 'epic', description: 'Overcharged stinger. Heavy darts, long reload.', hp: 35, mass: 4, power: 5, tag: 'venom', weapon: { damage: 18, range: 220, cooldown: 1.6, arc: deg(18), projectileSpeed: 380 }, move: 'venom-barrage' },
  { id: 'pinc-clamp', name: 'Clamp Pincers', category: 'pincers', rarity: 'common', description: 'Wide-sweeping claws that crush.', hp: 40, mass: 5, power: 2, weapon: { damage: 12, range: 40, cooldown: 0.9, arc: deg(70) }, move: 'vise-lock' },
  { id: 'pinc-vise', name: 'Hydra-Vise Pincers', category: 'pincers', rarity: 'rare', description: 'Hydraulic claws with a brutal squeeze.', hp: 55, mass: 7, power: 3, weapon: { damage: 20, range: 42, cooldown: 1.0, arc: deg(65) }, move: 'vise-lock' },
  { id: 'horn-nub', name: 'Bumper Horn', category: 'horn', rarity: 'common', description: 'Blunt horn. Deals damage when you ram at speed.', hp: 50, mass: 5, power: 0, weapon: { damage: 4, range: 26, cooldown: 0.5, arc: deg(30), ramBonus: 0.12 }, move: 'ram-charge' },
  { id: 'horn-drill', name: 'Auger Horn', category: 'horn', rarity: 'epic', description: 'Spinning drill horn. Devastating rams.', hp: 70, mass: 7, power: 3, weapon: { damage: 8, range: 28, cooldown: 0.4, arc: deg(30), ramBonus: 0.25 }, move: 'ram-charge' },

  { id: 'sting-laser', name: 'Prism Cutter', category: 'stinger', rarity: 'rare', description: 'A focusing lens that spits rapid bolts of light.', hp: 30, mass: 4, power: 4, tag: 'laser', weapon: { damage: 7, range: 210, cooldown: 0.45, arc: deg(16), projectileSpeed: 900, beam: true }, move: 'sunder-beam' },
  { id: 'pinc-digger', name: 'Mole Diggers', category: 'pincers', rarity: 'uncommon', description: 'Broad shovel claws.', hp: 60, mass: 7, power: 2, tag: 'dig', weapon: { damage: 10, range: 36, cooldown: 0.8, arc: deg(60) }, move: 'burrow-strike' },
  { id: 'sting-tail', name: 'Barbed Tail', category: 'stinger', rarity: 'epic', description: 'A scorpion tail that arcs right over your own body to stab. Melee, very long reach, hits hard but slowly: mount it at the back.', hp: 50, mass: 5, power: 3, tag: 'scorpion', weapon: { damage: 22, range: 76, cooldown: 1.3, arc: deg(35) }, move: 'skewer' },
  { id: 'pinc-grip', name: 'Gripper Claws', category: 'pincers', rarity: 'rare', description: 'Big scorpion claws that clamp on. A hit pins the enemy: it can\'t dodge for 1.5 seconds.', hp: 60, mass: 7, power: 3, tag: 'grip', weapon: { damage: 15, range: 46, cooldown: 1.0, arc: deg(65), grip: 1.5 } },
  { id: 'horn-shock', name: 'Tesla Prongs', category: 'horn', rarity: 'rare', description: 'Twin prongs that zap on contact.', hp: 45, mass: 5, power: 3, tag: 'shock', weapon: { damage: 7, range: 30, cooldown: 0.6, arc: deg(40) }, move: 'static-burst' },

  // ── Defense & systems ──────────────────────────────────────────
  { id: 'armor-hex', name: 'Hex Plate', category: 'armor', rarity: 'common', description: 'Bolt-on plate. Place it on the edges to shield inner parts.', hp: 80, mass: 6, power: 0 },
  { id: 'armor-ceramic', name: 'Lacquer Plate', category: 'armor', rarity: 'uncommon', description: 'Lighter, tougher layered plate.', hp: 110, mass: 6, power: 0, move: 'carapace-lock' },
  { id: 'armor-aegis', name: 'Bastion Plate', category: 'armor', rarity: 'rare', description: 'Thick slab of alloy. Heavy but nearly unbreakable.', hp: 170, mass: 10, power: 0, move: 'carapace-lock' },
  { id: 'armor-mirage', name: 'Mirage Plate', category: 'armor', rarity: 'rare', description: 'Light-bending plating.', hp: 90, mass: 5, power: 2, tag: 'cloak', move: 'ghost-shell' },
  { id: 'core-cell', name: 'Glowcell Core', category: 'core', rarity: 'common', description: 'Supplies 10 power. Lose every core and your bug shuts down.', hp: 45, mass: 5, power: -10 },
  { id: 'core-fusion', name: 'Ember Core', category: 'core', rarity: 'rare', description: 'Supplies 16 power in the same space.', hp: 55, mass: 6, power: -16, move: 'overclock' },
  { id: 'sensor-antenna', name: 'Feeler Antennae', category: 'sensor', rarity: 'common', description: 'Improves turning, extends weapon reach by 10% and adds 4% critical-hit chance.', hp: 15, mass: 1, power: 1, grip: 0.5 },
  { id: 'sensor-radar', name: 'Echo Array', category: 'sensor', rarity: 'rare', description: 'Sweeping sensor dish. Big turning and reach bonus, plus 7% critical-hit chance.', hp: 25, mass: 2, power: 2, grip: 0.9, move: 'mark-prey' },

  // ── Storm Peaks (zone 4): each carries a move ───────────────────
  { id: 'head-coil', name: 'Coil Crown', category: 'head', rarity: 'rare', description: 'A copper coil crown that crackles with stored charge.', hp: 50, mass: 7, power: 3, grip: 0.6, tag: 'storm', move: 'chain-spark' },
  { id: 'head-mirror', name: 'Mirror Crown', category: 'head', rarity: 'rare', description: 'A polished, faceted crown that throws light around.', hp: 55, mass: 7, power: 2, grip: 0.7, tag: 'storm', move: 'mirror-ward' },
  { id: 'thorax-anvil', name: 'Anvil Thorax', category: 'thorax', rarity: 'rare', description: 'A thick iron frame segment. Heavy, and very hard to break.', hp: 150, mass: 18, power: 1, tag: 'storm', move: 'quake-stomp' },
  { id: 'abdomen-hive', name: 'Hive Abdomen', category: 'abdomen', rarity: 'epic', description: 'A humming nest of tiny drones.', hp: 70, mass: 9, power: 3, tag: 'storm', move: 'hornet-swarm' },
  { id: 'abdomen-smog', name: 'Smog Bladder', category: 'abdomen', rarity: 'uncommon', description: 'A rubbery sac full of black smoke.', hp: 65, mass: 7, power: 1, tag: 'storm', move: 'ink-cloud' },
  { id: 'legs-hopper', name: 'Spring Hoppers', category: 'legs', rarity: 'uncommon', description: 'Coiled grasshopper legs. Quick, and they can leap.', hp: 35, mass: 4, power: 2, thrust: 34, grip: 0.6, tag: 'storm', move: 'pounce' },
  { id: 'wings-blade', name: 'Razor Wings', category: 'wings', rarity: 'rare', description: 'Stiff, sharp-edged wings built for diving.', hp: 25, mass: 3, power: 3, thrust: 20, lift: 16, tag: 'storm', move: 'dive-bomb' },
  { id: 'horn-gavel', name: 'Gavel Horn', category: 'horn', rarity: 'rare', description: 'A hammer-headed horn. Rams hit hard and knock the enemy flying.', hp: 60, mass: 7, power: 2, tag: 'storm', weapon: { damage: 6, range: 28, cooldown: 0.5, arc: deg(30), ramBonus: 0.2 }, move: 'ram-charge' },
  { id: 'sting-needle', name: 'Needle Gun', category: 'stinger', rarity: 'uncommon', description: 'A rapid-fire stinger: streams of light darts.', hp: 25, mass: 3, power: 3, tag: 'storm', weapon: { damage: 5, range: 170, cooldown: 0.4, arc: deg(18), projectileSpeed: 360 }, move: 'mark-prey' },
  { id: 'armor-thorn', name: 'Thornback Plate', category: 'armor', rarity: 'uncommon', description: 'A plate covered in spring-loaded thorns.', hp: 95, mass: 7, power: 1, tag: 'storm', move: 'thorn-bloom' },
  { id: 'core-lodestone', name: 'Lodestone Core', category: 'core', rarity: 'rare', description: 'Supplies 13 power, and a magnetic field strong enough to drag a bug.', hp: 55, mass: 7, power: -13, tag: 'storm', move: 'magnet-pull' },
  { id: 'sensor-beacon', name: 'Beacon Antenna', category: 'sensor', rarity: 'uncommon', description: 'A repair beacon on a stalk. Helps turning a little.', hp: 20, mass: 1, power: 1, grip: 0.4, tag: 'storm', move: 'rally-pulse' },
];

const PART_INDEX: Record<string, PartDef> = Object.fromEntries(PARTS.map((p) => [p.id, p]));

export function getPart(id: string): PartDef {
  const p = PART_INDEX[id];
  if (!p) throw new Error(`Unknown part ${id}`);
  return p;
}

export function isBody(c: Category) {
  return BODY_CATEGORIES.includes(c);
}

export const RARITY_COLOR: Record<Rarity, string> = {
  common: '#9AA3AE',
  uncommon: '#5FD38D',
  rare: '#4FA8FF',
  epic: '#C77DFF',
};

/** Fill color per category, used for the simple top-down sprites. */
export const CATEGORY_COLOR: Record<Category, string> = {
  head: '#F2C14E',
  thorax: '#E07A3F',
  abdomen: '#C85A3A',
  legs: '#6C7A89',
  wings: '#8ED1E6',
  mandibles: '#E5484D',
  stinger: '#B65BE0',
  pincers: '#D9534F',
  horn: '#E8E2D0',
  armor: '#4B5563',
  core: '#3DDC97',
  sensor: '#7FB3FF',
};

/** Two-letter glyph drawn on a part cell. */
export const CATEGORY_GLYPH: Record<Category, string> = {
  head: 'Hd',
  thorax: 'Th',
  abdomen: 'Ab',
  legs: 'Lg',
  wings: 'Wg',
  mandibles: 'Mn',
  stinger: 'St',
  pincers: 'Pc',
  horn: 'Hn',
  armor: 'Ar',
  core: 'Co',
  sensor: 'Se',
};
