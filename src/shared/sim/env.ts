import type { AsteroidField, PlanetDef, StarDef, StationDef } from '../galaxy/system-gen.ts';

/** Static world geometry the movement simulation collides with. */
export interface SimEnv {
  star: StarDef;
  planets: PlanetDef[];
  fields: AsteroidField[];
  station: StationDef;
  /** Simulation time (s): orients rotating planet frames when a ship changes frame. */
  time: number;
}
