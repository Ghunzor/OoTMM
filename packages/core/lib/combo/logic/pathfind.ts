import { cloneDeep } from 'lodash';
import { Settings } from '../settings';
import { AreaData, Expr, ExprResult, MM_TIME_SLICES, isDefaultRestrictions } from './expr';

import { Location, locationData, makeLocation } from './locations';
import { World, WorldOptimized, optimizedWorldView } from './world';
import { isLocationLicenseGranting, isLocationRenewable } from './locations';
import { ItemPlacement } from './solve';
import { countMapAdd } from '../util';
import { Item, Items, ItemsCount, PlayerItems } from '../items';

export const AGES = ['child', 'adult'] as const;

export type Age = typeof AGES[number];

const recursiveForEach = <T>(arr: any, cb: (x: T) => void) => {
  if (Array.isArray(arr)) {
    for (const x of arr) {
      recursiveForEach(x, cb);
    }
  } else {
    cb(arr);
  }
}

type PathfinderDependencyList = {
  locations: Set<string>;
  events: Set<string>;
  gossips: Set<string>;
  exits: Set<string>;
};

type PathfinderDependencySet<T> = Map<T, Map<string, PathfinderDependencyList>>;

type PathfinderDependencies = {
  items: PathfinderDependencySet<Item>;
  events: PathfinderDependencySet<string>;
};

type PathfinderQueues = {
  locations: Map<string, Set<string>>;
  events: Map<string, Set<string>>;
  gossips: Map<string, Set<string>>;
  exits: Map<string, Set<string>>;
};

type PathfinderAgeState = {
  queues: PathfinderQueues;
  areas: Map<string, AreaData>;
  dependencies: PathfinderDependencies;
};

type PathfinderWorldState = {
  ages: {
    child: PathfinderAgeState;
    adult: PathfinderAgeState;
  },
  uncollectedLocations: Set<string>;
  items: ItemsCount;
  licenses: ItemsCount;
  renewables: ItemsCount;
  forbiddenReachableLocations: Set<string>;
  events: Set<string>;
  restrictedLocations?: Set<string>;
  forbiddenLocations?: Set<string>;
}

export type PathfinderState = {
  goal: boolean;
  ganonMajora: boolean;
  changed: boolean;
  started: boolean;
  ws: PathfinderWorldState[];
  previousAssumedItems: PlayerItems;

  /* Output */
  locations: Set<Location>;
  newLocations: Set<Location>;
  gossips: Set<string>[];
}

const emptyDepList = (): PathfinderDependencyList => ({
  locations: new Set(),
  events: new Set(),
  gossips: new Set(),
  exits: new Set(),
});

const defaultAgeState = (): PathfinderAgeState => ({
  queues: {
    locations: new Map(),
    events: new Map(),
    gossips: new Map(),
    exits: new Map(),
  },
  areas: new Map(),
  dependencies: {
    items: new Map(),
    events: new Map(),
  },
});

const defaultWorldState = (startingItems: ItemsCount): PathfinderWorldState => ({
  ages: {
    child: defaultAgeState(),
    adult: defaultAgeState(),
  },
  uncollectedLocations: new Set(),
  items: new Map(startingItems),
  licenses: new Map(startingItems),
  renewables: new Map(),
  forbiddenReachableLocations: new Set(),
  events: new Set(),
});

const defaultWorldStates = (startingItems: PlayerItems, worldCount: number) => {
  const ws: PathfinderWorldState[] = [];

  for (let world = 0; world < worldCount; ++world) {
    const itemCount: ItemsCount = new Map;
    for (const [pi, count] of startingItems) {
      if (pi.player === world) {
        itemCount.set(pi.item, count);
      }
    }
    ws.push(defaultWorldState(itemCount));
  }

  return ws;
}

const defaultState = (startingItems: PlayerItems, worldCount: number): PathfinderState => {
  const gossips: Set<string>[] = [];

  for (let world = 0; world < worldCount; ++world) {
    gossips.push(new Set());
  }

  return {
    previousAssumedItems: new Map,
    changed: false,
    goal: false,
    ganonMajora: false,
    started: false,
    ws: defaultWorldStates(startingItems, worldCount),
    locations: new Set(),
    newLocations: new Set(),
    gossips,
  };
};

