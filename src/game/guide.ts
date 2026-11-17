/**
 * Plain-language guide to the parts: what each kind is, what it does and
 * where it belongs on the bug. Shown throughout the garage.
 */
import type { Category } from './parts';

export type GuideGroup = 'body' | 'move' | 'weapon' | 'system';

export const GROUPS: { id: GuideGroup; title: string; blurb: string }[] = [
  { id: 'body', title: 'BODY', blurb: 'The frame everything bolts onto. You need 1 head and at least 1 thorax, in a line down the middle.' },
  { id: 'move', title: 'MOVEMENT', blurb: 'You need legs or wings. Put the same number of legs on the left and right. Wings can stack on top of the body.' },
  { id: 'weapon', title: 'WEAPONS', blurb: 'They only hit what is in front of them, so mount them at the front.' },
  { id: 'system', title: 'POWER & DEFENSE', blurb: 'At least 1 power core. Armor goes on the outside to shield what is behind it.' },
];

export const GUIDE: Record<Category, { label: string; group: GuideGroup; does: string; where: string }> = {
  head: {
    label: 'Head',
    group: 'body',
    does: 'The cockpit. Every bug needs exactly one. Helps turning.',
    where: 'Front of the spine: centre column, near the top.',
  },
  thorax: {
    label: 'Middle body',
    group: 'body',
    does: 'The thorax is the main frame. Every part must link back to one. Lose them all and the bug falls apart.',
    where: 'Centre column, right behind the head.',
  },
  abdomen: {
    label: 'Tail body',
    group: 'body',
    does: 'The abdomen is an optional rear segment: more health and more room to bolt parts onto.',
    where: 'Centre column, behind the thorax.',
  },
  legs: {
    label: 'Legs',
    group: 'move',
    does: 'Push the bug along and help it turn. More legs = faster.',
    where: 'On the sides of the body, the same number left and right. Uneven legs make the bug pull to one side.',
  },
  wings: {
    label: 'Wings',
    group: 'move',
    does: 'Extra speed, and lift that makes the bug handle like a lighter one. Fragile.',
    where: 'Stack them on top of the thorax (drop them onto it), like real bug wings. Or put them on the sides, mirrored left and right.',
  },
  mandibles: {
    label: 'Jaws',
    group: 'weapon',
    does: 'Fast bites at short range.',
    where: 'At the very front, ahead of the head.',
  },
  pincers: {
    label: 'Pincers',
    group: 'weapon',
    does: 'Heavy, wide-swinging claws. Catch enemies at an angle.',
    where: 'At the front or the front corners. On the sides they point sideways (tap Rotate to turn them).',
  },
  stinger: {
    label: 'Stinger',
    group: 'weapon',
    does: 'Shoots at range in the direction it points: venom darts, or laser bolts from a Prism Cutter.',
    where: 'Front, sides or back: it points outward from wherever you put it (tap Rotate to turn it). A rear stinger lets your bug shoot while backing away.',
  },
  horn: {
    label: 'Horn',
    group: 'weapon',
    does: 'Ramming weapon. A front horn hits harder the faster you charge.',
    where: 'Dead centre at the front for charging; on the sides or back it works as a spiked bumper (tap Rotate to turn it).',
  },
  armor: {
    label: 'Armor',
    group: 'system',
    does: 'A tough plate. Enemies hit the nearest part first, so armor takes the damage for whatever sits behind it.',
    where: 'On the outside, next to what you want to protect: the core, weapons or legs.',
  },
  core: {
    label: 'Power core',
    group: 'system',
    does: 'Supplies the power every other part uses. Lose every core and the bug shuts down.',
    where: 'Tucked in the middle or rear, or stack it: drop it onto a body or armor part to sling it underneath (safe from weapons, but not from acid or crash landings) or put it on top.',
  },
  sensor: {
    label: 'Sensor',
    group: 'system',
    does: 'Sharper turning, longer weapon reach and more critical hits. Fragile.',
    where: 'Stack it on top of the head (drop it onto it), like real antennae. Or use any spare spot.',
  },
};
