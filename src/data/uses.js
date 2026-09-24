// Catalog of building uses. Every building in the town carries a `use` key from this list.
// `category` groups uses for the 15-minute coverage analysis (several uses can satisfy one need).
// `weight` is the Walk Score-style importance of having that category nearby.
// `residentsPerLevelM2` estimates population for residential-type uses (people per m² of floor area).

export const USES = {
  residential:   { label: 'Housing',          color: '#d9c9a8', category: null,          residentsPerLevelM2: 1 / 60, defaultLevels: 2 },
  apartments:    { label: 'Apartments',       color: '#c9a87a', category: null,          residentsPerLevelM2: 1 / 35, defaultLevels: 4 },
  mixed:         { label: 'Mixed-use (shop + flats)', color: '#c48a5a', category: 'shopping', residentsPerLevelM2: 1 / 40, defaultLevels: 3, groundFloorOnly: true },
  grocery:       { label: 'Grocery',          color: '#4caf50', category: 'grocery',     defaultLevels: 1 },
  cafe:          { label: 'Café',             color: '#a0522d', category: 'coffee',      defaultLevels: 1 },
  restaurant:    { label: 'Restaurant',       color: '#e07b39', category: 'restaurant',  defaultLevels: 1 },
  retail:        { label: 'Retail shop',      color: '#e6b422', category: 'shopping',    defaultLevels: 2 },
  pharmacy:      { label: 'Pharmacy',         color: '#26a69a', category: 'pharmacy',    defaultLevels: 1 },
  healthcare:    { label: 'Clinic / doctor',  color: '#ef5350', category: 'healthcare',  defaultLevels: 2 },
  school:        { label: 'School',           color: '#5c6bc0', category: 'school',      defaultLevels: 2 },
  library:       { label: 'Library',          color: '#7e57c2', category: 'library',     defaultLevels: 1 },
  park:          { label: 'Park / green',     color: '#8bc34a', category: 'park',        defaultLevels: 0 },
  gym:           { label: 'Gym / rec center', color: '#ec407a', category: 'recreation',  defaultLevels: 1 },
  bank:          { label: 'Bank',             color: '#78909c', category: 'bank',        defaultLevels: 1 },
  transit:       { label: 'Transit stop',     color: '#29b6f6', category: 'transit',     defaultLevels: 0 },
  office:        { label: 'Office',           color: '#90a4ae', category: 'jobs',        defaultLevels: 3 },
  civic:         { label: 'Town hall / post office', color: '#9575cd', category: 'civic', defaultLevels: 2 },
  church:        { label: 'Church / community', color: '#b0bec5', category: 'civic',     defaultLevels: 1 },
  hotel:         { label: 'Hotel / inn',      color: '#ffab91', category: null,          defaultLevels: 3 },
  industrial:    { label: 'Industrial / warehouse', color: '#8d6e63', category: 'jobs',  defaultLevels: 1 },
  parking:       { label: 'Parking lot',      color: '#616161', category: null,          defaultLevels: 0 },
  vacant:        { label: 'Vacant',           color: '#bdbdbd', category: null,          defaultLevels: 1 },
};

export const USE_KEYS = Object.keys(USES);

// Categories used by the walkability engine. `essential` categories drive the
// "15-minute resident" metric (a home that has ALL essentials within 15 min).
export const CATEGORIES = {
  grocery:    { label: 'Grocery',        weight: 3,   essential: true },
  restaurant: { label: 'Restaurant',     weight: 2,   essential: false },
  coffee:     { label: 'Café',           weight: 1.5, essential: false },
  shopping:   { label: 'Shops',          weight: 2,   essential: false },
  pharmacy:   { label: 'Pharmacy',       weight: 2,   essential: true },
  healthcare: { label: 'Healthcare',     weight: 1.5, essential: true },
  school:     { label: 'School',         weight: 2,   essential: true },
  park:       { label: 'Park',           weight: 2,   essential: true },
  library:    { label: 'Library',        weight: 1,   essential: false },
  recreation: { label: 'Gym / rec',      weight: 1,   essential: false },
  bank:       { label: 'Bank',           weight: 0.5, essential: false },
  transit:    { label: 'Transit',        weight: 1.5, essential: true },
  civic:      { label: 'Civic',          weight: 0.5, essential: false },
  jobs:       { label: 'Jobs',           weight: 1,   essential: false },
};

export const CATEGORY_KEYS = Object.keys(CATEGORIES);

export const WALK_SPEED_M_PER_MIN = 80; // ~4.8 km/h, typical planning assumption
export const FIFTEEN_MIN_M = 15 * WALK_SPEED_M_PER_MIN; // 1200 m

export function isResidential(use) {
  return !!USES[use]?.residentsPerLevelM2;
}

/** Estimated residents of a building given its use, footprint (m²) and levels. */
export function estimateResidents(use, footprintM2, levels) {
  const u = USES[use];
  if (!u?.residentsPerLevelM2) return 0;
  const floors = u.groundFloorOnly ? Math.max(0, levels - 1) : Math.max(1, levels);
  return Math.max(1, Math.round(footprintM2 * floors * u.residentsPerLevelM2));
}