const defaultAreaData = (): AreaData => ({
  oot: {
    day: false,
    night: false,
  },
  mmTime: 0,
  mmTime2: 0,
  flagsOn: 0,
  flagsOff: 0,
});

const mergeAreaData = (a: AreaData, b: AreaData): AreaData => ({
  oot: {
    day: a.oot.day || b.oot.day,
    night: a.oot.night || b.oot.night,
  },
  mmTime: (a.mmTime | b.mmTime) >>> 0,
  mmTime2: (a.mmTime2 | b.mmTime2) >>> 0,
  flagsOn: (a.flagsOn & b.flagsOn) >>> 0,
  flagsOff: (a.flagsOff & b.flagsOff) >>> 0,
});

const coveringAreaData = (a: AreaData, b: AreaData): boolean => {
  if (!a.oot.day && b.oot.day) return false;
  if (!a.oot.night && b.oot.night) return false;
  if (((a.mmTime | b.mmTime) >>> 0) !== a.mmTime) return false;
  if (((a.mmTime2 | b.mmTime2) >>> 0) !== a.mmTime2) return false;
  if (((a.flagsOn & b.flagsOn) >>> 0) !== a.flagsOn) return false;
  if (((a.flagsOff & b.flagsOff) >>> 0) !== a.flagsOff) return false;
  return true;
}

const cloneAreaData = (a: AreaData): AreaData => ({
  oot: {
    day: a.oot.day,
    night: a.oot.night,
  },
  mmTime: a.mmTime,
  mmTime2: a.mmTime2,
  flagsOn: a.flagsOn,
  flagsOff: a.flagsOff,
});

export type EntranceOverrides = {[k: string]: {[k: string]: string | null}};
type PathfinderOptions = {
  assumedItems?: PlayerItems;
  items?: ItemPlacement;
  ignoreItems?: boolean;
  recursive?: boolean;
  stopAtGoal?: boolean;
  restrictedLocations?: Set<Location>;
  forbiddenLocations?: Set<Location>;
  includeForbiddenReachable?: boolean;
  gossips?: boolean;
  inPlace?: boolean;
  singleWorld?: number;
  ganonMajora?: boolean;
};

export class Pathfinder {
  private opts!: PathfinderOptions;
  private state!: PathfinderState;
  private worldsOptimized: WorldOptimized[];

  constructor(
    private readonly worlds: World[],
    private readonly settings: Settings,
    private readonly startingItems: PlayerItems,
  ) {
    this.worldsOptimized = worlds.map(world => optimizedWorldView(world));
  }

  run(state: PathfinderState | null, opts?: PathfinderOptions) {
    this.opts = opts || {};
    this.state = state ? (this.opts.inPlace ? state : cloneDeep(state)) : defaultState(this.startingItems, this.worlds.length);

    /* Restricted locations */
    if (this.opts.restrictedLocations) {
      for (let world = 0; world < this.worlds.length; ++world) {
        this.state.ws[world].restrictedLocations = new Set();
      }

      for (const loc of this.opts.restrictedLocations) {
        const locD = locationData(loc);
        this.state.ws[locD.world as number].restrictedLocations!.add(locD.id);
      }
    } else {
      for (let world = 0; world < this.worlds.length; ++world) {
        this.state.ws[world].restrictedLocations = undefined;
      }
    }

    /* Forbidden locations */
    if (this.opts.forbiddenLocations) {
      for (let world = 0; world < this.worlds.length; ++world) {
        this.state.ws[world].forbiddenLocations = new Set();
      }

      for (const loc of this.opts.forbiddenLocations) {
        const locD = locationData(loc);
        this.state.ws[locD.world as number].forbiddenLocations!.add(locD.id);
      }
    } else {
      for (let world = 0; world < this.worlds.length; ++world) {
        this.state.ws[world].forbiddenLocations = undefined;
      }
    }

    this.pathfind();
    return this.state;
  }

  private queue(type: 'locations' | 'events' | 'exits' | 'gossips', age: Age, world: number, id: string, area: string) {
    const q = this.state.ws[world].ages[age].queues[type];
    if (!q.has(id)) {
      q.set(id, new Set([area]));
    } else {
      q.get(id)!.add(area);
    }
  }

