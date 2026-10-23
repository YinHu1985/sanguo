import { NEUTRAL_FACTION_ID } from "./atlas.js";
import { areAllied } from "./campaign.js";
import { cityBesieged } from "./war-state.js";

// The whole route is checked against the sending faction: an ally's own allies
// do not automatically grant passage to the sender.
function friendlyRoutes(state, sourceId, factionId) {
  const cities = new Map(state.cities.map((city) => [city.id, city]));
  const source = cities.get(sourceId);
  const sender = factionId ?? source?.factionId;
  const passable = (city) => city && city.factionId && city.factionId !== NEUTRAL_FACTION_ID
    && !cityBesieged(state, city.id) && areAllied(state, sender, city.factionId);
  const parents = new Map();
  if (!sender || sender === NEUTRAL_FACTION_ID || !passable(source)) return { cities, parents };
  parents.set(sourceId, null);
  const frontier = [source];
  for (let index = 0; index < frontier.length; index += 1) {
    for (const id of frontier[index].adjacent ?? []) {
      const city = cities.get(id);
      if (parents.has(id) || !passable(city)) continue;
      parents.set(id, frontier[index].id);
      frontier.push(city);
    }
  }
  return { cities, parents };
}

/** Shortest friendly route as city IDs, including both endpoints; null if blocked. */
export function findFriendlyRoute(state, sourceId, targetId, factionId) {
  const { parents } = friendlyRoutes(state, sourceId, factionId);
  if (!parents.has(targetId)) return null;
  const path = [];
  for (let id = targetId; id !== null; id = parents.get(id)) path.push(id);
  return path.reverse();
}

/** All reachable friendly/allied city objects in BFS order, excluding the origin. */
export function reachableFriendlyCities(state, sourceId) {
  const { cities, parents } = friendlyRoutes(state, sourceId);
  return [...parents.keys()].filter((id) => id !== sourceId).map((id) => cities.get(id));
}