  /**
   * Explore an area, adding all locations and events to the queue
   */
  private exploreArea(worldId: number, age: Age, area: string, sourceAreaData: AreaData, fromArea: string) {
    /* Compute the previous area data and compare it to the old one */
    const world = this.worlds[worldId];
    const ws = this.state.ws[worldId];
    const as = ws.ages[age];
    const previousAreaData = as.areas.get(area);
    const newAreaData = previousAreaData ? mergeAreaData(previousAreaData, sourceAreaData) : sourceAreaData;
    const worldArea = world.areas[area];
    const worldOptimized = this.worldsOptimized[worldId][age];
    const worldAreaOptimized = worldOptimized[area];

    if (worldArea === undefined) {
      throw new Error(`Unknown area ${area}`);
    }
    if (worldArea.game === 'oot') {
      if (['day', 'flow'].includes(worldArea.time)) {
        newAreaData.oot.day = true;
      }
      if (['night', 'flow'].includes(worldArea.time)) {
        newAreaData.oot.night = true;
      }
    } else {
      /* MM: Expand the time range */
      if (newAreaData.mmTime === 0 && newAreaData.mmTime2 === 0) {
        return;
      }

      /* If we come from OoT, we can song of time to get back to day 1 */
      const fa = world.areas[fromArea];
      if (fa.game === 'oot') {
        newAreaData.mmTime = (newAreaData.mmTime | (1 << 0)) >>> 0;
      }

      if (worldAreaOptimized.stay === null) {
        /* We can wait to reach later time slices */
        let earliest: number;
        if (newAreaData.mmTime) {
          earliest = Math.floor(Math.log2(newAreaData.mmTime));
        } else {
          earliest = Math.floor(Math.log2(newAreaData.mmTime2)) + 32;
        }
        for (let i = earliest; i < MM_TIME_SLICES.length; ++i) {
          if (i < 32) {
            newAreaData.mmTime = (newAreaData.mmTime | (1 << i)) >>> 0;
          } else {
            newAreaData.mmTime2 = (newAreaData.mmTime2 | (1 << (i - 32))) >>> 0;
          }
        }
      } else {
        /* We can wait but there are conditions */
        let waitMode = false;

        for (let i = 0; i < MM_TIME_SLICES.length; ++i) {
          const mask1 = (i < 32) ? (1 << i) >>> 0 : 0;
          const mask2 = (i < 32) ? 0 : (1 << ((i - 32) >>> 0)) >>> 0;
          if ((newAreaData.mmTime & mask1) || (newAreaData.mmTime2 & mask2)) {
            waitMode = true;
          } else if (waitMode) {
            const stayExpr = worldAreaOptimized.stay![i];
            const result = this.evalExpr(worldId, stayExpr, age, area);
            if (result.result) {
              waitMode = true;
              newAreaData.mmTime = (newAreaData.mmTime | mask1) >>> 0;
              newAreaData.mmTime2 = (newAreaData.mmTime2 | mask2) >>> 0;
            } else {
              /* We can't wait! */
              waitMode = false;
              const d = this.getDeps([result]);
              this.addDependencies('exits', as.dependencies.items, area, fromArea, d.items);
              this.addDependencies('exits', as.dependencies.events, area, fromArea, d.events);
            }
          }
        }
      }
    }

    /* Age swap */
    if (ws.events.has('OOT_TIME_TRAVEL_AT_WILL') && worldArea.ageChange && area !== fromArea) {
      const otherAge = age === 'child' ? 'adult' : 'child';
      this.exploreArea(worldId, otherAge, area, newAreaData, area);
    }

    if (previousAreaData && coveringAreaData(previousAreaData, newAreaData)) {
      return;
    }
    as.areas.set(area, newAreaData);
    let locs = Object.keys(worldAreaOptimized.locations).filter(x => !this.state.locations.has(makeLocation(x, worldId)));
    if (ws.restrictedLocations && !this.opts.includeForbiddenReachable) {
      locs = locs.filter(x => ws.restrictedLocations!.has(x));
    }
    if (ws.forbiddenLocations && !this.opts.includeForbiddenReachable) {
      locs = locs.filter(x => !ws.forbiddenLocations!.has(x));
    }

    locs.forEach(x => this.queue('locations', age, worldId, x, area));
    Object.keys(worldAreaOptimized.events).filter(x => !ws.events.has(x)).forEach(x => this.queue('events', age, worldId, x, area));
    const exits = Object.keys(worldAreaOptimized.exits);
    exits.forEach(x => this.queue('exits', age, worldId, x, area));

    if (this.opts.gossips) {
      Object.keys(worldAreaOptimized.gossip).forEach(x => this.queue('gossips', age, worldId, x, area));
    }
  }

  private evalExpr(worldId: number, expr: Expr, age: Age, area: string) {
    const world = this.worlds[worldId];
    const ws = this.state.ws[worldId];
    const as = ws.ages[age];
    const areaData = as.areas.get(area)!;
    const state = { settings: this.settings, world, areaData, items: ws.items, renewables: ws.renewables, licenses: ws.licenses, age, events: ws.events, ignoreItems: this.opts.ignoreItems || false };
    const result = expr.eval(state);
    if (result.result) {
      if (!result.restrictions || isDefaultRestrictions(result.restrictions)) {
        result.depItems = [];
        result.depEvents = [];
      }
    }
    return result;
  }

  private dependenciesLookup<T>(set: PathfinderDependencySet<T>, dependency: T, areaFrom: string) {
    let data1 = set.get(dependency);
    if (!data1) {
      data1 = new Map();
      set.set(dependency, data1);
    }

    let data2 = data1.get(areaFrom);
    if (!data2) {
      data2 = emptyDepList();
      data1.set(areaFrom, data2);
    }

    return data2;
  }

  private addDependencies<T>(type: 'exits' | 'locations' | 'events' | 'gossips', set: PathfinderDependencySet<T>, id: string, area: string, dependents: Set<T>) {
    for (const dep of dependents) {
      const data = this.dependenciesLookup(set, dep, area);
      data[type].add(id);
    }
  }

  private requeueItem(worldId: number, item: Item) {
    const ws = this.state.ws[worldId];
    for (const age of AGES) {
      const as = ws.ages[age];
      const deps = as.dependencies.items.get(item);
      if (deps) {
        as.dependencies.items.delete(item);
        for (const [area, d] of deps) {
          d.exits.forEach(x => this.queue('exits', age, worldId, x, area));
          d.events.forEach(x => this.queue('events', age, worldId, x, area));
          d.locations.forEach(x => this.queue('locations', age, worldId, x, area));
          if (this.opts.gossips) {
            d.gossips.forEach(x => this.queue('gossips', age, worldId, x, area));
          }
        }
      }
    }
  }

  private addLocationDelayed(worldId: number, loc: string) {
    if (this.opts.recursive) {
      this.addLocation(worldId, loc);
    } else {
      const globalLoc = makeLocation(loc, worldId);
      this.state.locations.add(globalLoc);
      this.state.newLocations.add(globalLoc);
    }
  }

  private addLocation(worldId: number, loc: string) {
    const ws = this.state.ws[worldId];
    const world = this.worlds[worldId];
    const globalLoc = makeLocation(loc, worldId);
    this.state.locations.add(globalLoc);
    const playerItem = this.opts.items?.get(globalLoc);
    if (playerItem) {
      const otherWs = this.state.ws[playerItem.player];
      ws.uncollectedLocations.delete(loc);
      countMapAdd(otherWs.items, playerItem.item);
      if (isLocationRenewable(world, globalLoc)) {
        countMapAdd(otherWs.renewables, playerItem.item);
      }
      if (isLocationLicenseGranting(world, globalLoc))
        countMapAdd(otherWs.licenses, playerItem.item);
      this.requeueItem(playerItem.player, playerItem.item);
    } else {
      ws.uncollectedLocations.add(loc);
    }
  }

  private evalExits(worldId: number, age: Age) {
    /* Extract the queue */
    const ws = this.state.ws[worldId];
    const as = ws.ages[age];
    const queue = as.queues.exits;
    as.queues.exits = new Map();
    const areasOptimized = this.worldsOptimized[worldId][age];

    /* Evaluate all the exits */
    for (const [exit, areas] of queue) {
      for (const area of areas) {
        const aOptimized = areasOptimized[area];
        const expr = aOptimized.exits[exit];
        const exprResult = this.evalExpr(worldId, expr, age, area);

        /* Track dependencies */
        const d = this.getDeps([exprResult]);
        this.addDependencies('exits', as.dependencies.items, exit, area, d.items);
        this.addDependencies('exits', as.dependencies.events, exit, area, d.events);

        if (exprResult.result) {
          const areaData = cloneAreaData(as.areas.get(area)!);
          const r = exprResult.restrictions;
          if (r) {
            if (r.oot.day) areaData.oot.day = false;
            if (r.oot.night) areaData.oot.night = false;
            if (r.mmTime) {
              areaData.mmTime = (areaData.mmTime & ~(r.mmTime)) >>> 0;
            }
            if (r.mmTime2) {
              areaData.mmTime2 = (areaData.mmTime2 & ~(r.mmTime2)) >>> 0;
            }
            areaData.flagsOn = (areaData.flagsOn | r.flagsOn) >>> 0;
            areaData.flagsOff = (areaData.flagsOff | r.flagsOff) >>> 0;
          }
          this.exploreArea(worldId, age, exit, areaData, area);
        }
      }
    }
  }

  private getDeps(res: ExprResult[]) {
    const itemsArr = res.map(x => x.depItems);
    const eventsArr = res.map(x => x.depEvents);
    const items = new Set<Item>();
    const events = new Set<string>();

    recursiveForEach<Item>(itemsArr, x => items.add(x));
    recursiveForEach<string>(eventsArr, x => events.add(x));

    return { items, events };
  }

  private evalEvents(worldId: number, age: Age) {
    /* Extract the queue */
    const ws = this.state.ws[worldId];
    const world = this.worlds[worldId];
    const as = ws.ages[age];
    const areasOptimized = this.worldsOptimized[worldId][age];
    const q = as.queues.events;
    as.queues.events = new Map();

    /* Evaluate all the events */
    for (const [event, areas] of q) {
      for (const area of areas) {
        if (ws.events.has(event)) {
          continue;
        }

        const areaOptimized = areasOptimized[area];

        /* Evaluate the event */
        const expr = areaOptimized.events[event];
        if (!expr) {
          throw new Error(`Event ${event} not found in area ${area}`);
        }
        const result = this.evalExpr(worldId, expr, age, area);

        /* If the result is true, add the event to the state and queue up everything */
        /* Otherwise, track dependencies */
        if (result.result) {
          ws.events.add(event);
          for (const evAge of AGES) {
            const evAs = ws.ages[evAge];
            const deps = evAs.dependencies.events.get(event);
            if (deps) {
              evAs.dependencies.events.delete(event);
              for (const [area, d] of deps) {
                d.exits.forEach(x => this.queue('exits', evAge, worldId, x, area));
                d.events.forEach(x => this.queue('events', evAge, worldId, x, area));
                d.locations.forEach(x => this.queue('locations', evAge, worldId, x, area));
                if (this.opts.gossips) {
                  d.gossips.forEach(x => this.queue('gossips', evAge, worldId, x, area));
                }
              }
            }
          }

          /* If it's time travel at will, we need to re-explore everything */
          if (event === 'OOT_TIME_TRAVEL_AT_WILL') {
            for (const [area, areaData] of ws.ages.child.areas) {
              const a = world.areas[area];
              if (a.ageChange)
                this.exploreArea(worldId, 'child', area, areaData, area);
            }
            for (const [area, areaData] of ws.ages.adult.areas) {
              const a = world.areas[area];
              if (a.ageChange)
                this.exploreArea(worldId, 'adult', area, areaData, area);
            }
          }
        } else {
          /* Track dependencies */
          const d = this.getDeps([result]);
          this.addDependencies('events', as.dependencies.items, event, area, d.items);
          this.addDependencies('events', as.dependencies.events, event, area, d.events);
        }
      }
    }
  }

  private evalLocations(worldId: number, age: Age) {
    /* Extract the queue */
    const ws = this.state.ws[worldId];
    const as = ws.ages[age];
    const q = as.queues.locations;
    as.queues.locations = new Map();
    const areasOptimized = this.worldsOptimized[worldId][age];

    /* Evaluate all the locations */
    for (const [location, areas] of q) {
      let isAllowed = true;
      if (this.opts.includeForbiddenReachable) {
        if (ws.restrictedLocations && !ws.restrictedLocations.has(location)) {
          isAllowed = false;
        } else if (ws.forbiddenLocations && ws.forbiddenLocations.has(location)) {
          isAllowed = false;
        }
      }

      const globalLoc = makeLocation(location, worldId);

      for (const area of areas) {
        if (this.state.locations.has(globalLoc)) {
          continue;
        }

        const areaOptimized = areasOptimized[area];

        /* Evaluate the location */
        const expr = areaOptimized.locations[location];
        const result = this.evalExpr(worldId, expr, age, area);

        /* If the result is true, add the location to the state and queue up everything */
        /* Otherwise, track dependencies */
        if (result.result) {
          if (isAllowed) {
            this.addLocationDelayed(worldId, location);
          } else {
            ws.forbiddenReachableLocations.add(location);
          }
        } else {
          /* Track dependencies */
          const d = this.getDeps([result]);
          this.addDependencies('locations', as.dependencies.items, location, area, d.items);
          this.addDependencies('locations', as.dependencies.events, location, area, d.events);
        }
      }
    }
  }

  private evalGossips(worldId: number, age: Age) {
    /* Extract the queue */
    const ws = this.state.ws[worldId];
    const as = ws.ages[age];
    const q = as.queues.gossips;
    as.queues.gossips = new Map();
    const areasOptimized = this.worldsOptimized[worldId][age];

    /* Evaluate all the gossips */
    for (const [gossip, areas] of q) {
      for (const area of areas) {
        if (this.state.gossips[worldId].has(gossip)) {
          continue;
        }

        /* Evaluate the gossip */
        const areaOptimized = areasOptimized[area];
        const expr = areaOptimized.gossip[gossip];
        const result = this.evalExpr(worldId, expr, age, area);

        /* If any of the results are true, add the gossip to the state and queue up everything */
        /* Otherwise, track dependencies */
        if (result.result) {
          this.state.gossips[worldId].add(gossip);
        } else {
          /* Track dependencies */
          const d = this.getDeps([result]);
          this.addDependencies('gossips', as.dependencies.items, gossip, area, d.items);
          this.addDependencies('gossips', as.dependencies.events, gossip, area, d.events);
        }
      }
    }
  }

  private pathfindStep() {
    /* Clear new locations */
    this.state.newLocations.clear();

    for (let worldId = 0; worldId < this.worlds.length; ++worldId) {
      const ws = this.state.ws[worldId];

      if (this.opts.singleWorld !== undefined && this.opts.singleWorld !== worldId) {
        continue;
      }

      for (;;) {
        /* Expand as much as possible */
        for (const age of AGES) {
          this.evalExits(worldId, age);
        }
        for (const age of AGES) {
          this.evalEvents(worldId, age);
        }

        let isQueued = false;
        for (const age of AGES) {
          if (ws.ages[age].queues.exits.size) {
            isQueued = true;
            break;
          }
          if (ws.ages[age].queues.events.size) {

            isQueued = true;
            break;
          }
        }

        if (!isQueued) {
          break;
        }
      }

      /* Get locations */
      for (;;) {
        for (const age of AGES) {
          this.evalLocations(worldId, age);
        }
        if (!this.opts.recursive || (!ws.ages.child.queues.locations.size && !ws.ages.adult.queues.locations.size))
          break;
      }
    }

    /* Add delayed locations */
    for (const globalLoc of this.state.newLocations) {
      const locD = locationData(globalLoc);
      this.addLocation(locD.world as number, locD.id);
    }

    /* Return true if there is more to do */
    for (let world = 0; world < this.worlds.length; ++world) {
      if (this.opts.singleWorld !== undefined && this.opts.singleWorld !== world) {
        continue;
      }
      const ws = this.state.ws[world];
      for (const age of AGES) {
        const as = ws.ages[age];
        const q = as.queues;
        if (q.events.size || q.exits.size || q.locations.size)
          return true;
      }
    }

    return false;
  }

  private isGanonMajoraReached() {
    for (let worldId = 0; worldId < this.worlds.length; ++worldId) {
      if (this.opts.singleWorld !== undefined && this.opts.singleWorld !== worldId) {
        continue;
      }
      const ws = this.state.ws[worldId];
      if (this.settings.games !== 'mm' && !ws.events.has('OOT_GANON_PRE_BOSS')) return false;
      if (this.settings.games !== 'oot' && !ws.events.has('MM_MAJORA_PRE_BOSS')) return false;
    }

    return true;
  }

  private isGoalReached() {
    const { settings } = this;

    for (let worldId = 0; worldId < this.worlds.length; ++worldId) {
      if (this.opts.singleWorld !== undefined && this.opts.singleWorld !== worldId) {
        continue;
      }
      const ws = this.state.ws[worldId];
      const ganon = ws.events.has('OOT_GANON');
      const majora = ws.events.has('MM_MAJORA');
      let worldGoal = false;

      switch (settings.goal) {
      case 'any': worldGoal = ganon || majora; break;
      case 'ganon': worldGoal = ganon; break;
      case 'majora': worldGoal = majora; break;
      case 'both': worldGoal = ganon && majora; break;
      case 'triforce': worldGoal = (this.opts.ignoreItems || ((ws.items.get(Items.SHARED_TRIFORCE) || 0) >= settings.triforceGoal)); break;
      case 'triforce3': worldGoal = (this.opts.ignoreItems || (ws.items.has(Items.SHARED_TRIFORCE_POWER) && ws.items.has(Items.SHARED_TRIFORCE_COURAGE) && ws.items.has(Items.SHARED_TRIFORCE_WISDOM))); break;
      }

      if (!worldGoal) {
        return false;
      }
    }

    return true;
  }

  private pathfind() {
    /* Handle initial state */
    if (!this.state.started) {
      this.state.started = true;
      const initAreaData = defaultAreaData();
      initAreaData.mmTime = 1;

      for (let worldId = 0; worldId < this.worlds.length; ++worldId) {
        if (this.opts.singleWorld !== undefined && this.opts.singleWorld !== worldId) {
          continue;
        }
        this.exploreArea(worldId, 'child', 'OOT SPAWN', initAreaData, 'OOT SPAWN');
        this.exploreArea(worldId, 'adult', 'OOT SPAWN', initAreaData, 'OOT SPAWN');
      }
    }

    /* Assumed items */
    if (this.opts.assumedItems) {
      for (const [playerItem, amount] of this.opts.assumedItems.entries()) {
        const amountPrev = this.state.previousAssumedItems.get(playerItem) || 0;

        if (amount > amountPrev) {
          const ws = this.state.ws[playerItem.player];
          const delta = amount - amountPrev;

          countMapAdd(ws.items, playerItem.item, delta);
          countMapAdd(ws.renewables, playerItem.item, delta);
          countMapAdd(ws.licenses, playerItem.item, delta);
          this.requeueItem(playerItem.player, playerItem.item);
          this.state.previousAssumedItems.set(playerItem, amount);
        }
      }
    }

    /* Handle no logic */
    if (this.settings.logic === 'none') {
      this.state.goal = true;
      const locations: Location[][] = [];
      this.state.gossips = [];
      for (let worldId = 0; worldId < this.worlds.length; ++worldId) {
        const world = this.worlds[worldId];
        const worldGossips = new Set(Object.values(world.areas).map(x => Object.keys(x.gossip || {})).flat());
        this.state.gossips.push(worldGossips);
        const locs = Object.keys(world.checks).map(x => makeLocation(x, worldId));
        locations.push(locs);
      }
      this.state.locations = new Set(locations.flat());
      return;
    }

    for (let worldId = 0; worldId < this.worlds.length; ++worldId) {
      const ws = this.state.ws[worldId];

      /* Collect previous locations */
      for (const loc of ws.uncollectedLocations) {
        this.addLocation(worldId, loc);
      }

      /* Collect previously forbidden locations */
      for (const loc of ws.forbiddenReachableLocations) {
        let isAllowed = true;
        if (ws.restrictedLocations && !ws.restrictedLocations.has(loc)) {
          isAllowed = false;
        } else if (ws.forbiddenLocations && ws.forbiddenLocations.has(loc)) {
          isAllowed = false;
        }
        if (isAllowed) {
          this.addLocation(worldId, loc);
          ws.forbiddenReachableLocations.delete(loc);
        }
      }
    }

    /* Pathfind */
    for (;;) {
      this.state.changed = this.pathfindStep();
      if (this.opts.ganonMajora) {
        this.state.ganonMajora = this.isGanonMajoraReached();
      }
      if (this.isGoalReached()) {
        this.state.goal = true;
        if (this.opts.stopAtGoal) {
          break;
        }
      }
      if (!this.state.changed || !this.opts.recursive) {
        break;
      }
    }

    /* Check for gossips */
    if (this.opts.gossips) {
      for (let worldId = 0; worldId < this.worlds.length; ++worldId) {
        for (const age of AGES) {
          this.evalGossips(worldId, age);
        }
      }
    }
  }
}
